/**
 * The pure half of the session transcript.
 *
 * These live here rather than beside the component that renders them because
 * they are the only parts of it worth asserting: a duration that goes backwards
 * or an MCP tool that reads as `mcp__linear-server__list_issues` is a bug you
 * can write down, and everything else in `conversation.tsx` is layout. Keeping
 * them in a `"use client"` module would mean either exporting internals for a
 * test or not testing them, and the second is what happened.
 */

/** `src/app/page.tsx` → `page.tsx`. A chip is a glance, and a path is not one. */
export const baseName = (p: string) => p.split("/").pop() ?? p;

/**
 * How long a turn took, or null when the harness never stamped it.
 *
 * Null rather than `0s` for an unstamped turn: absent and instant are different
 * facts, and the capture legitimately holds both. A negative span — clocks do
 * go backwards — is also null, because `-3s` is not a duration anybody can act
 * on and it is not worth inventing one.
 */
export function elapsed(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** `mcp__linear-server__list_issues` → `linear-server · list issues`. */
export function toolLabel(tool: string | null): string {
  if (!tool) return "tool";
  if (!tool.startsWith("mcp__")) return tool;
  const [, server, ...verb] = tool.split("__");
  return `${server} · ${verb.join(" ").replace(/_/g, " ")}`;
}

export const TOOL_FAMILIES = [
  "mcp", "shell", "edit", "read", "search", "web", "agent", "other",
] as const;

export type ToolFamily = (typeof TOOL_FAMILIES)[number];

/**
 * A family per tool, so the transcript draws a glyph per *kind* of step rather
 * than maintaining a list of every tool any harness has ever shipped.
 *
 * `other` rather than nothing for an unknown one: a step with no icon reads as
 * a different kind of line from the ones around it, which is exactly what it is
 * not. MCP is checked first because an MCP server may be called anything at
 * all — `mcp__github__search_code` is not a search step, it is an MCP step.
 */
export function toolFamily(tool: string | null): ToolFamily {
  const t = (tool ?? "").toLowerCase();
  if (t.startsWith("mcp__")) return "mcp";
  if (t.includes("bash") || t.includes("shell")) return "shell";
  // `apply_patch` is Codex's editor and is the single most common edit in the
  // ledger — 10,337 calls against `Edit`'s 2,985. It was landing in `other` and
  // drawing a wrench.
  if (t.includes("edit") || t.includes("write") || t.includes("notebook") || t.includes("patch")) return "edit";
  if (t.includes("read")) return "read";
  if (t.includes("grep") || t.includes("glob") || t.includes("search")) return "search";
  if (t.includes("web") || t.includes("fetch")) return "web";
  if (t.includes("task") || t.includes("agent")) return "agent";
  return "other";
}

/**
 * What a step consumed. Zeroes are dropped by the caller, not here.
 *
 * `cacheRead` is usually the largest of the four by an order of magnitude and
 * is the one worth seeing: it is context re-read on every turn, and a session
 * whose cache reads are climbing is one where the agent is carrying more than
 * it needs. Summing the four into a single "tokens" figure hides exactly that.
 */
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

export function tokensOf(e: {
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
}): Tokens {
  return {
    input: e.inputTokens,
    output: e.outputTokens,
    cacheRead: e.cacheReadTokens,
    cacheWrite: e.cacheWriteTokens,
  };
}

export const anyTokens = (t: Tokens) => t.input + t.output + t.cacheRead + t.cacheWrite > 0;

/** Collapse a command to the one line a step's chip shows. */
export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Whether a step has anything behind it worth opening.
 *
 * **The rule used to be `patch || output`, and that was the bug.** Those two
 * columns are `--full` only, so on laptop capture — which is most of the corpus
 * — every step in the transcript was a dead line with no disclosure at all,
 * including the `Bash` rows whose command had been squashed onto one line and
 * truncated with an ellipsis. The full text of what was run was in the row's
 * own `title` and nowhere a reader could see it.
 *
 * So: a step opens when it holds a body, a *fuller* version of what its chip
 * already shows, a path the chip did not have room for, or a token count. What
 * is left closed is the genuinely empty step, and a chevron that opens onto
 * nothing is worse than no chevron.
 */
export function stepExpandable(e: {
  detail: string | null; path: string | null; patch: string | null; output: string | null;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
}): boolean {
  if (e.patch || e.output) return true;
  if (anyTokens(tokensOf(e))) return true;
  const detail = e.detail?.trim() ?? "";
  // Multi-line or long enough that the chip is showing a prefix of it.
  if (detail && (detail !== oneLine(detail) || detail.length > 80)) return true;
  // A path the chip is not already showing, because `detail` won the slot.
  return Boolean(e.path && e.detail);
}
