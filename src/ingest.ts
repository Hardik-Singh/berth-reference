/**
 * The ingest write path — what a collector's push turns into rows.
 *
 * The routes that call this used to live here too, against `node:http`. They
 * are in `http.ts` now, as one `Request`-to-`Response` function, because there
 * are two mounts — `berth serve` on a socket and a hosted deployment inside a
 * Next route handler — and a route table written against `IncomingMessage`
 * could only ever be one of them. What is left here is the part that touches
 * the database, and it is unchanged.
 *
 * Three properties the whole design is built around:
 *
 *   - **Idempotent.** A collector crashes mid-batch, resumes from its last
 *     durable cursor, and re-sends. Every write here is `on conflict do update`
 *     keyed on the harness's own ids, so a re-send converges instead of
 *     duplicating. This is what lets the client be simple and crash-tolerant.
 *   - **Accepts partial batches.** One malformed record must not reject 5,000
 *     good ones — the collector cannot fix a record the harness wrote, so
 *     rejecting the batch would wedge the cursor forever. Bad records are counted
 *     and reported back, never fatal.
 *   - **The token is the identity.** See below.
 *
 * ## Registration, and why it is a property of this endpoint
 *
 * `POST /v1/register` is here rather than in a separate service because it is the
 * same credential answering the same question the write path asks on every push:
 * *who is this, and off which box*. A machine presents its device token and a
 * **proposal** — `{label, os, hostnameHash}` — and gets back the identity the
 * server decided, which it stores and echoes forever after.
 *
 * What this endpoint refuses to do:
 *
 *   - **It will not let a client name its own ids.** `POST /v1/register` accepts
 *     no `machineId` and no `engineerId`, and there is no parameter that would
 *     take one. The engineer comes off the authenticated device row; the machine
 *     id is minted by `registerMachine`. A client that could choose either could
 *     file its work under somebody else's name, and — far more often — would mint
 *     a fresh machine every time its config file was recreated, so one laptop
 *     reinstalled four times becomes four rows that nothing can ever rejoin.
 *   - **It will not invent an engineer.** A token minted before attribution
 *     existed has `engineer_id` null. Registration proceeds and replies with
 *     `engineerId: null` rather than upserting an engineer out of the label, the
 *     hostname or a git config — that is the exact re-derivation this whole
 *     change exists to stop, and a plausible wrong answer is worse than a null
 *     that `berth doctor` can see.
 *   - **It will not believe `batch.identity` on the ingest path.** The envelope
 *     field exists for the direct-to-PostgREST path in `supabase.ts`, where there
 *     is no server in between. Here there is one, so it is dropped on the floor
 *     at the top of `ingestBatch` and the token's own pair is written instead.
 *     Trusting the body would make every attribution in the product a claim the
 *     claimant got to write.
 *
 * The reply is exactly `{orgId, deviceId, engineerId, engineerEmail, machineId,
 * machineLabel}` — the contract in `.context/identity-contract.md`, which
 * `src/setup.ts` stores verbatim as the client's only source of identity.
 * Registering twice from one host returns the same `machineId`, so `berth setup`
 * is safe to re-run and a collector that lost its credentials file recovers its
 * identity rather than forking it.
 */

import type { BerthDb, Executor } from "./db.js";
import { bindDeviceMachine, type AuthedDevice } from "./device.js";
import { findEngineer } from "./engineer.js";
import { registerMachine } from "./machine.js";
import { and, eq, sql } from "drizzle-orm";
import { captureDecisions, captureEvents, captureSessions, captureTurns, sources } from "./schema.js";

// The body ceilings live in `limits.ts` with every other ceiling, and are
// re-exported here because this is where callers have always found them.
export { MAX_BODY_BYTES, MAX_DECOMPRESSED_BYTES } from "./limits.js";

