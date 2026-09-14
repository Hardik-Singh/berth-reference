/**
 * The Berth's tables, and the closed vocabularies their text columns draw
 * from.
 *
 * Table names are prefixed `berth_` because these definitions are meant to be
 * composed into a consumer's own Drizzle schema and share a database with it —
 * an unprefixed `events` is a collision waiting for its second occupant.
 *
 * Tenancy is one `org_id` uuid column per table, filtered by every read and
 * write in the kernel. The Berth does not own an orgs table — the consumer
 * does — so the column is a plain uuid, not a foreign key. Single-tenant
 * deployments use one well-known org id throughout (the CLI defaults to the nil
 * uuid).
 *
 * Closed sets over free strings: the columns are `text`, the vocabulary is an
 * `as const` array, and tests — not CHECK constraints — hold the line. Widening
 * a set is a TypeScript change every call site sees, never a migration.
 */

import { sql } from "drizzle-orm";
import {
	boolean,
	customType,
	index,
	bigint,
	integer,
	jsonb,
	pgTable,
	smallint,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * Postgres `xid8` — a 64-bit transaction id. Drizzle has no built-in for it, and
 * it is read back as a decimal string because the value outgrows a JS number.
 * Its one use is `berth_events.transaction_id`; see the note there for why.
 */
const xid8 = customType<{ data: string; driverData: string }>({
	dataType: () => "xid8",
});

// ---------------------------------------------------------------------------
// Closed sets
// ---------------------------------------------------------------------------

/**
 * Everything the ledger can say happened. Every state change the kernel makes
 * co-writes exactly one of these in the same transaction, so the log cannot
 * drift from the tables it describes.
 */
export const COORDINATION_EVENT_TYPES = [
	"claimed",
	"claim_conflict",
	"released",
	"completed",
	"lease_renewed",
	"lease_expired",
	"lease_revoked",
	"work_linked",
	"work_unlinked",
	"work_marked",
	"work_unmarked",
	"dependency_blocked",
	"signal_recorded",
	"signal_superseded",
	"artifact_saved",
] as const;

/**
 * Messaging's audit trail, kept out of the coordination set on purpose.
 *
 * The views that answer "what is the fleet doing" — `berth week`, the live
 * dashboard, the conflicts count — read the events table with a time window and
 * no type filter. Two agents having a conversation is not the fleet doing work,
 * and a chatty thread would crowd real claims out of a bounded window. So the
 * views read COORDINATION_EVENT_TYPES and the audit surfaces read both.
 *
 * This is a second line of defence, not the first: a message body never enters
 * `berth_events` at all, because `MessageSentPayload` has no field for one.
 */
export const MESSAGE_EVENT_TYPES = ["message_sent", "message_acked"] as const;

export const EVENT_TYPES = [...COORDINATION_EVENT_TYPES, ...MESSAGE_EVENT_TYPES] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type CoordinationEventType = (typeof COORDINATION_EVENT_TYPES)[number];

/**
 * What a `message_sent` event carries. Written as a type rather than an inline
 * object literal so that adding `body` here is a compile error rather than a
 * leak into every view that reads the ledger.
 */
export type MessageSentPayload = {
	message_id: string;
	thread_id: string;
	to: string;
	bytes: number;
};

/**
 * Closed set, same discipline as EVENT_TYPES. `blocks` is deliberately absent:
 * it is `depends_on` read backwards, and storing both directions would let the
 * two disagree. The symmetric members (`relates_to`, `duplicates`) are stored
 * with their scope pair normalized so one relationship is one row, not two.
 */
export const RELATION_TYPES = [
	"depends_on", // asymmetric, DAG-constrained, gates claim()
	"relates_to", // symmetric
	"duplicates", // symmetric
	"derived_from", // asymmetric
	"references", // asymmetric
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/** Symmetric relations store from<=to so a pair cannot be recorded both ways. */
export const SYMMETRIC_RELATIONS: readonly RelationType[] = ["relates_to", "duplicates"];

/**
 * A mark is a fact asserted about one scope: a free label, an outcome, a flag.
 * Coarse on purpose — detail lives in the value, not in a kind explosion.
 */
export const MARK_KINDS = ["label", "outcome", "flag"] as const;

/**
 * What a pull request is doing, as one word.
 *
 * Derived exactly once, by the writer (`github.ts:prStateOf`), and stored beside
 * the raw `merged_at` / `draft` it came from. Storing a derived value is
 * normally a smell; here it is the point. GitHub reports a merged pull request
 * as `CLOSED` with a `mergedAt`, so every reader that re-derives this has to
 * know to test merged first — and the reader that does not is a page telling
 * somebody their work was abandoned. One decider, one answer.
 */
export const PR_STATES = ["draft", "open", "merged", "closed"] as const;
export type PrState = (typeof PR_STATES)[number];

/**
 * How berth came to believe a session produced a given pull request.
 *
 * **This is the verified/unverified distinction, and it is why there is no
 * `verified boolean` column.** `linkage.ts` spends a page of its header on the
 * difference between "GitHub says this branch is the head of that PR" and "a
 * `pr-link` record was on screen during the session" — the first is a query
 * against repository state, the second is a note about what the agent happened
 * to be looking at. A boolean would collapse them. The source *is* the evidence,
 * exactly as `complete()` records `ref_source`.
 */
export const PR_LINK_SOURCES = ["branch", "transcript", "agent"] as const;
export type PrLinkSource = (typeof PR_LINK_SOURCES)[number];
export type MarkKind = (typeof MARK_KINDS)[number];

/**
 * How a census row was found.
 *
 * Two, not more, and the distinction is worth keeping: a `conductor` row carries
 * session colour — model, agent type, context occupancy — that a bare worktree
 * cannot have, so a reader that finds those columns null needs to know whether
 * that means "idle" or "we never had a source for them".
 *
 * A path found by both is `conductor`, because that is the strictly more
 * informative sighting. Conductor hands its agent a git worktree, so the two are
 * the same directory rather than two entities to reconcile.
 */
export const WORKSPACE_SOURCES = ["conductor", "worktree"] as const;

/**
 * What kind of session a captured row is.
 *
 * A closed vocabulary over a `text` column with no CHECK, held by a test rather
 * than by the database — the convention throughout this schema, so widening one
 * is a TypeScript change every call site sees rather than a migration.
 *
 * Two members and not three: a workflow subagent
 * (`…/subagents/workflows/<wf>/agent-<id>.jsonl`) is a subagent. The distinction
 * is real in the filesystem and nothing downstream has a different answer for
 * it, and a vocabulary member nothing branches on is a member somebody has to
 * keep deciding about.
 */
export const SESSION_KINDS = ["session", "subagent"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];
export type WorkspaceSource = (typeof WORKSPACE_SOURCES)[number];

/**
 * Who observed a failure — ordered by how much a reader should trust it.
 *
 * This set is the load-bearing part of the signal design. A signal is only
 * worth reading if it was written by whatever *observed* the failure: a test
 * runner's exit code, the error the process printed, the commit that reverted
 * it, the human who came along afterwards and fixed it. The moment signals
 * become "ask a model what went wrong", every scope grows a plausible-sounding
 * paragraph, readers learn to skip them, and the channel is dead.
 *
 * `agent_report` is last on purpose: it is the one source that is an account
 * rather than an artifact, so it ranks below every mechanical observation and
 * should always carry a `ref` pointing at something real.
 */
export const SIGNAL_SOURCES = [
	"human_correction", // a human fixed it afterwards and said why — highest value
	"test_failure", // a failing test: exit code and output
	"error_output", // what the run actually printed
	"revert", // the commit that undid it
	"agent_report", // an agent's own account — lowest, needs a ref
] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

/**
 * What a piece of work produced, or what produced it.
 *
 * `conversation` is first because it is the one most systems throw away: the
 * transcript that explains why the work went the way it did. Code is one kind
 * among several here, not the privileged one — a decision, a design doc and a
 * dataset are units of work with owners and reasons exactly like a diff is.
 */
export const ARTIFACT_KINDS = [
	"conversation", // a transcript — the reasoning, not just the result
	"document",
	"design",
	"decision",
	"code_change", // a PR, commit or diff
	"dataset",
	"image",
	"log",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Read order: most-trusted source first, then most recent. */
export const SIGNAL_TRUST: Record<SignalSource, number> = {
	human_correction: 0,
	test_failure: 1,
	error_output: 2,
	revert: 3,
	agent_report: 4,
};

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * The coordination primitive — a lease over a namespaced scope.
 *
 * The partial unique index is the entire mechanism: at most one active row per
 * `(org_id, scope)` with `released_at is null`. Two agents racing to claim the
 * same scope both issue an INSERT, Postgres serialises them, and exactly one
 * lands. The loser is not an error to swallow — it is a `claim_conflict` event,
 * and that event is the number a coordination plane is ultimately judged by.
 *
 * Note what the index does NOT cover: expiry. An expired-but-unreleased lease
 * still occupies the slot. That is deliberate — a partial index cannot depend
 * on `now()` — and it is why `claim()` lazily releases an expired holder inside
 * the same transaction before inserting. The sweeper is a backstop that keeps
 * the event log honest, not the thing correctness depends on.
 */
export const leases = pgTable(
	"berth_leases",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		/**
		 * What is leased, as `<namespace>:<identifier>` — the load-bearing key.
		 * The kernel never parses the part after the colon; a per-namespace
		 * `ScopeResolver` decides containment.
		 */
		scope: text("scope").notNull(),
		agentId: text("agent_id").notNull(),
		/**
		 * What the holder may do, drawn from RIGHTS. Rights never widen: `narrow()`
		 * refuses a child lease asking for a right the parent does not hold.
		 */
		rights: text("rights").array().notNull().default(sql`'{read,write}'`),
		/**
		 * The lease this one was narrowed from, if any. Self-referencing, nullable.
		 * Revoking a parent cascades to its children, and that relationship cannot
		 * be reconstructed after the fact — so the edge is recorded at mint.
		 */
		parentLeaseId: uuid("parent_lease_id").references((): AnyPgColumn => leases.id),
		/**
		 * Why this work is being done, in the claimant's own words. Required at
		 * mint. The ledger records what changed and when; the intent is the only
		 * thing that can answer why somebody started — the question asked six
		 * months later. Attached to the lease, not the work item: one scope can be
		 * claimed three times for three different reasons.
		 */
		intent: text("intent").notNull(),
		/** A spec, design doc, thread or issue URL backing that intent. */
		intentRef: text("intent_ref"),
		claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		releasedAt: timestamp("released_at", { withTimezone: true }),
		completionSummary: text("completion_summary"),
		/**
		 * What the work shipped as: the PR, the commit, the run.
		 *
		 * Also written onto the `completed` event, where the moment belongs — this column
		 * exists so the *answer* can be read without it. `completionsForScope` deliberately
		 * projects a handful of columns off this table (see `completion.ts`) to keep the
		 * "was this already done?" query bounded; recovering the ref would otherwise mean a
		 * join against `berth_events` per completion, on the hot path of every claim.
		 *
		 * Usually derived rather than typed — see `linkage.ts`. The `completed` event
		 * carries `ref_source` so a derived link is never mistaken for one an agent vouched
		 * for.
		 */
		completionRef: text("completion_ref"),
	},
	(table) => [
		// The entire race mechanism: at most one active lease per (org_id, scope).
		// claim() targets this exact partial index in its ON CONFLICT.
		uniqueIndex("one_active_lease_per_scope")
			.on(table.orgId, table.scope)
			.where(sql`${table.releasedAt} is null`),
		index("berth_leases_expiry_idx")
			.on(table.expiresAt)
			.where(sql`${table.releasedAt} is null`),
		index("berth_leases_agent_idx").on(table.orgId, table.agentId),
		index("berth_leases_parent_idx").on(table.parentLeaseId),
		// "Was this already finished?" — asked on every successful claim, so it
		// must not be a sequential scan. Partial on the completion summary because
		// that column, not `released_at`, is what distinguishes shipped work from
		// an abandoned attempt.
		index("berth_leases_completed_idx")
			.on(table.orgId, table.releasedAt)
			.where(sql`${table.completionSummary} is not null`),
	],
);

/**
 * Everything that happened. Append-only.
 *
 * Written in the same transaction as the state change it describes, so the log
 * cannot drift from reality: if a lease exists, its event exists. Keyed on
 * scope, not on a work-item id — the Berth has no work-item table; scope
 * strings are the node identity everywhere.
 */
export const events = pgTable(
	"berth_events",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		scope: text("scope"),
		agentId: text("agent_id"),
		/** One of EVENT_TYPES. */
		type: text("type").notNull(),
		payload: jsonb("payload"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		/**
		 * The transaction that wrote this row, so that "what changed since I last
		 * asked" can one day be answered without dropping rows on the floor.
		 *
		 * Nothing reads this column yet. It exists now because it cannot be added
		 * cheaply later, and because the two columns that look like they would do
		 * the job both silently would not:
		 *
		 *  - `id` is a random uuid. It carries no order at all.
		 *  - `created_at` defaults to `now()`, which in Postgres is *transaction
		 *    start* time, not commit time. Every row written in one transaction
		 *    shares it, and a slow transaction stamps its rows *earlier* than
		 *    transactions that began later and already committed. A reader doing
		 *    `where created_at > cursor` therefore skips rows that were still in
		 *    flight when it read, permanently — the same out-of-order-commit hazard
		 *    a bigserial has, with ties on top.
		 *
		 * The fix is not a better timestamp, it is a visibility test: read rows with
		 * `transaction_id < pg_snapshot_xmin(pg_current_snapshot())` and you see
		 * only transactions that have certainly committed, at the cost of trailing
		 * whatever the longest open transaction is. Berth's own writes are all short
		 * one-shot transactions, so that trail is small — but a consumer holding a
		 * long transaction open elsewhere in the same database will stall it, which
		 * is a real constraint on whoever builds the delta read.
		 */
		transactionId: xid8("transaction_id")
			.notNull()
			.default(sql`pg_current_xact_id()`),
	},
	(table) => [
		index("berth_events_org_created_idx").on(table.orgId, table.createdAt),
		index("berth_events_scope_idx").on(table.orgId, table.scope, table.createdAt),
		// The index the delta read will want: one org's log in commit order.
		index("berth_events_txn_idx").on(table.orgId, table.transactionId),
	],
);

/**
 * A directed relationship between two work nodes, keyed on scope.
 *
 * The load-bearing identity is `(from_scope, to_scope, relation)` — an edge can
 * point at a scope no lease has ever touched. Soft-retracted, not deleted, same
 * discipline as `leases.released_at`: the row and its author survive in the
 * history. The partial unique index enforces one active edge per directed
 * relationship; symmetric relations are normalized (from<=to) before insert so
 * a pair is one row regardless of the order the caller named it.
 */
export const edges = pgTable(
	"berth_edges",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		fromScope: text("from_scope").notNull(),
		toScope: text("to_scope").notNull(),
		/** One of RELATION_TYPES. */
		relation: text("relation").notNull(),
		/** The agent or human that asserted the edge. Provenance. */
		createdBy: text("created_by").notNull(),
		metadata: jsonb("metadata"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		retractedAt: timestamp("retracted_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("one_active_edge")
			.on(table.orgId, table.fromScope, table.toScope, table.relation)
			.where(sql`${table.retractedAt} is null`),
		// The two traversal directions the recursive CTE and the graph read walk.
		index("berth_edges_from_idx")
			.on(table.orgId, table.fromScope, table.relation)
			.where(sql`${table.retractedAt} is null`),
		index("berth_edges_to_idx")
			.on(table.orgId, table.toScope, table.relation)
			.where(sql`${table.retractedAt} is null`),
	],
);

/**
 * A fact asserted about one scope: a label, an outcome, a flag.
 *
 * `authority` is the boundary between what an agent may assert about its own
 * work and what only an authority (a human, a verified webhook) may. An agent
 * asserting its own `outcome: completed` is a metric measuring the agent's
 * optimism, so authority-gated writers pass `authority: true` and readers that
 * feed metrics filter on it. Soft-retracted like edges and leases.
 */
export const marks = pgTable(
	"berth_marks",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		scope: text("scope").notNull(),
		/** One of MARK_KINDS. */
		kind: text("kind").notNull(),
		/** The tag/outcome/flag value, e.g. "needs-review", "completed", "security". */
		value: text("value").notNull(),
		/** True if written by an authority; false if agent-asserted. */
		authority: boolean("authority").notNull().default(false),
		createdBy: text("created_by").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		retractedAt: timestamp("retracted_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("one_active_mark")
			.on(table.orgId, table.scope, table.kind, table.value)
			.where(sql`${table.retractedAt} is null`),
		index("berth_marks_scope_idx")
			.on(table.orgId, table.scope)
			.where(sql`${table.retractedAt} is null`),
	],
);

/**
 * What went wrong here last time, attached to the scope rather than the lease.
 *
 * A lease-attached failure note dies with the lease and the next holder never
 * sees it; a scope-attached one persists and is exactly what `observe()` hands
 * the next claimant before they start. Signals accumulate on scopes that are
 * genuinely hard, which is the point — the compounding is the product.
 *
 * Two rules the schema enforces rather than hopes for:
 *
 *  - **`source` is mandatory and drawn from a closed set.** There is no default.
 *    Writing a signal is always a deliberate act naming who observed the
 *    failure, because an unsourced note is indistinguishable from a guess.
 *  - **`body` is opaque text, stored verbatim.** Nothing in this library reads
 *    it, parses it, merges it with another scope's signals, or summarises across
 *    them. A signal is a quote from an observer, not an opinion the system
 *    formed. That restraint is what keeps this a retrieval channel and stops it
 *    from drifting into a knowledge graph that thinks it knows your codebase.
 *
 * Staleness is handled by **supersession, not decay**: when a scope ships
 * successfully, its active signals are stamped `superseded_at` and drop out of
 * reads. That keys on a real event in the ledger rather than a half-life
 * constant nobody can validate, and it cannot wrongly fade a note about
 * something that is still broken. Rows survive supersession; `created_at`
 * travels with every read so a reader can weigh age themselves.
 */
export const signals = pgTable(
	"berth_signals",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		/** The scope this is about. Not the lease — that is the whole point. */
		scope: text("scope").notNull(),
		/** One of SIGNAL_SOURCES. Mandatory: no source, no signal. */
		source: text("source").notNull(),
		/** The observation, verbatim. Never synthesised, never merged. */
		body: text("body").notNull(),
		/** Where to see it for yourself: CI run, commit sha, thread, log URL. */
		ref: text("ref"),
		/** The attempt that produced it. Provenance; soft, nullable. */
		leaseId: uuid("lease_id"),
		createdBy: text("created_by").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		/** Set when the scope later shipped successfully. */
		supersededAt: timestamp("superseded_at", { withTimezone: true }),
		/** The lease whose successful completion superseded it. */
		supersededBy: uuid("superseded_by"),
	},
	(table) => [
		index("berth_signals_scope_idx")
			.on(table.orgId, table.scope)
			.where(sql`${table.supersededAt} is null`),
		index("berth_signals_created_idx").on(table.orgId, table.createdAt),
	],
);

/**
 * What the work produced, or what produced it — attached to a scope.
 *
 * A conversation is an artifact, and it is the one this table exists for. Most
 * systems keep the diff and discard the transcript that explains it, which is
 * why "why is it like this" is usually unanswerable six months later. Here the
 * transcript is a first-class row with an owner, a scope and a timestamp, the
 * same as everything else.
 *
 * **The token-efficiency rule is structural, not advisory.** `body` is the only
 * large column, and no listing read ever selects it: `listArtifacts` returns
 * kind, label, uri, size and digest — tens of tokens per row — and a body costs
 * a deliberate `readArtifact` call for one id. That is what keeps "save every
 * conversation" from turning into "every claim drags a megabyte of transcript
 * into the next agent's context".
 *
 * `body` is optional: pass a `uri` alone and the row is a pointer to wherever
 * the artifact really lives. `digest` is sha256 over the body when there is one
 * and over the uri when there is not, so it is always present — it dedups
 * repeated saves of the same transcript and makes tampering with a stored body
 * detectable after the fact.
 */
export const artifacts = pgTable(
	"berth_artifacts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		scope: text("scope").notNull(),
		/** One of ARTIFACT_KINDS. */
		kind: text("kind").notNull(),
		/** A one-line human handle: "design review with priya", "PR #482". */
		label: text("label").notNull(),
		/** Where it lives, when it lives somewhere else. */
		uri: text("uri"),
		/** The artifact itself, when stored here. Never returned by a listing. */
		body: text("body"),
		/** sha256 of the body, or of the uri when the row is a pointer. */
		digest: text("digest").notNull(),
		/** Size of the body in bytes; 0 for pointers. Lets a reader budget. */
		bytes: integer("bytes").notNull().default(0),
		createdBy: text("created_by").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		// Saving the same artifact twice is one row: retries and re-runs are free.
		uniqueIndex("one_artifact_per_digest").on(table.orgId, table.scope, table.digest),
		index("berth_artifacts_scope_idx").on(table.orgId, table.scope, table.createdAt),
		index("berth_artifacts_kind_idx").on(table.orgId, table.kind, table.createdAt),
	],
);

/**
 * Live mail between two running agents.
 *
 * The second channel, and deliberately not a replacement for the first.
 * A signal is addressed to a *scope*: durable, queryable, survives the sender
 * dying, read by whoever touches that scope next — including agents that do not
 * exist yet. A message is addressed to an *actor*: live, threaded, acknowledged,
 * and worthless if the recipient is not running. Splitting "you take auth, I
 * take billing" is language work a state store cannot do; remembering that
 * billing broke last time is work a conversation cannot do. Both are needed and
 * neither substitutes.
 *
 * The rule that keeps them from fighting, and the one every design decision here
 * defends: **a message can carry a proposal, but only a ledger write changes
 * coordination state.** Two agents can agree in a thread that one takes billing.
 * Nothing is true until a lease exists. Nothing in this table is read by any
 * view that answers "what is the fleet doing" — those read leases and events.
 *
 * `body` is the only large column and no listing selects it. `listInbox` returns
 * a preview truncated by Postgres, so a long body cannot cross the wire even by
 * accident; `readMessage` is the single function that reads the column, and it
 * is scoped to the two participants rather than to the org — the only read in
 * the Berth that is.
 *
 * A message that starts a thread carries its own id in `thread_id`, so every row
 * has one and a reply is just a row with the same value.
 */
export const messages = pgTable(
	"berth_messages",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		/** The conversation. A thread-starter carries its own id here. */
		threadId: uuid("thread_id").notNull(),
		sender: text("sender").notNull(),
		recipient: text("recipient").notNull(),
		/** The message. Opaque, never parsed, never summarised, never in a view. */
		body: text("body").notNull(),
		/** The sender is blocked on an answer. A hint to the reader, not a lock. */
		expectsReply: boolean("expects_reply").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		/** First time a read path handed it over. Delivery, not reading. */
		deliveredAt: timestamp("delivered_at", { withTimezone: true }),
		/** Acted on. Acked messages leave the inbox; this is what a sender waits for. */
		ackedAt: timestamp("acked_at", { withTimezone: true }),
	},
	(table) => [
		// The hot path: one agent's unread mail. Partial, like the signals index,
		// because an acked message is never in it and the ledger only grows.
		index("berth_messages_inbox_idx")
			.on(table.orgId, table.recipient, table.createdAt)
			.where(sql`${table.ackedAt} is null`),
		index("berth_messages_sender_idx")
			.on(table.orgId, table.sender, table.createdAt)
			.where(sql`${table.ackedAt} is null`),
		index("berth_messages_thread_idx").on(table.orgId, table.threadId, table.createdAt),
		index("berth_messages_created_idx").on(table.orgId, table.createdAt),
	],
);

