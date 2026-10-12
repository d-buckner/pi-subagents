import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	acquireAgentCapacitySlot,
	AgentCapacityUnavailableError,
	createAgentActivityLease,
	driveAgentActivityLease,
	formatAgentCapacity,
	readAgentCapacityOccupants,
	readAgentCapacitySnapshot,
	resolveAgentCapacityQueueTimeoutMs,
	resolveAgentModelIdleAfterMs,
	resolveMaxActiveAgents,
} from "../../src/shared/agent-capacity.ts";
import { resetAgentCapacityCache, resolveAgentCapacity } from "../../src/shared/agent-capacity-settings.ts";

function capacityRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agent-capacity-"));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeLease(rootDir: string, occupant: Record<string, unknown>): string {
	fs.mkdirSync(rootDir, { recursive: true });
	const key = String(occupant.key);
	fs.writeFileSync(path.join(rootDir, `${key}.json`), `${JSON.stringify({ version: 1, active: true, ...occupant })}\n`, "utf-8");
	return key;
}

/** A lease owned by a live process, so liveness checks keep it counted. */
function foreignLease(rootDir: string, key: string, overrides: Record<string, unknown> = {}): string {
	return writeLease(rootDir, {
		key,
		kind: "child",
		label: "foreign",
		pid: process.pid,
		hostname: os.hostname(),
		claimedAt: Date.now(),
		lastSeenAt: Date.now(),
		...overrides,
	});
}

function lease(rootDir: string, overrides: Parameters<typeof createAgentActivityLease>[0] = {}) {
	return createAgentActivityLease({ kind: "parent", label: "test", rootDir, heartbeatMs: 5, ...overrides });
}

describe("resolveAgentCapacity", () => {
	function writeConfig(rootDir: string, contents: string): string {
		const configPath = path.join(rootDir, "config.json");
		fs.writeFileSync(configPath, contents, "utf-8");
		return configPath;
	}

	it("reads the cap and tuning from the user config file", () => {
		resetAgentCapacityCache();
		const rootDir = capacityRoot();
		const configPath = writeConfig(rootDir, JSON.stringify({ capacity: { maxActiveAgents: 3, modelIdleAfterMs: 45_000, queueTimeoutMs: 60_000 } }));
		assert.deepEqual(resolveAgentCapacity(configPath), { limit: 3, idleAfterMs: 45_000, queueTimeoutMs: 60_000 });
	});

	it("treats a missing or malformed config as unlimited", () => {
		resetAgentCapacityCache();
		const rootDir = capacityRoot();
		assert.deepEqual(resolveAgentCapacity(path.join(rootDir, "absent.json")), { limit: null, idleAfterMs: 30_000, queueTimeoutMs: 30 * 60_000 });
		const configPath = writeConfig(rootDir, "{ not json");
		assert.equal(resolveAgentCapacity(configPath).limit, null);
	});

	it("caches the first read until the cache is reset", () => {
		resetAgentCapacityCache();
		const rootDir = capacityRoot();
		const configPath = writeConfig(rootDir, JSON.stringify({ capacity: { maxActiveAgents: 2 } }));
		assert.equal(resolveAgentCapacity(configPath).limit, 2);
		fs.writeFileSync(configPath, JSON.stringify({ capacity: { maxActiveAgents: 9 } }), "utf-8");
		assert.equal(resolveAgentCapacity(configPath).limit, 2, "one process measures the pool one way");
		resetAgentCapacityCache();
		assert.equal(resolveAgentCapacity(configPath).limit, 9);
		resetAgentCapacityCache();
	});
});

describe("resolveMaxActiveAgents", () => {
	it("treats unset, zero, negative, and non-integer values as unlimited", () => {
		for (const value of [undefined, null, 0, -1, 1.5, "3", NaN, Infinity]) {
			assert.equal(resolveMaxActiveAgents(value), undefined, `expected unlimited for ${String(value)}`);
		}
	});

	it("accepts a positive integer cap", () => {
		assert.equal(resolveMaxActiveAgents(3), 3);
	});
});

