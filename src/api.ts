/**
 * The read API: the same primitives, over HTTP, and the seam that lets a tool
 * call reach them.
 *
 * `sessions` and `find` were built against `BerthDb` directly, which means the
 * CLI and the MCP server are not two surfaces over one kernel — they are two
 * surfaces over one **database connection**. That works on a laptop where the
 * agent and the ledger share a machine, and it does not work anywhere else:
 *
 *   - an agent on a customer's machine would need `BERTH_DATABASE_URL`, which is
 *     a credential that can read and write every row of every table;
 *   - the write half already solved this a different way — a device token, a
 *     `Bearer` header, and `POST /v1/ingest` — so capture pushes over HTTP while
 *     reads reach into Postgres, which is an asymmetry nobody chose;
 *   - and `berth serve` already exposes `/api/sessions`, a **second
 *     implementation** of the same listing, hand-written, unfaceted, and (until
 *     this file) missing its `org_id` filter entirely.
 *
 * That last one is the one that would have bitten. `week.ts` is shared by three
 * surfaces on purpose because three definitions of "this week" is a standup that
 * disagrees with the dashboard; `/api/sessions` was exactly that mistake, already
 * made, in the read path. It now calls `listSessions` like everything else.
 *
 * So: routes that are **thin**, and a client, and one interface with two
 * implementations behind it.
 *
 *   ReadSource ── local  → navigate(db, …)      the laptop, no server
 *              └─ remote → GET /v1/sessions     a fleet, a token, no db url
 *
 * The CLI and MCP ask `resolveSource()` and never know which they got.
 *
 * **The wire format is `{text, data}` and that is deliberate.** `text` is exactly
 * what the local path would have printed — already budgeted, already carrying the
 * "next:" line — so a remote caller renders identically to a local one with no
 * client-side formatter to drift. `data` is the structured result for anything
 * that wants to compute. Sending only `data` would have meant a second renderer
 * living in the client, and two renderers is how the CLI and the MCP tool start
 * describing the same row differently.
 *
 * ## The fourth read
 *
 * `memory` joined `sessions`, `find` and `reflect` with the memory layer, and it
 * is the one method here whose arguments are a **structure rather than a
 * sentence**: paths, a task, a repo, tags, a ticket. That is why it is not a
 * parameter on `find`. `find` answers with ranked corpus lines quoting turns;
 * `memory` answers with compiled blocks carrying a provenance `tier`, a citation
 * list and a compile time, and one method returning either shape would make
 * every caller branch on which it got.
 *
 * Its list-valued selectors cross the wire as **repeated keys** — `?path=a&path=b`
 * — never comma-joined. A comma is a legal character in a path, and joining
 * would split one selector into two that match nothing; the symptom is an empty
 * answer, which is also exactly what "nothing has been learned yet" looks like.
 *
 * **Reads are authenticated and writes-grade sensitive.** A capture row holds
 * prompts, reasoning and commands — more sensitive than the lease ledger, not
 * less — so every route here takes the same device token `/v1/ingest` does, and
 * an unauthenticated request gets the same undifferentiated 401 a revoked one
 * does.
 */

import type { BerthDb } from "./db.js";
import { authenticateRequest, deviceCan } from "./device.js";
import { formatNav, navigate, type Facets, type GroupBy, GROUP_BY } from "./nav.js";
import { formatPack, recall, RECALL_BUDGET_TOKENS } from "./recall.js";
import { formatReflection, reflect, type ReflectOptions } from "./reflect.js";
import { formatKbRecall, kbRecall, type KbRecallSelector } from "./kbrecall.js";
import { listLearnings, type StoredLearning } from "./derive.js";
import {
	LEARNING_KINDS,
	LEARNING_SCOPES,
	type LearningKind,
	type LearningScope,
} from "./schema.js";
import { bound, KB_BUDGET_TOKENS, KB_MAX_BUDGET_TOKENS } from "./limits.js";
import { loadCredentials } from "./credentials.js";
import { json } from "./wire.js";
import {
	DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS, MIN_WINDOW_DAYS,
} from "./window.js";

/** What every read returns, local or remote. */
export interface ReadResult {
	/** Rendered exactly as the local path would print it. The thing you show. */
	text: string;
	/** The structured result, for anything that computes rather than displays. */
	data: unknown;
}