/**
 * Who is running right now, so a message to a dead agent fails instead of
 * queueing.
 *
 * Messages are the one thing in the Berth that only works if the other side is
 * alive. Signals survive the sender dying — that is what they are for — but a
 * message addressed to an actor that stopped an hour ago is a coordination lie
 * with a long fuse: the sender proceeds believing a handoff landed, and the
 * discovery happens when two agents have both done the work.
 *
 * Three decisions worth stating, because each has an obvious wrong answer:
 *
 *  - **Presence is a byproduct of calls, not a verb.** Every MCP tool and every
 *    CLI command touches this row. An agent cannot forget to report, does not
 *    opt in, and spends no tokens being visible. A `heartbeat` verb would make
 *    every agent pay, on every turn, for the dashboard's benefit.
 *  - **Liveness is computed at read time from `last_seen_at`, never stored as a
 *    flag.** A flag needs somebody to clear it, and the agent that crashed is
 *    precisely the one that will not.
 *  - **The timestamps come from the database clock**, written as `now()` and
 *    compared against `now()`. The alternative lets two machines' clocks decide
 *    whether an agent is alive, and a client running slow reads as dead to
 *    everyone else.
 *
 * `session_id` is minted per process, so one actor id running in two shells is
 * two rows. Berth cannot make them separately addressable — the sender only ever
 * knows the actor name — but it can count them and say so, which turns a
 * confusing misconfiguration into a reported one.
 *
 * This is the one table that writes no event. Presence is not a state change,
 * and one ledger row per verb call would bury the coordination events that the
 * ledger exists for.
 */
export const presence = pgTable(
	"berth_presence",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		agentId: text("agent_id").notNull(),
		/** Minted at process start. One actor in two shells is two rows. */
		sessionId: uuid("session_id").notNull(),
		firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
		/** The verb it last called. Diagnostic colour, never a coordination fact. */
		lastAction: text("last_action"),

		// ---------------------------------------------------------------------
		// Where this agent is working, and what is running it.
		//
		// Stamped here rather than on every event because none of it changes inside
		// a session: repeating six unchanging strings on every ledger row would buy
		// no query and cost the log its readability. `berth_events` carries the two
		// that *can* move — branch and ticket — on the events where it matters.
		//
		// `harness` and `wrapper` are separate columns on purpose. Conductor wraps
		// either binary, and "claude-code under Conductor" versus "claude-code in a
		// terminal" is exactly the distinction an install problem turns on.
		// ---------------------------------------------------------------------
		/** Absolute worktree root — the key a hook and the MCP server both compute. */
		worktree: text("worktree"),
		branch: text("branch"),
		remote: text("remote"),
		ticket: text("ticket"),
		/** claude-code | codex | unknown. */
		harness: text("harness"),
		/** conductor | none. */
		wrapper: text("wrapper"),
	},
	(table) => [
		uniqueIndex("one_presence_per_session").on(table.orgId, table.agentId, table.sessionId),
		index("berth_presence_seen_idx").on(table.orgId, table.lastSeenAt),
	],
);

/**
 * What agents were *observed* doing, as opposed to what they declared.
 *
 * A separate table from `berth_leases` because the difference between the two is
 * the entire point and collapsing them would be a product error, not a schema
 * one. A lease is a claim: somebody asked for exclusion and can be told they have
 * it. A row here is a fact: a hook saw this actor open this file. Nobody
 * consented to it and nobody can be told about it mid-session, so it must never
 * gate anything — it is read to *warn*, never to refuse.
 *
 * Separate from `berth_presence` too, which answers "is this agent alive" with one
 * upserted row per session. This answers "where has this agent been", which needs
 * one row per place.
 *
 * Upserted on (org, agent, scope) rather than appended per tool call. An agent
 * editing one file in a loop is one fact observed many times, and appending would
 * put a row in the ledger for every keystroke-sized edit in the fleet. `touches`
 * keeps the count that the append would have carried.
 */
export const activity = pgTable(
	"berth_activity",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		agentId: text("agent_id").notNull(),
		/** The harness session, so a rename or a second session stays attributable. */
		sessionId: uuid("session_id"),
		/** A real scope string — `github:owner/repo#src/lease.ts` — not a raw path. */
		scope: text("scope").notNull(),
		/** How many times this actor was seen in this scope. */
		touches: integer("touches").notNull().default(1),
		firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
		branch: text("branch"),
	},
	(table) => [
		uniqueIndex("one_activity_per_agent_scope").on(table.orgId, table.agentId, table.scope),
		index("berth_activity_seen_idx").on(table.orgId, table.lastSeenAt),
	],
);

/**
 * Every place work can happen on this machine, whether or not anybody is there.
 *
 * A third table beside `berth_presence` and `berth_activity`, because it answers a
 * third question and collapsing it into either would corrupt them:
 *
 *   presence   — is this agent alive right now?   written by the agent, windowed
 *   activity   — where has this agent been?       written by a hook that saw it
 *   workspaces — where could work happen at all?  written by a timer that looked
 *
 * A row here confers nothing and observes nothing. It says a directory exists, is a
 * git worktree, and looked like this the last time anybody counted.
 *
 * It is never read to decide liveness, and the reason is not stylistic. A
 * background timer cannot know whether a process is running, only that a path is on
 * disk. Writing that second fact into `berth_presence` would make `live now:` report
 * every archived workspace forever — destroying the one signal it exists to carry —
 * and would make `send` promise delivery to an agent that exited days ago, because
 * `messages.ts` gates delivery on `lastSeen().present`. Presence is written by the
 * thing that is alive, from inside its own process; that is why `touchPresence`
 * defaults its context to `resolveIdentity()`.
 *
 * `host` is in the unique index because `deriveActorId` hashes the absolute path
 * only, so two machines with the same path derive the same actor id. That is fine
 * while the writer is always the process itself, and stops being fine the moment a
 * census enumerates paths on two machines against one ledger.
 *
 * Rows are marked `gone_at`, never deleted — the same reasoning as
 * `devices.revokedAt`. After a worktree disappears, what it changed before it went
 * is the question worth asking, and `conductor.archive_commit` exists specifically
 * to keep those commits reachable.
 */
