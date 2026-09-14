import "server-only";

/**
 * Starting a background agent, and reading what the running ones are doing.
 *
 * **The shared secret never reaches the browser, and that is the whole reason
 * this is a procedure rather than a `fetch` from a form.** `BERTH_AGENT_SECRET`
 * authenticates the Modal endpoint, and an endpoint that runs a coding agent is
 * somebody else's compute budget: anything holding that string can spend it. It
 * is read here, server-side, from an environment variable that is not
 * `NEXT_PUBLIC_`, so a client bundle cannot contain it even by accident.
 *
 * **`start` records the row before it calls Modal, and that order is deliberate.**
 * Modal answers with a call id and then the container runs for minutes. If the
 * row were written afterwards, a request that reached Modal and then lost the
 * response would leave an agent working on a repository with nothing in the
 * ledger to say so — the run would be invisible and un-cancellable. Written
 * first, the worst case is a `queued` row whose call never happened, which is
 * visible, and which says exactly what went wrong in `error`.
 *
 * **Nothing here accepts an `orgId`.** `ctx.db` is `forOrg(membership.orgId)` and
 * applies the filter by construction — see `~/server/db/scope`. A tRPC procedure
 * is a public endpoint, so an org id that arrives as an argument is one the
 * caller chose.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { desc, eq, isNotNull, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { orgProcedure, router } from "../init";
import { agentRuns } from "~/server/db/schema";
import type { OrgDb } from "~/server/db/scope";
// Imported rather than copied. The vocabulary belongs to the kernel, which
// writes these rows from the container's report-back too, and a second list here
// is a second thing to widen — `~/lib/roles.ts` is the one that goes the other
// way, and its header says why.
import { AGENT_RUN_STATES } from "@berth/schema";
import { isLive } from "~/server/source";
// Through `~/server/github/app` rather than `@berth/github-env` directly: that
// file is the one place in `core/src` that reads the App private key, and
// `app.test.ts` fails if a second one does. A key that mints for every
// customer's installation is worth keeping to one import.
import { appCreds as appCredentials } from "~/server/github/app";
import { tokenForRepo } from "@berth/github-app";
import { githubIdentity } from "~/server/github/identity";

/** Where the Modal app publishes its trigger, and the secret it checks. */
function modalConfig(): { url: string; secret: string } | null {
  const url = process.env.BERTH_AGENT_URL?.trim();
  const secret = process.env.BERTH_AGENT_SECRET?.trim();
  return url && secret ? { url, secret } : null;
}

export const agentRunSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  state: z.enum(AGENT_RUN_STATES),
  sessionId: z.string().nullable(),
  prUrl: z.string().nullable(),
  prNumber: z.number().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
});

export type AgentRun = z.infer<typeof agentRunSchema>;

