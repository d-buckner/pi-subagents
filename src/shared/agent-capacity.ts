import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TEMP_ROOT_DIR } from "./types.ts";

/**
 * Machine-wide agent capacity.
 *
 * One pool shared by every pi process of this user bounds how many agents are
 * doing model work at the same time. Every live agent — a root parent session or
 * a running child — keeps one lease file here while it occupies the model, and a
 * child launch waits for room before it starts. Parent sessions are never
 * gated: they hold a lease when they have one and run anyway when they do not,
 * because the operator opening a pi session is never the thing under test.
 *
 * A lease is a heartbeat, not a lock. A process that dies stops refreshing and
 * stops being counted once its lease ages out, so no crash can wedge the pool.
 * An agent blocked on a long tool call — a build, a test suite, a supervisor
 * reply — releases its capacity and reclaims it when it returns to model work.
 * Reclaim is opportunistic: an agent that finds the pool full when its tool
 * finally returns still finishes its turn, because admission already happened
 * and un-starting live model work is not something this pool can honestly undo.
 */

export const AGENT_CAPACITY_DIR = path.join(TEMP_ROOT_DIR, "agent-capacity");

/** How often a live lease refreshes its heartbeat. */
export const AGENT_CAPACITY_HEARTBEAT_MS = 5_000;
/** A lease this old is dead: its owner stopped refreshing or died. */
export const AGENT_CAPACITY_LEASE_TTL_MS = 3 * AGENT_CAPACITY_HEARTBEAT_MS;
/** How long a tool call may run before its agent counts as waiting, not working. */
export const DEFAULT_AGENT_MODEL_IDLE_AFTER_MS = 30_000;
export const MIN_AGENT_MODEL_IDLE_AFTER_MS = 5_000;
export const MAX_AGENT_MODEL_IDLE_AFTER_MS = 10 * 60_000;
/** How long a child waits for capacity before its launch fails. */
export const DEFAULT_AGENT_CAPACITY_QUEUE_TIMEOUT_MS = 30 * 60_000;
export const MIN_AGENT_CAPACITY_QUEUE_TIMEOUT_MS = 1_000;
export const MAX_AGENT_CAPACITY_QUEUE_TIMEOUT_MS = 24 * 60 * 60_000;
/** Poll interval while a child waits for a slot. */
export const AGENT_CAPACITY_POLL_MS = 1_000;

const ADMISSION_LOCK_STALE_MS = 5_000;
/** Past this age a dead owner's lease is removed instead of merely ignored. */
const LEASE_GC_AFTER_MS = 60 * 60_000;

export type AgentCapacityKind = "parent" | "child";

export interface AgentCapacityOccupant {
	version: 1;
	key: string;
	kind: AgentCapacityKind;
	label: string;
	pid: number;
	hostname: string;
	/** True while the owner occupies the model and is counted against the limit. */
	active: boolean;
	claimedAt: number;
	lastSeenAt: number;
	runId?: string;
	sessionId?: string;
}

export interface AgentCapacitySnapshot {
	/** `null` means unlimited, which is the default when the cap is unset. */
	limit: number | null;
	used: number;
	remaining: number | null;
	/** Live agents inside a turn but waiting on a tool or a reply instead of the model. */
	waiting: number;
	occupants: AgentCapacityOccupant[];
}

export class AgentCapacityUnavailableError extends Error {
	readonly snapshot: AgentCapacitySnapshot;

	constructor(snapshot: AgentCapacitySnapshot, waitedMs: number) {
		super(`Agent capacity is full: ${snapshot.used}/${snapshot.limit} agent slots are in use and none freed after ${Math.round(waitedMs / 1000)}s. Raise config.capacity.maxActiveAgents or wait for a running agent to finish.`);
		this.name = "AgentCapacityUnavailableError";
		this.snapshot = snapshot;
	}
}

/** `undefined` means unlimited. Mirrors `resolveMaxActiveAsyncRunsPerSession`. */
export function resolveMaxActiveAgents(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
	return value;
}

