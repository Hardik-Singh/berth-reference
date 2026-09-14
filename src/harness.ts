/**
 * The agentic loop: the model searches the corpus itself instead of being handed one
 * fixed blob.
 *
 * `learn.ts` does a single shot — trim a session, send it, parse the reply. That works
 * and it is cheap, and it cannot answer the question that actually produces a good
 * lesson: *has this happened before?* A failure seen once is an anecdote; the same
 * failure across four unrelated worktrees is a fact about the repository. Only a loop
 * that can go and look can tell those apart.
 *
 * ## The protocol
 *
 * The backend is a stateless one-shot process, so there is no provider tool-calling
 * API to lean on. The loop is explicit instead: the model replies with a JSON action,
 * the harness executes it against the ledger, appends the result to a running
 * transcript, and asks again. That is a real tool loop — the model chooses what to
 * look at next based on what it just saw — and it has the useful property that every
 * step is inspectable text rather than an opaque provider structure.
 *
 * ## Every tool is read-only, and that is the security model
 *
 * The corpus is untrusted: transcripts contain arbitrary text, including text shaped
 * like instructions. A model that cannot write has nothing to actuate if it is talked
 * into something, so the defence is the tool surface rather than a filter on the
 * input. `submit` is the only terminal action and its output is validated against the
 * corpus before anything is stored.
 */

import type { BerthDb } from "./db.js";
import { complete, estimateTokens, InferenceError } from "./inference.js";
import { leanSession, promptFingerprint, render, validate, type Learning } from "./learn.js";
import { runTool, renderTools, clip as clipResult } from "./tools.js";

/** Stop before the model can spend the afternoon. */
export const MAX_STEPS = 8;
/** Ceiling on any single step's prompt. */
export const MAX_PROMPT_TOKENS = 60_000;
/**
 * Ceiling on the **whole run**, and the one that actually bounds a session.
 *
 * Checking each step against `MAX_PROMPT_TOKENS` bounds a step, not a session: the
 * transcript is re-sent whole every time, so eight steps could each pass a 60k check
 * and still spend far more than 60k on one session. A per-step limit read as a
 * per-session limit is how a ceiling becomes a surprise bill instead of a graceful
 * stop. Set at three times the single-step ceiling rather than eight, because a run
 * that has spent 180k tokens without submitting is not about to start.
 */
export const MAX_RUN_TOKENS = 180_000;
/** Per tool result. Enough to carry a cause, small enough that eight fit. */
const RESULT_CHARS = 2_000;

export interface Step {
	action: string;
	input: string;
	/** What the tool returned, clipped. Kept so a run can be read back. */
	result: string;
	ms: number;
}

export interface HarnessRun {
	sessionId: string;
	state: "done" | "empty" | "failed" | "skipped";
	learnings: Learning[];
	dropped: { body: string; why: string }[];
	/**
	 * Hash of the session under review, not of the whole conversation. The loop's
	 * later prompts include tool results from across the corpus, which move for
	 * reasons that have nothing to do with this session — fingerprinting those would
	 * mark every stored learning stale whenever any other session grew.
	 */
	fingerprint: string;
	steps: Step[];
	/**
	 * Every prompt sent, summed. The transcript is re-sent whole on each step, so the
	 * cost of a run is the sum and not the last one — and the run that exhausts its
	 * steps is the most expensive outcome, not a free one.
	 */
	promptTokens: number;
	ms: number;
	error?: string;
}

function clip(s: string, n = RESULT_CHARS): string {
	return s.length <= n ? s : `${s.slice(0, n)}\n… [${s.length - n} more characters]`;
}

const SYSTEM = () => `You are extracting DURABLE LESSONS from a recorded coding session.

A durable lesson is something now true about this repository or its tools that a future
engineer would want to know BEFORE starting work. It outlives the session.

GOOD: "The migration runner silently no-ops unless DATABASE_URL is set — it exits 0."
GOOD: "Postgres on 5434 collides with the archived stack; it looks like an auth error."
BAD:  "The agent fixed a bug in auth.ts."     (what happened, not a lesson)
BAD:  "Be careful with async code."           (generic)

You may investigate before answering. Reply with EXACTLY ONE JSON object per message,
no prose, no code fence:

${renderTools()}
  {"action":"submit","learnings":[...]}
      Finish. Only when you have checked whether what you saw happened more than once.

Investigate before answering. A failure in one session is an anecdote; the same failure
in four is a fact about the repository worth writing down — so check.

When done:
  {"action":"submit","learnings":[
     {"scope":"file|repo|session","subject":"src/x.ts","body":"...","cites":[3,7]}]}

RULES
- Most sessions contain ZERO durable lessons. {"action":"submit","learnings":[]} is a
  correct and expected answer. Do not invent one to fill space.
- cites MUST be turn numbers from THIS session (the one shown below).
- Never say work was shipped, merged, released or landed.`;

