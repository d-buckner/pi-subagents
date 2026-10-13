import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_AGENT_MODEL_IDLE_AFTER_MS,
	resolveAgentCapacity,
	type ResolvedAgentCapacity,
} from "./agent-capacity-settings.ts";
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
 *
 * Everything here is fail-open. The pool exists to keep a machine from
 * over-subscribing itself, so a lease that cannot be read, a lock that cannot be
 * taken, or a directory that cannot be written must never cost a user a launch:
 * each degrades to ungated instead of blocking.
 */

export const AGENT_CAPACITY_DIR = path.join(TEMP_ROOT_DIR, "agent-capacity");

/** How often a live lease refreshes its heartbeat. */
export const AGENT_CAPACITY_HEARTBEAT_MS = 5_000;
/** A lease this old is dead: its owner stopped refreshing or died. */
export const AGENT_CAPACITY_LEASE_TTL_MS = 3 * AGENT_CAPACITY_HEARTBEAT_MS;
/** Poll interval while a child waits for a slot. */
export const AGENT_CAPACITY_POLL_MS = 1_000;

const ADMISSION_LOCK_STALE_MS = 5_000;
const ADMISSION_LOCK_ATTEMPTS = 40;
const ADMISSION_LOCK_RETRY_MS = 50;
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
	/** Live agents inside a turn but waiting on a long tool call instead of the model. */
	waiting: number;
	occupants: AgentCapacityOccupant[];
	/** The pool could not be read, so the counts above are not trustworthy. */
	unreadable?: boolean;
}

/**
 * A pi agent or child-session event, narrowed to what a lease reads. Hosts may
 * forward their whole event stream; anything unrecognised is ignored.
 */
export interface AgentCapacityEvent {
	type?: string;
	toolCallId?: string;
}

export class AgentCapacityUnavailableError extends Error {
	readonly snapshot: AgentCapacitySnapshot;

