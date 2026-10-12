import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "./agent-dir.ts";
import {
	resolveAgentCapacityQueueTimeoutMs,
	resolveAgentModelIdleAfterMs,
	resolveMaxActiveAgents,
} from "./agent-capacity.ts";

/**
 * Pool settings as this process measures them.
 *
 * The pool only means something if every pi process on the machine measures it
 * the same way, so each one reads the same user config file instead of relying
 * on launch plumbing to forward the cap through every async, workflow, and
 * resume path. This lives apart from `agent-capacity.ts` so the pool itself stays
 * free of config and filesystem-adjacent imports.
 */
export interface ResolvedAgentCapacity {
	/** `null` means unlimited: the pool stays off and no lease is ever written. */
	limit: number | null;
	idleAfterMs: number;
	queueTimeoutMs: number;
}

let cachedCapacity: ResolvedAgentCapacity | undefined;

/** An unreadable or invalid config means unlimited, the same as an unset cap. */
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

/** Test seam: forget the cached pool settings. */
export function resetAgentCapacityCache(): void {
	cachedCapacity = undefined;
}