interface Action { action?: unknown; input?: unknown; learnings?: unknown }

/** One JSON object out of a reply that may be wrapped in prose or a fence. */
export function parseAction(text: string): Action | null {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
	const body = fenced?.[1] ?? text;
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	try {
		return JSON.parse(body.slice(start, end + 1)) as Action;
	} catch {
		return null;
	}
}

/**
 * Run the loop over one session.
 *
 * The conversation is re-sent whole on each step because the backend is stateless.
 * That is why `MAX_STEPS` is small and results are clipped: the transcript grows on
 * every turn, and an unbounded loop would quietly become the most expensive thing in
 * the product.
 */
export async function runHarness(
	db: BerthDb,
	opts: { orgId: string; sessionId: string; maxSteps?: number; onStep?: (s: Step) => void },
): Promise<HarnessRun> {
	const started = Date.now();
	const lean = await leanSession(db, { orgId: opts.orgId, sessionId: opts.sessionId });
	if (!lean || lean.turns.length === 0) {
		return {
			sessionId: opts.sessionId, state: "skipped", learnings: [], dropped: [],
			fingerprint: "", steps: [], promptTokens: 0, ms: Date.now() - started,
		};
	}

	const under = render(lean);
	const fingerprint = promptFingerprint(under);
	const transcript: string[] = [`${SYSTEM()}\n\n=== THE SESSION UNDER REVIEW ===\n${under}`];
	const steps: Step[] = [];
	const limit = opts.maxSteps ?? MAX_STEPS;
	let promptTokens = 0;

	for (let i = 0; i < limit; i += 1) {
		const prompt = `${transcript.join("\n\n")}\n\nReply with one JSON object.`;
		const next = estimateTokens(prompt);
		if (promptTokens + next > MAX_RUN_TOKENS) {
			// Refused before the call, like every other ceiling here. Reported as its
			// own outcome so "this session is too expensive to read this way" is
			// distinguishable from "the model found nothing".
			return {
				sessionId: opts.sessionId, state: "empty", learnings: [], dropped: [], fingerprint,
				steps, promptTokens, ms: Date.now() - started,
				error: `run budget exhausted after ${steps.length} steps`
					+ ` (~${promptTokens} of ${MAX_RUN_TOKENS} tokens)`,
			};
		}
		promptTokens += next;
		let reply: string;
		try {
			reply = (await complete({ prompt, maxInputTokens: MAX_PROMPT_TOKENS })).text;
		} catch (error) {
			return {
				sessionId: opts.sessionId, state: "failed", learnings: [], dropped: [], fingerprint, steps,
				promptTokens, ms: Date.now() - started,
				error: error instanceof InferenceError ? error.message : String(error),
			};
		}

		const act = parseAction(reply);
		if (!act || typeof act.action !== "string") {
			// Told, not failed: a reply that is not an action is usually the model
			// narrating, and one correction recovers the run.
			transcript.push(`ASSISTANT: ${clip(reply, 400)}`);
			transcript.push("SYSTEM: that was not a JSON action. Reply with exactly one JSON object.");
			continue;
		}

		if (act.action === "submit") {
			const raw = Array.isArray(act.learnings) ? act.learnings : [];
			const { kept, dropped } = validate(raw as never[], lean);
			return {
				sessionId: opts.sessionId,
				state: kept.length > 0 ? "done" : "empty",
				learnings: kept, dropped, fingerprint, steps,
				promptTokens, ms: Date.now() - started,
			};
		}

		const input = typeof act.input === "string" ? act.input : "";
		const at = Date.now();
		const result = await runTool(db, {
			orgId: opts.orgId, action: act.action, input,
			fallbackSession: opts.sessionId,
		});
		const step: Step = { action: act.action, input, result, ms: Date.now() - at };
		steps.push(step);
		opts.onStep?.(step);
		transcript.push(`ASSISTANT: ${JSON.stringify({ action: act.action, input })}`);
		transcript.push(`TOOL RESULT:\n${clipResult(result)}`);
	}

	// Out of steps without submitting. Reported as its own outcome rather than as a
	// failure: it usually means the budget is too small for this session, which is a
	// different fix from an error.
	return {
		sessionId: opts.sessionId, state: "empty", learnings: [], dropped: [], fingerprint, steps,
		promptTokens, ms: Date.now() - started,
		error: `no submit within ${limit} steps`,
	};
}