function resolveBoundedMs(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return fallback;
	return value;
}

export function resolveAgentModelIdleAfterMs(value: unknown): number {
	return resolveBoundedMs(value, DEFAULT_AGENT_MODEL_IDLE_AFTER_MS, MIN_AGENT_MODEL_IDLE_AFTER_MS, MAX_AGENT_MODEL_IDLE_AFTER_MS);
}

export function resolveAgentCapacityQueueTimeoutMs(value: unknown): number {
	return resolveBoundedMs(value, DEFAULT_AGENT_CAPACITY_QUEUE_TIMEOUT_MS, MIN_AGENT_CAPACITY_QUEUE_TIMEOUT_MS, MAX_AGENT_CAPACITY_QUEUE_TIMEOUT_MS);
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists and belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function parseOccupant(value: unknown): AgentCapacityOccupant | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const occupant = value as Partial<AgentCapacityOccupant>;
	if (occupant.version !== 1
		|| typeof occupant.key !== "string" || !occupant.key
		|| (occupant.kind !== "parent" && occupant.kind !== "child")
		|| typeof occupant.label !== "string"
		|| !Number.isSafeInteger(occupant.pid) || (occupant.pid ?? 0) <= 0
		|| typeof occupant.hostname !== "string"
		|| typeof occupant.active !== "boolean"
		|| typeof occupant.claimedAt !== "number" || !Number.isFinite(occupant.claimedAt)
		|| typeof occupant.lastSeenAt !== "number" || !Number.isFinite(occupant.lastSeenAt)) return undefined;
	if (occupant.runId !== undefined && typeof occupant.runId !== "string") return undefined;
	if (occupant.sessionId !== undefined && typeof occupant.sessionId !== "string") return undefined;
	return occupant as AgentCapacityOccupant;
}

function leasePath(rootDir: string, key: string): string {
	return path.join(rootDir, `${key}.json`);
}

function ensureCapacityRoot(rootDir: string): void {
	fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
}

function writeOccupant(rootDir: string, occupant: AgentCapacityOccupant): void {
	ensureCapacityRoot(rootDir);
	const target = leasePath(rootDir, occupant.key);
	const temp = `${target}.${randomUUID()}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(occupant)}\n`, { encoding: "utf-8", mode: 0o600 });
	fs.renameSync(temp, target);
}

/**
 * Live occupants, with leases from dead or silent owners dropped. A lease from
 * another host can only be judged by its heartbeat, since a PID there means
 * nothing here.
 */
