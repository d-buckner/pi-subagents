import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "./agent-dir.ts";

/**
 * What the agent-capacity knobs mean, and what this process measured them as.
 *
 * The capacity pool only means something if every pi process on the machine
 * counts it the same way, so each one reads the same user config file rather
 * than relying on launch plumbing to forward the cap through every async,
 * workflow, and resume path. This module is a leaf: it knows about the config
 * file and nothing about the pool, so `agent-capacity.ts` can depend on it
 * without a cycle.
 */

/** How long a tool call may run before its agent counts as waiting, not working. */
export const DEFAULT_AGENT_MODEL_IDLE_AFTER_MS = 30_000;
export const MIN_AGENT_MODEL_IDLE_AFTER_MS = 5_000;
export const MAX_AGENT_MODEL_IDLE_AFTER_MS = 10 * 60_000;
/** How long a child waits for capacity before its launch fails. */
export const DEFAULT_AGENT_CAPACITY_QUEUE_TIMEOUT_MS = 30 * 60_000;
export const MIN_AGENT_CAPACITY_QUEUE_TIMEOUT_MS = 1_000;
export const MAX_AGENT_CAPACITY_QUEUE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface ResolvedAgentCapacity {
	/** `null` means unlimited: the pool stays off and no lease is ever written. */
	limit: number | null;
	idleAfterMs: number;
	queueTimeoutMs: number;
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

let cachedCapacity: ResolvedAgentCapacity | undefined;

/**
 * The pool settings for this process, read once from the user config file.
 *
 * An unreadable or invalid config means unlimited, the same as an unset cap: the
 * pool is an optimisation, so nothing about it may block a launch.
 */
export function resolveAgentCapacity(configPath = path.join(getAgentDir(), "extensions", "subagent", "config.json")): ResolvedAgentCapacity {
	if (cachedCapacity) return cachedCapacity;
	let capacity: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const configured = (parsed as { capacity?: unknown }).capacity;
			if (configured && typeof configured === "object" && !Array.isArray(configured)) capacity = configured as Record<string, unknown>;
		}
	} catch {
		// No config file, or an unreadable one: the pool stays off.
	}
	cachedCapacity = {
		limit: resolveMaxActiveAgents(capacity.maxActiveAgents) ?? null,
		idleAfterMs: resolveAgentModelIdleAfterMs(capacity.modelIdleAfterMs),
		queueTimeoutMs: resolveAgentCapacityQueueTimeoutMs(capacity.queueTimeoutMs),
	};
	return cachedCapacity;
}

/**
 * Test seam only: nothing in production changes the cap mid-process, which is
 * what makes one process measure the pool one consistent way.
 */
export function resetAgentCapacityCache(): void {
	cachedCapacity = undefined;
}