	constructor(snapshot: AgentCapacitySnapshot, waitedMs: number) {
		super(`Agent capacity is full: ${snapshot.used}/${snapshot.limit} agent slots are in use and none freed after ${Math.round(waitedMs / 1000)}s. Raise config.capacity.maxActiveAgents or wait for a running agent to finish.`);
		this.name = "AgentCapacityUnavailableError";
		this.snapshot = snapshot;
	}
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

/** Delete a lease no current runtime can parse, but only once it has aged out. */
function reapUnparseableLease(filePath: string, now: number): void {
	try {
		if (now - fs.statSync(filePath).mtimeMs > LEASE_GC_AFTER_MS) fs.rmSync(filePath, { force: true });
	} catch {}
}

function leasePath(rootDir: string, key: string): string {
	return path.join(rootDir, `${key}.json`);
}

function ensureCapacityRoot(rootDir: string): void {
	fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
}

function writeOccupant(rootDir: string, occupant: AgentCapacityOccupant): void {
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
			// Unreadable litter from an older runtime still has to age out.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") reapUnparseableLease(filePath, now);
			continue;
		}
		if (!occupant) {
			// Well-formed JSON from an incompatible runtime: unusable here, so it ages out too.
			reapUnparseableLease(filePath, now);
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

/**
 * Live occupants, or `undefined` when the pool could not be read at all.
 *
 * Every gate in this module treats `undefined` as unlimited rather than as full,
 * because a transient `EACCES` or `EMFILE` must not stall or fail a launch.
 */
function tryReadOccupants(rootDir: string, now: () => number): AgentCapacityOccupant[] | undefined {
	try {
		return readAgentCapacityOccupants(rootDir, now());
	} catch {
		return undefined;
	}
}

export function readAgentCapacitySnapshot(
	limit: number | null | undefined,
	options: { rootDir?: string; now?: () => number } = {},
): AgentCapacitySnapshot {
	const occupants = tryReadOccupants(options.rootDir ?? AGENT_CAPACITY_DIR, options.now ?? Date.now);
	if (!occupants) return { limit: limit ?? null, used: 0, remaining: limit == null ? null : limit, waiting: 0, occupants: [], unreadable: true };
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
	if (snapshot.unreadable) return "Agent capacity: unavailable (the pool could not be read, so launches stay ungated)";
	if (snapshot.limit === null) return `Agent capacity: unlimited (${snapshot.used} model-active, ${snapshot.waiting} waiting)`;
	return `Agent capacity: ${snapshot.used}/${snapshot.limit} in use, ${snapshot.remaining} free (${snapshot.waiting} waiting on a long tool call)`;
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

/** Returned instead of throwing when the lock could not be taken; callers proceed ungated. */
const LOCK_UNAVAILABLE = Symbol("agent capacity admission lock unavailable");

/**
 * Serializes the check-then-claim so two launches that both see one free slot
 * cannot both take it.
 *
 * `operation` runs while the lock is held and must stay quick — a directory read
 * and a file rename, never a run. Contention is never fatal: a wedged lock is
 * reclaimed, and a lock that still cannot be taken returns `LOCK_UNAVAILABLE` so
 * the caller can claim unsafely, because losing a rare race on the last slot
 * costs less than failing a user's launch.
 */
async function withAdmissionLock<T>(rootDir: string, operation: () => T): Promise<T | typeof LOCK_UNAVAILABLE> {
	const lockPath = path.join(rootDir, "admission.lock");
	const owner: AdmissionLockOwner = { pid: process.pid, token: randomUUID() };
	for (let attempt = 0; attempt < ADMISSION_LOCK_ATTEMPTS; attempt++) {
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
			try {
				return operation();
			} finally {
				if (readAdmissionLockOwner(lockPath)?.token === owner.token) fs.rmSync(lockPath, { recursive: true, force: true });
			}
		} catch (error) {
			if (acquired) throw error;
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return LOCK_UNAVAILABLE;
			const held = readAdmissionLockOwner(lockPath);
			const wedged = held ? !processIsAlive(held.pid) : Date.now() - fs.statSync(lockPath).mtimeMs > ADMISSION_LOCK_STALE_MS;
			if (wedged) {
				try {
					fs.renameSync(lockPath, path.join(rootDir, `admission.stale-${randomUUID()}`));
					fs.rmSync(path.join(rootDir, `admission.stale-${randomUUID()}`), { recursive: true, force: true });
				} catch (reclaimError) {
					if ((reclaimError as NodeJS.ErrnoException).code !== "ENOENT") return LOCK_UNAVAILABLE;
				}
				continue;
			}
			await new Promise<void>((resolve) => {
				setTimeout(resolve, ADMISSION_LOCK_RETRY_MS).unref?.();
			});
		}
	}
	return LOCK_UNAVAILABLE;
}

export interface AgentActivityLeaseInput {
	kind: AgentCapacityKind;
	label: string;
	/** Pool the lease competes in. `null` means unlimited, so the owner always claims a slot. */
	limit?: number | null;
	runId?: string;
	sessionId?: string;
	idleAfterMs?: number;
	rootDir?: string;
	heartbeatMs?: number;
	now?: () => number;
}

/**
 * One agent's claim on the pool, driven by that agent's own events.
 *
 * The contract callers need: a lease may stop holding capacity at any moment —
 * the pool filled, the tool ran long, another process died — and nothing a
 * caller does may depend on the slot still being there. `release()` is terminal
 * and idempotent; a released lease records nothing further.
 */
export interface AgentActivityLease {
	/** Feed one agent or tool event. Never throws; unknown events are ignored. */
	drive(event: AgentCapacityEvent): void;
	/** Terminal: stop counting, stop refreshing, remove the lease. Idempotent. */
	release(): void;
}

/** Returned instead of a real lease when no cap is configured, so callers need no guard. */
const UNLIMITED_LEASE: AgentActivityLease = Object.freeze({
	drive() {},
	release() {},
});

/**
 * Keeps one lease in step with one agent's loop. Feed it the agent's lifecycle
 * and tool events; it decides whether that agent currently occupies the model.
 */
export function createAgentActivityLease(input: AgentActivityLeaseInput): AgentActivityLease {
	const rootDir = input.rootDir ?? AGENT_CAPACITY_DIR;
	const heartbeatMs = input.heartbeatMs ?? AGENT_CAPACITY_HEARTBEAT_MS;
	const idleAfterMs = input.idleAfterMs ?? DEFAULT_AGENT_MODEL_IDLE_AFTER_MS;
	const limit = input.limit ?? null;
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
	let released = false;
	/** Open tool calls by id, mapped to when each began. */
	const openTools = new Map<string, number>();
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let blockTimer: ReturnType<typeof setTimeout> | undefined;

	const persist = (): void => {
		if (released) return;
		try {
			writeOccupant(rootDir, { ...base, active, lastSeenAt: now() });
			exists = true;
		} catch {
			// A missing directory is the only recoverable cause, and the only reason
			// to pay for a mkdir: the happy path writes straight through.
			try {
				ensureCapacityRoot(rootDir);
				writeOccupant(rootDir, { ...base, active, lastSeenAt: now() });
				exists = true;
			} catch {
				// A lease that cannot be written must not break the agent it describes.
			}
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
		const occupants = tryReadOccupants(rootDir, now);
		if (!occupants) return true;
		return occupants.filter((occupant) => occupant.active).length < limit;
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
		if (blockedOnTool()) {
			active = false;
			persist();
			return;
		}
		// Returning from a long tool call reclaims capacity only when room is free;
		// live model work is never stopped for want of a slot.
		active = active || roomAvailable();
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
		drive(event) {
			if (released) return;
			switch (event.type) {
				case "agent_start":
				case "auto_retry_start":
					running = true;
					evaluate();
					return;
				case "agent_end":
				case "agent_settled":
					// Off the model until the next turn: stop counting, stay invisible.
					running = false;
					active = false;
					openTools.clear();
					drop();
					return;
				case "tool_execution_start":
					openTools.set(event.toolCallId ?? event.type!, now());
					armBlockTimer();
					return;
				case "tool_execution_end":
					openTools.delete(event.toolCallId ?? event.type!);
					evaluate();
					armBlockTimer();
					return;
				default:
					return;
			}
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
	};
}

/**
 * The lease for a parent pi session.
 *
 * A parent competes against no limit — it is never gated — but it still holds a
 * slot while it works the model, so children can see the room a busy parent
 * takes. With no cap configured it is inert and nothing is written.
 */
export function createParentActivityLease(input: { label: string; sessionId?: string }): AgentActivityLease {
	const settings = resolveAgentCapacity();
	if (settings.limit === null) return UNLIMITED_LEASE;
	return createAgentActivityLease({
		kind: "parent",
		label: input.label,
		limit: null,
		idleAfterMs: settings.idleAfterMs,
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
	});
}

export interface AcquireAgentCapacityInput {
	label: string;
	runId?: string;
	sessionId?: string;
	signal?: AbortSignal;
	/** Called on each poll while the launch waits, so the caller can report why it is idle. */
	onWait?: (snapshot: AgentCapacitySnapshot, waitedMs: number) => void;
	/**
	 * Pool to compete in, resolved from the config file when omitted. Passing it
	 * pins the pool for a test; production callers never do.
	 */
	settings?: ResolvedAgentCapacity;
	/** Test seams: the queue poll interval and the pool directory. */
	pollMs?: number;
	rootDir?: string;
}

/**
 * Takes one slot for a child that is about to start, waiting while the pool is
 * full. Throws `AgentCapacityUnavailableError` once the queue deadline passes
 * and rejects on abort, so a cancelled parent never leaves a queued child.
 *
 * With no cap configured this returns an inert lease without touching the
 * filesystem, so an uncapped machine pays nothing and callers need no guard.
 */
export async function acquireAgentCapacitySlot(input: AcquireAgentCapacityInput): Promise<AgentActivityLease> {
	const settings = input.settings ?? resolveAgentCapacity();
	if (settings.limit === null) return UNLIMITED_LEASE;
	const limit = settings.limit;
	const rootDir = input.rootDir ?? AGENT_CAPACITY_DIR;
	const pollMs = input.pollMs ?? AGENT_CAPACITY_POLL_MS;
	const startedAt = Date.now();
	const claim = (): AgentActivityLease | undefined => {
		const occupants = tryReadOccupants(rootDir, Date.now);
		if (occupants && occupants.filter((occupant) => occupant.active).length >= limit) return undefined;
		const lease = createAgentActivityLease({
			kind: "child",
			label: input.label,
			limit,
			runId: input.runId,
			sessionId: input.sessionId,
			idleAfterMs: settings.idleAfterMs,
			rootDir,
		});
		// Claimed inside the lock so the count above stays true for the winner.
		lease.drive({ type: "agent_start" });
		return lease;
	};
	for (;;) {
		if (input.signal?.aborted) throw new Error("Subagent launch was cancelled while it waited for agent capacity.");
		const outcome = await withAdmissionLock(rootDir, claim);
		const lease = outcome === LOCK_UNAVAILABLE ? claim() : outcome;
		if (lease) return lease;
		const waitedMs = Date.now() - startedAt;
		if (waitedMs >= settings.queueTimeoutMs) {
			throw new AgentCapacityUnavailableError(readAgentCapacitySnapshot(limit, { rootDir }), waitedMs);
		}
		input.onWait?.(readAgentCapacitySnapshot(limit, { rootDir }), waitedMs);
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