export interface NavParams {
	id?: string;
	groupBy?: GroupBy;
	engineer?: string;
	file?: string;
	since?: string;
	/** Upper bound, same vocabulary as `since`. Declared in `Facets` since #22
	 *  and unreachable from any surface until now. */
	until?: string;
	/** Exact `owner/repo`. Sessions with an unknown repo are excluded, not matched. */
	repository?: string;
	stuck?: boolean;
	limit?: number;
}

/**
 * A reproducible window, as a caller states it.
 *
 * Every field is optional and every one widens rather than fails when it is
 * wrong: an unknown timezone falls back to UTC, an out-of-range `windowDays`
 * clamps, and both are reported in the response's `note` rather than as a 400.
 * `parseSince` already makes that bargain one type up, for the same reason — a
 * caller that gets more than it asked for can see that, and one that gets a
 * protocol error has to guess which argument was wrong.
 */
export interface ReflectParams {
	/** @deprecated The old spelling of `windowDays`. Still accepted. */
	days?: number;
	windowDays?: number;
	/** ISO instant. Defaults to now, and is echoed back either way. */
	asOf?: string;
	timezone?: string;
	repository?: string;
	refresh?: boolean;
	/** Read the retired lease kernel. Additive; false skips two queries. */
	leases?: boolean;
	/** Check every excerpt against the row it names. */
	verify?: boolean;
}

/**
 * Where a surface gets its reads.
 *
 * Two implementations, one interface, and the caller cannot tell them apart —
 * which is the only property that matters, because the moment a surface branches
 * on which one it has, the two paths start diverging.
 */
/** What `/v1/learnings` accepts. A subset of `listLearnings`, minus the unsafe knobs. */
export interface LearningsParams {
	/** Sugar for `scopeKind: "session", scopeKey: <id>` — the dashboard's whole use. */
	session?: string;
	scopeKind?: LearningScope;
	scopeKey?: string;
	kind?: LearningKind;
	tag?: string;
	imperative?: boolean;
	limit?: number;
}

export interface ReadSource {
	sessions(params: NavParams): Promise<ReadResult>;
	find(query: string, maxTokens?: number): Promise<ReadResult>;
	/**
	 * `number` is the old shape and still works.
	 *
	 * Widened rather than replaced so that no existing call site changes, and both
	 * implementations accept both — which is what keeps the invariant above true.
	 * A transport where one side takes a number and the other takes an object is
	 * exactly the seam a caller learns to branch on.
	 */
	reflect(params: number | ReflectParams): Promise<ReadResult>;
	/**
	 * The compiled memory, by structured selector rather than by sentence.
	 *
	 * A separate method from `find` and not a parameter on it, which is the one
	 * place this file departs from the surface discipline stated in `mcp.ts` —
	 * and the reason is the return shape. `find` answers with ranked corpus
	 * lines that cite turns; this answers with typed blocks that carry a `tier`,
	 * a citation list and a compile time. One method returning either would make
	 * every caller branch on which it got, which is the drift the whole seam
	 * exists to prevent.
	 */
	memory(selector: KbRecallSelector): Promise<ReadResult>;
	/**
	 * The atomic learnings, by scope — the layer under the compiled pages.
	 *
	 * A separate method from `memory` for a structural reason rather than a
	 * stylistic one: `KB_PAGE_KINDS` has no `session` member, so no compiled page
	 * can answer *"what did berth learn from this session"*. The KB is compiled
	 * per file, dir, repo, topic, PR and ticket; a session is a scope on the
	 * learning, not a page. The dashboard's session view needs exactly that
	 * question answered, so it reads rows rather than pages.
	 *
	 * The difference is also a trust difference worth keeping visible: `memory`
	 * returns a *budgeted, ranked* pack meant to be injected into an agent's
	 * context; this returns an *unranked list* meant to be shown to a person who
	 * can see every one of them and judge for themselves.
	 */
	learnings(params: LearningsParams): Promise<ReadResult>;
	/** For a message that says where an answer came from. Never used to branch. */
	readonly origin: string;
}