export const workspaces = pgTable(
	"berth_workspaces",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		/** `deriveActorId(path)` — the same id a lease and a presence row carry. */
		actorId: text("actor_id").notNull(),
		/** Absolute worktree root. The natural key; `actorId` is derived from it. */
		path: text("path").notNull(),
		/** Which machine counted it. Two laptops can both have `/Users/x/repo`. */
		host: text("host").notNull(),
		/** How this row was found. */
		source: text("source", { enum: WORKSPACE_SOURCES }).notNull(),
		/** The main checkout every worktree of this repo shares. Groups the census. */
		repoRoot: text("repo_root"),
		/** `owner/repo` via `repoSlug()`. Null in a repo with no usable remote. */
		repo: text("repo"),
		remote: text("remote"),
		branch: text("branch"),
		head: text("head"),

		// ---------------------------------------------------------------------
		// What only Conductor knows. All null on a worktree it never heard of,
		// which is the common case for a hand-made `git worktree add`.
		// ---------------------------------------------------------------------
		conductorState: text("conductor_state"),
		conductorTitle: text("conductor_title"),
		agentType: text("agent_type"),
		model: text("model"),
		/** Context-window occupancy, **not** spend. See `conductor.ts` — wrong by 20x. */
		contextTokens: integer("context_tokens"),

		/** Set when a round could no longer find it. Cleared if it comes back. */
		goneAt: timestamp("gone_at", { withTimezone: true }),
		firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("one_workspace_per_path").on(table.orgId, table.host, table.path),
		index("berth_workspaces_actor_idx").on(table.orgId, table.actorId),
		index("berth_workspaces_seen_idx").on(table.orgId, table.lastSeenAt),
	],
);

export type WorkspaceRow = typeof workspaces.$inferSelect;

/**
 * The tenant. One row per organization, and the thing every `org_id` points at.
 *
 * It existed in the hosted database and not in the kernel, which is not a
 * cosmetic gap: `src/supabase.ts` reads `berth_orgs` in `resolveOrg` and
 * `verifySupabase`, so `berth login --endpoint …/rest/v1` against a database
 * that only ever had `berth init` run on it fails with a PostgREST 404 —
 * `PGRST205`, "Perhaps you meant the table public.berth_marks". That reads as a
 * broken key or a broken endpoint, and it is neither.
 *
 * `slug` is unique per live org because it is what appears in a URL and in
 * `BERTH_ORG` lookups; the partial index leaves a deleted org's slug free to be
 * taken again. Deletion is a timestamp for the usual reason — an org's captured
 * history outlives the org, and a deleted row takes every `org_id` with it.
 */
export const orgs = pgTable(
	"berth_orgs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		/** The GitHub organization this tenant maps to, when there is one. */
		githubOrg: text("github_org"),
		/**
		 * A code somebody already inside can hand to somebody who is not.
		 *
		 * Nullable, and an org with none cannot be joined by code at all — which
		 * is the safe default, because this is the whole of the check. It is a
		 * bearer secret rather than an identifier: anybody holding it becomes a
		 * member of this tenant, so it is generated with real entropy and is
		 * rotatable by writing a new one.
		 */
		joinCode: text("join_code"),
		/**
		 * The email domain that may join without a code, lowercased and bare
		 * (`harbor.so`, never `@harbor.so`).
		 *
		 * This is also the only thing that makes an org *discoverable*. Searching
		 * tenants by name would let any signed-up stranger enumerate every
		 * customer, so a person is shown the orgs that have already declared
		 * themselves willing to take their address and nothing else.
		 *
		 * It is not proof of employment — it is proof of controlling an address
		 * at that domain, which is what the auth provider verified. An org that
		 * wants more than that leaves this null and hands out codes.
		 */
		emailDomain: text("email_domain"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("one_org_per_slug").on(table.slug).where(sql`${table.deletedAt} is null`),
		// A join code that matched two orgs would put somebody in whichever the
		// planner reached first.
		uniqueIndex("one_org_per_join_code")
			.on(table.joinCode)
			.where(sql`${table.joinCode} is not null and ${table.deletedAt} is null`),
		index("berth_orgs_domain_idx").on(sql`lower(${table.emailDomain})`),
	],
);

/**
 * An invitation to one address, on one org.
 *
 * The table shipped in `supabase/migrations/20260828000001_tenancy.sql` and then
 * nothing read or wrote it for two months — no Drizzle definition, no bootstrap
 * DDL, absent from `BERTH_TABLES`. It is defined here because `org.invite` and
 * `org.acceptInvite` in the dashboard now use it, and because a table the
 * integrity test cannot see is a table that drifts.
 *
 * **What an invite proves, and why that is worth a whole table.** The other two
 * ways onto an org each fall short of one person: a `join_code` is a bearer
 * secret for the *org* — whoever holds it is a member, but it says nothing about
 * which member — and an `email_domain` says only that the org accepts a suffix.
 * An invite names the address, and somebody already inside put it there. That is
 * what makes it the one route allowed to attach a caller to an engineer row that
 * already has captured work under it.
 *
 * The secret is stored as `hashToken(token)` and nothing else, the same
 * discipline as `berth_devices.token_hash` and for the same reason: a dump of
 * this table is not a set of working invites. `token_hash` is uniquely indexed,
 * so redemption is an equality match rather than a scan.
 *
 * `invited_by` is **text holding a `berth_engineers.id`**, not the migration's
 * original `uuid references auth.users(id)`. That referenced Supabase Auth,
 * which is no longer the auth system and whose `auth` schema does not exist at
 * all on a database `berth init` created — so the FK was both wrong and
 * unbootstrappable. `berth_device_authorizations.approved_by` records an
 * approver the same way.
 *
 * `role` is the standing the accepted invite grants, and it is the reason an
 * invite is the natural place to appoint a second admin: the address, the org
 * and what they may do there are all decided in one act, by somebody already
 * inside. It went two months written with its default and read by nothing —
 * that comment is retired. The vocabulary is closed and lives in
 * `core/src/lib/roles.ts`; there is deliberately no copy of it in this project,
 * because the kernel's surfaces authenticate with a device token, which carries
 * no membership and is gated on `scopes` rather than on a role.
 *
 * Spent and withdrawn are timestamps rather than deletes, so "this invite was
 * used, by whom, when" survives — the same reason `revoked_at` is a timestamp on
 * a device.
 */
export const orgInvites = pgTable(
	"berth_org_invites",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		/** The address this invite is for. Matched case-insensitively. */
		email: text("email").notNull(),
		role: text("role").notNull().default("member"),
		/** sha256 of the token. The plaintext exists only in the link. */
		tokenHash: text("token_hash").notNull(),
		/** The `berth_engineers.id` of whoever sent it, when it is known. */
		invitedBy: text("invited_by"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		acceptedAt: timestamp("accepted_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("one_invite_per_token").on(table.tokenHash),
		// The open invites for an address, which is what "already invited" reads.
		index("berth_org_invites_open_idx")
			.on(table.orgId, sql`lower(${table.email})`)
			.where(sql`${table.acceptedAt} is null and ${table.revokedAt} is null`),
	],
);

/**
 * A harness installation that is supposed to be reporting, and whether it is.
 *
 * The table that answers "is this quiet because nothing happened, or quiet
 * because it broke" — which is the one question a capture pipeline cannot answer
 * about itself from the capture alone. An absent session and an absent *source*
 * look identical downstream, and only one of them is a bug.
 *
 * Like `berth_orgs`, this was in the hosted database and not in the kernel, and
 * the dashboard reads it (`core/src/lib/supabase/queries.ts`, `core/src/data/live.ts`).
 * A `berth init` database therefore served a dashboard that 404s on its own
 * health surface.
 *
 * Nothing in this repo writes it yet — `state`, `cursor_lag_seconds` and
 * `parse_failures` are the shape HAR-36 needs and the collector does not fill in.
 * It is defined here so the two schemas stop disagreeing, and so whoever wires it
 * does not also have to re-derive the columns from a generated types file.
 */
export const sources = pgTable(
	"berth_sources",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		machineId: uuid("machine_id"),
		harness: text("harness").notNull(),
		harnessVersion: text("harness_version"),
		installPath: text("install_path"),
		/** Free text rather than a closed vocabulary until something writes it. */
		state: text("state").notNull().default("unknown"),
		cursor: text("cursor"),
		cursorAt: timestamp("cursor_at", { withTimezone: true }),
		cursorLagSeconds: integer("cursor_lag_seconds"),
		coverageStart: timestamp("coverage_start", { withTimezone: true }),
		coverageEnd: timestamp("coverage_end", { withTimezone: true }),
		parseFailures: integer("parse_failures").notNull().default(0),
		lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
		lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		/**
		 * The conflict target the heartbeat upserts on.
		 *
		 * Without this every round INSERTs, and the table whose job is to make
		 * silence legible becomes the fastest-growing thing in the database.
		 *
		 * `machine_id` is nullable and Postgres treats NULLs as distinct here, so a
		 * row written without one still inserts every round. `ingestBatch` refuses
		 * such a row rather than writing it; this index cannot defend itself.
		 */
		uniqueIndex("one_source_per_machine_harness").on(table.orgId, table.machineId, table.harness),
		index("berth_sources_org_idx").on(table.orgId, table.lastSuccessAt),
	],
);

/**
 * A person the work is attributed to.
 *
 * The table exists because every attribution berth had before it was a **string
 * re-derived at capture time from `git config user.email`** — a local value
 * anyone can set, on a machine berth does not control, read fresh on every push.
 * That does not identify a person; it identifies whoever last ran `git config`.
 * An id in a row, minted once server-side and echoed back by the client, is the
 * thing a report can be added up by.
 *
 * `email` is the natural key and is matched **case-insensitively** — the unique
 * index is over `lower(email)`, not `email`. Two rows for `Ada@corp.com` and
 * `ada@corp.com` are the same person with half their week each, and that is a
 * defect no dashboard can detect and no join can repair afterwards. The stored
 * case is whatever the engineer typed, because it is what gets displayed.
 *
 * **Two auth joins, and they are not interchangeable.** `better_auth_user_id` is
 * the live one — the dashboard's `membershipForRequest` resolves a signed-in
 * person through it, and `org.join` writes it. `auth_user_id` is the older
 * Supabase Auth join, kept because the column is in the hosted database and a
 * schema that omits a live column lies. This comment used to describe
 * `auth_user_id` as "a Better Auth user id", which is worse than a gap: Better
 * Auth mints text cuids and the hosted column is `uuid references auth.users`,
 * so writing one into the other fails at the database on a machine nobody is
 * testing on.
 *
 * That type is also the one place these three schemas genuinely disagree —
 * `uuid` in `supabase/migrations/20260828000001_tenancy.sql:43` and in the
 * dashboard's mirror, `text` here and in `bootstrap.ts`. It is left alone
 * deliberately: nothing reads the column for authentication any more, the
 * migration that introduced Better Auth says out loud that `auth_user_id` stays
 * untouched, and an `alter column type` on a live table buys nothing. Do not
 * "fix" it by writing to it.
 *
 * Neither is the primary key: engineers exist in the ledger who have never
 * signed in — an old capture row carrying only an email is still work somebody
 * did — and keying on the auth system would make this table unable to hold them.
 *
 * Removal is `removed_at`, not a delete, for the same reason as
 * `devices.revokedAt`: after somebody leaves, what they shipped is exactly the
 * history worth keeping, and a deleted row takes every `engineer_id` pointing at
 * it with it. The unique index is partial on `removed_at is null`, so the same
 * address can be re-onboarded without colliding with the departure.
 *
 * **`role` does not survive that round trip, and `removed_at` does.** The
 * asymmetry looks like an inconsistency and is the point. Clearing `removed_at`
 * on a re-join is about *attribution* — the sessions captured under that address
 * are theirs, and a second row would orphan them. Role is not attribution, it is
 * standing, and standing is granted by a person. If it survived removal, then
 * removing an admin and letting them back in with the org's join code — a bearer
 * secret already in circulation, which any member could have passed on — would
 * silently restore it. A control a bearer code undoes is not a control, so the
 * dashboard's `removeMember` writes `removed_at` and `role = 'member'` together.
 */
