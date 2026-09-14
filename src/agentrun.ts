/**
 * What a background agent run turned into, written by the container that ran it.
 *
 * **Why this exists at all.** `berth_agent_runs` is created by the dashboard the
 * instant somebody presses a button, and capture arrives minutes later over
 * `/v1/ingest` carrying no idea which run asked for it. Neither end can join the
 * two: the ingest path sees a session, the run row sees a prompt, and nothing
 * relates them. The container is the only party that knows both, so it says so.
 *
 * **The org comes from the device token and never from the caller.** Every update
 * below is scoped by `org_id` in the same statement as the run id, so a run id
 * from another tenant matches nothing — which is why the route can answer 404 for
 * "not yours" without leaking whether it exists.
 *
 * **Terminal states are not overwritten.** A run that already reported `done`
 * must not be walked back to `running` by a retry, a duplicate delivery, or a
 * second container started from the same call. The guard is in the `where`, not
 * in a read-then-write, because two containers reporting at once would both pass
 * a check made a statement earlier.
 */

import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "./db.js";
import { agentRuns, AGENT_RUN_STATES, type AgentRunState } from "./schema.js";

/** What a container may say about its own run. Every field optional but `state`. */
export interface AgentRunReport {
	state?: AgentRunState;
	sessionId?: string;
	branch?: string;
	prUrl?: string;
	prNumber?: number;
	error?: string;
}

/** The states a run does not move out of. */
const TERMINAL: readonly string[] = ["done", "no_changes", "failed"];

/**
 * Record a run's outcome. Returns false when nothing matched — wrong org, no such
 * run, or a run that had already finished.
 *
 * Fields absent from the report are left alone rather than nulled: a container
 * reporting `no_changes` sends no `prUrl`, and treating that as "clear the pull
 * request" would erase a link on a retry.
 */
export async function reportAgentRun(
	db: Executor,
	orgId: string,
	runId: string,
	report: AgentRunReport,
): Promise<boolean> {
	const values: Record<string, unknown> = {};
	if (report.state) values.state = report.state;
	if (report.sessionId) values.sessionId = report.sessionId;
	if (report.branch) values.branch = report.branch;
	if (report.prUrl) values.prUrl = report.prUrl;
	if (typeof report.prNumber === "number") values.prNumber = report.prNumber;
	if (report.error) values.error = report.error.slice(0, 4000);
	if (report.state && TERMINAL.includes(report.state)) values.finishedAt = new Date();
	// A report with nothing in it is not an error and not a write. Answering true
	// keeps a container that sent an empty body from retrying forever.
	if (Object.keys(values).length === 0) return true;

	const rows = await db
		.update(agentRuns)
		.set(values)
		.where(and(
			eq(agentRuns.orgId, orgId),
			eq(agentRuns.id, runId),
			// Terminal runs are settled. Checked here rather than read first, because
			// two containers reporting at once would both pass a check made a
			// statement earlier and the later one would win by accident.
			sql`${agentRuns.state} not in ('done','no_changes','failed')`,
		))
		.returning({ id: agentRuns.id });

	return rows.length > 0;
}

/** Re-exported so the HTTP layer validates against one list. */
export { AGENT_RUN_STATES };
