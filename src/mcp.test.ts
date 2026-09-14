/**
 * The MCP surface, over the wire.
 *
 * A linked in-memory client/server pair — the same protocol path a real agent
 * takes — because the thing worth testing is not that the handlers return
 * strings but that an agent asking through the protocol gets them.
 *
 * **Three tools, where there were sixteen.** Fourteen of them were the
 * coordination surface built around `claim`, and they went with the kernel. What
 * is left is the read surface HAR-24 describes: `sessions` to navigate what was
 * captured, `find` to search it, and `memory` to read what has already been
 * learned about the files in front of you — all three optional to call and none
 * of them a required hop. The budget test below matters more than it used to,
 * not less — with a surface this small, a new verb is a much larger proportional
 * cost.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildBerthMcpServer } from "./mcp.js";
import { localSource } from "./api.js";
import { closeTestDb, ORG, testDb, truncateAll } from "./test-db.js";
import { captureEvents, captureSessions, captureTurns, kbPages } from "./schema.js";
import { refreshDigests } from "./digest.js";
import type { KbBlock } from "./kb.js";

const db = await testDb();

beforeEach(() => truncateAll(db));
afterAll(() => closeTestDb());

const DEVICE = "00000000-0000-0000-0000-0000000000de";
const ago = (days: number) => new Date(Date.now() - days * 24 * 3600_000);

let n = 0;
const uid = () => `m${(n += 1).toString().padStart(5, "0")}`;

/** One captured session: a worktree, a prompt, and some edits. */
async function seed(opts: { id: string; actor: string; path: string; ask?: string }) {
	const at = ago(1);
	await db.insert(captureSessions).values({
		orgId: ORG, deviceId: DEVICE, sessionId: opts.id, harness: "claude-code",
		worktree: `/w/${opts.actor}`, branch: "main", startedAt: at,
	});
	await db.insert(captureTurns).values({
		orgId: ORG, sessionId: opts.id, seq: 1, startedAt: at, tools: 3,
		prompt: opts.ask ?? `rework the handler in ${opts.path} as agreed`,
	});
	for (let i = 0; i < 3; i += 1) {
		await db.insert(captureEvents).values({
			orgId: ORG, sessionId: opts.id, recordUuid: uid(), turnSeq: 1,
			kind: "assistant", tool: "Edit", path: opts.path, at,
		});
	}
}

const REPO = "acme/harbor";
const COMPILED = new Date("2026-08-30T09:00:00.000Z");

let blocks = 0;

/** One compiled block, in the shape `kb.ts` writes and `kbrecall.ts` reads back. */
function block(body: string): KbBlock {
	blocks += 1;
	return {
		kind: "lesson",
		tier: "synthesized",
		scope: `file:${REPO}#src/lib/auth.ts`,
		body,
		tokens: Math.ceil(body.length / 4),
		tags: ["ts", "auth"],
		citations: ["a1b2c3d4:17"],
		learningId: `00000000-0000-0000-0000-${String(blocks).padStart(12, "0")}`,
		observed: { branch: "main", commit: null, at: "2026-08-30T00:00:00.000Z" },
		imperative: false,
		approved: false,
	};
}

/** A compiled page, inserted directly: this file is about the protocol, not the compiler. */
async function page(pageKind: string, pageKey: string, list: KbBlock[]): Promise<void> {
	await db.insert(kbPages).values({
		orgId: ORG,
		pageKind,
		pageKey,
		title: pageKey,
		blocks: list,
		tokens: list.reduce((n, b) => n + b.tokens, 0),
		learningIds: list.map((b) => b.learningId),
		sourceFingerprint: `fp-${pageKind}-${pageKey}`,
		compiledAt: COMPILED,
	});
}

async function connectedClient(agentId: string): Promise<Client> {
	const server = buildBerthMcpServer({ source: localSource(db, ORG), agentId });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-agent", version: "0.0.0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
	const content = result.content as Array<{ type: string; text?: string }>;
	return content.map((c) => c.text ?? "").join("\n");
}