export const engineers = pgTable(
	"berth_engineers",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		/** The natural key. Matched case-insensitively; stored as typed. */
		email: text("email").notNull(),
		displayName: text("display_name"),
		githubLogin: text("github_login"),
		/** The legacy Supabase Auth join. Vestigial; see the header. */
		authUserId: text("auth_user_id"),
		/**
		 * The Better Auth user id, when this engineer has ever signed in — and
		 * deliberately a second column beside `auth_user_id` rather than a rename.
		 *
		 * `auth_user_id` is Supabase Auth's `uuid references auth.users(id)`; this
		 * is Better Auth's own opaque id, and the two identity systems can both be
		 * true of one person. `20260828000005_better_auth.sql` makes that argument
		 * at length; nothing here should collapse them.
		 *
		 * Text, not uuid: Better Auth mints cuids. Null until the first sign-in,
		 * because capture attributes work to people who have never opened the
		 * dashboard — which is exactly why `membershipForRequest` needs an email
		 * fallback to find the row the first time, and why this column is written
		 * once and never moved afterwards.
		 *
		 * It lives in the kernel because `berth init` has to be able to back the
		 * dashboard on its own, and it could not: this column was declared in
		 * `core/src/server/db/schema.ts`, added by that one migration, and present
		 * in neither this file nor `bootstrap.ts` — so a `berth init` database
		 * resolved every signed-in user to no membership, on the one query that
		 * decides which org a person may read. `schema-integrity.test.ts` now
		 * asserts the two projects agree in this direction as well as the other.
		 */
		betterAuthUserId: text("better_auth_user_id"),
		/**
		 * What this person may do to the org's *membership* — `member` or `admin`.
		 *
		 * Not a general permission system: it gates handing out access and nothing
		 * else. Inviting mints a credential that lets a new address read this org's
		 * captured prompts, reasoning and command output, and the join code does
		 * the same for anybody holding it; the roster, the machines and the
		 * sessions stay open to every member. The closed vocabulary is
		 * `core/src/lib/roles.ts` and is held by a test rather than a CHECK
		 * constraint, so widening it is a TypeScript change every call site sees.
		 *
		 * Defaulted `member` here and in the DDL, which makes the *backfill* the
		 * risky half of introducing it: every member could invite before this
		 * column existed, so `20260830140000_engineer_roles.sql` promotes everybody
		 * who has ever signed in, and then rescues any org that statement left with
		 * no admin at all. An org with zero admins can never invite again.
		 */
		role: text("role").notNull().default("member"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		/** Left the org. Their rows stay; the address can be re-onboarded. */
		removedAt: timestamp("removed_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("one_engineer_per_email")
			.on(table.orgId, sql`lower(${table.email})`)
			.where(sql`${table.removedAt} is null`),
		// One engineer per signed-in account, org-wide: the dashboard resolves a
		// session through this column, so two rows carrying one user id is an
		// ambiguous membership that resolves as whichever row the planner reached
		// first — a tenancy bug that only shows up once somebody belongs to two
		// orgs. Partial for the same reason as the index above it: a removed
		// engineer's row is kept so work they already did stays attributed, and
		// must not block the same person being re-added.
		uniqueIndex("one_engineer_per_better_auth_user")
			.on(table.betterAuthUserId)
			.where(sql`${table.removedAt} is null`),
	],
);

/**
 * A physical machine an engineer captures from.
 *
 * Server-minted, and that is the entire point of the table. The id here is
 * decided by the ingest server at registration and handed back to the client to
 * store; the client never proposes one. A client-chosen machine id is a client
 * that can claim to be somebody else's laptop, and — more mundanely and far more
 * often — a client that mints a fresh id every time its config file is recreated,
 * which turns one laptop into a chart of forty.
 *
 * `hostname_hash` is sha256 of the hostname and **never the hostname itself**.
 * Hostnames are personal (`adas-mbp.local`) and leak org structure, but the only
 * thing registration needs from one is "is this the same box as last time" —
 * which an opaque digest answers exactly as well. `hashHostname` in
 * `machine.ts` is the one definition of that digest, shared by both sides.
 *
 * `label` is what a human reads and is free to be wrong; the hash is what
 * identity is keyed on. `engineer_email` is denormalized beside `engineer_id`
 * for display and for rows minted before the engineer existed — it is never the
 * key, and on any path holding an `engineer_id` it is derived from the engineer
 * row rather than from the machine's git config.
 *
 * Retirement is a timestamp, like revocation and removal everywhere else here:
 * the sessions a decommissioned laptop pushed are still the record of the work.
 * The unique index is partial on `retired_at is null`, so a rebuilt machine with
 * the same hostname gets a new row rather than resurrecting the old one.
 */
export const machines = pgTable(
	"berth_machines",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		/** Who registered it, resolved from the token — not from the client. */
		engineerId: uuid("engineer_id"),
		/** Display only, and only authoritative on rows with no `engineerId`. */
		engineerEmail: text("engineer_email"),
		/** What a human calls this box. Not an identity. */
		label: text("label").notNull(),
		/** sha256 of the hostname, hex. Never the hostname. */
		hostnameHash: text("hostname_hash"),
		os: text("os"),
		firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
		retiredAt: timestamp("retired_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("one_machine_per_host")
			.on(table.orgId, table.hostnameHash)
			.where(sql`${table.retiredAt} is null`),
	],
);

/**
 * A machine allowed to push captured sessions.
 *
 * The token is never stored. `tokenHash` is sha256 of the secret the operator was
 * shown exactly once at creation, and every later comparison is against the hash —
 * so a copy of this table is not a set of working credentials. That is the whole
 * reason the column is not called `token`.
 *
 * Revocation is a timestamp rather than a delete, because the interesting question
 * after an incident is *what did that device send before it was cut off*, and a
 * deleted row takes its own event history's foreign key with it.
 */
export const devices = pgTable(
	"berth_devices",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		/** What a human calls this machine in a list. Not an identity. */
		label: text("label").notNull(),
		/** sha256 of the secret, hex. Never the secret. */
		tokenHash: text("token_hash").notNull(),
		/** The first 8 characters of the secret, so a human can tell two apart. */
		tokenPrefix: text("token_prefix").notNull(),
		/**
		 * What this credential may do. `{ingest}` and, so far, nothing else.
		 *
		 * A column rather than an implicit rule because the narrowness is the whole
		 * security argument for handing this token to a laptop — a stolen device
		 * credential must not be able to release somebody's lease — and an argument
		 * that lives only in a comment is one a later feature quietly widens. It
		 * has been in the hosted database since keys were mintable from the
		 * dashboard; the kernel was simply behind, so a `berth init` database had
		 * no `scopes` and the dashboard's key list failed against it with
		 * `column berth_devices.scopes does not exist`.
		 */
		scopes: text("scopes").array().notNull().default(sql`'{ingest,read}'`),
		/**
		 * Who owns this token. The token *is* the identity: everything this device
		 * pushes is attributed to this engineer, server-side, whatever the client
		 * claims. Nullable only because keys minted before this column existed
		 * cannot be attributed retroactively without guessing.
		 */
		engineerId: uuid("engineer_id"),
		/** The machine that last registered against this token. Server-minted. */
		machineId: uuid("machine_id"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("one_device_per_token").on(table.tokenHash),
		index("berth_devices_org_idx").on(table.orgId),
	],
);

/**
 * A pending request to connect a machine, waiting for somebody to click.
 *
 * `berth login` prints a link instead of asking for a pasted token. This is the
 * row that link refers to: created unapproved, approved from a browser session,
 * and redeemed exactly once by the CLI that started it.
 *
 * **Nothing in `src/` writes this.** The approval half needs a signed-in browser
 * session, which `berth serve` does not have; the dashboard does, and reaches
 * this table over PostgREST. It is defined here because `bootstrap.ts` is the
 * only sanctioned generator of this schema, and a table created outside it is
 * the same invisible drift as `berth_devices.scopes`.
 *
 * **No secret is stored.** The row holds sha256 of the two codes and nothing
 * that could be presented to anything, so a dump of this table is not a set of
 * pending credentials — the same reason `tokenHash` is not called `token`. The
 * credential itself does not exist until redemption: approving records who and
 * which org, and the poll that presents the right `deviceCodeHash` is what mints.
 */
export const deviceAuthorizations = pgTable(
	"berth_device_authorizations",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		/**
		 * Null until approved.
		 *
		 * The one deliberate exception to every other table's `org_id not null`: a
		 * request that nobody has approved yet belongs to no tenant, which is the
		 * whole point of the flow. It is written from the approver's session and
		 * never from anything the CLI sent.
		 */
		orgId: uuid("org_id"),
		/** sha256 of the secret the CLI alone holds. Never appears in a URL. */
		deviceCodeHash: text("device_code_hash").notNull(),
		/** sha256 of the value carried in the link. Identifies; cannot redeem. */
		handleHash: text("handle_hash").notNull(),
		/** Self-reported by the CLI, shown to the approver, trusted for nothing. */
		label: text("label").notNull(),
		platform: text("platform"),
		client: text("client"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		/** The arbiter for `slow_down`. */
		lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
		/**
		 * Who asked, as a salted hash — the arbiter for the rate limit on `/api/device/code`.
		 *
		 * That route is the only one in the product that is **unauthenticated and
		 * writes a row**, on a public origin. Anyone can POST it in a loop and mint
		 * pending authorizations until the table is the size of the disk; the sweep
		 * in `startDeviceAuth` only clears rows a day old, and says in its own
		 * comment that it is not a rate limiter.
		 *
		 * Hashed rather than stored, and salted with the app secret rather than bare
		 * sha256, for the reason `berth_machines.hostname_hash` is: an IPv4 space is
		 * small enough to enumerate, so an unsalted digest is the address written
		 * down with extra steps. Nothing reads this back — it is only ever compared
		 * to a freshly computed one, so a one-way value costs nothing.
		 */
		requesterHash: text("requester_hash"),
		approvedAt: timestamp("approved_at", { withTimezone: true }),
		/** The identity that approved it, for an audit that outlives the session. */
		approvedBy: text("approved_by"),
		deniedAt: timestamp("denied_at", { withTimezone: true }),
		/** Set by the winning poll, before the mint. One redemption, ever. */
		consumedAt: timestamp("consumed_at", { withTimezone: true }),
		deviceId: uuid("device_id"),
	},
	(table) => [
		uniqueIndex("one_authorization_per_device_code").on(table.deviceCodeHash),
		uniqueIndex("one_authorization_per_handle").on(table.handleHash),
		index("berth_device_authorizations_expiry_idx").on(table.expiresAt),
		// The rate limit's read: "how many did this requester start in the last
		// minute". Partial, because the overwhelming majority of rows carry no
		// requester and indexing them would be paying for a scan nobody makes.
		index("berth_device_authorizations_requester_idx").on(table.requesterHash, table.createdAt),
	],
);

/**
 * One captured harness session — a Claude Code transcript or a Codex rollout.
 *
 * Keyed on the harness's own session id rather than a generated one, so a session
 * pushed twice from two collector runs converges instead of duplicating. That is
 * the only property that makes a resumable, crash-tolerant collector possible.
 */
export const captureSessions = pgTable(
	"berth_capture_sessions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		deviceId: uuid("device_id").notNull(),
		/**
		 * Who did this work, and on what box. Both resolved from the pushing
		 * token, never from the client's claim and never from git config.
		 * Nullable because sessions captured before identity landed exist and are
		 * still the record of the work — an unattributed *new* row is a bug.
		 */
		engineerId: uuid("engineer_id"),
		machineId: uuid("machine_id"),
		/**
		 * The git config the capture came off, denormalized. Display only, and
		 * only authoritative on rows with no `engineerId` — see `attributionOf`,
		 * which does not read it when the id is present, because the id was
		 * resolved server-side from the token and this was whatever the machine
		 * happened to have set.
		 */
		engineerEmail: text("engineer_email"),
		/** The harness's session id. `claude_session_id`, or Codex's `session_id`. */
		sessionId: text("session_id").notNull(),
		harness: text("harness").notNull(),
		/**
		 * Whether a human started this session, or another session did.
		 *
		 * **472 of 691 Claude Code transcripts on one machine are subagent runs**,
		 * and until this column they were peers of a real session on every listing.
		 * That is not a cosmetic difference: a subagent transcript is one prompt
		 * followed only by tool results, so it is **one turn by construction** and
		 * always will be — which is most of why "1 turn" reads as the normal state
		 * of the ledger. Filtering them out is a decision the dashboard can only
		 * make if the row says which it is.
		 */
		kind: text("kind").notNull().default("session"),
		/**
		 * The session that spawned this one, for a subagent.
		 *
		 * **No foreign key**, matching every other capture table: the parent is
		 * pushed in the same batch but not necessarily before the child, and a
		 * subagent whose parent was collected on a different day or pruned by a
		 * backfill window is still a real row. A dangling parent renders as a plain
		 * id rather than failing an insert.
		 *
		 * Derived from the transcript's path, which is where Claude Code puts it:
		 * `<slug>/<parent-session-id>/subagents/agent-<id>.jsonl`.
		 */
		parentSessionId: text("parent_session_id"),
		/** Absolute worktree root on the machine that sent it. */
		worktree: text("worktree"),
		branch: text("branch"),
		/** `owner/repo`, so sessions from two checkouts of one repo join up. */
		repo: text("repo"),
		model: text("model"),
		startedAt: timestamp("started_at", { withTimezone: true }),
		endedAt: timestamp("ended_at", { withTimezone: true }),
		// Summed over deduped `message.id` — see the 2.45x note in the collector.
		//
		// Four columns, not two, because `input_tokens` alone is a catastrophically
		// wrong measure of input: on a long cached conversation it was 468 against
		// 53,275,775 read from cache. Cache reads are also priced differently from
		// fresh input, so summing them into one column would destroy the only
		// number a cost report needs.
		inputTokens: integer("input_tokens").notNull().default(0),
		outputTokens: integer("output_tokens").notNull().default(0),
		cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
		cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),
		records: integer("records").notNull().default(0),
		receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),

		// Which pull request this session's work became. Written by `pr-sync`,
		// never by the collector — see `berth_pull_requests` for why the PR's own
		// state does not live here.
		prNumber: integer("pr_number"),
		/**
		 * Usually the same as `repo`, and not derivable from it.
		 *
		 * A pull request opened from a fork lives in the upstream repository while
		 * the session was in the fork. Reusing `repo` as the join key would point
		 * at a repository that has no such PR number, or worse, at a different
		 * repository's PR with that number.
		 */
		prRepo: text("pr_repo"),
		/** `PR_LINK_SOURCES`. The evidence, not a confidence score. */
		prLinkSource: text("pr_link_source"),
		/**
		 * When the link was established — and, by its absence, that it never was.
		 *
		 * Load-bearing for `pr-sync`'s selection: a round that could not reach
		 * GitHub must leave this null, or the next round reads the session as
		 * already resolved and never asks again.
		 */
		prLinkedAt: timestamp("pr_linked_at", { withTimezone: true }),
		/**
		 * What this row's shape was when it was written. HAR-34.
		 *
		 * Written as 1 and left there. The value of a version column is not that it
		 * counts up — it is that `extra` beside it lets a machine on an older build
		 * round-trip fields it does not understand instead of dropping them, so a
		 * newer machine's writes are not silently destroyed by an older one reading
		 * them back. Bumping this means defining what 2 means, which is a decision.
		 */
		schemaVersion: smallint("schema_version").notNull().default(1),
		extra: jsonb("extra"),
		/**
		 * Filed away, not deleted. See the same column on `berth_agent_runs`.
		 *
		 * **This is a display decision and never a capture one.** Ingest does not
		 * read it, so a machine that pushes more turns for an archived session
		 * still lands them — the row is the record of what happened, and hiding it
		 * from a list must not make the ledger stop believing it.
		 */
		archivedAt: timestamp("archived_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("one_capture_per_session").on(table.orgId, table.sessionId),
		index("berth_capture_sessions_device_idx").on(table.orgId, table.receivedAt),
		index("berth_capture_sessions_pr_idx").on(table.orgId, table.prRepo, table.prNumber),
		// As above: every session list is the unarchived ones, newest first.
		index("berth_capture_sessions_live_idx")
			.on(table.orgId, table.startedAt)
			.where(sql`${table.archivedAt} is null`),
	],
);