export const agentsRouter = router({
  /**
   * Is this dashboard able to start one at all?
   *
   * Separate from `start` so a page can render the reason instead of a disabled
   * button with no explanation. Three different things stop a run — no ledger, no
   * Modal configuration, nothing installed on GitHub — and they have three
   * different fixes.
   */
  capability: orgProcedure
    .output(z.object({ canStart: z.boolean(), reason: z.string().nullable() }))
    .query(() => {
      if (!isLive()) {
        return { canStart: false, reason: "This dashboard is reading the frozen capture, so there is no ledger to record a run in." };
      }
      if (!modalConfig()) {
        return { canStart: false, reason: "No agent runner is configured. Set BERTH_AGENT_URL and BERTH_AGENT_SECRET to the deployed Modal endpoint." };
      }
      return { canStart: true, reason: null };
    }),

  /**
   * The runs, newest first — the live ones by default.
   *
   * `archived` is a *view*, not a filter that can be widened to "both": a list
   * mixing filed-away rows with live ones is the state archiving exists to
   * avoid, and having to switch views is what makes an archive feel archived.
   */
  list: orgProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(100).default(25),
        archived: z.boolean().default(false),
      }).optional(),
    )
    .output(z.array(agentRunSchema))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .from(agentRuns, input?.archived ? isNotNull(agentRuns.archivedAt) : isNull(agentRuns.archivedAt))
        .orderBy(desc(agentRuns.createdAt))
        .limit(input?.limit ?? 25);
      return rows.map(toRun);
    }),

  /**
   * File a run away, or put it back.
   *
   * **It sets a timestamp and deletes nothing.** A run row is where a branch
   * called `berth/…` came from and which pull request it opened; deleting it to
   * tidy a list would take that explanation with it, and the person who needs it
   * is the reviewer six weeks later who did not start the run.
   *
   * Archiving a run in flight is allowed. Somebody who has decided a run does
   * not matter should not have to wait for it to finish to say so — it keeps
   * running and reports back exactly as before, because `reportAgentRun` writes
   * by id and never reads this column.
   */
  archive: orgProcedure
    .input(z.object({ id: z.string().uuid(), archived: z.boolean().default(true) }))
    .output(agentRunSchema)
    .mutation(async ({ ctx, input }) => {
      // The id is another condition on the same statement as the org filter, so
      // an id from another tenant updates nothing rather than a row.
      const [row] = await ctx.db
        .update(agentRuns, { archivedAt: input.archived ? new Date() : null }, eq(agentRuns.id, input.id))
        .returning();
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "No such run." });
      return toRun(row);
    }),

  get: orgProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(agentRunSchema.nullable())
    .query(async ({ ctx, input }) => {
      // The id is an extra condition on the *same* statement as the org filter,
      // so an id from another tenant matches nothing rather than reading a row.
      const [row] = await ctx.db.from(agentRuns, eq(agentRuns.id, input.id)).limit(1);
      return row ? toRun(row) : null;
    }),

  /**
   * The run that owns a session id, if any.
   *
   * **This is what stops a just-started run 404ing.** The browser now goes to
   * `/sessions/<id>` the moment `start` returns, and capture does not exist yet
   * — the container has not run. `sessions.detail` correctly answers null, and
   * the page asks this instead: a run in `queued` or `running` is a session that
   * is *about* to exist, and saying so is better than "not found" for something
   * the reader started four seconds ago.
   */
  bySession: orgProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .output(agentRunSchema.nullable())
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .from(agentRuns, eq(agentRuns.sessionId, input.sessionId))
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);
      return row ? toRun(row) : null;
    }),

  start: orgProcedure
    .input(
      z.object({
        prompt: z.string().trim().min(1, "Say what the agent should do.").max(4000),
        /**
         * `owner/name`. **Required** — every run names a repository.
         *
         * The scratch run it used to be optional for is gone: it produced a diff
         * against a throwaway `utils.py`, could not open a pull request, and was
         * reachable from the picker as an item somebody could choose by mistake.
         * `task.sh` refuses an unset `BERTH_REPO` at its first line, and this is
         * the same refusal one process earlier, where it can be a message rather
         * than a container exit.
         *
         * Validated as a slug rather than trusted: it is interpolated into a
         * clone URL inside the container, and a value that is not a slug is a
         * value that could be something else entirely.
         */
        repo: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/, "Expected owner/name."),
        base: z.string().trim().max(200).optional(),
        /**
         * A session to pick up from, rather than starting cold.
         *
         * The container passes it to `claude --resume`, so the agent arrives with
         * the conversation that produced it instead of re-deriving the context
         * from a prompt describing it. That is the whole reason a chat on a
         * session is worth more than a second cold run: the expensive part of an
         * agent's first minute is reading what somebody already read.
         */
        resumeSessionId: z.string().trim().min(1).max(200).optional(),
      }),
    )
    .output(agentRunSchema)
    .mutation(async ({ ctx, input }) => {
      const modal = modalConfig();
      if (!modal) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No agent runner is configured. Set BERTH_AGENT_URL and BERTH_AGENT_SECRET.",
        });
      }

      /**
       * **The session is named here, not discovered later.**
       *
       * `session_id` used to be null until the container finished and reported
       * back, which meant the run had nowhere to go for the whole time somebody
       * was waiting: `/agents` could show a row, and that was all. Minting the id
       * before the call gives the run a URL that exists the moment it does, so
       * the browser opens the conversation and watches it fill in.
       *
       * It is safe because the id is *ours* either way — `task.sh` generated one
       * itself before this, so nothing downstream is being overruled, and a
       * resumed run keeps the session it is resuming.
       */
      const sessionId = input.resumeSessionId ?? randomUUID();

      // Recorded before the call, so a request that reaches Modal and loses the
      // response still leaves something on screen. See this file's header.
      const [row] = await ctx.db
        .insert(agentRuns, {
          requestedBy: ctx.org.engineerId,
          prompt: input.prompt,
          repo: input.repo,
          baseRef: input.base ?? null,
          sessionId,
          state: "queued",
        })
        .returning();

      if (!row) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The run was not recorded." });
      }

      // Minted here, by the half that holds the App private key, and scoped to the
      // one repository this run named. The container never sees the key and could
      // not widen the grant if it tried.
      //
      // The alternative — the container asking berth for a token with its device
      // token — would let any device token mint GitHub credentials for any
      // repository, which is the narrowing undone. The dashboard deciding is the
      // version where "scoped to one repo for an hour" means something.
      const creds = appCredentials();
      if (!creds) {
        return await fail(ctx.db, row.id, "no GitHub App is configured, so no repository token could be minted");
      }
      const minted = await tokenForRepo(input.repo).catch(() => null);
      if (!minted) {
        return await fail(
          ctx.db, row.id,
          `berth's GitHub App is not installed on ${input.repo}, or that repository is not selected`,
        );
      }
      const ghToken = minted.token;

      /**
       * Who this run commits as.
       *
       * Resolved here rather than in the container, because the container has no
       * session and must never be given one — the whole shape of this system is
       * that the dashboard holds the credentials and hands the agent the narrow
       * results. An unlinked person is not an error: the run proceeds and the
       * commits carry berth's name, which is what happened before this existed.
       */
      const author = await githubIdentity(ctx.org.betterAuthUserId ?? "").catch(
        () => ({ linked: false }) as const,
      );

      try {
        const res = await fetch(modal.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            secret: modal.secret,
            prompt: input.prompt,
            run_id: row.id,
            repo: input.repo,
            gh_token: ghToken,
            session_id: sessionId,
            ...(author.linked
              ? {
                  git_author_name: author.name,
                  git_author_email: author.email,
                  github_login: author.login,
                }
              : {}),
            ...(input.base ? { base: input.base } : {}),
            ...(input.resumeSessionId ? { resume_session_id: input.resumeSessionId } : {}),
          }),
          // A trigger that spawns and returns should answer in a second. Holding
          // longer than this means something is wrong with the endpoint, not that
          // the agent is thinking — the agent has not started yet.
          signal: AbortSignal.timeout(30_000),
        });

        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 300);
          return await fail(ctx.db, row.id, `the runner refused: ${res.status} ${detail}`);
        }

        const body = await res.json().catch(() => null) as { call_id?: string } | null;
        const [updated] = await ctx.db
          .update(
            agentRuns,
            { modalCallId: body?.call_id ?? null, state: "running", startedAt: new Date() },
            eq(agentRuns.id, row.id),
          )
          .returning();
        return toRun(updated ?? row);
      } catch (error) {
        // The row survives the failure carrying the reason. A thrown error with
        // no row would lose both the request and the explanation.
        return await fail(ctx.db, row.id, error instanceof Error ? error.message : String(error));
      }
    }),
});

/** Mark a run failed and hand the row back, so the caller renders a run rather than an exception. */
async function fail(db: OrgDb, id: string, detail: string): Promise<AgentRun> {
  const [row] = await db
    .update(agentRuns, { state: "failed", error: detail, finishedAt: new Date() }, eq(agentRuns.id, id))
    .returning();
  if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: detail });
  return toRun(row);
}

function toRun(row: typeof agentRuns.$inferSelect): AgentRun {
  return {
    id: row.id,
    prompt: row.prompt,
    repo: row.repo,
    branch: row.branch,
    // Widened at the boundary rather than trusted: `state` is a text column, and
    // a row written by an older client could carry a word this build does not
    // know. Unknown reads as `failed` — the safe direction for a status.
    state: (AGENT_RUN_STATES as readonly string[]).includes(row.state)
      ? (row.state as AgentRun["state"])
      : "failed",
    sessionId: row.sessionId,
    prUrl: row.prUrl,
    prNumber: row.prNumber,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}