export function readAgentCapacityOccupants(rootDir = AGENT_CAPACITY_DIR, now = Date.now()): AgentCapacityOccupant[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(rootDir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const here = os.hostname();
	const occupants: AgentCapacityOccupant[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.includes(".tmp.")) continue;
		const filePath = path.join(rootDir, entry.name);
		let occupant: AgentCapacityOccupant | undefined;
		try {
			occupant = parseOccupant(JSON.parse(fs.readFileSync(filePath, "utf-8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				// Unreadable litter from an older runtime still has to age out.
				try {
					if (now - fs.statSync(filePath).mtimeMs > LEASE_GC_AFTER_MS) fs.rmSync(filePath, { force: true });
				} catch {}
			}
			continue;
		}
		const age = now - occupant.lastSeenAt;
		const sameHost = occupant.hostname === here;
		const ownerGone = sameHost && !processIsAlive(occupant.pid);
		if (age > AGENT_CAPACITY_LEASE_TTL_MS || ownerGone) {
			// Only reap a lease nobody can still defend, so a suspended-but-alive
			// session keeps its identity.
			if (age > LEASE_GC_AFTER_MS && (ownerGone || !sameHost)) {
				try {
					fs.rmSync(filePath, { force: true });
				} catch {}
			}
			continue;
		}
		occupants.push(occupant);
	}
	return occupants.sort((left, right) => left.claimedAt - right.claimedAt || left.key.localeCompare(right.key));
}

export function readAgentCapacitySnapshot(limit: number | null | undefined, rootDir = AGENT_CAPACITY_DIR, now = Date.now()): AgentCapacitySnapshot {
	const occupants = readAgentCapacityOccupants(rootDir, now);
	const used = occupants.filter((occupant) => occupant.active).length;
	return {
		limit: limit ?? null,
		used,
		remaining: limit == null ? null : Math.max(0, limit - used),
		waiting: occupants.length - used,
		occupants,
	};
}

export function formatAgentCapacity(snapshot: AgentCapacitySnapshot): string {
	if (snapshot.limit === null) return `Agent capacity: unlimited (${snapshot.used} model-active, ${snapshot.waiting} waiting)`;
	return `Agent capacity: ${snapshot.used}/${snapshot.limit} in use, ${snapshot.remaining} free (${snapshot.waiting} waiting on a tool or a reply)`;
}

interface AdmissionLockOwner {
	pid: number;
	token: string;
}

function readAdmissionLockOwner(lockPath: string): AdmissionLockOwner | undefined {
	try {
		const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf-8")) as Partial<AdmissionLockOwner>;
		if (Number.isSafeInteger(owner.pid) && (owner.pid ?? 0) > 0 && typeof owner.token === "string" && owner.token) return owner as AdmissionLockOwner;
	} catch {}
	return undefined;
}

/**
 * Serializes the check-then-claim so two launches that both see one free slot
 * cannot both take it. Held for one directory read and one file rename, never
 * across a run.
 */
function withAdmissionLock<T>(rootDir: string, operation: () => T): T {
	ensureCapacityRoot(rootDir);
	const lockPath = path.join(rootDir, "admission.lock");
	const owner: AdmissionLockOwner = { pid: process.pid, token: randomUUID() };
	for (let attempt = 0; attempt < 200; attempt++) {
		let acquired = false;
		try {
			fs.mkdirSync(lockPath, { mode: 0o700 });
			try {
				fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner), { encoding: "utf-8", mode: 0o600 });
			} catch (error) {
				fs.rmSync(lockPath, { recursive: true, force: true });
				throw error;
			}
			acquired = true;
			return operation();
		} catch (error) {
			if (acquired) throw error;
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const held = readAdmissionLockOwner(lockPath);
			const wedged = held ? !processIsAlive(held.pid) : Date.now() - fs.statSync(lockPath).mtimeMs > ADMISSION_LOCK_STALE_MS;
			if (wedged) {
				const tombstone = path.join(rootDir, `admission.stale-${randomUUID()}`);
				try {
					fs.renameSync(lockPath, tombstone);
					fs.rmSync(tombstone, { recursive: true, force: true });
					continue;
				} catch (reclaimError) {
					if ((reclaimError as NodeJS.ErrnoException).code !== "ENOENT") throw reclaimError;
				}
			}
			const until = Date.now() + Math.min(50, 2 * 2 ** Math.min(attempt, 4));
			while (Date.now() < until) { /* brief hand-over wait; the lock is never held across a run */ }
		} finally {
			if (acquired && readAdmissionLockOwner(lockPath)?.token === owner.token) fs.rmSync(lockPath, { recursive: true, force: true });
		}
	}
	throw new Error(`Timed out acquiring the agent capacity admission lock at '${rootDir}'.`);
}

export interface AgentActivityLeaseInput {
	kind: AgentCapacityKind;
	label: string;
	/** Pool the lease competes in. `undefined` or `null` means unlimited, so the owner always claims a slot. */
	limit?: number | null;
	runId?: string;
	sessionId?: string;
	idleAfterMs?: number;
	rootDir?: string;
	heartbeatMs?: number;
	now?: () => number;
}

export interface AgentActivityLease {
	readonly key: string;
	/** True while this lease is counted against the pool. */
	isHolding(): boolean;
	/** The agent is doing model work. Claims capacity when a slot is available. */
	markRunning(): void;
	/** Inside a turn but not on the model: capacity is released, the lease stays visible. */
	markWaiting(): void;
	/** The turn is over. Capacity is released and the lease is removed. */
	markIdle(): void;
	toolStarted(toolCallId: string): void;
	toolEnded(toolCallId: string): void;
	/** Drops the lease entirely. Idempotent. */
	release(): void;
	snapshot(): AgentCapacityOccupant | undefined;
}