describe("capacity tuning resolution", () => {
	it("falls back for out-of-range tuning values", () => {
		assert.equal(resolveAgentModelIdleAfterMs(undefined), 30_000);
		assert.equal(resolveAgentModelIdleAfterMs(1), 30_000);
		assert.equal(resolveAgentModelIdleAfterMs(60_000), 60_000);
		assert.equal(resolveAgentCapacityQueueTimeoutMs("nope"), 30 * 60_000);
		assert.equal(resolveAgentCapacityQueueTimeoutMs(5_000), 5_000);
	});
});

describe("agent activity leases", () => {
	it("claims capacity while the agent works the model", () => {
		const rootDir = capacityRoot();
		const slot = lease(rootDir);
		try {
			slot.markRunning();
			assert.equal(slot.isHolding(), true);
			const snapshot = readAgentCapacitySnapshot(3, rootDir);
			assert.equal(snapshot.used, 1);
			assert.equal(snapshot.remaining, 2);
			assert.equal(snapshot.occupants[0]?.kind, "parent");
		} finally {
			slot.release();
		}
		assert.equal(readAgentCapacityOccupants(rootDir).length, 0);
	});

	it("refuses to claim a slot when the pool is already full", () => {
		const rootDir = capacityRoot();
		foreignLease(rootDir, "full-1");
		foreignLease(rootDir, "full-2");
		const slot = lease(rootDir, { limit: 2 });
		try {
			slot.markRunning();
			assert.equal(slot.isHolding(), false);
			assert.equal(readAgentCapacitySnapshot(2, rootDir).used, 2);
		} finally {
			slot.release();
		}
	});

	it("releases capacity once a tool call outlives the model-idle grace", async () => {
		const rootDir = capacityRoot();
		const slot = lease(rootDir, { idleAfterMs: 20 });
		try {
			slot.markRunning();
			slot.toolStarted("build");
			assert.equal(slot.isHolding(), true, "a short tool call keeps the slot");
			await sleep(80);
			assert.equal(slot.isHolding(), false, "a long tool call releases the slot");
			assert.equal(readAgentCapacitySnapshot(3, rootDir).used, 0);
			assert.equal(readAgentCapacitySnapshot(3, rootDir).waiting, 1, "the waiting agent stays visible");
		} finally {
			slot.release();
		}
	});

	it("reclaims capacity when the agent returns to model work", async () => {
		const rootDir = capacityRoot();
		const slot = lease(rootDir, { idleAfterMs: 20 });
		try {
			slot.markRunning();
			slot.toolStarted("build");
			await sleep(80);
			assert.equal(slot.isHolding(), false);
			slot.toolEnded("build");
			assert.equal(slot.isHolding(), true);
		} finally {
			slot.release();
		}
	});

	it("lets a resuming agent run uncounted when the pool filled while it waited", async () => {
		const rootDir = capacityRoot();
		const slot = lease(rootDir, { idleAfterMs: 20, limit: 1 });
		try {
			slot.markRunning();
			slot.toolStarted("build");
			await sleep(80);
			assert.equal(slot.isHolding(), false);
			foreignLease(rootDir, "took-the-slot");
			slot.toolEnded("build");
			assert.equal(slot.isHolding(), false, "reclaim waits for room instead of overshooting");
		} finally {
			slot.release();
		}
	});

	it("drops the lease when the turn ends", () => {
		const rootDir = capacityRoot();
		const slot = lease(rootDir);
		slot.markRunning();
		slot.markIdle();
		assert.equal(slot.isHolding(), false);
		assert.equal(readAgentCapacityOccupants(rootDir).length, 0);
		slot.release();
	});
});

describe("lease liveness", () => {
	it("ignores a lease whose owner stopped refreshing", () => {
		const rootDir = capacityRoot();
		foreignLease(rootDir, "silent", { lastSeenAt: Date.now() - 60_000 });
		assert.equal(readAgentCapacityOccupants(rootDir).length, 0);
	});

	it("ignores a fresh lease whose process is gone", () => {
		const rootDir = capacityRoot();
		foreignLease(rootDir, "dead", { pid: 999_999 });
		assert.equal(readAgentCapacityOccupants(rootDir).length, 0);
	});

	it("keeps a lease from another host while its heartbeat is fresh", () => {
		const rootDir = capacityRoot();
		foreignLease(rootDir, "remote", { hostname: "somewhere-else", pid: 999_999 });
		assert.equal(readAgentCapacityOccupants(rootDir).length, 1);
	});

	it("ignores malformed and in-flight lease files", () => {
		const rootDir = capacityRoot();
		fs.mkdirSync(rootDir, { recursive: true });
		fs.writeFileSync(path.join(rootDir, "junk.json"), "not json");
		fs.writeFileSync(path.join(rootDir, "partial.json.uuid.tmp"), "");
		assert.equal(readAgentCapacityOccupants(rootDir).length, 0);
	});
});

