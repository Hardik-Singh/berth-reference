/**
 * What a container is allowed to say about its own run.
 *
 * Three properties are worth a database rather than a mock, because all three are
 * enforced by the `where` clause rather than by code a mock would run:
 *
 *   1. **The org filter is in the same statement as the id.** A run id from
 *      another tenant has to match nothing — not throw, not 403, *match nothing* —
 *      which is what lets the route answer 404 without leaking existence.
 *   2. **Terminal runs are settled.** The guard is in the statement precisely so
 *      that two containers reporting at once cannot both pass a check made a
 *      moment earlier. A read-then-write would pass this test and fail in
 *      production.
 *   3. **Absent fields are left alone.** A container reporting `no_changes` sends
 *      no `prUrl`, and treating absence as "clear it" would erase a link on a
 *      retry.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ORG, closeTestDb, testDb, truncateAll } from "./test-db.js";
import { reportAgentRun } from "./agentrun.js";
import { agentRuns } from "./schema.js";

const db = await testDb();
beforeEach(() => truncateAll(db));
afterAll(() => closeTestDb());

const OTHER_ORG = "11111111-1111-1111-1111-111111111111";

/** A run in flight, which is the only state a report may move. */
async function running(orgId: string = ORG): Promise<string> {
	const [row] = await db
		.insert(agentRuns)
		.values({ orgId, prompt: "add a docstring", state: "running" })
		.returning({ id: agentRuns.id });
	return row!.id;
}

const read = async (id: string) => {
	const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
	return row!;
};

describe("reportAgentRun", () => {
	it("records the session, branch and pull request together", async () => {
		const id = await running();
		expect(await reportAgentRun(db, ORG, id, {
			state: "done",
			sessionId: "sess-1",
			branch: "berth/agent-1",
			prUrl: "https://github.com/o/r/pull/7",
			prNumber: 7,
		})).toBe(true);

		const row = await read(id);
		expect(row.state).toBe("done");
		expect(row.sessionId).toBe("sess-1");
		expect(row.branch).toBe("berth/agent-1");
		expect(row.prUrl).toBe("https://github.com/o/r/pull/7");
		expect(row.prNumber).toBe(7);
		// Stamped by the terminal state, not by the caller — a container's clock is
		// not the one the dashboard sorts by.
		expect(row.finishedAt).not.toBeNull();
	});

	it("leaves a run in another org untouched, and says so by matching nothing", async () => {
		const id = await running(OTHER_ORG);
		expect(await reportAgentRun(db, ORG, id, { state: "done" })).toBe(false);
		// The point: not an error, not a partial write. The row is exactly as it was.
		expect((await read(id)).state).toBe("running");
	});

	it("refuses to reopen a run that already finished", async () => {
		const id = await running();
		expect(await reportAgentRun(db, ORG, id, { state: "done", sessionId: "sess-1" })).toBe(true);
		// A duplicate delivery, a retried container, a second call from the same
		// spawn. None of them may walk it back.
		expect(await reportAgentRun(db, ORG, id, { state: "running" })).toBe(false);

		const row = await read(id);
		expect(row.state).toBe("done");
		expect(row.sessionId).toBe("sess-1");
	});

	it("treats every terminal state as settled, not just `done`", async () => {
		for (const terminal of ["done", "no_changes", "failed"] as const) {
			const id = await running();
			expect(await reportAgentRun(db, ORG, id, { state: terminal })).toBe(true);
			expect(await reportAgentRun(db, ORG, id, { state: "running" })).toBe(false);
			expect((await read(id)).state).toBe(terminal);
		}
	});

	it("leaves fields the report did not mention alone", async () => {
		const id = await running();
		await reportAgentRun(db, ORG, id, { branch: "berth/agent-2", prUrl: "https://github.com/o/r/pull/9" });
		// `no_changes` carries no pull request. Absence must not read as "clear it".
		await reportAgentRun(db, ORG, id, { state: "no_changes", sessionId: "sess-2" });

		const row = await read(id);
		expect(row.prUrl).toBe("https://github.com/o/r/pull/9");
		expect(row.branch).toBe("berth/agent-2");
		expect(row.sessionId).toBe("sess-2");
	});

	it("accepts an empty report without writing, so a retry loop terminates", async () => {
		const id = await running();
		expect(await reportAgentRun(db, ORG, id, {})).toBe(true);
		const row = await read(id);
		expect(row.state).toBe("running");
		expect(row.finishedAt).toBeNull();
	});

	it("bounds an error string rather than storing whatever a container printed", async () => {
		const id = await running();
		await reportAgentRun(db, ORG, id, { state: "failed", error: "x".repeat(10_000) });
		expect((await read(id)).error).toHaveLength(4000);
	});

	it("answers false for a run id that does not exist at all", async () => {
		expect(await reportAgentRun(db, ORG, "22222222-2222-2222-2222-222222222222", { state: "done" }))
			.toBe(false);
	});

	it("does not move a run belonging to another org even when the id is right", async () => {
		const mine = await running();
		const theirs = await running(OTHER_ORG);
		await reportAgentRun(db, ORG, theirs, { state: "failed", error: "should not land" });

		const [rows] = await db
			.select({ state: agentRuns.state })
			.from(agentRuns)
			.where(and(eq(agentRuns.id, theirs), eq(agentRuns.orgId, OTHER_ORG)));
		expect(rows!.state).toBe("running");
		expect((await read(mine)).state).toBe("running");
	});
});