/**
 * Keeps one lease in step with one agent's loop. Feed it the agent's lifecycle
 * and tool events; it decides whether that agent currently occupies the model.
 */
export function createAgentActivityLease(input: AgentActivityLeaseInput): AgentActivityLease {
	const rootDir = input.rootDir ?? AGENT_CAPACITY_DIR;
	const heartbeatMs = input.heartbeatMs ?? AGENT_CAPACITY_HEARTBEAT_MS;
	const idleAfterMs = input.idleAfterMs ?? DEFAULT_AGENT_MODEL_IDLE_AFTER_MS;
	const limit = resolveMaxActiveAgents(input.limit ?? undefined) ?? null;
	const now = input.now ?? Date.now;
	const key = `${input.kind}-${process.pid}-${randomUUID().slice(0, 8)}`;
	const base = {
		version: 1 as const,
		key,
		kind: input.kind,
		label: input.label,
		pid: process.pid,
		hostname: os.hostname(),
		claimedAt: now(),
		...(input.runId ? { runId: input.runId } : {}),
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
	};

	let exists = false;
	let active = false;
	let running = false;
	/** Set while the agent is knowingly off the model; blocks auto-reclaim. */
	let heldBack = false;
	let released = false;
	const openTools = new Map<string, number>();
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let blockTimer: ReturnType<typeof setTimeout> | undefined;

	const persist = (): void => {
		if (released) return;
		try {
			writeOccupant(rootDir, { ...base, active, lastSeenAt: now() });
			exists = true;
		} catch {
			// A lease that cannot be written must not break the agent it describes.
		}
	};

	const drop = (): void => {
		if (!exists) return;
		try {
			fs.rmSync(leasePath(rootDir, key), { force: true });
		} catch {}
		exists = false;
	};

	/** A tool call older than the grace window means the model is idle. */
	const blockedOnTool = (): boolean => {
		for (const startedAt of openTools.values()) {
			if (now() - startedAt >= idleAfterMs) return true;
		}
		return false;
	};

	const roomAvailable = (): boolean => {
		if (limit === null) return true;
		try {
			return readAgentCapacityOccupants(rootDir, now()).filter((occupant) => occupant.active).length < limit;
		} catch {
			return false;
		}
	};

	const stopTimers = (): void => {
		if (heartbeat) clearInterval(heartbeat);
		if (blockTimer) clearTimeout(blockTimer);
		heartbeat = undefined;
		blockTimer = undefined;
	};

	/** One pass of the state machine: hold capacity only while the agent works the model. */
	const evaluate = (): void => {
		if (released || !running) return;
		if (blockedOnTool() || heldBack) {
			if (active) active = false;
			persist();
			return;
		}
		if (!active) {
			// Returning from a long tool call reclaims capacity only when room is
			// free; live model work is never stopped for want of a slot.
			if (!roomAvailable()) {
				persist();
				return;
			}
			active = true;
		}
		persist();
	};

	const armBlockTimer = (): void => {
		if (blockTimer) clearTimeout(blockTimer);
		let oldest = Number.POSITIVE_INFINITY;
		for (const startedAt of openTools.values()) oldest = Math.min(oldest, startedAt);
		if (!Number.isFinite(oldest)) return;
		blockTimer = setTimeout(() => {
			blockTimer = undefined;
			evaluate();
			armBlockTimer();
		}, Math.max(0, oldest + idleAfterMs - now()));
		blockTimer.unref?.();
	};

	const onExit = (): void => drop();
	process.once("exit", onExit);

	heartbeat = setInterval(() => evaluate(), heartbeatMs);
	heartbeat.unref?.();

	return {
		key,
		isHolding: () => active,
		markRunning() {
			running = true;
			heldBack = false;
			evaluate();
		},
		markWaiting() {
			heldBack = true;
			if (active || !exists) {
				active = false;
				persist();
			}
		},
		markIdle() {
			running = false;
			heldBack = false;
			active = false;
			openTools.clear();
			drop();
		},
		toolStarted(toolCallId) {
			openTools.set(toolCallId, now());
			armBlockTimer();
		},
		toolEnded(toolCallId) {
			openTools.delete(toolCallId);
			heldBack = false;
			evaluate();
			armBlockTimer();
		},
		release() {
			if (released) return;
			released = true;
			running = false;
			active = false;
			openTools.clear();
			stopTimers();
			process.off("exit", onExit);
			drop();
		},
		snapshot() {
			return exists ? { ...base, active, lastSeenAt: now() } : undefined;
		},
	};
}