/**
 * A pull request, as GitHub last described it.
 *
 * ## Why this is not columns on `berth_capture_sessions`
 *
 * **A pull request is not a property of a session.** Several sessions share one
 * branch routinely — a resumed session, a forked one, a second agent picking the
 * work back up — and every one of them points at the same pull request. Nine
 * `pr_*` columns on the session row would store that pull request once per
 * session and let two pages answer "is this merged" differently, because one of
 * them was written on Tuesday.
 *
 * The other half of the reason is whose clock it moves on. A session row is
 * written when a transcript changes; a pull request changes when somebody
 * merges it, which is not an event any transcript sees. Those are two different
 * refresh cadences and they need two different rows.
 *
 * ## Why `state` is stored rather than computed on read
 *
 * See `PR_STATES`. GitHub reports a merged pull request as `CLOSED` carrying a
 * `mergedAt`, so "merged" is a derivation, and a derivation performed in two
 * places is a disagreement waiting for its first merged PR.
 *
 * ## Why there is no installations table *in the kernel*
 *
 * There is one now — `berth_github_installations`, below. This comment used to
 * say a table was unnecessary because `github-app.ts` asks GitHub which
 * installation covers a repository — true, and true for the reason it gave: on a
 * laptop, the holder of the App key and the owner of the repositories are the
 * same person, so GitHub's answer is the right one.
 *
 * What changed is that the question did. A hosted deployment holds one App key
 * on behalf of every customer, and `repo` on the row below is a string a laptop
 * supplied. So the question stopped being *which installation covers this
 * repository* — GitHub still answers that, correctly, for somebody else's
 * installation — and became *may this org ask about this repository at all*.
 * Only a row answers the second, and it is a row about a tenant, so it lives
 * with the other tenant state the kernel does not create: `berth init` embeds a
 * ledger in somebody else's Postgres and must not put our App's installation ids
 * in it, exactly as it must not put a Stripe customer id there.
 *
 * `installationForRepo` in `github-app.ts` is unchanged and still correct for
 * `berth github token`. `core/src/server/github/sync.ts` does not call it.
 */
export const pullRequests = pgTable(
	"berth_pull_requests",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		/** `owner/repo`, spelled as `repoSlug()` spells it. */
		repo: text("repo").notNull(),
		number: integer("number").notNull(),
		url: text("url").notNull(),
		title: text("title"),
		/** `PR_STATES`, derived once by the writer. */
		state: text("state").notNull(),
		draft: boolean("draft"),
		headRef: text("head_ref"),
		headSha: text("head_sha"),
		baseRef: text("base_ref"),
		authorLogin: text("author_login"),
		openedAt: timestamp("opened_at", { withTimezone: true }),
		mergedAt: timestamp("merged_at", { withTimezone: true }),
		closedAt: timestamp("closed_at", { withTimezone: true }),
		/** GitHub's own `updatedAt`. When the pull request last changed. */
		updatedAtGh: timestamp("updated_at_gh", { withTimezone: true }),
		/**
		 * When berth last asked.
		 *
		 * Deliberately distinct from `updated_at_gh`: "we have not looked since
		 * Tuesday" and "GitHub says nothing has changed since Tuesday" are
		 * different facts, and a staleness badge built on the wrong one is a lie
		 * told confidently. It is also what bounds `pr-sync` — see the
		 * merged-is-terminal rule there.
		 */
		checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("one_pull_request_per_number").on(table.orgId, table.repo, table.number),
		index("berth_pull_requests_head_idx").on(table.orgId, table.repo, table.headRef),
	],
);

/**
 * The extracted records of a session. Structure and measurements, never content.
 *
 * `recordUuid` is scoped by session on purpose: the same uuid appears under two
 * session ids when a session is resumed or forked, and a globally unique index
 * would silently drop the second — which is also the highest-precision
 * work-identity edge available.
 */
export const captureEvents = pgTable(
	"berth_capture_events",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		sessionId: text("session_id").notNull(),
		/**
		 * Denormalized from the session, on purpose: the dashboard filters
		 * millions of events by engineer and joining every one of them back
		 * through `berth_capture_sessions` to learn who it belongs to is the
		 * query that makes that page unusable. Written from the token, like the
		 * session's own pair.
		 */
		engineerId: uuid("engineer_id"),
		machineId: uuid("machine_id"),
		/** As on the session, and for the same reason: display only. */
		engineerEmail: text("engineer_email"),
		/** The harness's `uuid` for this record. Unique within a session, not across. */
		recordUuid: text("record_uuid").notNull(),
		at: timestamp("at", { withTimezone: true }),
		kind: text("kind"),
		tool: text("tool"),
		/** Repo-relative. Absolute paths collide across worktrees 13x — see COLLECTOR.md. */
		path: text("path"),
		// The shape of a change, never the change. Additions and deletions are kept
		// apart rather than summed: "+120 −4" and "+62 −62" are the same total and
		// completely different events, and the split is what every diff view shows.
		patchHunks: integer("patch_hunks"),
		patchLines: integer("patch_lines"),
		additions: integer("additions"),
		deletions: integer("deletions"),
		inputTokens: integer("input_tokens"),
		outputTokens: integer("output_tokens"),
		cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }),
		cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }),
		/** The turn this happened in, so events and turns line up. */
		turnSeq: integer("turn_seq"),
		/**
		 * The tool failed.
		 *
		 * One boolean, and the highest signal-per-byte field in the extract: it is
		 * what separates "the agent worked for an hour" from "the agent fought the
		 * build for an hour", and nothing else in the capture distinguishes those.
		 */
		error: boolean("error"),
		/**
		 * CONTENT. A command, or a tool's own one-line description of itself.
		 *
		 * The command is the single most legible record of what an agent actually
		 * did — far more than a tool name — and it is also the field most likely to
		 * contain a pasted secret. Governed by the same content flag as prompts.
		 */
		detail: text("detail"),
		/**
		 * CONTENT, and the heaviest kind. The literal `+`/`-` lines of the change.
		 *
		 * Only under `--full`. This is the customer's source code, and it is also
		 * most of the ~96% of bytes that the default extract drops: the whole 128x
		 * compression figure is this field and `output` not being here.
		 */
		patch: text("patch"),
		/** CONTENT. Command stdout/stderr, or a tool's result. Only under `--full`. */
		output: text("output"),
		/** HAR-34. Written as 1; `extra` beside it is what makes it useful. */
		schemaVersion: smallint("schema_version").notNull().default(1),
		extra: jsonb("extra"),
	},
	(table) => [
		uniqueIndex("one_event_per_record").on(table.orgId, table.sessionId, table.recordUuid),
		index("berth_capture_events_session_idx").on(table.orgId, table.sessionId),
		// `path` is the most-asked predicate in the corpus and was a sequential
		// scan over every event before this. Partial because a path-less event —
		// a plain assistant message — can never match a path query.
		index("berth_capture_events_path_idx")
			.on(table.orgId, table.path)
			.where(sql`${table.path} is not null`),
		index("berth_capture_events_tool_idx")
			.on(table.orgId, table.tool)
			.where(sql`${table.tool} is not null`),
		// Partial on purpose, and by a wide margin: a few hundred error rows out
		// of tens of thousands, so the index is a fraction of the full one and
		// answers the only question anybody asks of the column.
		index("berth_capture_events_error_idx")
			.on(table.orgId, table.sessionId, table.turnSeq)
			.where(sql`${table.error} is true`),
	],
);

/**
 * One turn: a human said something, the agent did things, something came of it.
 *
 * Turns are delimited by prompt records **in file order**, not grouped by a key.
 * `promptId` is on user records at 100% and on assistant records at 0%, so there
 * is no id shared by both halves of a turn — everything between prompt N and
 * prompt N+1 belongs to turn N, which the append-ordered transcript guarantees.
 *
 * `prompt`, `reasoning` and `summary` hold what a person and a model actually
 * wrote, and they are the only columns in berth that do. They are captured by
 * default because the whole point of a turn view is the flow — the ask, the
 * thinking, the answer — and a turn stripped of all three is a row of counters.
 *
 * **That default is a trust boundary, not a config detail.** It is right for a
 * team looking at its own machines and wrong the first time this points at
 * somebody else's: prompts and reasoning carry pasted secrets, customer names and
 * unreleased plans. `--no-content` turns it off in one flag, and shipping to a
 * customer means flipping which way that flag defaults, with consent attached.
 */
export const captureTurns = pgTable(
	"berth_capture_turns",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		sessionId: text("session_id").notNull(),
		/** Position in the session. The stable key, since turns have no shared id. */
		seq: integer("seq").notNull(),
		/** The harness's id for the prompt, when it recorded one. Joins to hooks. */
		promptId: text("prompt_id"),
		startedAt: timestamp("started_at", { withTimezone: true }),
		endedAt: timestamp("ended_at", { withTimezone: true }),
		/** CONTENT. What the human asked, verbatim. */
		prompt: text("prompt"),
		/** CONTENT. The agent's thinking for the turn — why, not just what. */
		reasoning: text("reasoning"),
		/** CONTENT. The agent's closing message for the turn. */
		summary: text("summary"),
		tools: integer("tools").notNull().default(0),
		files: integer("files").notNull().default(0),
		additions: integer("additions").notNull().default(0),
		deletions: integer("deletions").notNull().default(0),
		outputTokens: integer("output_tokens").notNull().default(0),
		/** HAR-34. Written as 1; `extra` beside it is what makes it useful. */
		schemaVersion: smallint("schema_version").notNull().default(1),
		extra: jsonb("extra"),
	},
	(table) => [
		uniqueIndex("one_turn_per_seq").on(table.orgId, table.sessionId, table.seq),
		index("berth_capture_turns_session_idx").on(table.orgId, table.sessionId),
		// The lexical half of search. One expression index over the three content
		// columns together, rather than three indexes ORed at query time: a turn
		// is one document, and its prompt, reasoning and summary are three parts
		// of it. `coalesce` because concatenating a NULL yields NULL, which would
		// silently drop every turn missing any one of the three.
		index("berth_capture_turns_fts_idx").using(
			"gin",
			sql`to_tsvector('english', coalesce(${table.prompt},'') || ' ' || coalesce(${table.reasoning},'') || ' ' || coalesce(${table.summary},''))`,
		),
	],
);

/**
 * A moment where a human chose, and what they chose.
 *
 * The rarest and most valuable thing in a transcript. A rejected plan normally
 * leaves no trace anywhere — not in git, not in a PR, not in an issue — and it is
 * the single best evidence of what an agent got wrong and was corrected on.
 *
 * `kind` is stored rather than inferred at read time because the shapes that
 * produce these differ per tool, and a reader rediscovering that is a reader that
 * will disagree with the writer.
 */
export const captureDecisions = pgTable(
	"berth_capture_decisions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		sessionId: text("session_id").notNull(),
		/** The turn it happened in. */
		seq: integer("seq").notNull(),
		at: timestamp("at", { withTimezone: true }),
		/** One of DECISION_KINDS. Text column, closed set held by a test. */
		kind: text("kind").notNull(),
		/** CONTENT. What was asked or proposed, verbatim. */
		detail: text("detail"),
		/** The tool that occasioned it, when there was one. Never content. */
		tool: text("tool"),
		/** CONTENT. One question from an AskUserQuestion, on its own row. */
		question: text("question"),
		/** CONTENT. The labels that were offered, JSON array of strings. */
		options: text("options"),
		/** CONTENT. What the human actually picked or typed. */
		answer: text("answer"),
		/**
		 * The answer matched none of the offered options — the human typed their own.
		 *
		 * The single most interesting bit in the whole decisions table. An agent
		 * offering three choices and the human writing a fourth is the agent having
		 * framed the question wrong, and that is invisible if the answer is stored
		 * as just another string.
		 */
		custom: boolean("custom"),
		/** HAR-34. Written as 1; `extra` beside it is what makes it useful. */
		schemaVersion: smallint("schema_version").notNull().default(1),
		extra: jsonb("extra"),
	},
	(table) => [
		index("berth_capture_decisions_session_idx").on(table.orgId, table.sessionId),
	],
);

/**
 * What a session turned out to be, in one row.
 *
 * The vocabulary is deliberately four words and none of them is a judgement of
 * the person. `fought` describes a transcript that contains a fight — repeated
 * failing commands, a rejected plan — and says nothing about whether the fight
 * was won or whether it should have happened.
 *
 * `progressed` beats `fought` when both are true, and that precedence is the
 * whole ethics of the label: a session that wrote code and also hit a wall is a
 * session that got somewhere, and filing it under the wall is how a weekly
 * summary starts insulting people. The wall is still reported, as a count, beside
 * the label.
 */
export const SESSION_OUTCOMES = ["progressed", "fought", "explored", "quiet"] as const;
export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

/**
 * One captured session, reduced to the row a weekly reflection can read.
 *
 * **Derived, and re-derivable, and that is the property the table exists for.**
 * Every field here is either a count or a verbatim quote with the citation it
 * came from — nothing is synthesized, so `berth_capture_*` remains the only
 * ground truth and this is a cache in front of it. Drop the table and
 * `berth digest` rebuilds it; there is no migration and no history to lose.
 *
 * `sourceFingerprint` is what makes that cheap. It is a digest of the counts the
 * derivation read — turns, events, last seq — so a session that grew since the
 * last pass has a different fingerprint and a session that did not is skipped
 * without touching a row. Staleness is therefore *detectable* rather than
 * assumed, which is the difference between a cache and a second source of truth
 * that quietly disagrees with the first.
 *
 * There is deliberately no `narrative` column. The moment a model writes prose
 * into this table, every reader downstream is citing something no human said, and
 * the citation stops meaning what it means everywhere else in berth. If that ever
 * lands it goes in a separate table that the retrieval path is forbidden to read.
 */
/**
 * The four moments a transcript records a human steering.
 *
 * Written as a vocabulary here rather than as a comment on the column because
 * three surfaces narrow against it — the collector that writes it, the mapper the
 * dashboard reads it through, and the summary that ranks unresolved questions
 * first. A closed `as const` over a `text` column means widening it is a
 * TypeScript change every call site sees, rather than a migration nobody notices.
 */