/**
 * `"7d"`, `"24h"`, or a date.
 *
 * Unparseable widens the answer rather than failing the call: an agent that gets
 * back more than it asked for can see that, and one that gets a protocol error
 * has to guess which argument was wrong.
 */
export function parseSince(raw: string | undefined): Date | undefined {
	if (!raw) return undefined;
	const m = /^(\d+)\s*(h|hour|hours|d|day|days|w|week|weeks)$/i.exec(raw.trim());
	if (m) {
		const n = Number(m[1]);
		const u = m[2]!.toLowerCase();
		const hours = u.startsWith("h") ? n : u.startsWith("w") ? n * 24 * 7 : n * 24;
		return new Date(Date.now() - hours * 3600_000);
	}
	const at = new Date(raw);
	return Number.isNaN(at.getTime()) ? undefined : at;
}

/**
 * A query-string boolean.
 *
 * Present-and-not-falsey, so `?index`, `?index=1` and `?index=true` all mean the
 * same thing and `?index=0` / `?index=false` are the only spellings that turn it
 * off. `/v1/reflect` has carried this rule inline since it shipped; naming it
 * once is what stops the next route inventing a third answer for `?index=no`.
 */
function truthy(raw: string | null): boolean {
	return raw !== null && raw !== "0" && raw !== "false";
}

function facetsOf(p: NavParams): Facets {
	const since = parseSince(p.since);
	const until = parseSince(p.until);
	return {
		...(p.engineer ? { engineer: p.engineer } : {}),
		...(p.file ? { file: p.file } : {}),
		...(since ? { since } : {}),
		...(until ? { until } : {}),
		...(p.repository ? { repository: p.repository } : {}),
		...(p.stuck ? { stuck: true } : {}),
	};
}

/**
 * The one place the two `reflect` shapes become one.
 *
 * `exactOptionalPropertyTypes` is on, so every optional has to be absent rather
 * than explicitly undefined — hence the spread-if-present rather than a plain
 * object literal.
 */