export interface IngestSession {
	sessionId: string;
	harness: string;
	/**
	 * What kind of session this is — see `SESSION_KINDS` in `schema.ts`.
	 *
	 * Optional on the wire because an older client does not send it, and the
	 * upsert coalesces rather than overwriting for the same reason `engineerId`
	 * does: a null from a stale collector must not blank what a current one wrote.
	 */
	kind?: string | null;
	/** The session that spawned this one, for a subagent. Never a foreign key. */
	parentSessionId?: string | null;
	worktree?: string | null;
	branch?: string | null;
	repo?: string | null;
	model?: string | null;
	startedAt?: string | null;
	endedAt?: string | null;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

export interface IngestEvent {
	sessionId: string;
	recordUuid: string;
	at?: string | null;
	kind?: string | null;
	tool?: string | null;
	path?: string | null;
	patchHunks?: number | null;
	patchLines?: number | null;
	additions?: number | null;
	deletions?: number | null;
	inputTokens?: number | null;
	outputTokens?: number | null;
	cacheReadTokens?: number | null;
	cacheWriteTokens?: number | null;
	/** Which turn this happened in, so events and turns line up. */
	turnSeq?: number | null;
	/** The tool failed. The cheapest high-signal field in the whole extract. */
	error?: boolean | null;
	/** A command, or a tool's own one-line description. Content — same opt-in. */
	detail?: string | null;
	/** The literal diff lines. `--full` only. */
	patch?: string | null;
	/** Command output or tool result. `--full` only. */
	output?: string | null;
}

export interface IngestTurn {
	sessionId: string;
	seq: number;
	promptId?: string | null;
	startedAt?: string | null;
	endedAt?: string | null;
	prompt?: string | null;
	reasoning?: string | null;
	summary?: string | null;
	tools?: number;
	files?: number;
	additions?: number;
	deletions?: number;
	outputTokens?: number;
}

export interface IngestDecision {
	sessionId: string;
	seq: number;
	at?: string | null;
	kind: string;
	detail?: string | null;
	tool?: string | null;
	question?: string | null;
	/** JSON array of option labels. */
	options?: string | null;
	answer?: string | null;
	custom?: boolean | null;
}

/**
 * Who and what box a batch came from, as *claimed by the client*.
 *
 * On the authenticated path this is advisory and is overwritten: the server
 * resolves the engineer and machine from the presented token and writes those,
 * because a client that can name its own `engineer_id` can file its work under
 * somebody else's name. It is carried at all for the direct-to-PostgREST path in
 * `supabase.ts`, where there is no server in between and the values the client
 * stored at registration are the only ones available to stamp with.
 *
 * Batch-level rather than per row: every row in one push came off one machine,
 * and repeating the pair on 44,000 events is bytes spent to say the same thing.
 */
export interface IngestIdentity {
	engineerId?: string | null;
	machineId?: string | null;
}

export interface IngestBatch {
	sessions: IngestSession[];
	events: IngestEvent[];
	/** Optional so an older collector's batch is still accepted. */
	turns?: IngestTurn[];
	decisions?: IngestDecision[];
	/** Optional so an older collector's batch is still accepted. */
	identity?: IngestIdentity;
	/**
	 * Per-harness capture health. HAR-36, HAR-37.
	 *
	 * Rides inside the batch rather than getting its own endpoint: one POST, one
	 * auth, one gzip. A separate `/v1/heartbeat` would be a second thing that can
	 * be up or down on its own, reporting on whether the first one worked.
	 */
	sources?: IngestSource[];
}

/**
 * One harness on one machine, and whether it is still reporting.
 *
 * **Why this table has to be written on every round, including empty ones.** A
 * machine whose collector has died and a machine whose engineer is on holiday
 * produce the same thing — no sessions — so without a heartbeat they are the same
 * picture. Shipping a quiet week that was really a broken pipeline is the single
 * most damaging thing this product can do, and it happened here: 2,063
 * consecutive failures over seventeen hours, recorded nowhere but a local log.
 *
 * Two clocks, deliberately not one. `cursor`/`cursorAt` is INGESTION time — how
 * far the reader got. `coverageEnd` is SOURCE time — how fresh the newest thing
 * on disk is. Conflated, a backfill is indistinguishable from live capture.
 *
 * No transcript content here, ever: metadata about capture, not captured data.
 */
export interface IngestSource {
	harness: string;
	harnessVersion?: string | null;
	installPath?: string | null;
	cursor?: string | null;
	cursorAt?: string | null;
	coverageStart?: string | null;
	coverageEnd?: string | null;
	/** `now − coverageEnd`, computed client-side where both clocks agree. */
	cursorLagSeconds?: number | null;
	parseFailures?: number;
	state?: string | null;
	/** Did the collection behind this batch succeed. The field that earns the table. */
	ok?: boolean;
}

/**
 * What a machine sends to `POST /v1/register`. A proposal, not an assertion.
 *
 * Every field here is something a human chose or the OS reported, and none of
 * them is a key the server trusts to mean anything beyond itself. There is
 * deliberately no `machineId` and no `engineerId` — see the module header. If you
 * are about to add one, the thing you actually want is a new column on
 * `berth_machines` that registration fills in from the token.
 */
export interface RegisterRequest {
	/** What a human calls this box. Free to be wrong; not an identity. */
	label?: string | null;
	os?: string | null;
	/** `hashHostname(os.hostname())`. The hostname itself is never sent. */
	hostnameHash?: string | null;
}

/**
 * What the server decided, and the only source of identity the client then has.
 *
 * Stored verbatim by `berth setup` into the credentials file and echoed on every
 * batch. `engineerId`/`engineerEmail` are nullable and that is a reportable state,
 * not a shrug: a token minted before attribution existed has no owner, and saying
 * so is what lets `berth doctor` and `daemon status` show it instead of the
 * collector quietly writing unattributed rows forever.
 */
export interface RegisterReply {
	orgId: string;
	deviceId: string;
	engineerId: string | null;
	engineerEmail: string | null;
	machineId: string;
	machineLabel: string;
}

/**
 * Resolve an authenticated device to an engineer and a machine, minting the
 * machine if this host has not registered before.
 *
 * Split out of the route so the decision — not the HTTP — is what the tests
 * exercise, and so `berth setup` against a local database can reach the identical
 * code path without a server in the middle.
 *
 * The label falls back to the device's own label when the proposal omits one.
 * `registerMachine` refuses a blank label, and failing a registration over a
 * cosmetic string would leave a working collector unattributed — whereas the
 * device label is already a human-chosen name for this box, sitting right there
 * on the row we just authenticated.
 */
export async function registerDevice(
	db: BerthDb,
	device: AuthedDevice,
	proposal: RegisterRequest,
): Promise<RegisterReply> {
	const hostnameHash = (proposal.hostnameHash ?? "").trim();
	if (!hostnameHash) {
		// The only field with no safe default: it is the arbiter that makes
		// registration idempotent, and inventing one would mint a rival machine
		// on every call.
		throw new Error("hostnameHash is required — it is what makes registration idempotent");
	}

	// The engineer is read off the token's device row, never off the request. A
	// device minted before `engineer_id` existed has none, and we say so rather
	// than upserting one out of the label or the hostname: a guess wearing a
	// fact's clothing is exactly what this change exists to delete.
	const engineerId = device.engineerId;
	const engineer = engineerId ? await findEngineer(db, device.orgId, engineerId) : null;

	const machine = await registerMachine(db, {
		orgId: device.orgId,
		engineerId,
		engineerEmail: engineer?.email ?? null,
		label: (proposal.label ?? "").trim() || device.label,
		hostnameHash,
		os: proposal.os ?? null,
	});

	// Back-link, so `authenticateDevice` answers "which box is this" on every
	// later push without a second query — which is what makes stamping identity
	// on the ingest hot path free.
	await bindDeviceMachine(db, {
		orgId: device.orgId,
		deviceId: device.id,
		machineId: machine.id,
	});

	return {
		orgId: device.orgId,
		deviceId: device.id,
		engineerId,
		engineerEmail: engineer?.email ?? null,
		machineId: machine.id,
		machineLabel: machine.label,
	};
}

export interface IngestResult {
	turns: number;
	decisions: number;
	sessions: number;
	/** Rows that did not exist before. The number that means "new work arrived". */
	events: number;
	/** Rows that existed and were refreshed by a better extractor. */
	updated: number;
	skipped: number;
	/** Capture-health rows written. Absent from an older collector's batch. */
	sources?: number;
}

const asDate = (v: unknown): Date | null => {
	if (typeof v !== "string" || !v) return null;
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Write a batch. Returns what landed and what was unusable.
 *
 * Events are chunked because Postgres caps a statement at 65,535 bind parameters
 * and a big backfill batch will exceed it — a limit that only shows up under real
 * data volume, which is exactly when you do not want to discover it.
 */
/**
 * Text Postgres will actually accept.
 *
 * A `text` column cannot hold `0x00` — Postgres rejects the whole statement with
 * `invalid byte sequence for encoding "UTF8"`, so one NUL byte anywhere in a
 * 5,000-row chunk fails all 5,000. Captured command output and diffs contain them
 * in practice: any tool that emits binary, and anything reading a file with an
 * embedded NUL, produces one.
 *
 * Stripped here as well as in the collector on purpose. The collector fixes what
 * *we* send; this fixes what *anybody* sends. Ingest is an authenticated endpoint
 * open to any device token, and a single byte that turns into a 500 for every
 * subsequent batch is a denial of service by accident.
 *
 * Stripped rather than replaced: a NUL in captured output is an artifact of how the
 * bytes were produced, never content somebody meant to write, and substituting a
 * visible character would silently corrupt a diff that is supposed to be verbatim.
 */
function pg(value: string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	return value.includes("\u0000") ? value.replace(/\u0000/g, "") : value;
}

/**
 * Write one batch.
 *
 * Takes an `Executor` rather than a `BerthDb` so the caller can hand it a
 * transaction, which the ingest endpoint does. That is not a convenience: the
 * denormalised `records` count is a second statement over rows written by the
 * first, and outside a transaction a crash between them leaves a session whose
 * stated size disagrees with its own events — and `0` there is indistinguishable
 * from a session that genuinely captured nothing (HAR-74).
 */
export async function ingestBatch(
	db: Executor,
	device: AuthedDevice,
	batch: IngestBatch,
): Promise<IngestResult> {
	let skipped = 0;
	let sessionCount = 0;

	// **`batch.identity` is deliberately not read here.** It is right there on the
	// type and the next reader will assume it is used, so: on this path it is
	// dropped on the floor. The engineer and the machine come off the device the
	// presented token authenticated to, because a client that can name its own
	// `engineer_id` can file its work under somebody else's name, and a client
	// that can name its own `machine_id` can make one laptop look like four. The
	// envelope exists for `supabase.ts`, which writes straight to PostgREST with
	// no server in between and has nothing else to stamp with.
	const engineerId = device.engineerId;
	const machineId = device.machineId;

	for (const s of batch.sessions ?? []) {
		if (!s?.sessionId || !s?.harness) {
			skipped++;
			continue;
		}
		await db
			.insert(captureSessions)
			.values({
				orgId: device.orgId,
				deviceId: device.id,
				engineerId,
				machineId,
				sessionId: s.sessionId,
				harness: s.harness,
				// Defaulted here rather than in the column, so a row written by an
				// older client reads as an ordinary session instead of as a null the
				// dashboard has to decide about on every render.
				kind: pg(s.kind) ?? "session",
				parentSessionId: pg(s.parentSessionId),
				worktree: pg(s.worktree),
				branch: pg(s.branch),
				repo: pg(s.repo),
				model: pg(s.model),
				startedAt: asDate(s.startedAt),
				endedAt: asDate(s.endedAt),
				inputTokens: s.inputTokens ?? 0,
				outputTokens: s.outputTokens ?? 0,
				cacheReadTokens: s.cacheReadTokens ?? 0,
				cacheWriteTokens: s.cacheWriteTokens ?? 0,
				records: 0,
			})
			.onConflictDoUpdate({
				target: [captureSessions.orgId, captureSessions.sessionId],
				// A live session is pushed repeatedly as it grows, so the later push is
				// authoritative for everything that moves. `startedAt` is deliberately
				// not updated: the first push saw the true beginning.
				set: {
					endedAt: asDate(s.endedAt),
					inputTokens: s.inputTokens ?? 0,
					outputTokens: s.outputTokens ?? 0,
					cacheReadTokens: s.cacheReadTokens ?? 0,
					cacheWriteTokens: s.cacheWriteTokens ?? 0,
					branch: pg(s.branch),
					model: pg(s.model),
					// Backfill, never blank. A session captured before identity landed
					// is re-pushed by a collector that has since registered, and this
					// is the one moment it can be attributed. `coalesce` rather than a
					// plain overwrite because the reverse also happens: a device whose
					// registration has not run yet pushes with a null pair, and letting
					// that null win is how an attributed session silently becomes
					// unattributed halfway through a week.
					engineerId: sql`coalesce(excluded.engineer_id, ${captureSessions.engineerId})`,
					machineId: sql`coalesce(excluded.machine_id, ${captureSessions.machineId})`,
					// Coalesced for the same reason, and it is the likelier case here:
					// every credential in the field predates these columns, so a
					// current collector and an older one pushing the same live session
					// would otherwise take turns setting and clearing its parent.
					parentSessionId: sql`coalesce(excluded.parent_session_id, ${captureSessions.parentSessionId})`,
					receivedAt: sql`now()`,
				},
			});
		sessionCount++;
	}

	const valid = (batch.events ?? []).filter((e) => {
		if (!e?.sessionId || !e?.recordUuid) {
			skipped++;
			return false;
		}
		return true;
	});

	// One row per conflict key, last one wins.
	//
	// **This is not tidiness, it is the difference between a 190,000-row backfill
	// landing and a 500.** The insert below is multi-row with `ON CONFLICT DO
	// UPDATE`, and Postgres refuses a command that would update the same row
	// twice: `21000 ON CONFLICT DO UPDATE command cannot affect row a second
	// time`. It aborts the transaction, so one duplicated pair anywhere in a
	// batch discards every other row in it — and because `pushSince` leaves its
	// cursor unmoved on a non-200, the client re-collects and re-sends the whole
	// corpus on the next round, for ever.
	//
	// Two sources seen on one real machine, and the second is why this guard is
	// here rather than only in the collector:
	//
	//   · a Claude Code workflow directory symlinked into a second parent
	//     session, so the same transcript is read under two paths — fixed at
	//     source in `findTranscripts`, but only for clients that have the fix;
	//   · a Codex rollout emitting one `call_…` id twice under two spellings of
	//     the same tool (`_get_plugin_dependencies` and
	//     `mcp__codex_apps__plugin_management.get_plugin_dependencies`), which
	//     no amount of de-duplicating files can prevent.
	//
	// Last-wins matches the `doUpdate` below: within one batch the later record
	// is the more complete one, which is the same reason a re-push is
	// authoritative over what is already stored. Duplicates are **not** counted
	// as `skipped` — nothing was dropped that a caller could act on, and
	// inflating that number would make a healthy push look lossy.
	const byKey = new Map<string, (typeof valid)[number]>();
	for (const e of valid) byKey.set(`${e.sessionId}\u0000${e.recordUuid}`, e);
	const rows = [...byKey.values()];

	// Postgres caps a statement at 65,535 bind parameters, so the ceiling is
	// `65535 / columns-per-row`. Recounted when `engineer_id` and `machine_id`
	// landed: 22 columns below, giving a hard maximum of 2,978 rows per statement.
	// 500 keeps a wide margin, and the margin is the point — this arithmetic has
	// to be redone every time a column is added here, because exceeding it fails
	// only under backfill-sized volume.
	const CHUNK = 500;
	let eventCount = 0;
	let updatedCount = 0;
	for (let i = 0; i < rows.length; i += CHUNK) {
		const slice = rows.slice(i, i + CHUNK).map((e) => ({
			orgId: device.orgId,
			engineerId,
			machineId,
			sessionId: e.sessionId,
			recordUuid: e.recordUuid,
			at: asDate(e.at),
			kind: pg(e.kind),
			tool: pg(e.tool),
			path: pg(e.path),
			patchHunks: e.patchHunks ?? null,
			patchLines: e.patchLines ?? null,
			additions: e.additions ?? null,
			deletions: e.deletions ?? null,
			inputTokens: e.inputTokens ?? null,
			outputTokens: e.outputTokens ?? null,
			cacheReadTokens: e.cacheReadTokens ?? null,
			cacheWriteTokens: e.cacheWriteTokens ?? null,
			turnSeq: e.turnSeq ?? null,
			error: e.error ?? null,
			detail: pg(e.detail),
			patch: pg(e.patch),
			output: pg(e.output),
		}));
		// `doUpdate`, not `doNothing`, and the difference is not academic. The
		// record a harness wrote is immutable, but what berth *derives* from it is
		// not: adding `additions`/`deletions` to the extractor left 40,000 already-
		// ingested rows that could never be filled in, because a re-push of the
		// improved extract hit `doNothing` and was silently discarded. An extractor
		// that can never backfill is one you cannot improve.
		//
		// Only derived measurements are refreshed. Identity — org, session, uuid —
		// is the conflict key and cannot move.
		const written = await db
			.insert(captureEvents)
			.values(slice)
			.onConflictDoUpdate({
				target: [captureEvents.orgId, captureEvents.sessionId, captureEvents.recordUuid],
				set: {
					at: sql`excluded.at`,
					kind: sql`excluded.kind`,
					tool: sql`excluded.tool`,
					path: sql`excluded.path`,
					patchHunks: sql`excluded.patch_hunks`,
					patchLines: sql`excluded.patch_lines`,
					additions: sql`excluded.additions`,
					deletions: sql`excluded.deletions`,
					inputTokens: sql`excluded.input_tokens`,
					outputTokens: sql`excluded.output_tokens`,
					cacheReadTokens: sql`excluded.cache_read_tokens`,
					cacheWriteTokens: sql`excluded.cache_write_tokens`,
					turnSeq: sql`excluded.turn_seq`,
					error: sql`excluded.error`,
					detail: sql`excluded.detail`,
					patch: sql`excluded.patch`,
					output: sql`excluded.output`,
					// Same backfill-never-blank rule as the session above: a re-push
					// from a registered collector attributes rows captured before
					// identity existed, and a push from one that has not registered
					// yet must not undo it.
					engineerId: sql`coalesce(excluded.engineer_id, ${captureEvents.engineerId})`,
					machineId: sql`coalesce(excluded.machine_id, ${captureEvents.machineId})`,
				},
			})
			// `xmax = 0` is true only for a freshly inserted row, so this keeps the
			// insert/update split that `doUpdate` would otherwise blur — and with it
			// the signal that says "the re-push was genuinely idempotent".
			.returning({ inserted: sql<boolean>`(xmax = 0)` });
		for (const r of written) {
			if (r.inserted) eventCount++;
			else updatedCount++;
		}
	}

	// Denormalised so "how big was this session" is not a count(*) over every
	// event on every dashboard render.
	for (const s of batch.sessions ?? []) {
		if (!s?.sessionId) continue;
		await db.execute(sql`
			update berth_capture_sessions set records = (
				select count(*) from berth_capture_events
				where org_id = ${device.orgId} and session_id = ${s.sessionId}
			) where org_id = ${device.orgId} and session_id = ${s.sessionId}
		`);
	}

	// Turns are upserted on (org, session, seq) so a growing session's last turn
	// converges as it is re-pushed rather than duplicating.
	let turnCount = 0;
	for (const t of batch.turns ?? []) {
		if (!t?.sessionId || typeof t.seq !== "number") {
			skipped++;
			continue;
		}
		await db
			.insert(captureTurns)
			.values({
				orgId: device.orgId, sessionId: t.sessionId, seq: t.seq,
				promptId: pg(t.promptId),
				startedAt: asDate(t.startedAt), endedAt: asDate(t.endedAt),
				prompt: pg(t.prompt), reasoning: pg(t.reasoning),
				summary: pg(t.summary),
				tools: t.tools ?? 0, files: t.files ?? 0,
				additions: t.additions ?? 0, deletions: t.deletions ?? 0,
				outputTokens: t.outputTokens ?? 0,
			})
			.onConflictDoUpdate({
				target: [captureTurns.orgId, captureTurns.sessionId, captureTurns.seq],
				set: {
					endedAt: asDate(t.endedAt),
					prompt: pg(t.prompt), reasoning: pg(t.reasoning),
					summary: pg(t.summary),
					tools: t.tools ?? 0, files: t.files ?? 0,
					additions: t.additions ?? 0, deletions: t.deletions ?? 0,
					outputTokens: t.outputTokens ?? 0,
				},
			});
		turnCount++;
	}

	// Decisions have no natural key — a turn can hold several of the same kind —
	// so the session's are replaced wholesale rather than upserted. Cheap, and it
	// keeps a re-push from stacking duplicates.
	let decisionCount = 0;
	const sessionsWithDecisions = new Set((batch.decisions ?? []).map((d) => d.sessionId));
	for (const sid of sessionsWithDecisions) {
		await db.delete(captureDecisions).where(
			and(eq(captureDecisions.orgId, device.orgId), eq(captureDecisions.sessionId, sid)),
		);
	}
	const decisions = (batch.decisions ?? []).filter((d) => d?.sessionId && d?.kind);
	for (let i = 0; i < decisions.length; i += CHUNK) {
		const slice = decisions.slice(i, i + CHUNK).map((d) => ({
			orgId: device.orgId, sessionId: d.sessionId, seq: d.seq ?? 0,
			at: asDate(d.at), kind: d.kind,
			// `pg()` on every text field that reaches Postgres, not only the two that
			// were remembered. A single NUL byte in a decision's `detail` — copied out
			// of a tool's raw output, which is exactly where NULs come from — rejects
			// the entire 500-row insert, which is the failure `pg()` exists to prevent.
			detail: pg(d.detail), tool: pg(d.tool),
			question: pg(d.question), options: pg(d.options),
			answer: pg(d.answer), custom: d.custom ?? null,
		}));
		await db.insert(captureDecisions).values(slice);
		decisionCount += slice.length;
	}

	// ── Capture health ────────────────────────────────────────────────────────
	//
	// Last, and outside everything above, because it must be written for a batch
	// that carried no sessions at all. That is the case it exists for.
	//
	// Keyed on `device.machineId` — the token's machine, not anything the client
	// sent. Same rule the session rows follow, and for the same reason: a client
	// that could name its own machine would either claim somebody else's laptop
	// or, far more often, mint a fresh one whenever its config was recreated and
	// turn one machine into a chart of forty.
	let sourceCount = 0;
	for (const src of batch.sources ?? []) {
		if (!src?.harness) {
			skipped++;
			continue;
		}
		// `one_source_per_machine_harness` is `unique (org_id, machine_id, harness)`
		// and Postgres treats NULLs as distinct in a unique index. A row with no
		// machine id would therefore INSERT every round, forever — the table whose
		// job is to make silence legible becoming the fastest-growing thing in the
		// database. A device that never registered has no machine to report for.
		if (!device.machineId) {
			skipped++;
			continue;
		}
		const ok = src.ok !== false;
		await db
			.insert(sources)
			.values({
				orgId: device.orgId,
				machineId: device.machineId,
				harness: src.harness,
				harnessVersion: pg(src.harnessVersion),
				installPath: pg(src.installPath),
				cursor: pg(src.cursor),
				cursorAt: asDate(src.cursorAt),
				coverageStart: asDate(src.coverageStart),
				coverageEnd: asDate(src.coverageEnd),
				cursorLagSeconds: src.cursorLagSeconds ?? null,
				parseFailures: src.parseFailures ?? 0,
				state: src.state ?? (ok ? "active" : "error"),
				lastAttemptAt: sql`now()`,
				...(ok ? { lastSuccessAt: sql`now()` } : {}),
			})
			.onConflictDoUpdate({
				target: [sources.orgId, sources.machineId, sources.harness],
				set: {
					harnessVersion: pg(src.harnessVersion),
					installPath: pg(src.installPath),
					cursor: pg(src.cursor),
					cursorAt: asDate(src.cursorAt),
					coverageStart: asDate(src.coverageStart),
					coverageEnd: asDate(src.coverageEnd),
					cursorLagSeconds: src.cursorLagSeconds ?? null,
					parseFailures: src.parseFailures ?? 0,
					state: src.state ?? (ok ? "active" : "error"),
					// Always moves. `lastAttemptAt` and `lastSuccessAt` diverging IS the
					// signal: equal means healthy, and the gap says how long it has been
					// broken.
					lastAttemptAt: sql`now()`,
					// Only on success, and untouched otherwise, so the last known good
					// time survives a run of failures instead of being erased by them.
					...(ok ? { lastSuccessAt: sql`now()` } : {}),
					updatedAt: sql`now()`,
				},
			});
		sourceCount++;
	}

	return {
		sessions: sessionCount, events: eventCount, updated: updatedCount,
		turns: turnCount, decisions: decisionCount, skipped,
		sources: sourceCount,
	};
}