export const DECISION_KINDS = [
	"plan_proposed",
	"plan_rejected",
	"question_asked",
	"tool_denied",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export const sessionDigests = pgTable(
	"berth_session_digests",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		/** The harness session id. Joins to `berth_capture_sessions`. */
		sessionId: text("session_id").notNull(),
		/** Worktree basename — one workspace is one agent on a Conductor machine. */
		actor: text("actor"),
		branch: text("branch"),
		/**
		 * `owner/repo`, denormalized from `berth_capture_sessions.repo`.
		 *
		 * Denormalized so a windowed read can filter by repository without joining
		 * back through the capture table for every row. Null means **unknown**,
		 * never "no repo": 26 of the 106 sessions in this corpus predate
		 * `remoteFor()` in the collector, or came off a worktree git can no longer
		 * be asked about. A repository-scoped read excludes them and reports how
		 * many it set aside; it must never treat null as a wildcard.
		 */
		repo: text("repo"),
		startedAt: timestamp("started_at", { withTimezone: true }),
		endedAt: timestamp("ended_at", { withTimezone: true }),
		/** CONTENT, verbatim: the framing ask, clipped. Never a paraphrase. */
		title: text("title"),
		/** `<session>:<seq>` — where `title` was taken from, so it can be opened. */
		titleCite: text("title_cite"),
		/** One of SESSION_OUTCOMES. Text column, closed set held by a test. */
		outcome: text("outcome").notNull(),
		/**
		 * One of DISPOSITIONS. `unknown` on every row today, and that is honest
		 * rather than broken — see `src/disposition.ts` for why nothing captured
		 * can currently answer the question. The column exists so the vocabulary
		 * is fixed and the read surface has a shape to return; `dispositionOf` is
		 * the one place that will change when a collector records a starting
		 * commit.
		 */
		disposition: text("disposition").notNull().default("unknown"),
		turns: integer("turns").notNull().default(0),
		/** Edit/Write calls, never `additions` — that column is null on 96% of events. */
		writes: integer("writes").notNull().default(0),
		failures: integer("failures").notNull().default(0),
		/** Turns meeting the two-signal `stuck` test. Reported beside the label, not folded into it. */
		stuckTurns: integer("stuck_turns").notNull().default(0),
		/**
		 * JSON array of the paths with the most events — the "what was this about"
		 * answer, and the join key to a lease.
		 *
		 * Paths, not scopes. When this was written `berth_capture_sessions.repo`
		 * was null on every row, so a `scopes` column would have been null
		 * everywhere and a dead column is worse than no column. `remoteFor()` in
		 * the collector fixed the source (80 of 106 rows carry a slug now) and the
		 * `repo` column above carries it — but these stay paths, because a path is
		 * what the events recorded and composing `repo#path` at read time keeps
		 * the two facts separately falsifiable.
		 */
		topPaths: text("top_paths"),
		derivedAt: timestamp("derived_at", { withTimezone: true }).notNull().defaultNow(),
		/** Counts the derivation read. Different means the session grew; equal means skip. */
		sourceFingerprint: text("source_fingerprint").notNull(),
	},
	(table) => [
		uniqueIndex("one_digest_per_session").on(table.orgId, table.sessionId),
		index("berth_session_digests_actor_idx").on(table.orgId, table.startedAt),
		// The repository-filtered window. Two indexes rather than one because a
		// btree on (org_id, repo, started_at) cannot serve the repo-less range
		// scan: `repo` sits between the equality and the range. At this corpus
		// size neither matters and the planner will ignore both; they are here for
		// the shape, which is worth saying rather than pretending otherwise.
		index("berth_session_digests_window_idx").on(table.orgId, table.repo, table.startedAt),
	],
);

/**
 * What a session turned out to mean for the work, as opposed to what it did.
 *
 * **Every one of these is a claim about an object the capture can see** — a
 * commit, a branch ref, its absence, or nothing at all. None of them is a claim
 * about a destination, which is why `shipped`, `merged`, `released` and `landed`
 * are banned (`SETTLED_VERBS` in `recall.ts`) and these four are not. Mainline
 * arrival is a strictly stronger claim needing `git merge-base --is-ancestor` or
 * patch equivalence, and nothing here has either.
 *
 * `committed` is the dangerous one: read quickly it says `merged`, and
 * `assertNoSettledVerbs` will not catch it because the word is not on the list.
 * `renderDisposition` in `disposition.ts` therefore renders phrases, never these
 * bare words, and a test asserts it.
 */
export const DISPOSITIONS = ["committed", "preserved", "discarded", "unknown"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/**
 * Where a claim came from, and therefore what a reader is allowed to do with it.
 *
 * The vocabulary is `harbor/models.py`'s — that file already tags every field
 * `[raw]` / `[derived]` / `[joined]` / `[never]` — with one tier added for the
 * thing berth does not yet do.
 *
 *   - **extractive** — verbatim corpus bytes. A quote, with the row it came from.
 *   - **derived** — a deterministic observation over rows. Counts, patterns.
 *     The rule *is* the support: it is checkable, and checking it is the claim.
 *   - **synthesized** — model output. Support is **not** assumed, and `learn.ts`
 *     is the only writer: every row it produces carries at least one citation
 *     `verifyEvidence()` confirmed is a byte-substring of a real turn.
 *
 * `docs/RECALL.md` is where the last one comes from: *"If a model ever writes
 * into this path, it writes into a separate column that the retrieval path is
 * forbidden to read."* `berth_learnings.tier` is that column, and the quarantine
 * is asserted in source text by `src/quarantine.test.ts` rather than trusted.
 *
 * **This header used to name `schema-integrity.test.ts` as the file holding that
 * line, and that file never asserted it** — no case in it mentioned the
 * quarantine at all, so the claim was prose describing prose for as long as it
 * stood. `src/quarantine.test.ts` reads the four forbidden modules' source with
 * `readFileSync` and fails if any of them names `berth_learnings` or
 * `berth_kb_pages`, and it counts the files it read so a rename cannot make it
 * pass vacuously.
 *
 * The boundary moved in one respect, deliberately: the KB read path
 * (`kbrecall.ts`, over `berth_kb_pages`) may now **disclose** `tier` on every
 * block it returns, rather than being banned from the table — a reader who is
 * told which lines are model output can discount them, and a reader who is told
 * nothing cannot.
 */
export const PROVENANCE_TIERS = ["extractive", "derived", "synthesized"] as const;
export type ProvenanceTier = (typeof PROVENANCE_TIERS)[number];

/**
 * What a learning is *about*, which decides how it is keyed and how it is found.
 *
 * Five scopes, because a fact about one run, a fact about a file, a fact about a
 * review, a fact about a ticket and a fact about how this team works have
 * different lifetimes and different join keys:
 *
 *   - `session` — `scopeKey` is the harness session id.
 *   - `file` — `scopeKey` is `owner/repo#path`. Keyed to the repository slug
 *     rather than the worktree on purpose: a note keyed to a worktree name
 *     evaporates when the worktree is deleted, and 70 of 98 sessions in this
 *     corpus came off directories that no longer exist.
 *   - `general` — `scopeKey` is the empty string.
 *   - `pr` — `scopeKey` is `owner/repo#<number>`, taken from
 *     `berth_capture_sessions.pr_repo` and `pr_number`. **`pr_repo`, not
 *     `repo`**: a fork's pull request lives on the upstream repository, so
 *     keying it by the worktree's own slug files it under a repository the
 *     review cannot be found in. See the note on those two columns.
 *   - `ticket` — `scopeKey` is the bare ticket key, uppercased (`HAR-24`),
 *     matched by `/\b[A-Z][A-Z0-9]{1,9}-\d+\b/`. No URL and no project prefix:
 *     the key is what a person types and what a branch name carries, and a
 *     tracker URL is a second spelling of the same fact that only one of the two
 *     writers would remember to normalise.
 *
 * Widening this list is a TypeScript change every call site sees, which is the
 * feature — `scope_kind` is a `text` column with no CHECK, so the compiler is
 * the only thing that notices a new member needs a key format.
 */
export const LEARNING_SCOPES = ["session", "file", "general", "pr", "ticket"] as const;
export type LearningScope = (typeof LEARNING_SCOPES)[number];

/**
 * The closed vocabulary of derived learnings, and what each one is allowed to
 * assert.
 *
 * The four `[candidate]` kinds are the ones that must never render as an
 * established fact. `strengthenedBy` is required on those rows, and it names the
 * threshold the evidence did not clear — an unlabelled inference is the thing
 * this whole layer is arranged against.
 *
 * Two of them are deliberately weaker than the obvious version, because the
 * corpus cannot support the obvious version. All 317 error rows carry
 * `tool is null`, `path is null` and `detail is null`: the `is_error` flag lands
 * on the `tool_result` record, whose sibling `tool_use` record — the one holding
 * the tool name and the path — is joined only by a `tool_use_id` the collector
 * never persists. So `failure-resolution` is turn-level rather than path-level,
 * and `recurring-failure` matches the same *command* rather than the same error
 * text. Both say so on the row.
 *
 * ## The last three are the model's, and they were added rather than swapped in
 *
 * `lesson`, `what-worked` and `failure-cause` are the only kinds a model may
 * emit, and `derive.ts` is type-forbidden from emitting them — `LearningWrite`
 * carries the deterministic kinds and `SynthesizedWrite` carries these, so the
 * two paths cannot be confused by a caller passing the wrong string.
 *
 * They were **added, never renamed onto the eight above.** A rename reads like
 * tidying and is a data migration over `berth_learnings.kind` plus the ordering
 * CASE in `derive.ts`, `CANDIDATE_KINDS`, and four literal sites in
 * `candidates.ts` — every one of them changed to make one piece of prose match
 * another. The overlap the rename would have chased is already there: a
 * `file-note` is the existing `revisited-file`, and `unresolved-question` is
 * spelled the same in both vocabularies.
 */
export const LEARNING_KINDS = [
	"work-attempted",
	"unresolved-question",
	"validation-activity",
	"revisited-file",
	"failure-resolution",
	"re-exploration",
	"recurring-failure",
	"cost-to-learn",
	// Written only by `learnings.ts`, only on `tier = 'synthesized'`. They are here
	// rather than in a second vocabulary because `kind` is one column and two
	// vocabularies over one column is how a reader ends up unable to enumerate it.
	// `unresolved-question` above is shared deliberately: a model finding an open
	// question and a rule finding one are the same claim, and somebody filtering for
	// open questions wants both.
	"lesson", // a durable fact a future engineer would want before starting
	"failure-cause", // why something broke — NOT `failure-resolution`, which claims a fix
	"what-worked", // an approach worth repeating
	"file-note", // what to know before editing a specific file
] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];

/** The kinds that are inferences, not observations. Rendered `[candidate]`. */
export const CANDIDATE_KINDS = [
	"failure-resolution",
	"re-exploration",
	"recurring-failure",
	"cost-to-learn",
] as const satisfies readonly LearningKind[];

export function isCandidateKind(kind: string): boolean {
	return (CANDIDATE_KINDS as readonly string[]).includes(kind);
}

/**
 * The kinds a model may emit. Disjoint from what `derive()` can write.
 *
 * Disjointness is the point, and it is what makes `tier` auditable at all: if a
 * synthesized row could wear a deterministic kind, a reader who filtered by kind
 * would silently take model output for a count. `satisfies readonly
 * LearningKind[]` keeps the two lists from drifting — a member deleted from
 * `LEARNING_KINDS` fails here rather than in the query that stops matching.
 */
export const SYNTHESIZED_KINDS = [
	"lesson",
	"what-worked",
	"failure-cause",
] as const satisfies readonly LearningKind[];
export type SynthesizedKind = (typeof SYNTHESIZED_KINDS)[number];

export function isSynthesizedKind(kind: string): boolean {
	return (SYNTHESIZED_KINDS as readonly string[]).includes(kind);
}

/**
 * What the derivation produced, stored so that reading it is cheap and citing it
 * is possible.
 *
 * **This is the table `berth_session_digests` refuses to become.** That one is a
 * cache of counts in front of the capture tables and says in its own header that
 * a `narrative` column would poison every reader downstream. This is the separate
 * table that header points at: it holds prose, it is allowed to hold model output
 * one day, and `recall.ts` / `nav.ts` / `digest.ts` / `reflect.ts` are forbidden
 * to read it. `src/quarantine.test.ts` asserts that in source text, because a
 * behavioural test only covers the paths it happens to take.
 *
 * **That file is new, and the claim was false until it existed.** This header
 * and the one on `PROVENANCE_TIERS` both named `schema-integrity.test.ts`, which
 * has never contained the word `learnings` in an assertion. The prohibition held
 * anyway — by discipline, which is the thing the sentence was claiming it did
 * not rest on.
 *
 * The KB read path is the one deliberate opening: `kbrecall.ts` serves
 * `berth_kb_pages`, and every block it returns **discloses its `tier`** instead
 * of the module being banned from the table. Disclosure per block is a stronger
 * guarantee than a per-module ban, because the ban protects only the modules
 * somebody remembered to list.
 *
 * Three properties make a wrong row survivable:
 *
 *   - **Nothing is deleted.** A moved `sourceFingerprint` marks prior rows
 *     `stale`; the new run supersedes by `runId`. Stale rows drop out of reads
 *     and stay inspectable, so "this used to say something else" is answerable.
 *   - **Every substantive row is citable.** `berth_learning_evidence` carries a
 *     verbatim excerpt and the turn it came from. A learning nobody can open is a
 *     claim; a learning that opens its turn is a citation.
 *   - **`tier` is the quarantine boundary**, not a display hint. `derive.ts`
 *     cannot express `synthesized` — its write type narrows to two of the three
 *     — and `learn.ts` cannot write a row without a verified citation.
 */