function reflectOptionsOf(params: number | ReflectParams): Omit<ReflectOptions, "orgId"> {
	if (typeof params === "number") return { windowDays: params };
	const asOf = params.asOf ? new Date(params.asOf) : undefined;
	const days = params.windowDays ?? params.days;
	return {
		...(days !== undefined ? { windowDays: days } : {}),
		...(asOf && !Number.isNaN(asOf.getTime()) ? { asOf } : {}),
		...(params.timezone ? { timezone: params.timezone } : {}),
		...(params.repository ? { repository: params.repository } : {}),
		...(params.refresh !== undefined ? { refresh: params.refresh } : {}),
		...(params.leases !== undefined ? { leases: params.leases } : {}),
		...(params.verify !== undefined ? { verify: params.verify } : {}),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Local — the laptop, no server
// ─────────────────────────────────────────────────────────────────────────────

/** Default and ceiling for `/v1/learnings`. A person scrolls; an agent uses `memory`. */
export const LEARNINGS_LIMIT = 100;
export const LEARNINGS_MAX = 500;

/**
 * `session` is sugar, expanded here rather than in `listLearnings`.
 *
 * The kernel keeps one way to say a scope — a kind and a key — and this is the
 * transport being convenient for the one caller that always wants the same pair.
 * Expanding it at the edge means `listLearnings` never grows a second spelling
 * of a thing it already has, which is how two ways to ask the same question
 * start disagreeing.
 *
 * An explicit `scopeKind`/`scopeKey` wins, so a caller that passes both gets
 * what it actually named rather than silently having it overwritten.
 */
function learningsQueryOf(p: LearningsParams): {
	scopeKind?: LearningScope; scopeKey?: string; kind?: LearningKind;
	tag?: string; imperative?: boolean; limit?: number;
} {
	const scoped = p.session !== undefined && p.scopeKind === undefined
		? { scopeKind: "session" as LearningScope, scopeKey: p.session }
		: {
			...(p.scopeKind !== undefined ? { scopeKind: p.scopeKind } : {}),
			...(p.scopeKey !== undefined ? { scopeKey: p.scopeKey } : {}),
		};
	return {
		...scoped,
		...(p.kind !== undefined ? { kind: p.kind } : {}),
		...(p.tag !== undefined ? { tag: p.tag } : {}),
		...(p.imperative !== undefined ? { imperative: p.imperative } : {}),
		limit: p.limit ?? LEARNINGS_LIMIT,
	};
}

/**
 * A learning on the wire: `Date`s as ISO strings, evidence flattened to what a
 * reader can check.
 *
 * `StoredLearning` carries `Date` objects and an `EvidenceRef` whose `tier` and
 * `cite` are computed rather than stored. JSON has no `Date`, and a consumer
 * that receives one gets a string typed as a `Date` — the exact defect
 * `listLearnings` documents on its own decode path, reintroduced at the
 * transport. So the boundary is explicit and one-directional.
 */
function wireLearning(l: StoredLearning): Record<string, unknown> {
	return {
		id: l.id,
		kind: l.kind,
		tier: l.tier,
		scopeKind: l.scopeKind,
		scopeKey: l.scopeKey,
		body: l.body,
		tokens: l.tokens,
		tags: l.tags,
		strengthenedBy: l.strengthenedBy,
		candidate: l.candidate,
		imperative: l.imperative,
		approved: l.approved,
		suppressedAt: l.suppressedAt ? l.suppressedAt.toISOString() : null,
		needsReviewAt: l.needsReviewAt ? l.needsReviewAt.toISOString() : null,
		observed: {
			branch: l.observedBranch,
			commit: l.observedCommit,
			at: l.createdAt.toISOString(),
		},
		citations: l.evidence.map((e) => ({
			sessionId: e.sessionId,
			turnSeq: e.turnSeq,
			recordUuid: e.recordUuid ?? null,
			field: e.field,
			excerpt: e.excerpt,
		})),
		createdAt: l.createdAt.toISOString(),
	};
}

/**
 * The same rows as text, so a remote caller renders identically to a local one
 * without writing a formatter — the property `ReadResult.text` exists for.
 *
 * A candidate kind is marked `[candidate]` here for the same reason the
 * dashboard has a component for it: an inference printed like an observation is
 * the failure the whole derived layer is arranged to prevent.
 */
export function formatLearnings(rows: readonly StoredLearning[]): string {
	if (rows.length === 0) return "no learnings for that scope";
	const lines = [`${rows.length} learning${rows.length === 1 ? "" : "s"}`];
	for (const l of rows) {
		const scope = l.scopeKey === "" ? l.scopeKind : `${l.scopeKind}:${l.scopeKey}`;
		const cites = l.evidence.map((e) => e.cite).join(", ");
		// `derive.ts` already writes `[candidate] ` into the body of a candidate
		// kind, so marking it again here printed `[candidate] [candidate]`. The
		// marker is checked rather than assumed on either side: a formatter that
		// trusts the body carries it would silently stop marking the day a writer
		// stops, and one that always prepends doubles it. Mark what is not marked.
		const marked = l.candidate && !l.body.startsWith("[candidate]")
			? `[candidate] ${l.body}`
			: l.body;
		lines.push(
			`  [${l.tier} · ${l.kind}] ${scope} — ${marked}`
			+ (cites ? ` (${cites})` : ""),
		);
		if (l.strengthenedBy) lines.push(`      strengthened by: ${l.strengthenedBy}`);
	}
	return lines.join("\n");
}

export function localSource(db: BerthDb, orgId: string): ReadSource {
	return {
		origin: "local database",
		async sessions(p) {
			const result = await navigate(db, {
				orgId,
				...(p.id ? { id: p.id } : {}),
				...(p.groupBy ? { groupBy: p.groupBy } : {}),
				facets: facetsOf(p),
				...(p.limit !== undefined ? { limit: p.limit } : {}),
			});
			return { text: formatNav(result), data: result };
		},
		async find(query, maxTokens) {
			const pack = await recall(db, {
				orgId, question: query,
				...(maxTokens !== undefined ? { max: maxTokens } : {}),
			});
			return { text: formatPack(pack), data: pack };
		},
		async reflect(params) {
			const report = await reflect(db, { orgId, ...reflectOptionsOf(params) });
			return { text: formatReflection(report), data: report };
		},
		async memory(selector) {
			// `surface: "http"` on the local implementation is deliberate and is
			// pinned by the build plan: this is the body the route runs, and the
			// `berth_recall_log` row it writes is the one measurement of what a
			// served read cost. See the note in `BUILD-PLAN.md` §6.8 — a CLI read
			// that resolves to this implementation is logged the same way, which
			// means the `surface` column today distinguishes nothing.
			const result = await kbRecall(db, { orgId, ...selector, surface: "http" });
			return { text: formatKbRecall(result), data: result };
		},
		async learnings(params) {
			const rows = await listLearnings(db, { orgId, ...learningsQueryOf(params) });
			return { text: formatLearnings(rows), data: { learnings: rows.map(wireLearning) } };
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Remote — a fleet, a token, no database url
// ─────────────────────────────────────────────────────────────────────────────

export class ReadApiError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
		this.name = "ReadApiError";
	}
}

/**
 * The client.
 *
 * Deliberately does not retry. A read is cheap to reissue and an agent that gets
 * a clear failure picks differently; a client that retries silently turns a dead
 * server into a slow one, which is the harder thing to diagnose from the outside.
 */
export function remoteSource(baseUrl: string, token: string): ReadSource {
	const base = baseUrl.replace(/\/+$/, "");
	const get = async (
		path: string,
		params: Record<string, string | readonly string[] | undefined>,
	): Promise<ReadResult> => {
		const url = new URL(`${base}${path}`);
		for (const [k, v] of Object.entries(params)) {
			// A list becomes the same key repeated, never one comma-joined value.
			// `paths` carries repo-relative file paths, and a comma is a legal
			// character in one — joining would split `src/a,b.ts` into two paths
			// that match nothing, and the symptom is an empty answer, which is
			// also what "nothing learned yet" looks like.
			if (Array.isArray(v)) {
				for (const item of v) if (item !== "") url.searchParams.append(k, item);
				continue;
			}
			if (typeof v === "string" && v !== "") url.searchParams.set(k, v);
		}
		const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new ReadApiError(res.status, `${res.status} from ${url.pathname}${body ? `: ${body.slice(0, 200)}` : ""}`);
		}
		const body = (await res.json()) as { text?: string; data?: unknown };
		return { text: body.text ?? "", data: body.data ?? null };
	};
	return {
		origin: base,
		sessions: (p) => get("/v1/sessions", {
			id: p.id,
			group_by: p.groupBy,
			engineer: p.engineer,
			file: p.file,
			since: p.since,
			until: p.until,
			repository: p.repository,
			stuck: p.stuck ? "1" : undefined,
			limit: p.limit === undefined ? undefined : String(p.limit),
		}),
		find: (query, maxTokens) => get("/v1/find", {
			// The canonical spelling, matching the MCP tool's argument. The server
			// still accepts `q` for anything older than this.
			query,
			max_tokens: maxTokens === undefined ? undefined : String(maxTokens),
		}),
		reflect: (params) => {
			const p = typeof params === "number" ? { windowDays: params } : params;
			const days = p.windowDays ?? p.days;
			return get("/v1/reflect", {
				// Both spellings on the wire, because a URL somebody pasted from the
				// old surface has to keep working.
				days: days === undefined ? undefined : String(days),
				window_days: days === undefined ? undefined : String(days),
				as_of: p.asOf,
				tz: p.timezone,
				repository: p.repository,
				refresh: p.refresh === undefined ? undefined : p.refresh ? "1" : "0",
				leases: p.leases === undefined ? undefined : p.leases ? "1" : "0",
				verify: p.verify ? "1" : undefined,
			});
		},
		learnings: (params) => get("/v1/learnings", {
			session: params.session,
			scope_kind: params.scopeKind,
			scope_key: params.scopeKey,
			kind: params.kind,
			tag: params.tag,
			imperative: params.imperative === undefined ? undefined : params.imperative ? "1" : "0",
			limit: params.limit === undefined ? undefined : String(params.limit),
		}),
		memory: (selector) => get("/v1/memory", {
			// Singular keys, repeated. `path` and `tag` name one value each and the
			// list is the repetition — the shape a URL already has, rather than a
			// second encoding layered on top of it.
			path: selector.paths ?? undefined,
			tag: selector.tags ?? undefined,
			task: selector.task,
			repo: selector.repo,
			ticket: selector.ticket,
			index: selector.index ? "1" : undefined,
			max_tokens: selector.budgetTokens === undefined
				? undefined
				: String(selector.budgetTokens),
		}),
	};
}

/**
 * The origin a `/v1/ingest` endpoint belongs to.
 *
 * `https://platform.example/v1/ingest` -> `https://platform.example`. A relative
 * `URL` rather than string surgery, so a deployment served from a path prefix
 * resolves correctly and a trailing slash is not a special case.
 */
export function readBaseFor(endpoint: string): string {
	// The trailing slash is stripped *before* resolving, not after. `new URL("../")`
	// is relative to the last path segment, so ".../v1/ingest" resolves to the
	// origin but ".../v1/ingest/" resolves to ".../v1" — one directory short, and
	// every read against it a 404 with nothing to say why. `ingestEndpoint()`
	// happens not to emit one today; `BERTH_ENDPOINT` is set by hand and can.
	const clean = endpoint.replace(/\/+$/, "");
	try {
		return new URL("../", clean).toString().replace(/\/+$/, "");
	} catch {
		return clean;
	}
}

/**
 * The remote this machine is configured for, or null.
 *
 * **This is the wiring `resolveSource` used to say was "the obvious next step
 * and is not done here".** Before it, reads went remote only if somebody set two
 * variables nothing writes, so `berth login` against a hosted endpoint gave you
 * a machine that *pushed* over HTTP and still *read* by opening Postgres — which
 * on a laptop with no database meant `berth sessions` failed on the one setup
 * the hosted endpoint exists to serve.
 *
 * Precedence:
 *
 *   1. `BERTH_SOURCE`, if somebody said `local` or `remote` outright.
 *   2. `BERTH_API_URL` + `BERTH_API_TOKEN`. Explicit beats inferred, unchanged.
 *   3. The saved credentials, **when no database was actually configured**.
 *
 * That last condition is the subtle one, and it is deliberately *not* "is the
 * endpoint loopback". Loopback was the first rule written here and it is wrong
 * for a real case: somebody running the dashboard on `localhost:8190` with a
 * token and no Postgres would be sent to the local path and fail on a database
 * they were never told to want — which is precisely the failure this function
 * exists to remove, reintroduced one address at a time.
 *
 * "Configured" means `BERTH_DATABASE_URL` or `DATABASE_URL` is set. It has to be
 * the *explicit* variables rather than `resolveDatabaseUrl()`, because that one
 * always answers: it falls back to the docker-compose default, so asking it
 * would mean every machine looks like it has a database and nothing is ever
 * remote. An operator who set one meant it and keeps reading it directly; a
 * laptop that set nothing has a token, and the token is the whole configuration.
 */
export function configuredRemote(env: NodeJS.ProcessEnv = process.env): ReadSource | null {
	if (env.BERTH_SOURCE === "local") return null;

	const url = env.BERTH_API_URL;
	const token = env.BERTH_API_TOKEN;
	if (url && token) return remoteSource(url, token);

	const creds = loadCredentials(env);
	if (!creds) return null;
	const hasDatabase = Boolean(env.BERTH_DATABASE_URL ?? env.DATABASE_URL);
	if (hasDatabase && env.BERTH_SOURCE !== "remote") return null;
	return remoteSource(readBaseFor(creds.endpoint), creds.token);
}

/**
 * Pick a source, given a database handle.
 *
 * Remote when `BERTH_API_URL` and a token are both set, local otherwise — and
 * **local is the fallback, not the error case**. A machine that has a database
 * and no server keeps working exactly as it did; requiring configuration to get
 * back the previous behaviour is how a transport seam becomes a migration.
 *
 * Deliberately **does not read `credentials.json`**, though `configuredRemote`
 * above does. Two reasons, and the second is the one that bites:
 *
 *   - Every caller here already holds a `BerthDb`, which means `connect()`
 *     succeeded, which means local is available and cheap. The case
 *     credentials-following exists for — no database at all — never reaches this
 *     function, because `cli.ts` takes that branch before `connect()`.
 *   - `env` is a parameter so a caller can state the whole world, and a disk
 *     read is not in it. With the credentials branch here, passing `{}` still
 *     picked up whatever `~/.config/berth/credentials.json` happened to say, so
 *     the answer depended on the machine the code was running on. A test caught
 *     it; a person debugging "why is this reading the server" would not have.
 */
export function resolveSource(
	db: BerthDb,
	orgId: string,
	env: NodeJS.ProcessEnv = process.env,
): ReadSource {
	const url = env.BERTH_API_URL;
	const token = env.BERTH_API_TOKEN;
	if (url && token) return remoteSource(url, token);
	return localSource(db, orgId);
}

// ─────────────────────────────────────────────────────────────────────────────
// The routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serve `/v1/sessions`, `/v1/find`, `/v1/reflect` and `/v1/memory`. Returns null
 * when the path is none of them, so the ladder in `http.ts` can mount it without
 * an if-else.
 *
 * The org comes from the **authenticated device**, never from a query parameter.
 * That is the whole difference between this and the `/api/sessions` it replaces:
 * a caller cannot ask for somebody else's rows, because the tenant is a property
 * of the token rather than of the request.
 */
export async function readRoute(
	db: BerthDb,
	request: Request,
	url: URL,
): Promise<Response | null> {
	const path = url.pathname;
	if (
		path !== "/v1/sessions" && path !== "/v1/find"
		&& path !== "/v1/reflect" && path !== "/v1/memory"
		&& path !== "/v1/learnings"
	) return null;

	// Reads carry prompts, reasoning and commands — more sensitive than the lease
	// ledger, not less. Same token as the write path, same undifferentiated 401:
	// whoever holds a bad one learns only that it does not work.
	//
	// **Before the method check, and that ordering is the point.** `GET /v1` is
	// authenticated on the stated grounds that an index answering to anyone is an
	// invitation to enumerate — but while the 405 came first, an anonymous
	// `POST /v1/sessions` answered "method not allowed" where `POST /v1/nonsense`
	// answered "not found", which is the same route list by another spelling.
	// Authenticating first means an unknown caller learns nothing either way.
	const device = await authenticateRequest(db, request.headers);
	if (!device) return json(401, { error: "unauthorized" });

	// 403, not 401, and for the reason `http.ts` gives on the write side: a token
	// that authenticated belongs to somebody who already knows it is theirs, so
	// naming the missing scope discloses nothing and is the only message that
	// names the fix. These rows are prompts, reasoning and command output — until
	// this check existed, every token could read all of them.
	if (!deviceCan(device, "read")) {
		return json(403, { error: "this key may not read captured sessions", scopes: device.scopes });
	}

	if (request.method !== "GET") return json(405, { error: "method not allowed" });

	const source = localSource(db, device.orgId);
	const q = url.searchParams;

	try {
		if (path === "/v1/find") {
			// Both spellings, `query` canonical. The MCP tool has always called this
			// argument `query` and the HTTP route has always called it `q`, which is
			// one parameter with two names across two surfaces over one kernel —
			// exactly what `sessions` avoids by spelling `group_by` the same in both
			// places. `q` stays accepted because it is the older wire name and
			// breaking a script to tidy a spelling is not a trade worth making.
			const query = q.get("query") ?? q.get("q") ?? "";
			if (!query.trim()) return json(400, { error: "query is required" });
			return json(200, await source.find(query, bound(q.get("max_tokens"), RECALL_BUDGET_TOKENS, 50, 4000)));
		}

		if (path === "/v1/memory") {
			// Repeated keys, not a comma-joined list — see the client above.
			const paths = q.getAll("path").filter((p) => p.trim() !== "");
			const tags = q.getAll("tag").filter((t) => t.trim() !== "");
			const max = q.get("max_tokens");
			// **The ceiling is only stated when the caller states one.** Applying
			// `bound()` unconditionally would answer `index=1` with the block budget
			// of 800 rather than the index budget of 300, because a default supplied
			// here is indistinguishable from a number the caller chose — and the
			// index is small on purpose. Absent, `kbRecall` picks the budget that
			// matches the mode it is in.
			return json(200, await source.memory({
				...(paths.length > 0 ? { paths } : {}),
				...(tags.length > 0 ? { tags } : {}),
				...(q.get("task") ? { task: q.get("task")! } : {}),
				...(q.get("repo") ? { repo: q.get("repo")! } : {}),
				...(q.get("ticket") ? { ticket: q.get("ticket")! } : {}),
				...(truthy(q.get("index")) ? { index: true } : {}),
				// The ceiling by name rather than by literal, so this route, the MCP
				// tool and `kbRecall`'s own clamp cannot disagree about it — they did,
				// and MCP was the door with no bound at all.
				...(max ? { budgetTokens: bound(max, KB_BUDGET_TOKENS, 50, KB_MAX_BUDGET_TOKENS) } : {}),
			}));
		}

		if (path === "/v1/learnings") {
			// A closed vocabulary arriving off a URL is checked here rather than
			// passed through: `listLearnings` interpolates `scope_kind` and `kind`
			// into a comparison, and a value outside the vocabulary can only ever
			// match nothing — so accepting it silently answers "no learnings" to a
			// question that was actually misspelled. 400 says which.
			const scopeKind = q.get("scope_kind");
			if (scopeKind && !LEARNING_SCOPES.includes(scopeKind as LearningScope)) {
				return json(400, { error: `scope_kind must be one of ${LEARNING_SCOPES.join(", ")}` });
			}
			const kind = q.get("kind");
			if (kind && !LEARNING_KINDS.includes(kind as LearningKind)) {
				return json(400, { error: `kind must be one of ${LEARNING_KINDS.join(", ")}` });
			}
			const imperative = q.get("imperative");
			return json(200, await source.learnings({
				...(q.get("session") ? { session: q.get("session")! } : {}),
				...(scopeKind ? { scopeKind: scopeKind as LearningScope } : {}),
				...(q.get("scope_key") ? { scopeKey: q.get("scope_key")! } : {}),
				...(kind ? { kind: kind as LearningKind } : {}),
				...(q.get("tag") ? { tag: q.get("tag")! } : {}),
				...(imperative !== null ? { imperative: truthy(imperative) } : {}),
				...(q.get("limit") ? { limit: bound(q.get("limit"), LEARNINGS_LIMIT, 1, LEARNINGS_MAX) } : {}),
			}));
		}

		if (path === "/v1/reflect") {
			// Both spellings accepted; `window_days` wins when both are present.
			// The bounds are `window.ts`'s, applied here too so a caller gets a 200
			// with a clamped window and a note rather than a 400 it has to guess at.
			const days = bound(
				q.get("window_days") ?? q.get("days"),
				DEFAULT_WINDOW_DAYS, MIN_WINDOW_DAYS, MAX_WINDOW_DAYS,
			);
			const flag = (name: string): boolean | undefined => {
				const raw = q.get(name);
				return raw === null ? undefined : raw !== "0" && raw !== "false";
			};
			const refresh = flag("refresh");
			const leases = flag("leases");
			return json(200, await source.reflect({
				windowDays: days,
				...(q.get("as_of") ? { asOf: q.get("as_of")! } : {}),
				...(q.get("tz") ? { timezone: q.get("tz")! } : {}),
				...(q.get("repository") ? { repository: q.get("repository")! } : {}),
				...(refresh !== undefined ? { refresh } : {}),
				...(leases !== undefined ? { leases } : {}),
				...(flag("verify") ? { verify: true } : {}),
			}));
		}

		const groupBy = q.get("group_by");
		if (groupBy && !(GROUP_BY as readonly string[]).includes(groupBy)) {
			return json(400, { error: `group_by must be one of: ${GROUP_BY.join(", ")}` });
		}
		return json(200, await source.sessions({
			...(q.get("id") ? { id: q.get("id")! } : {}),
			...(groupBy ? { groupBy: groupBy as GroupBy } : {}),
			...(q.get("engineer") ? { engineer: q.get("engineer")! } : {}),
			...(q.get("file") ? { file: q.get("file")! } : {}),
			...(q.get("since") ? { since: q.get("since")! } : {}),
			...(q.get("until") ? { until: q.get("until")! } : {}),
			...(q.get("repository") ? { repository: q.get("repository")! } : {}),
			...(q.get("stuck") ? { stuck: true } : {}),
			limit: bound(q.get("limit"), 25, 1, 200),
		}));
	} catch (error) {
		// The message, not the stack, and 500 rather than a shape that looks like a
		// result. A read that failed must never be mistaken for a read that was empty.
		return json(500, { error: (error as Error).message });
	}
}
