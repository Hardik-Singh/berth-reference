/**
 * The read surface over MCP: what agents *did*, served to agents.
 *
 * **Three tools, `sessions`, `find` and `memory`** — and they are the whole
 * server. This file used to carry sixteen, over the coordination kernel:
 * `claim`, `release`, `complete`, `observe`, `send`, `inbox`, `read`, and the
 * rest. HAR-9 cut that protocol and the modules behind it were deleted, so what
 * is left here is the half that never asked an agent to do anything before it
 * started working.
 *
 * That is the property to keep. **Nothing on this server is a required hop.** An
 * agent that never calls it is captured anyway, out of the transcripts the
 * harness already writes. If a tool here ever becomes something an agent must
 * call before editing a file, it has become the thing HAR-9 refused, whatever it
 * is named.
 *
 * The discipline that kept the number small still applies: new capability becomes
 * a parameter on an existing verb, not another tool.
 *
 * `sessions` and `find` are two rather than one because ranked and exhaustive are
 * different kinds of trust. A listing that claims to be complete and a search that
 * returns a lead cannot share a name without one of them lying.
 *
 * They arrived as one verb, `recall`, that took a question in words and routed it.
 * That was the wrong shape and the reason is worth keeping: **a model is good at
 * composing calls and bad at being guessed for.** Asked "what is going on here",
 * an agent does not want a verb that decides what that means — it wants to list,
 * group, narrow and open, four moves it already knows how to sequence. So the
 * router stays on the CLI, where a person types a sentence, and the surface an
 * agent sees is a noun it can navigate. `recall` the function still exists and is
 * what `find` calls.
 *
 * `memory` is the third, and it is the exception the discipline above has to be
 * argued past: new capability becomes a parameter, and this one did not. The
 * reason is that the return shapes are disjoint. `find` answers with ranked
 * corpus lines — what somebody said, in a turn you can open. `memory` answers
 * with compiled blocks that carry a provenance `tier`, a citation list and the
 * time the page was compiled. A single verb returning either would make every
 * caller branch on which it got, and an agent that has to test the shape of an
 * answer before reading it will read it wrong. The argument is written down
 * where the next person adding a tool will find it: `mcp.test.ts`, above the
 * assertion that pins the names.
 *
 * `memory` is also the one tool here that reads something a model wrote. It is
 * allowed to, and it pays for it: every block it returns carries `tier`, so
 * `synthesized` is labelled rather than hidden. The rule the tree defends is not
 * "no model output" but "no model output that is not labelled as such".
 *
 * `sessions` opens four levels behind one `id` parameter — grouped, listed, one
 * session, one turn — rather than four verbs, which would be the same information
 * behind four names an agent has to choose between. Every result it returns ends
 * with the call to make next, because the alternative is an agent inferring that
 * the eight characters at the front of a row are what `id` wants, and paying a
 * round trip when it infers wrong.
 *
 * Every tool description says when NOT to call it, because an agent deciding
 * between tools reads descriptions, not documentation. A protocol test holds the
 * whole serialised surface under a token budget so this server never crowds out
 * the caller's actual work — see `mcp.test.ts` for why that ceiling was not
 * lowered when the surface shrank.
 *
 * Refusals come back as ordinary text results, not errors: the agent has to read
 * them and pick a different call, which it cannot do with a protocol-level
 * failure.
 *
 * **This server needs no database.** It is constructed from a `ReadSource`, which
 * is either this process's Postgres or a server over HTTP, and it cannot tell
 * which. That is not a refactor for its own sake — see `buildBerthMcpServer`'s
 * comment: taking a `BerthDb` made a Postgres connection the precondition of
 * having a source at all, and the machine that most wants `claude mcp add berth
 * -- berth mcp` is the laptop that has a token and no database.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { render, said, type VerbResponse } from "./response.js";
import { RECALL_BUDGET_TOKENS } from "./recall.js";
import { KB_BUDGET_TOKENS } from "./limits.js";
import { GROUP_BY, type GroupBy } from "./nav.js";
import type { ReadSource } from "./api.js";

export interface BerthMcpOptions {
	/**
	 * Where reads come from — this process's Postgres, or a server over HTTP.
	 * Resolved by the caller, because the caller is the only one that knows
	 * whether it has a database at all.
	 *
	 * **The tenant is inside this and is not a parameter here.** A local source
	 * carries the org it was built with; a remote source carries a device token,
	 * and the server derives the org from the token. Either way a client cannot
	 * name its own tenant, which is the property that mattered when this was an
	 * `orgId` field and still does.
	 */
	source: ReadSource;
	/** Who is reading. Fixed at mount, never client-named. */
	agentId: string;
}

/**
 * The one place a verb's answer becomes the text an agent reads.
 *
 * Handlers build a `VerbResponse` and hand it here; nothing else in this file
 * concatenates strings. That is deliberate groundwork: verb responses are meant
 * to start carrying the context relevant to the scope they touched, and when
 * they do, the context block gets appended *here* — no handler changes, and no
 * tool `inputSchema` changes, which is the part a client would notice.
 */
function respond(response: VerbResponse) {
	return { content: [{ type: "text" as const, text: render(response) }] };
}

/** A verb whose whole answer is its outcome. */
function text(body: string) {
	return respond(said(body));
}