export const learnings = pgTable(
	"berth_learnings",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		/** One of LEARNING_SCOPES. */
		scopeKind: text("scope_kind").notNull(),
		/** Session id, `owner/repo#path`, or `''` for general. Never null. */
		scopeKey: text("scope_key").notNull(),
		/** One of LEARNING_KINDS. Text column, closed set held by a test. */
		kind: text("kind").notNull(),
		/** The claim, as a person would read it. Prose, and the only prose here. */
		body: text("body").notNull(),
		/** One of PROVENANCE_TIERS. The quarantine boundary. */
		tier: text("tier").notNull(),
		/**
		 * Distinguishes several statements of the same kind about the same subject in
		 * one pass. Always 0 for `derive`, which produces one by construction.
		 */
		ordinal: integer("ordinal").notNull().default(0),
		/**
		 * `ceil(body.length / 4)`, stored rather than recomputed so a read can be
		 * packed against a token ceiling without measuring every candidate row
		 * first. Same estimator as `recall.ts`, deliberately — two definitions of
		 * a token budget diverge on the first row that straddles the limit.
		 */
		tokens: integer("tokens").notNull(),
		/** What would turn a `[candidate]` into a fact. Required on candidate kinds. */
		strengthenedBy: text("strengthened_by"),
		/** The derivation pass that wrote this. Supersession is by run, not by row. */
		runId: uuid("run_id").notNull(),
		/** The evidence shape this was derived from. Moves ⇒ prior rows go stale. */
		sourceFingerprint: text("source_fingerprint").notNull(),
		/** Excluded from reads by default, never deleted. */
		stale: boolean("stale").notNull().default(false),
		/**
		 * Lowercase-hyphenated labels, for the `topic` pages and the `--tag`
		 * filter. Written by both writers: `tagsFor()` on the deterministic path,
		 * the model on the synthesized one, both screened by `validate()`.
		 *
		 * `text[]` rather than a join table because a tag has no attributes and
		 * never will — the only questions asked of it are "which rows carry it"
		 * and "what tags exist", and a GIN index answers both. The idiom is
		 * `berth_devices.scopes`'.
		 */
		tags: text("tags").array().notNull().default(sql`'{}'`),
		/**
		 * When this row should be looked at again by a person. Null means never
		 * scheduled — **not** "reviewed", which is a fact this column cannot
		 * express and must not be read as.
		 */
		needsReviewAt: timestamp("needs_review_at", { withTimezone: true }),
		/**
		 * The branch the work was observed on, from `Digest.branch`. Null on a
		 * Codex session, which records no branch at all — resolving it at read
		 * time would answer for today's checkout rather than that session's.
		 */
		observedBranch: text("observed_branch"),
		/**
		 * **Null on every row today, and shipped that way on purpose.** The
		 * collector records no starting commit, which is the same gap that makes
		 * `berth_session_digests.disposition` `unknown` everywhere. The column
		 * exists so the shape is fixed and the renderer has something to print
		 * `—` for; filling it is a capture-pipeline change, not a memory one, and
		 * inventing a value here would answer with today's HEAD.
		 */
		observedCommit: text("observed_commit"),
		/**
		 * Does this row tell the reader to do something, rather than report what
		 * happened?
		 *
		 * Stored rather than re-detected, because the gate downstream is a policy
		 * decision and a regex that drifts silently changes which rows are
		 * published. An imperative row is written freely and **refused by the
		 * compiler** until a `berth_learning_approvals` row exists for it: the
		 * row has to exist for a person to approve it, so gating at write time
		 * would make approval unreachable.
		 */
		imperative: boolean("imperative").notNull().default(false),
		/**
		 * Withdrawn by a person, never deleted — and a **different fact from
		 * `stale`**. `stale` says a later pass superseded this row; this says a
		 * human read it and did not want it served. Collapsing the two loses the
		 * distinction the whole nothing-is-deleted rule exists to keep, so the
		 * read filters name them separately and `includeSuppressed` is its own
		 * flag.
		 */
		suppressedAt: timestamp("suppressed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		// One row per claim per pass. Re-running a pass converges rather than
		// duplicating, which is what makes `berth derive` safe to run on a loop.
		// `ordinal` is in the key so a pass can write more than one statement about the
		// same subject. `derive` always writes 0 and is unaffected; a model returns
		// several lessons about one session, and without this they were concatenated
		// into a single row — measured at 4,713 characters and eight distinct lessons
		// on the first live run, individually uncitable and all-or-nothing to a
		// token-budgeted reader.
		uniqueIndex("one_learning_per_run").on(
			table.orgId, table.scopeKind, table.scopeKey, table.kind, table.runId,
			table.ordinal,
		),
		// The read path: everything asks "current learnings for this scope".
		index("berth_learnings_scope_idx")
			.on(table.orgId, table.scopeKind, table.scopeKey)
			.where(sql`stale is false`),
		// The `topic` page and `berth learnings --tag`. GIN because the predicate
		// is containment over an array, which a btree cannot serve at all.
		index("berth_learnings_tags_idx").using("gin", table.tags),
		// What the compiler actually scans: live rows for a scope. Narrower than
		// `berth_learnings_scope_idx` by one predicate, and kept as its own index
		// rather than a widening of it, because the existing one is read by the
		// paths that do not know about suppression and must keep their plan.
		index("berth_learnings_live_idx")
			.on(table.orgId, table.scopeKind, table.scopeKey)
			.where(sql`stale is false and suppressed_at is null`),
	],
);

/**
 * The citation that makes a learning checkable.
 *
 * `excerpt` is a **genuine byte-substring** of `field` on the row named by
 * `(sessionId, turnSeq)`. Not normalized, not whitespace-collapsed, no ellipsis
 * — `Digest.title` does `replace(/\s+/g, " ")` and is therefore *not* a substring
 * of its own prompt, which is exactly the trap this column exists to avoid.
 * Marking truncation is the renderer's job.
 *
 * Substring proves **authenticity** — that the quote is real. It does not prove
 * **support** — that the quote backs the claim. For a `derived` row support is
 * structural: the rule is checkable and the check is the claim. For a
 * `synthesized` row it is not assumed at all, which is why none exist yet.
 */
export const learningEvidence = pgTable(
	"berth_learning_evidence",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		learningId: uuid("learning_id")
			.notNull()
			.references(() => learnings.id, { onDelete: "cascade" }),
		sessionId: text("session_id").notNull(),
		turnSeq: integer("turn_seq").notNull(),
		/** The harness's own record id, when the excerpt came from one event. */
		recordUuid: text("record_uuid"),
		/** Which column the excerpt was taken from. The verifier cannot work without it. */
		field: text("field").notNull(),
		excerpt: text("excerpt").notNull(),
	},
	(table) => [
		index("berth_learning_evidence_learning_idx").on(table.learningId),
		index("berth_learning_evidence_session_idx").on(table.orgId, table.sessionId),
	],
);

/**
 * The states a derivation pass can be in.
 *
 * A bare `analyzed` boolean cannot tell *not yet* from *tried twice and failed*,
 * and those want opposite responses. `excluded` is the fifth because "we decided
 * not to" is not a failure and should not be retried.
 *
 * **A memo hit leaves `done` and stamps `reusedAt`.** Re-deriving a session whose
 * fingerprint has not moved is not a state transition, and modelling it as one
 * makes `reuse_count` unreadable.
 */
export const ENRICH_STATES = ["pending", "running", "done", "failed", "excluded"] as const;
export type EnrichState = (typeof ENRICH_STATES)[number];

/**
 * What has been derived, what is in flight, and what failed — per session, per
 * pass.
 *
 * Separate from `berth_session_digests` because that table is explicitly
 * droppable and rebuilt wholesale, and the record of *"we tried this twice and it
 * failed both times"* must survive a rebuild. It is also what makes a status line
 * possible: "106 captured, 94 derived, 3 pending, 2 failed" is a sentence about
 * the system that no count of digests can produce.
 */
export const enrichRuns = pgTable(
	"berth_enrich_runs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		sessionId: text("session_id").notNull(),
		runId: uuid("run_id").notNull(),
		/** The evidence shape this pass read. Compared to decide a memo hit. */
		sourceFingerprint: text("source_fingerprint").notNull(),
		/** One of ENRICH_STATES. */
		state: text("state").notNull(),
		attempts: integer("attempts").notNull().default(0),
		/** Stamped on a memo hit. Not a state transition — `state` stays `done`. */
		reusedAt: timestamp("reused_at", { withTimezone: true }),
		reuseCount: integer("reuse_count").notNull().default(0),
		/** Verbatim, and redacted before it gets here. Null unless `state = 'failed'`. */
		error: text("error"),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("one_enrich_run_per_session").on(table.orgId, table.sessionId, table.runId),
		index("berth_enrich_runs_state_idx").on(table.orgId, table.state),
	],
);

/**
 * Where one session is in the model pass.
 *
 * Spelled like `ENRICH_STATES` and deliberately not shared with it. `skipped` is
 * the fifth rather than `excluded` because it names a different decision: a
 * poison session that failed `LEARN_MAX_ATTEMPTS` times is *stopped*, not
 * *chosen against*, and a run that cannot tell those apart retries the one it
 * should leave alone and leaves alone the one somebody asked for.
 */
export const LEARN_STATES = ["pending", "running", "done", "failed", "skipped"] as const;
export type LearnState = (typeof LEARN_STATES)[number];

/**
 * The queue the model pass claims from — one row per session, not per pass.
 *
 * **A new table rather than a fourth use of `berth_enrich_runs`.** That one is
 * keyed `(org_id, session_id, run_id)`, which is a per-*pass* key: it can say
 * "this pass did this to this session" and cannot say "this session is waiting",
 * because every new run mints a new key and every old row stays `done`. It also
 * already owns a semantics this queue must not inherit — a memo hit there is not
 * a state transition — and nothing has ever written `pending` or `running` into
 * it. Overloading it would have meant two meanings of `state` in one column,
 * decided by which writer touched the row last.
 *
 * The unique key is `(org_id, session_id)`, so `enqueueLearn` is an upsert and
 * running it on a loop converges. Claiming is `pg_advisory_xact_lock` over
 * `hashtextextended(org || ':' || session)` plus a conditional `update … where
 * state='pending'`: the lock serialises two workers that arrive together, and
 * the `where` is what makes the loser's claim return zero rows rather than a
 * second copy of the same work.
 *
 * `error` holds the failure verbatim, sliced to 500 characters. **No credential
 * ever reaches it** — the backend is forbidden from putting the API key in a
 * thrown message precisely so this column cannot become the place it is stored.
 */
export const learnJobs = pgTable(
	"berth_learn_jobs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		sessionId: text("session_id").notNull(),
		/** One of LEARN_STATES. Text column, closed set held by a test. */
		state: text("state").notNull().default("pending"),
		/** Incremented on claim. `>= LEARN_MAX_ATTEMPTS` moves the row to `skipped`. */
		attempts: integer("attempts").notNull().default(0),
		/** The evidence shape enqueued. A moved fingerprint re-opens a `done` row. */
		sourceFingerprint: text("source_fingerprint").notNull(),
		enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
		/** Verbatim, sliced to 500. Null unless `state = 'failed'`. */
		error: text("error"),
	},
	(table) => [
		uniqueIndex("one_learn_job_per_session").on(table.orgId, table.sessionId),
		index("berth_learn_jobs_state_idx").on(table.orgId, table.state),
	],
);

/**
 * What kinds of page the knowledge base compiles into.
 *
 * `dir` is the one worth explaining: its `page_key` carries a **trailing
 * slash** (`owner/repo#src/lib/`), which is what turns ancestor lookup into a
 * sequence of equality matches walking up the path rather than a `like` scan
 * over every page in the org. The slash is not cosmetic and the compiler and the
 * reader must agree on it.
 */
export const KB_PAGE_KINDS = ["file", "dir", "repo", "topic", "pr", "ticket"] as const;
export type KbPageKind = (typeof KB_PAGE_KINDS)[number];

/**
 * The compiled pages the memory read serves — and the one place in this codebase
 * where something is precomputed.
 *
 * `docs/RECALL.md` argues the opposite for the corpus search, and it is right
 * there: *"Nothing is precomputed, so nothing can be stale."* That property is
 * bought with a query per read, which is affordable when the read is one person
 * at a terminal and is not when it is every agent opening every file. So this
 * layer takes the other trade and pays the honest price — a page can be stale,
 * therefore **every page states when it was compiled** and `KbRecallResult`
 * surfaces the *oldest* contributing page's timestamp rather than the newest.
 * Reporting the newest would let one fresh page hide a stale answer.
 *
 * `source_fingerprint` here is computed by `pageFingerprint()` from the
 * contributing learning ids and their `created_at`, and **is not**
 * `berth_learnings.source_fingerprint`: that column holds the literal string
 * `"window"` on cross-session rows and five colon-joined counts otherwise,
 * neither of which moves when the page's contents change. A recompile whose
 * fingerprint matches leaves the row alone and counts it `unchanged`.
 */
export const kbPages = pgTable(
	"berth_kb_pages",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		/** One of KB_PAGE_KINDS. */
		pageKind: text("page_kind").notNull(),
		/** The scope key this page answers for; `dir` keys end in `/`. */
		pageKey: text("page_key").notNull(),
		/** What a person reads at the top. The path, the slug, the tag. */
		title: text("title").notNull(),
		/** `KbBlock[]`, in the pinned order, already packed to KB_MAX_BLOCKS_PER_PAGE. */
		blocks: jsonb("blocks").notNull().default(sql`'[]'::jsonb`),
		/** Sum of the blocks' token estimates, so a read can pack without parsing. */
		tokens: integer("tokens").notNull().default(0),
		/** The learnings this page was built from. The fingerprint's input. */
		learningIds: uuid("learning_ids").array().notNull().default(sql`'{}'`),
		compiledAt: timestamp("compiled_at", { withTimezone: true }).notNull().defaultNow(),
		/** `pageFingerprint()` of the contributing rows. Unchanged ⇒ no rewrite. */
		sourceFingerprint: text("source_fingerprint").notNull(),
	},
	(table) => [
		uniqueIndex("one_kb_page_per_key").on(table.orgId, table.pageKind, table.pageKey),
		index("berth_kb_pages_compiled_idx").on(table.orgId, table.compiledAt),
	],
);

/**
 * Which rung of the resolution ladder produced an answer.
 *
 * `"symbol"` is **reserved and never returned today.** There is no symbol index
 * in this tree and building one is a separate project; the value is here so that
 * adding the rung later is an implementation change rather than a vocabulary
 * change that every stored `berth_recall_log` row predates.
 *
 * `"none"` is a real answer, not an error. Nothing learned about a path is the
 * honest response to most paths, and a surface that renders it as a failure
 * teaches agents to stop asking.
 */
export const RECALL_RESOLUTIONS = [
	"exact-path",
	"dir-ancestor",
	"repo",
	"symbol",
	"ticket",
	"tags",
	"index",
	"none",
] as const;
export type RecallResolution = (typeof RECALL_RESOLUTIONS)[number];

/** Which surface asked. Kept so a p95 can be read per surface, not blended. */
export const RECALL_SURFACES = ["cli", "mcp", "http", "demo"] as const;
export type RecallSurface = (typeof RECALL_SURFACES)[number];

/**
 * Every memory read, with what it cost.
 *
 * **This is the first measurement of the read path that exists in the tree.**
 * The `<500 ms p95` figure the design doc treats as a property to preserve is
 * not measured anywhere: the only `Date.now()` in `recall.ts` is inside
 * `parseSince`, and the 15–162 ms numbers in `docs/RECALL.md` are hand-run prose
 * from one laptop. A number nobody records is a number that drifts without a
 * symptom, so this table records one per call and the demo prints the p50/p95 of
 * the durations it just produced.
 *
 * `blocks_omitted` sits beside `blocks_returned` for the reason `budget()`
 * exists: a read that quietly returned four of eleven blocks has told the caller
 * with total confidence that there are four. Logging only what was served would
 * make a budget that is too small look like a corpus that is too thin.
 *
 * `selector` is the caller's own request, stored as jsonb. It holds paths and a
 * task sentence, which are work descriptions rather than transcript content —
 * but they are still the caller's words, so this table carries `org_id` and the
 * same three RLS policies as everything else.
 */