/**
 * Drives a lease from a pi agent or child-session event. Unknown events are
 * ignored, so a host can forward its whole event stream.
 */
export function driveAgentActivityLease(lease: AgentActivityLease, event: { type?: string; toolCallId?: string }): void {
	switch (event.type) {
		case "agent_start":
		case "auto_retry_start":
			lease.markRunning();
			return;
		case "agent_end":
		case "agent_settled":
			lease.markWaiting();
			return;
		case "tool_execution_start":
			lease.toolStarted(event.toolCallId ?? event.type);
			return;
		case "tool_execution_end":
			lease.toolEnded(event.toolCallId ?? event.type);
			return;
		default:
			return;
	}
}

export interface AcquireAgentCapacityInput {
	limit: number;
	label: string;
	runId?: string;
	sessionId?: string;
	idleAfterMs?: number;
	queueTimeoutMs?: number;
	rootDir?: string;
	signal?: AbortSignal;
	/** Called on each poll while the launch waits, so the caller can report why it is idle. */
	onWait?: (snapshot: AgentCapacitySnapshot, waitedMs: number) => void;
	pollMs?: number;
}

/**
 * Takes one slot for a child that is about to start, waiting while the pool is
 * full. Throws `AgentCapacityUnavailableError` once the queue deadline passes
 * and rejects on abort, so a cancelled parent never leaves a queued child.
 */
export async function acquireAgentCapacitySlot(input: AcquireAgentCapacityInput): Promise<AgentActivityLease> {
	const rootDir = input.rootDir ?? AGENT_CAPACITY_DIR;
	const pollMs = input.pollMs ?? AGENT_CAPACITY_POLL_MS;
	const queueTimeoutMs = input.queueTimeoutMs ?? DEFAULT_AGENT_CAPACITY_QUEUE_TIMEOUT_MS;
	const startedAt = Date.now();
	for (;;) {
		if (input.signal?.aborted) throw new Error("Subagent launch was cancelled while it waited for agent capacity.");
		const lease = withAdmissionLock(rootDir, () => {
			const used = readAgentCapacityOccupants(rootDir).filter((occupant) => occupant.active).length;
			if (used >= input.limit) return undefined;
			const lease = createAgentActivityLease({
				kind: "child",
				label: input.label,
				limit: input.limit,
				runId: input.runId,
				sessionId: input.sessionId,
				idleAfterMs: input.idleAfterMs,
				rootDir,
			});
			// Claimed inside the lock so the count above stays true for the winner.
			lease.markRunning();
			return lease;
		});
		if (lease) return lease;
		const waitedMs = Date.now() - startedAt;
		if (waitedMs >= queueTimeoutMs) throw new AgentCapacityUnavailableError(readAgentCapacitySnapshot(input.limit, rootDir), waitedMs);
		input.onWait?.(readAgentCapacitySnapshot(input.limit, rootDir), waitedMs);
		await new Promise<void>((resolve) => {
			// Not unref'd on purpose: a launch that is waiting for capacity must keep
			// its host alive instead of exiting under it.
			const timer = setTimeout(resolve, pollMs);
			input.signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				resolve();
			}, { once: true });
		});
	}
}