/**
 * Build the server. The source and agent are bound at construction — a client
 * cannot name its own tenant or identity, for the same reason a webhook's org
 * comes off the verified row and never the payload.
 *
 * **It takes a `ReadSource`, not a database handle**, and that is the whole of
 * why `berth mcp` works on a machine with no Postgres. It used to take
 * `{db, orgId}` and call `resolveSource` itself, which reads as a detail and was
 * not one: a parameter of type `BerthDb` means every caller must have called
 * `connect()`, so the *seam* said "local or remote" while the *signature* said
 * "you have a database". `cli.ts` dispatched accordingly, after `connect()`.
 *
 * Be exact about what that cost, because the symptom is worse than the
 * description: `connect()` is lazy, so on a laptop that had only run `berth
 * login` the server **started fine**, listed both tools, and then answered every
 * call with a connection refused against `localhost:5437` — a database its owner
 * had never been told to want. `resolveSource` deliberately does not read
 * `credentials.json` (its header says why), so the token that machine holds was
 * never even consulted. A server that fails at handshake is a bug somebody
 * reports; one that fails per call, on the machine the hosted endpoint exists to
 * serve, is the failure `configuredRemote()` argues against at length.
 *
 * So the resolution moves out to whoever knows what it has. Nothing about the
 * tools changed: they already went through the seam.
 */
export function buildBerthMcpServer(options: BerthMcpOptions): McpServer {
	// One seam, decided by the caller. `sessions` and `find` never learn whether
	// they are reading this process's Postgres or a server over HTTP — the moment
	// a tool branches on that, the two paths start drifting apart.
	const { source } = options;

	const server = new McpServer({ name: "berth", version: "0.1.0" });

	// Was a wrapper that recorded presence on every call. Presence went with the
	// coordination kernel, and with it the only reason this was not just
	// `server.registerTool`.
	const tool = server.registerTool.bind(server);

	tool(
		"sessions",
		{
			description:
				"Navigate what agents actually did: past sessions, their turns, and the files "
				+ "and failures in them. Call it bare or with group_by to see the shape, narrow "
				+ "with engineer/file/since/stuck, then id to open a session and "
				+ "id=\"<session>:<turn>\" for one turn verbatim. Every result ends with the call "
				+ "to make next. Exhaustive, not ranked — for a question in words use find. "
				+ "It reads what agents did, not what anyone declared; nothing here is a "
				+ "required hop and not calling it costs you nothing.",
			inputSchema: {
				id: z.string().optional().describe('Session id, or "<session>:<turn>"'),
				group_by: z.enum(GROUP_BY).optional(),
				engineer: z.string().optional().describe("Worktree or branch, substring"),
				file: z.string().optional().describe("Path or glob, e.g. src/**"),
				since: z.string().optional().describe('"7d", "24h", or a date'),
				until: z.string().optional().describe("Upper bound, same forms as since"),
				repository: z.string().optional().describe("Exact owner/repo. Unknown-repo sessions are excluded"),
				stuck: z.boolean().optional().describe("Only sessions that fought something"),
				limit: z.number().optional(),
			},
		},
		async (args) => {
			const result = await source.sessions({
				...(args.id ? { id: args.id } : {}),
				...(args.group_by ? { groupBy: args.group_by as GroupBy } : {}),
				...(args.engineer ? { engineer: args.engineer } : {}),
				...(args.file ? { file: args.file } : {}),
				...(args.since ? { since: args.since } : {}),
				...(args.until ? { until: args.until } : {}),
				...(args.repository ? { repository: args.repository } : {}),
				...(args.stuck ? { stuck: true } : {}),
				...(args.limit !== undefined ? { limit: args.limit } : {}),
			});
			return text(result.text);
		},
	);

	tool(
		"find",
		{
			description:
				"Search past sessions by what was said or run — why something kept failing, "
				+ "where a decision was argued. Ranked, so a lead rather than an answer: when "
				+ "the question is who or when or which file, sessions is exact and this is not. "
				+ "Narrow with path:, tool:, actor:, since:. Hits cite turns sessions can open.",
			inputSchema: {
				query: z.string().describe("Plain words; quote a phrase to match it literally"),
				max_tokens: z.number().optional().describe(`Answer ceiling. Default ${RECALL_BUDGET_TOKENS}`),
			},
		},
		async (args) => {
			const result = await source.find(args.query, args.max_tokens);
			return text(result.text);
		},
	);

	tool(
		"memory",
		{
			description:
				"What this codebase has already learned about the files you are about to "
				+ "touch — cited, budgeted, compiled ahead of time. Give paths you are "
				+ "working on, and optionally what you are doing. Returns nothing when "
				+ "nothing has been learned, which is the honest answer; index:true lists "
				+ "what pages exist instead. Nothing here is a required hop and not calling "
				+ "it costs you nothing. For a question in words, use find.",
			inputSchema: {
				paths: z.array(z.string()).optional().describe("Repo-relative paths you are about to edit"),
				task: z.string().optional().describe("What you are doing, in words"),
				repo: z.string().optional().describe("Exact owner/repo"),
				index: z.boolean().optional().describe("List the pages instead of reading them"),
				max_tokens: z.number().optional().describe(`Answer ceiling. Default ${KB_BUDGET_TOKENS}`),
			},
		},
		async (args) => {
			// `max_tokens` is forwarded only when the caller named one. Passing a
			// default through would hand `index: true` the block budget instead of
			// the smaller index budget, because a number supplied here is
			// indistinguishable from a number the agent chose.
			const result = await source.memory({
				...(args.paths ? { paths: args.paths } : {}),
				...(args.task ? { task: args.task } : {}),
				...(args.repo ? { repo: args.repo } : {}),
				...(args.index ? { index: true } : {}),
				...(args.max_tokens !== undefined ? { budgetTokens: args.max_tokens } : {}),
			});
			return text(result.text);
		},
	);

	return server;
}