export const recallLog = pgTable(
	"berth_recall_log",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
		/** One of RECALL_SURFACES. */
		surface: text("surface").notNull(),
		/** The selector as asked — paths, task, repo, tags, ticket, index. */
		selector: jsonb("selector").notNull().default(sql`'{}'::jsonb`),
		/** One of RECALL_RESOLUTIONS. The rung that produced the first block. */
		resolution: text("resolution").notNull(),
		pagesRead: integer("pages_read").notNull().default(0),
		blocksReturned: integer("blocks_returned").notNull().default(0),
		/** What the budget cut. Never inferable from the row above. */
		blocksOmitted: integer("blocks_omitted").notNull().default(0),
		tokensSpent: integer("tokens_spent").notNull().default(0),
		durationMs: integer("duration_ms").notNull().default(0),
	},
	(table) => [index("berth_recall_log_at_idx").on(table.orgId, table.at)],
);

/**
 * Why two learnings cannot both be served as settled.
 *
 * Three reasons and no free text, because a reason a reader has to interpret is
 * a reason two readers interpret differently.
 */
export const CONFLICT_REASONS = [
	"contradictory-body",
	"imperative-unapproved",
	"scope-collision",
] as const;
export type ConflictReason = (typeof CONFLICT_REASONS)[number];

/**
 * Two rows that disagree, recorded rather than resolved.
 *
 * **Neither side is deleted and neither is hidden.** The compiler surfaces the
 * conflict *on the block* (`KbBlock.conflict`), so a reader sees the claim and
 * the fact that something contradicts it in the same breath. Silently dropping
 * the loser would make the memory layer confidently wrong exactly where it is
 * least trustworthy, and picking a winner is a judgement no rule here can make.
 *
 * `resolved_at` is stamped when somebody settles it; the row stays, because
 * "this was contested and then settled" is a different fact from "this was never
 * contested" and only one of them is evidence about the derivation.
 */
export const learningConflicts = pgTable(
	"berth_learning_conflicts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		learningId: uuid("learning_id")
			.notNull()
			.references(() => learnings.id, { onDelete: "cascade" }),
		conflictsWith: uuid("conflicts_with")
			.notNull()
			.references(() => learnings.id, { onDelete: "cascade" }),
		/** One of CONFLICT_REASONS. */
		reason: text("reason").notNull(),
		detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("one_conflict_per_pair").on(
			table.orgId, table.learningId, table.conflictsWith,
		),
		index("berth_learning_conflicts_learning_idx").on(table.learningId),
	],
);

/**
 * A person saying an imperative row may be served.
 *
 * The gate exists because an imperative learning is the only thing this system
 * writes that tells a reader what to *do*, and a wrong instruction is acted on
 * where a wrong observation is merely read. Two conditions, both required: at
 * least `IMPERATIVE_SESSIONS_REQUIRED` **distinct evidence sessions**, so one
 * unusual afternoon cannot become policy, and a row here.
 *
 * `distinct_sessions` is stored as it stood at approval time rather than
 * recomputed. The count can only grow, and an approval that silently re-derives
 * is an approval nobody can date — the question a reader asks is what the
 * approver saw, not what is true now.
 *
 * `approved_by` is a plain string. It is whoever ran the command, not a foreign
 * key into `berth_engineers`: the CLI can be run on a machine that has no
 * engineer row at all, and a null approver on a gate this sharp is worse than an
 * unverified name.
 */
export const learningApprovals = pgTable(
	"berth_learning_approvals",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		learningId: uuid("learning_id")
			.notNull()
			.references(() => learnings.id, { onDelete: "cascade" }),
		/** Whoever ran the verb. Deliberately not a foreign key — see the header. */
		approvedBy: text("approved_by").notNull(),
		approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
		/** The count as it stood when this was approved. Never recomputed. */
		distinctSessions: integer("distinct_sessions").notNull().default(0),
		note: text("note"),
	},
	(table) => [
		uniqueIndex("one_approval_per_learning").on(table.orgId, table.learningId),
	],
);

/**
 * What a grader thought of a learning.
 *
 * Four grades, and the split between `wrong` and `unsupported` is the one that
 * carries information: a claim that is false and a claim whose citation does not
 * back it are different defects with different fixes — the first is the model
 * inventing, the second is the citation spine leaking — and a single `bad` would
 * make the two indistinguishable in exactly the corpus meant to tell them apart.
 */
export const LEARNING_GRADES = ["useful", "harmless", "wrong", "unsupported"] as const;
export type LearningGrade = (typeof LEARNING_GRADES)[number];

/**
 * The shadow evaluation's rows.
 *
 * The table ships and the `berth eval` command does not: the dashboard already
 * promises a shadow evaluation, and a grading CLI with no graded corpus is
 * furniture. Multiple rows per learning are allowed on purpose — two graders
 * disagreeing is the measurement, not a constraint violation — so there is no
 * unique index here, only the lookup by learning.
 */
export const learningGrades = pgTable(
	"berth_learning_grades",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		learningId: uuid("learning_id")
			.notNull()
			.references(() => learnings.id, { onDelete: "cascade" }),
		/** Who graded. A person's handle, or the name of the judge that ran. */
		grader: text("grader").notNull(),
		/** One of LEARNING_GRADES. */
		grade: text("grade").notNull(),
		note: text("note"),
		gradedAt: timestamp("graded_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [index("berth_learning_grades_learning_idx").on(table.learningId)],
);

export type LeaseRow = typeof leases.$inferSelect;
export type SignalRow = typeof signals.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type EdgeRow = typeof edges.$inferSelect;
export type MarkRow = typeof marks.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type PresenceRow = typeof presence.$inferSelect;
export type ActivityRow = typeof activity.$inferSelect;
export type EngineerRow = typeof engineers.$inferSelect;
export type MachineRow = typeof machines.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
export type CaptureSessionRow = typeof captureSessions.$inferSelect;
export type CaptureEventRow = typeof captureEvents.$inferSelect;
export type CaptureTurnRow = typeof captureTurns.$inferSelect;
export type CaptureDecisionRow = typeof captureDecisions.$inferSelect;
export type SessionDigestRow = typeof sessionDigests.$inferSelect;
export type LearningRow = typeof learnings.$inferSelect;
export type LearningEvidenceRow = typeof learningEvidence.$inferSelect;
export type EnrichRunRow = typeof enrichRuns.$inferSelect;

/**
 * What a background agent run is doing, and what it turned into.
 *
 * **Why a table at all, when a session is already the record.** A session exists
 * only *after* the agent finishes and `collect` pushes it — minutes later, and
 * never at all if the container died. Between "somebody pressed the button" and
 * that moment there is nothing to render, so a dashboard built on sessions alone
 * shows an empty list and no way to tell "still working" from "it broke". This is
 * the row that exists from the first instant.
 *
 * **`no_changes` is a state, not a failure**, and it is the same distinction
 * `openPullRequest` draws between "no commits between" and a refusal. An agent
 * that ran, read the code, and correctly concluded there was nothing to do has
 * succeeded; filing it under `failed` would train everybody to ignore the column.
 * It is also the single likeliest outcome of a badly-scoped prompt, so it wants
 * its own word rather than a shrug.
 *
 * The five states follow `berth_enrich_runs`' reasoning verbatim: a boolean
 * cannot tell *not yet* from *tried and failed*, and those want opposite
 * responses from a reader.
 *
 * `session_id` is nullable and stays that way for the life of a failed run. It is
 * filled by the container reporting back after `collect`, so a null means the
 * capture never landed — which is a different fact from the run failing, and one
 * worth being able to ask about.
 *
 * **`repo` is nullable only for history.** Every run names a repository now —
 * `agents.start` requires it and `task.sh` refuses an unset `BERTH_REPO` at its
 * first line. The column stays nullable because rows written while the scratch
 * mode existed carry a null, and rewriting them would be inventing a repository
 * those runs never had.
 */
export const AGENT_RUN_STATES = ["queued", "running", "done", "no_changes", "failed"] as const;
export type AgentRunState = (typeof AGENT_RUN_STATES)[number];

export const agentRuns = pgTable(
	"berth_agent_runs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		/** The engineer who asked for it. Null for a run started by a machine. */
		requestedBy: uuid("requested_by"),
		prompt: text("prompt").notNull(),
		/** `owner/name`. Null only on rows that predate the requirement. */
		repo: text("repo"),
		baseRef: text("base_ref"),
		branch: text("branch"),
		/** One of AGENT_RUN_STATES. */
		state: text("state").notNull().default("queued"),
		/** Modal's function-call id, so a run can be found in their dashboard too. */
		modalCallId: text("modal_call_id"),
		/** The captured session, once the container has pushed it. */
		sessionId: text("session_id"),
		prUrl: text("pr_url"),
		prNumber: integer("pr_number"),
		/** Verbatim, and redacted before it gets here. Null unless `state = 'failed'`. */
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		startedAt: timestamp("started_at", { withTimezone: true }),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
		/**
		 * Filed away, not deleted.
		 *
		 * A run is a record of compute somebody spent and of a pull request
		 * somebody may still be reviewing, so the list needs a way to get quiet
		 * without the history getting shorter. A delete would take the row that
		 * explains where a branch came from with it.
		 *
		 * A timestamp rather than a boolean, for the same reason `removed_at` is
		 * one everywhere else in this schema: "archived" and "archived on
		 * Tuesday" cost the same to store and only one of them can answer a
		 * question later.
		 */
		archivedAt: timestamp("archived_at", { withTimezone: true }),
	},
	(table) => [
		// The list query: newest first, one org.
		index("berth_agent_runs_org_idx").on(table.orgId, table.createdAt),
		// "what is in flight" without scanning the history.
		index("berth_agent_runs_state_idx").on(table.orgId, table.state),
		// The list as it is actually asked: the unarchived ones, newest first.
		// Partial, so the index does not carry the rows the query excludes.
		index("berth_agent_runs_live_idx")
			.on(table.orgId, table.createdAt)
			.where(sql`${table.archivedAt} is null`),
	],
);

/**
 * Which GitHub installation belongs to which org.
 *
 * **`pullRequests`' header says this table becomes necessary the moment an *org*
 * has to be resolved from an installation rather than the other way round. That
 * moment is now.** `installationForRepo` asks GitHub which installation covers a
 * repository, which needs no row and is still how a token is minted. But the
 * repository *picker* runs the other way: it starts from a signed-in reader and
 * has to produce the repositories their org may point an agent at. Without this
 * row that question has no answer, and the only implementation available is
 * "list whatever installation this token happens to be for" — which, under one
 * App shared by every customer, lists somebody else's repositories.
 *
 * So the row is a tenancy boundary, not a cache. It is written when a person
 * completes the App's install flow while signed in, which is the one moment both
 * halves — the installation id and the org — are known to be the same person's.
 *
 * **`account_login` is stored though it can be re-fetched**, because it is what a
 * settings screen has to render to say *which* GitHub account is connected, and
 * a page that must call GitHub to name what it already linked is a page that
 * breaks when GitHub is slow.
 *
 * More than one row per org is allowed on purpose: a company with repositories
 * under two GitHub orgs installs twice, and modelling that as a column on
 * `berth_orgs` would have made the second install silently replace the first.
 * `removed_at` rather than a delete, so an uninstall keeps the history that
 * explains why runs stopped working on a Tuesday.
 */
export const githubInstallations = pgTable(
	"berth_github_installations",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id").notNull(),
		/** GitHub's installation id. Bigint because it is theirs to grow, not ours. */
		installationId: bigint("installation_id", { mode: "number" }).notNull(),
		/** The GitHub org or user the App is installed on. */
		accountLogin: text("account_login"),
		/** `all` or `selected`, as GitHub reports it. Rendered, never trusted. */
		repositorySelection: text("repository_selection"),
		/** The engineer who completed the install. */
		installedBy: uuid("installed_by"),
		/**
		 * `Organization` or `User`, which decides where "Manage on GitHub" points.
		 *
		 * A personal installation lives at `/settings/installations` and an
		 * organization's at `/organizations/<login>/settings/installations`.
		 * Guessing wrong is a 404 at the end of the only link that lets somebody
		 * change what berth can see.
		 */
		accountType: text("account_type"),
		/**
		 * GitHub suspended this installation. **Not the same as removed.**
		 *
		 * A suspension lifts; a removal is a decision. They are also different
		 * behaviour in the sync — GitHub refuses to mint a token for a suspended
		 * installation, so asking anyway spends a round trip to be counted
		 * `unreachable`, which reads as an outage rather than a state with a fix.
		 */
		suspendedAt: timestamp("suspended_at", { withTimezone: true }),
		lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
		/**
		 * `summarise()`'s line, verbatim.
		 *
		 * Text rather than a status because "3 unreachable" means wait and "3
		 * no-installation" means tick the repository on GitHub, and a boolean
		 * cannot carry that difference to the person who can act on it.
		 */
		lastSyncNote: text("last_sync_note"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		removedAt: timestamp("removed_at", { withTimezone: true }),
	},
	(table) => [
		// One live row per installation, globally — an installation belongs to one
		// org, and a second org claiming it is the tenancy failure this table
		// exists to prevent, not a duplicate to tolerate.
		uniqueIndex("one_org_per_installation")
			.on(table.installationId)
			.where(sql`removed_at is null`),
		// The pull-request sync's hot path: owner → installation, scoped to one
		// org. Case-insensitive because GitHub logins are, and
		// `berth_capture_sessions.repo` arrives spelled however
		// `git remote get-url origin` wrote it — `Harbor-So/berth` and
		// `harbor-so/berth` are one repository and must not be one connected and
		// one not.
		index("berth_github_installations_owner_idx")
			.on(table.orgId, sql`lower(${table.accountLogin})`),
		index("berth_github_installations_org_idx").on(table.orgId),
	],
);
export type KbPageRow = typeof kbPages.$inferSelect;
export type RecallLogRow = typeof recallLog.$inferSelect;
export type LearnJobRow = typeof learnJobs.$inferSelect;
export type LearningConflictRow = typeof learningConflicts.$inferSelect;
export type LearningApprovalRow = typeof learningApprovals.$inferSelect;
export type LearningGradeRow = typeof learningGrades.$inferSelect;