describe("acquireAgentCapacitySlot", () => {
	it("waits for a slot and takes it once capacity frees", async () => {
		const rootDir = capacityRoot();
		const blocker = lease(rootDir);
		blocker.markRunning();
		let waited = 0;
		const pending = acquireAgentCapacitySlot({
			limit: 1,
			label: "worker",
			rootDir,
			pollMs: 10,
			queueTimeoutMs: 5_000,
			onWait: () => { waited++; },
		});
		await sleep(40);
		assert.equal(waited > 0, true, "the waiter reports why it is idle");
		blocker.release();
		const slot = await pending;
		try {
			assert.equal(slot.isHolding(), true);
			assert.equal(readAgentCapacitySnapshot(1, rootDir).used, 1);
		} finally {
			slot.release();
		}
	});

	it("fails the launch once the queue deadline passes", async () => {
		const rootDir = capacityRoot();
		const blocker = lease(rootDir);
		blocker.markRunning();
		try {
			await assert.rejects(
				acquireAgentCapacitySlot({ limit: 1, label: "worker", rootDir, pollMs: 10, queueTimeoutMs: 40 }),
				(error) => error instanceof AgentCapacityUnavailableError && /Agent capacity is full/.test(error.message),
			);
		} finally {
			blocker.release();
		}
	});

	it("rejects a waiter whose launch was cancelled", async () => {
		const rootDir = capacityRoot();
		const blocker = lease(rootDir);
		blocker.markRunning();
		const controller = new AbortController();
		const pending = acquireAgentCapacitySlot({ limit: 1, label: "worker", rootDir, pollMs: 10, signal: controller.signal });
		await sleep(20);
		controller.abort();
		await assert.rejects(pending, /cancelled while it waited/);
		blocker.release();
	});

	it("never lets two launches share the last slot", async () => {
		const rootDir = capacityRoot();
		const results = await Promise.allSettled([
			acquireAgentCapacitySlot({ limit: 1, label: "a", rootDir, pollMs: 5, queueTimeoutMs: 300 }),
			acquireAgentCapacitySlot({ limit: 1, label: "b", rootDir, pollMs: 5, queueTimeoutMs: 300 }),
		]);
		const won = results.filter((result) => result.status === "fulfilled");
		assert.equal(won.length, 1, "exactly one launch may take the last slot");
		for (const result of won) (result as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireAgentCapacitySlot>>>).value.release();
	});
});

describe("driveAgentActivityLease", () => {
	it("follows the agent and tool events of a child stream", () => {
		const rootDir = capacityRoot();
		const slot = lease(rootDir, { idleAfterMs: 60_000 });
		try {
			driveAgentActivityLease(slot, { type: "agent_start" });
			assert.equal(slot.isHolding(), true);
			driveAgentActivityLease(slot, { type: "tool_execution_start", toolCallId: "t1" });
			assert.equal(slot.isHolding(), true);
			driveAgentActivityLease(slot, { type: "tool_execution_end", toolCallId: "t1" });
			driveAgentActivityLease(slot, { type: "agent_settled" });
			assert.equal(slot.isHolding(), false);
			driveAgentActivityLease(slot, { type: "message_update" });
			driveAgentActivityLease(slot, { type: "agent_start" });
			assert.equal(slot.isHolding(), true);
		} finally {
			slot.release();
		}
	});
});

describe("formatAgentCapacity", () => {
	it("states the cap when one is configured and says unlimited when it is not", () => {
		assert.match(formatAgentCapacity(readAgentCapacitySnapshot(3, capacityRoot())), /3 in use, 3 free/);
		assert.match(formatAgentCapacity(readAgentCapacitySnapshot(undefined, capacityRoot())), /unlimited/);
	});
});