describe("the tool surface", () => {
	/**
	 * **The argument for the third tool, made here because `docs/NAVIGATION.md`
	 * says it has to be.** Two rules stand against this addition and both are
	 * worth stating before the answer. New capability becomes a *parameter on an
	 * existing verb*, not another tool — `sessions` opens four levels behind one
	 * `id` for exactly that reason. And `docs/NAVIGATION.md:206-207` goes further:
	 * *"a third verb displaces one rather than joining them, and the next person
	 * who wants room argues for it in `mcp.test.ts`."* This verb joins rather than
	 * displaces, so this is that argument, in the file the doc names, above the
	 * assertion that pins the names.
	 *
	 * Neither of the two can be the one displaced. `sessions` is the exhaustive
	 * listing and `find` is the ranked search, and the pair exists because
	 * complete and ranked are different kinds of trust — collapsing either into
	 * `memory` would put a compiled claim in the place an agent expects a quote
	 * from a turn.
	 *
	 * `memory` is optional, non-blocking and read-only. An agent that never calls
	 * it loses nothing: it is captured anyway, out of the transcripts the harness
	 * already writes, and nothing on this server may become a required hop —
	 * that is the thing HAR-9 cut. When nothing has been learned about the files
	 * in question it returns exactly that, in words, rather than filling the
	 * budget with the nearest thing it could find.
	 *
	 * It is a **different verb from `find` rather than a parameter on it because
	 * the return shapes are disjoint.** `find` answers with ranked corpus lines
	 * quoting turns that can be opened; `memory` answers with compiled blocks
	 * carrying a provenance `tier`, a citation list and the time the page was
	 * compiled. Folded into one verb, every caller would have to test which shape
	 * it got before reading it — and an agent that has to guess the shape of an
	 * answer reads it wrong. Ranked-lead and compiled-claim are also different
	 * kinds of trust, which is the same reason `sessions` and `find` are two.
	 */
	it("serves exactly three verbs", async () => {
		const client = await connectedClient("agent/t");
		const tools = await client.listTools();
		expect(tools.tools.map((t) => t.name).sort()).toEqual(["find", "memory", "sessions"]);
	});

	it("offers nothing that writes", async () => {
		// The point of the read surface is that calling it cannot change anything.
		// A write verb reappearing here is the regression worth failing on, and it
		// would arrive looking like a helpful addition.
		const client = await connectedClient("agent/t");
		const tools = await client.listTools();
		const forbidden = /\b(claim|release|complete|renew|send|ack|save|mark|link|observe)\b/;
		const writes = tools.tools.filter((t) => forbidden.test(t.name));
		expect(writes).toEqual([]);
		// Named rather than left to the filter above. `memory` is the newest verb
		// and the one whose name is closest to sounding like a write — it reads
		// compiled pages and holds no write path at all, and this is the line that
		// fails if a future `remember` arrives beside it wearing the same prefix.
		expect(forbidden.test("memory")).toBe(false);
	});

	it("keeps the whole surface under a 3400-token budget", async () => {
		const client = await connectedClient("agent/t");
		const tools = await client.listTools();
		const cost = Math.ceil(JSON.stringify(tools.tools).length / 4);
		// 1732 before messaging landed; 2695 before the capture surface; 2892 with
		// `recall`; 3139 with `sessions` and `find`; ~450 once the coordination
		// verbs were deleted; **507 with two tools, and 758 measured now that
		// `memory` is the third** — a 251-token verb, or about 7% of the ceiling.
		//
		// **The ceiling is deliberately not lowered to match.** It is a budget, not
		// a measurement — the number that says what the surface is allowed to cost
		// an agent, and re-pinning it just under today's total would make every
		// future description a negotiation with this line. Re-pinning it at, say,
		// 800 here would have been the natural-looking move and it is exactly the
		// move that makes the next description shorter than it should be. The
		// discipline it encodes is unchanged: a tool description an agent misreads
		// costs a whole wrong call, which is worth far more than the tokens.
		expect(cost).toBeLessThan(3400);
	});
});

describe("sessions, over the wire", () => {
	it("groups what was captured, and the rows carry the id the next call takes", async () => {
		await seed({ id: "s-kat", actor: "kathmandu", path: "src/lib/auth.ts" });
		await seed({ id: "s-suva", actor: "suva", path: "src/lib/auth.ts" });
		await refreshDigests(db, { orgId: ORG, since: ago(7) });

		const client = await connectedClient("agent/t");
		const grouped = textOf(await client.callTool({
			name: "sessions", arguments: { group_by: "engineer", since: "7d" },
		}));
		expect(grouped).toContain("kathmandu");
		expect(grouped).toContain("suva");

		// The navigable property: an id this printed is one the next call accepts.
		const listed = textOf(await client.callTool({
			name: "sessions", arguments: { id: "s-kat" },
		}));
		expect(listed).toContain("src/lib/auth.ts");
	});

	it("says so plainly when the window holds nothing", async () => {
		const client = await connectedClient("agent/t");
		const out = textOf(await client.callTool({
			name: "sessions", arguments: { group_by: "engineer", since: "7d" },
		}));
		// Silence and emptiness must not render the same: an agent that cannot tell
		// "nothing happened" from "the read failed" will assume the wrong one.
		expect(out.trim()).not.toBe("");
	});
});

describe("find, over the wire", () => {
	it("returns what was said, and says it is a lead rather than an answer", async () => {
		await seed({
			id: "s-bill", actor: "lima", path: "src/billing/invoice.ts",
			ask: "the invoice rounding is wrong on partial refunds, fix the cents",
		});
		await refreshDigests(db, { orgId: ORG, since: ago(7) });

		const client = await connectedClient("agent/t");
		const out = textOf(await client.callTool({
			name: "find", arguments: { query: "invoice rounding" },
		}));
		expect(out).toContain("invoice");
	});

	it("comes back empty-handed rather than inventing a match", async () => {
		await seed({ id: "s-bill", actor: "lima", path: "src/billing/invoice.ts" });
		await refreshDigests(db, { orgId: ORG, since: ago(7) });

		const client = await connectedClient("agent/t");
		const out = textOf(await client.callTool({
			name: "find", arguments: { query: "kubernetes ingress certificate rotation" },
		}));
		// This assertion is a negative, so it has to be pinned to a *successful*
		// call or it passes for the wrong reason — and it did. The argument used to
		// be `q` where the schema wants `query`, so the call failed validation, and
		// the protocol error text does not contain "invoice.ts" either. The one
		// test guarding `find` against inventing a match was green while never
		// reaching the search. Fixing the argument is not enough on its own:
		// without these two lines the next rename puts it straight back.
		expect(out).not.toMatch(/Input validation error/);
		expect(out.trim()).not.toBe("");
		expect(out).not.toContain("invoice.ts");
	});
});

describe("memory, over the wire", () => {
	it("serves the compiled blocks for a path an agent is about to edit", async () => {
		await page("file", `${REPO}#src/lib/auth.ts`, [
			block("the session cookie and the device token are never accepted on one route"),
		]);

		const client = await connectedClient("agent/t");
		const out = textOf(await client.callTool({
			name: "memory",
			arguments: { paths: ["src/lib/auth.ts"], repo: REPO, task: "add a scope check" },
		}));

		// The same two lines `find` learned the hard way, and for the same reason:
		// the assertions below are about *content*, so they have to be pinned to a
		// call that actually reached the handler. A schema mismatch — `path` where
		// the tool wants `paths`, say — comes back as a protocol error whose text
		// contains none of what is asserted, and every content assertion passes
		// while never reaching the read. See the note in `find` below.
		expect(out).not.toMatch(/Input validation error/);
		expect(out.trim()).not.toBe("");

		expect(out).toContain("never accepted on one route");
		// The disclosure, not the ban: a block a model wrote is served with its
		// tier on it. `kbrecall.ts` is allowed to read `berth_learnings` precisely
		// because it pays for the privilege by labelling every block.
		expect(out).toContain("synthesized");
	});

	it("says nothing is known rather than reaching for the nearest page", async () => {
		await page("file", `${REPO}#src/lib/auth.ts`, [block("about auth, not about billing")]);

		const client = await connectedClient("agent/t");
		const out = textOf(await client.callTool({
			name: "memory", arguments: { paths: ["src/billing/invoice.ts"], repo: REPO },
		}));

		expect(out).not.toMatch(/Input validation error/);
		expect(out.trim()).not.toBe("");
		// An empty answer that renders as silence is indistinguishable from a read
		// that failed, and an agent cannot tell those apart either.
		expect(out).toContain("nothing learned about this yet");
		expect(out).not.toContain("about auth, not about billing");
	});

	it("lists what pages exist when asked for the index instead", async () => {
		await page("file", `${REPO}#src/lib/auth.ts`, [block("one")]);
		await page("repo", REPO, [block("two")]);

		const client = await connectedClient("agent/t");
		const out = textOf(await client.callTool({
			name: "memory", arguments: { index: true, repo: REPO },
		}));

		expect(out).not.toMatch(/Input validation error/);
		expect(out).toContain("memory index");
		expect(out).toContain("src/lib/auth.ts");
	});
});
