"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Ban, Bot, Brain, ChevronRight, ClipboardList, CircleHelp, FileText, Globe, Loader2, Minus,
  Pencil, Plug, Plus, Search, Terminal, TriangleAlert, Wrench,
} from "lucide-react";
import { Composer } from "~/components/agents/composer";
import { Markdown } from "~/components/agents/markdown";
import { api } from "~/trpc/client";
import { Patch, Output } from "~/components/session/patch";
import { Mono } from "~/components/ui";
import { cn, commas, compact, plural, timeOrDate } from "~/lib/utils";
import {
  anyTokens, baseName, elapsed, oneLine, stepExpandable, toolFamily, toolLabel, tokensOf,
  type Tokens, type ToolFamily,
} from "~/lib/transcript";
import { LOADED_AT, useHydrated } from "~/lib/hydrated";
import { useOpenFile } from "./workbench";
import { DECISION_PHRASE } from "~/lib/decisions";
import type { CaptureDecision, CaptureEvent, CaptureTurn } from "~/data/schema";

/**
 * A session, read as the conversation it was.
 *
 * **This replaces a page that showed a session as a table of counts.** A turn is
 * a prompt, some work, and an answer — which is a chat, and rendering it as rows
 * of `turns / tools / files / +additions` made a reader reconstruct the exchange
 * from summary statistics.
 *
 * **The steps are inline, one line each, and that is the layout decision.** They
 * were collapsed behind `Worked · 40 tool calls` — one line for the whole middle
 * of a turn — which is tidy and is not what reading a transcript is for: the
 * commands *are* the work, and a reader scanning for the one that failed cannot
 * scan a number. A step is a line; what a step *returned* is behind the line,
 * because output is unbounded and a screenful of `npm install` is not a step.
 *
 * A step with nothing to show is not a disclosure. Rendering `<details>` around
 * an empty body gives a chevron that opens onto nothing, which teaches people
 * the chevrons mean nothing.
 */

type Props = {
  sessionId: string;
  turns: CaptureTurn[];
  events: CaptureEvent[];
  /**
   * What the agent put to a person, and what they said back.
   *
   * These were fetched by `sessions.detail` and dropped on the floor here for
   * as long as this page has existed — every `plan_proposed`, `plan_rejected`,
   * `question_asked` and `tool_denied` was paid for on the wire and rendered
   * nowhere, on the one screen about that session. Home has always shown them,
   * so the product's own answer to "what did this session decide" was on a
   * different page from the session.
   */
  decisions: CaptureDecision[];
  /** Null when the session was not on a repository we can start an agent on. */
  repo: string | null;
  canContinue: boolean;
  reason: string | null;
};

export function Conversation({ sessionId, turns, events, decisions, repo, canContinue, reason }: Props) {
  /**
   * What the reader just sent, before capture has caught up.
   *
   * **A reply takes a container start, an agent, and a push before it appears** —
   * tens of seconds in which the transcript looked exactly as it did before, and
   * the only evidence of the click was a field that had emptied. That reads as a
   * dropped message, and the reflex is to send it again.
   *
   * Cleared when a turn with that prompt arrives, rather than on a timer: the
   * real one replaces the placeholder at the moment it exists, so there is never
   * both and never neither.
   */
  const [pending, setPending] = useState<string[]>([]);
  const landed = new Set(turns.map((t) => t.prompt));
  const waiting = pending.filter((p) => !landed.has(p));

  const router = useRouter();

  /**
   * **The page follows the run, not the reply.**
   *
   * This used to refresh only while *this browser* had an unlanded optimistic
   * message, which answered "did my click work" and nothing else. Everything
   * after that — the agent's turns, its tool calls, the diff — arrived only if
   * somebody reloaded, and a run started from another tab or another person
   * never moved at all.
   *
   * So the condition is the run's state. `agents.bySession` is one indexed row,
   * and while it says `queued` or `running` there is more transcript coming; the
   * moment it does not, the polling stops completely and a tab left open
   * overnight costs nothing.
   *
   * `refetchInterval` is the query's own, and the `useEffect` below is what
   * turns a *changed answer* into a re-render of the server component — the
   * transcript is server-rendered, so the client learning something new is only
   * half of it.
   */
  const run = api.agents.bySession.useQuery(
    { sessionId },
    {
      refetchInterval: (q) => {
        const st = q.state.data?.state;
        return st === "queued" || st === "running" ? 3000 : false;
      },
    },
  );
  const active = run.data?.state === "queued" || run.data?.state === "running";

  useEffect(() => {
    // Either reason to keep asking: an agent is working, or this browser is
    // still waiting to see its own message come back.
    if (!active && waiting.length === 0) return;
    const id = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(id);
  }, [active, waiting.length, router]);

  /**
   * Follow the transcript as it grows, unless the reader has gone looking.
   *
   * **Capture streams in now**, so a page left open while an agent works gains
   * turns every few seconds — and each one landed below the fold with no
   * indication, so watching a run meant scrolling down by hand every time
   * something happened.
   *
   * **Pinned, not forced.** Scrolling somebody to the bottom while they are
   * reading turn two of forty is the worse failure, so this follows only while
   * they are already at the end. `PIN` is the slack: a reader who has nudged up
   * a line is still following, and one who has scrolled up to read is not.
   * Going back to the bottom re-arms it, which is the gesture people already
   * use in every chat client.
   */
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN;
  };

  // `useLayoutEffect`, so the jump happens in the same frame the new turn is
  // painted rather than one after it, which reads as a flicker.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !pinned.current) return;
    el.scrollTop = el.scrollHeight;
  }, [turns.length, events.length, waiting.length, active]);

  const byTurn = new Map<number, CaptureEvent[]>();
  for (const e of events) {
    if (e.turnSeq == null) continue;
    const list = byTurn.get(e.turnSeq) ?? [];
    list.push(e);
    byTurn.set(e.turnSeq, list);
  }

  /**
   * **`decision.seq` is a turn seq, not an event seq**, which is why this is a
   * plain group rather than a merge by timestamp. The collector emits a
   * decision with the seq of the turn it closed, so seq 3 is turn 3 — checked
   * against the ledger, where a `plan_rejected` at seq 3 is stamped 200ms
   * before turn 4 opens. Several decisions can share one seq: an
   * `AskUserQuestion` with four questions is four rows, deliberately, because
   * a person can answer them differently.
   */
  const decisionsByTurn = new Map<number, CaptureDecision[]>();
  for (const d of decisions) {
    const list = decisionsByTurn.get(d.seq) ?? [];
    list.push(d);
    decisionsByTurn.set(d.seq, list);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* `data-transcript` is the handle `ExpandAll` in the header reaches
          through. A `<details>` is uncontrolled by design — the browser owns
          its state — so driving every one of them from React state would mean
          either remounting the transcript on each toggle, losing the scroll
          position, or fighting the element. Setting `.open` on the nodes is
          what the element is for. */}
      <div
        ref={scroller}
        onScroll={onScroll}
        data-transcript
        className="min-h-0 flex-1 overflow-auto"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-8">
          {turns.length === 0 && !active ? (
            <p className="text-[13px] text-muted-foreground">
              Nothing captured yet.
            </p>
          ) : (
            turns.map((t) => (
              <Turn
                key={t.seq}
                turn={t}
                events={byTurn.get(t.seq) ?? []}
                decisions={decisionsByTurn.get(t.seq) ?? []}
              />
            ))
          )}

          {waiting.map((p) => <Pending key={p} prompt={p} />)}

          {/* The run is live and this browser is not waiting on a message of its
              own — somebody else started it, or the reply landed and the agent
              is still working. Without this the page just sits there looking
              finished while turns are still arriving. */}
          {active && waiting.length === 0 && (
            <div className="flex items-center gap-2.5 text-[13px] text-muted-foreground">
              <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
              {run.data?.state === "queued" ? "Starting a container…" : "The agent is working…"}
            </div>
          )}
        </div>
      </div>

      <Continue
        sessionId={sessionId}
        repo={repo}
        canContinue={canContinue}
        reason={reason}
        onSent={(p) => setPending((q) => [...q, p])}
        onFailed={(p) => setPending((q) => q.filter((x) => x !== p))}
      />
    </div>
  );
}

/**
 * A message that has been sent and not yet captured.
 *
 * Drawn exactly like a real prompt so the transcript does not reflow when the
 * captured one replaces it — a placeholder that changes shape on arrival is a
 * flicker that draws the eye to the wrong thing. The only difference is the line
 * beneath, which says why nothing has answered yet.
 */
function Pending({ prompt }: { prompt: string }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-panel px-4 py-2.5 text-[14px] leading-[1.6]">
          {prompt}
        </div>
      </div>
      <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Starting a container — the reply appears here when the agent has run.
      </div>
    </div>
  );
}

function Turn({
  turn, events, decisions,
}: { turn: CaptureTurn; events: CaptureEvent[]; decisions: CaptureDecision[] }) {
  const steps = events.filter((e) => e.tool);
  const touched = events.filter((e) => e.path && (e.additions > 0 || e.deletions > 0));
  const reasoning = turn.reasoning?.trim() ?? "";

  return (
    <div className="flex flex-col gap-3">
      {/* What the person asked. Right-aligned and rounded, so the eye finds the
          questions in a long transcript without reading the answers. */}
      {turn.prompt && (
        <div className="flex justify-end">
          <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-panel px-4 py-2.5 text-[14px] leading-[1.6]">
            {turn.prompt}
          </div>
        </div>
      )}

      {/* What it thought, before what it did. Closed, because reasoning is
          long and is not the answer — but present, because "why did it do
          that" is the question a transcript is opened to settle. */}
      {/* **The work, behind one line, closed.** What a turn *did* is most of its
          height and least of what a reader came for — the question is almost
          always the prompt and the answer, and the forty rows between them are
          how you settle a disagreement about one of them. So they fold, and the
          line that folds them says what is inside: how many calls, and of what
          kind. A run that is all `read` and `search` is an investigation and one
          that is all `edit` is a refactor, and the glyphs say which without
          opening anything.

          It sits after the prompt and above the thinking, because that is the
          order the turn happened in. */}
      {(reasoning || steps.length > 0) && (
        <Work steps={steps} reasoning={reasoning} />
      )}

      {/* After the steps and before the summary, which is where they happened:
          a plan is put once the agent has looked, and a rejection is the last
          thing in the turn it ends. */}
      {decisions.map((d, i) => <Decision key={i} decision={d} />)}

      {turn.summary && <Markdown>{turn.summary}</Markdown>}

      <Meta turn={turn} touched={touched} events={events} />
    </div>
  );
}

/**
 * A disclosure that is not a step: same row, same affordance, any body.
 *
 * Written once so the reasoning block and the tool steps cannot drift apart —
 * they are the same control and a reader should not have to learn two.
 *
 * **There is no chevron.** A column of them down the left of a transcript is a
 * second vertical rule beside the one the icons already make, and it is on
 * screen permanently to advertise something you only need to know while you are
 * pointing at a row. So the affordance is the row itself: hovering fills it —
 * a badge's ground and a badge's corner — and the tool's own glyph becomes a
 * `+`, or a `−` when it is already open. Nothing is added to the layout and
 * nothing moves when it appears.
 */
function Disclosure({
  icon: Icon, label, note, children, tone,
}: {
  icon: typeof Wrench;
  label: React.ReactNode;
  note?: React.ReactNode;
  children: React.ReactNode;
  tone?: "error";
}) {
  return (
    <details className="group/d">
      {/* The group is on the summary, not on the `<details>`: hovering the
          *body* of an open step must not light up its head. */}
      <summary className="group/row flex w-full cursor-pointer list-none items-center gap-2 rounded-[3px] px-1.5 py-1 transition-colors hover:bg-hover-muted [&::-webkit-details-marker]:hidden">
        <span className="relative grid size-4 shrink-0 place-items-center">
          <Icon
            className={cn(
              "size-3.5 transition-opacity group-hover/row:opacity-0",
              tone === "error" ? "text-destructive" : "text-muted-foreground",
            )}
          />
          {/* Stacked rather than swapped, so the row cannot reflow by a pixel
              between one glyph and the next. */}
          <Plus className="absolute size-3.5 text-foreground opacity-0 transition-opacity group-hover/row:opacity-100 group-open/d:hidden" />
          <Minus className="absolute hidden size-3.5 text-foreground opacity-0 transition-opacity group-hover/row:opacity-100 group-open/d:block" />
        </span>
        {/* `min-w-0` and `flex-1`, which is what stops a long command from
            pushing the row wider than the column. The label is two pieces —
            a name and a code chip — and they need the gap between them, so
            this is a flex row rather than a wrapper span. */}
        <span className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">{label}</span>
        {note && <span className="shrink-0 text-[11.5px] text-muted-foreground">{note}</span>}
      </summary>
      {/* Aligned to the label rather than to the glyph: 6px of padding, a 16px
          icon and an 8px gap. */}
      <div className="mt-1.5 mb-1 flex flex-col gap-2 pr-1.5 pl-[30px]">{children}</div>
    </details>
  );
}

/** Words, for the reasoning note. A character count means nothing to a reader. */
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * How many identical calls in a row before they collapse into one row.
 *
 * Four, not two. A pair of `Read`s is how a turn normally looks and hiding it
 * behind a disclosure would make the common case a click; a run of forty
 * `Bash` calls is a wall that pushes the prompt and the summary off screen,
 * which is the thing the transcript is read for. Three is the largest run that
 * still reads as "it did a few things".
 */
/**
 * How far off the bottom still counts as "following".
 *
 * A line and a half. Tight enough that a reader who has scrolled up to read
 * something is left alone, loose enough that the browser's own sub-pixel
 * rounding does not un-pin a page nobody touched.
 */
const PIN = 48;

const RUN_MIN = 4;

/**
 * Consecutive steps, split into runs of the same tool.
 *
 * Consecutive is the whole rule: `Bash Bash Bash Read Bash` is a run of three,
 * a `Read`, and a run of one — never a run of four `Bash`. Collapsing
 * non-adjacent calls would reorder the transcript, and the order is the only
 * thing a transcript is actually authoritative about.
 */
function runsOf(steps: CaptureEvent[]): Array<{ tool: string; events: CaptureEvent[] }> {
  const out: Array<{ tool: string; events: CaptureEvent[] }> = [];
  for (const e of steps) {
    const tool = e.tool ?? "";
    const last = out[out.length - 1];
    if (last && last.tool === tool) last.events.push(e);
    else out.push({ tool, events: [e] });
  }
  return out;
}

/**
 * A run of the same tool, behind one row: `Bash × 50`.
 *
 * **The failure count is on the closed row**, and that is the point of the
 * component rather than a decoration on it. A collapsed run that says only how
 * many calls it holds hides the one fact a reader is scanning for — that
 * eleven of those fifty exited non-zero — and hiding it behind a click is
 * worse than not collapsing at all, because the reader has no reason to
 * suspect there is anything to open.
 */
function StepRun({ tool, events }: { tool: string; events: CaptureEvent[] }) {
  const Icon = ICONS[toolFamily(tool)];
  const failed = events.filter((e) => e.error).length;
  return (
    <Disclosure
      icon={Icon}
      tone={failed > 0 ? "error" : undefined}
      label={
        <>
          <span className="shrink-0 text-[13px]">{toolLabel(tool)}</span>
          <span className="shrink-0 rounded-[3px] bg-secondary px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground">
            × {events.length}
          </span>
          {failed > 0 && (
            <span className="shrink-0 text-[12px] text-destructive">
              {commas(failed)} failed
            </span>
          )}
        </>
      }
    >
      {events.map((e, i) => <Step key={i} event={e} />)}
    </Disclosure>
  );
}

/** One glyph per decision kind, and a fallback for a kind this build predates. */
const DECISION_ICON: Record<string, typeof Wrench> = {
  plan_proposed: ClipboardList,
  plan_rejected: Ban,
  question_asked: CircleHelp,
  tool_denied: Ban,
};

/** The two kinds that are a person refusing. Drawn in the error tone. */
const REFUSAL = new Set(["plan_rejected", "tool_denied"]);

/**
 * The agent put something to a person, and this is what happened.
 *
 * `plan_proposed` carries `ExitPlanMode`'s whole input as JSON, because the
 * collector stores the tool call verbatim rather than a field it picked out.
 * The plan itself is the `plan` key, so it is lifted here — a reader opening
 * "plan proposed" wants the plan, not a JSON object with the plan inside it —
 * and anything that does not parse falls back to the raw text rather than
 * rendering empty. Nothing is re-derived: this only ever *narrows* to a value
 * that was already stored.
 */
function Decision({ decision: d }: { decision: CaptureDecision }) {
  const Icon = DECISION_ICON[d.kind] ?? Wrench;
  const refusal = REFUSAL.has(d.kind);
  const body = d.question ?? planOf(d.detail);
  const note = d.answer
    ? `answered${d.custom ? " (their own words)" : ""}`
    : undefined;

  const label = (
    <>
      <span className={cn("shrink-0 text-[13px]", refusal && "text-destructive")}>
        {DECISION_PHRASE[d.kind] ?? d.kind}
      </span>
      {d.answer && (
        <span className="min-w-0 truncate rounded-[3px] bg-secondary px-1.5 py-0.5 text-[12px] text-muted-foreground">
          {oneLine(d.answer)}
        </span>
      )}
    </>
  );

  // Nothing was captured beyond the fact itself — a `plan_rejected` on a
  // `--no-content` run is exactly that. A disclosure that opens onto an empty
  // box is worse than a line that does not open.
  if (!body && d.options.length === 0) {
    return (
      <div className="flex w-full items-center gap-2 px-1.5 py-1">
        <span className="grid size-4 shrink-0 place-items-center">
          <Icon className={cn("size-3.5", refusal ? "text-destructive" : "text-muted-foreground")} />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2">{label}</span>
      </div>
    );
  }

  return (
    <Disclosure icon={Icon} label={label} note={note} tone={refusal ? "error" : undefined}>
      {body && (
        <div className="whitespace-pre-wrap text-[13px] leading-[1.6] text-muted-foreground">
          {body}
        </div>
      )}
      {d.options.length > 0 && (
        <ul className="flex flex-col gap-1">
          {d.options.map((o, i) => (
            <li
              key={i}
              className={cn(
                "text-[12.5px]",
                d.answer === o ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {d.answer === o ? "● " : "○ "}
              {o}
            </li>
          ))}
        </ul>
      )}
      {d.answer && (
        <div className="whitespace-pre-wrap text-[13px] leading-[1.6]">{d.answer}</div>
      )}
    </Disclosure>
  );
}

/** `ExitPlanMode`'s `plan`, or the raw detail when it is not that shape. */
function planOf(detail: string | null): string | null {
  const text = detail?.trim();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "plan" in parsed) {
      const plan = (parsed as { plan: unknown }).plan;
      if (typeof plan === "string" && plan.trim() !== "") return plan;
    }
  } catch {
    // Not JSON. The verbatim string is still the best thing to show.
  }
  return text;
}

/**
 * One step: what was run, and — behind it — everything about it.
 *
 * The chip is one line and truncated. A step is a thing you skim past; a `find`
 * with nine predicates wrapping to four lines makes the turn around it
 * unreadable. Everything the chip could not hold is inside: the command
 * verbatim with its newlines, the diff, stdout and stderr, the path, and what
 * the call consumed.
 *
 * **The disclosure used to appear only when a patch or an output was captured**,
 * and both are `--full` only — so on laptop capture, which is most of the
 * corpus, every step was a dead line and the truncated command could not be
 * read at all. `stepExpandable` is the rule now, and it opens on anything a
 * reader could want rather than on the two columns that happen to be biggest.
 */
function Step({ event: e }: { event: CaptureEvent }) {
  const Icon = ICONS[toolFamily(e.tool)];
  const detail = e.detail?.trim() ?? "";
  const chip = detail ? oneLine(detail) : e.path ?? "";
  const tokens = tokensOf(e);
  // What we know happened without holding a line of it: the counts are captured
  // on every run, the body only on `--full`.
  const changed = e.additions > 0 || e.deletions > 0 || e.patchHunks > 0;

  const label = (
    <>
      <span className={cn("shrink-0 text-[13px]", e.error && "text-destructive")}>
        {toolLabel(e.tool)}
      </span>
      {chip && (
        <span className="min-w-0 truncate rounded-[3px] bg-secondary px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground">
          {chip}
        </span>
      )}
      {e.error && <TriangleAlert className="size-3.5 shrink-0 text-destructive" />}
    </>
  );

  if (!stepExpandable(e)) {
    // Same metrics as a `Disclosure` head, so a mixed run of steps is one
    // column rather than two that nearly line up — and no hover fill, because
    // there is nothing to open.
    return (
      <div className="flex w-full items-center gap-2 px-1.5 py-1">
        <span className="grid size-4 shrink-0 place-items-center">
          <Icon className={cn("size-3.5", e.error ? "text-destructive" : "text-muted-foreground")} />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2">{label}</span>
      </div>
    );
  }

  return (
    <Disclosure icon={Icon} label={label} tone={e.error ? "error" : undefined}>
      {/* **Always, not only when it differs from the chip.**
          The chip is a preview — squashed onto one line and cut at the column
          edge — and the box is the command as it was run. The rule used to be
          "show it if it does not match the chip", which meant a short `Bash`
          step opened onto its output with the command nowhere on screen: you
          were reading the result of something you could no longer see. A second
          copy of a short string costs a line; guessing when somebody wants the
          exact bytes costs them the thing they opened it for.

          Same treatment as the patch and the output below it, because it is the
          same kind of artefact — a verbatim block you may want to select. */}
      {detail && (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-black/60 px-3 py-2 font-mono text-[12px] leading-5 text-zinc-300">
          {detail}
        </pre>
      )}

      {/* The real diff renderer, with old and new line numbers — the same one
          `/changes` and the panel use, rather than text coloured by its first
          character. */}
      {/* `path` is what names the grammar — without it `languageOf` answers
          null and the diff renders in one colour. This is the most-opened diff
          in the product: the Changes panel is somewhere you go deliberately, a
          step is where you already are. */}
      {e.patch && <Patch text={e.patch} path={e.path} />}
      {e.output && <Output text={e.output} error={e.error} />}

      {/* **The diff is renderable, and there is nothing to render.**
          `patch` is `--full` only — patch bodies are ~96% of the bytes capture
          would carry, so laptop collection deliberately omits them — and
          measured against this ledger it is null on all 103,000 tool calls.
          An edit that changed forty lines and shows no diff reads as the
          product having lost it, so the step says which silence this is. */}
      {!e.patch && changed && (
        <p className="text-[11.5px] text-muted-foreground">
          No diff captured — this session was collected before capture became
          complete, or with <Mono>--no-content</Mono>. Re-running{" "}
          <Mono>berth collect</Mono> does not backfill it: a transcript that has
          stopped changing is never pushed again.
        </p>
      )}

      <Consumed event={e} tokens={tokens} />
    </Disclosure>
  );
}

/**
 * What one step touched and cost.
 *
 * The four token counts are named rather than summed. `cacheRead` is usually
 * an order of magnitude larger than the rest and is the one that answers "why
 * is this session expensive" — a single total hides precisely that.
 */
function Consumed({ event: e, tokens }: { event: CaptureEvent; tokens: Tokens }) {
  const counts = anyTokens(tokens);
  if (!e.path && !counts && !e.additions && !e.deletions && !e.patchHunks) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {e.path && <span className="max-w-full truncate font-mono">{e.path}</span>}
      {e.patchHunks > 0 && (
        <span className="tnum">
          {plural(e.patchHunks, "hunk")} · {plural(e.patchLines, "line")}
        </span>
      )}
      {(e.additions > 0 || e.deletions > 0) && (
        <span className="font-mono tnum">
          {e.additions > 0 && <span className="text-success">+{commas(e.additions)}</span>}
          {e.additions > 0 && e.deletions > 0 && " "}
          {e.deletions > 0 && <span className="text-destructive">−{commas(e.deletions)}</span>}
        </span>
      )}
      {counts && (
        <span className="font-mono tnum">
          {tokens.input > 0 && `${compact(tokens.input)} in`}
          {tokens.input > 0 && tokens.output > 0 && " · "}
          {tokens.output > 0 && `${compact(tokens.output)} out`}
          {(tokens.input > 0 || tokens.output > 0) && tokens.cacheRead > 0 && " · "}
          {tokens.cacheRead > 0 && `${compact(tokens.cacheRead)} cache read`}
          {tokens.cacheWrite > 0 && ` · ${compact(tokens.cacheWrite)} cache write`}
        </span>
      )}
    </div>
  );
}

/**
 * The turn's footer: how long it took, when it ended, and what it touched.
 *
 * Modelled on the transcript this page was drawn from. The file chips are the
 * useful half — a turn's effect on the tree, at a glance, without opening the
 * diff — and they are capped because a refactor touching ninety files would
 * otherwise be ninety chips between two sentences.
 */
function Meta({
  turn, touched, events,
}: { turn: CaptureTurn; touched: CaptureEvent[]; events: CaptureEvent[] }) {
  const hydrated = useHydrated();
  const took = elapsed(turn.startedAt, turn.endedAt);
  // `—` is what an unstamped turn formats to, and a lone em dash in the
  // footer is noise rather than information.
  const at = turn.endedAt ?? turn.startedAt;
  const when = at ? timeOrDate(at, LOADED_AT, hydrated) : null;
  const shown = touched.slice(0, 4);
  const rest = touched.slice(4);
  // What the turn cost, as one figure. The four counts broken out belong on the
  // step that spent them; here the question is only "was this turn expensive",
  // and cache reads are what make one so.
  const spent = events.reduce((n, e) => n + e.inputTokens + e.outputTokens + e.cacheReadTokens, 0);
  if (!took && !when && touched.length === 0 && spent === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11.5px] text-muted-foreground">
      {took && <span className="tnum">{took}</span>}
      {took && when && <span>·</span>}
      {when && <span className="tnum">{when}</span>}
      {spent > 0 && (took || when) && <span>·</span>}
      {spent > 0 && <span className="tnum">{compact(spent)} tokens</span>}
      {shown.map((e, i) => (
        <Chip
          key={i}
          label={baseName(e.path!)}
          additions={e.additions}
          deletions={e.deletions}
          title={e.path!}
          path={e.path!}
        />
      ))}
      {rest.length > 0 && (
        <Chip
          label={`+${rest.length} more`}
          additions={rest.reduce((n, e) => n + e.additions, 0)}
          deletions={rest.reduce((n, e) => n + e.deletions, 0)}
          title={rest.map((e) => e.path).join("\n")}
        />
      )}
    </div>
  );
}

/**
 * A file the turn touched.
 *
 * **A button when there is one file behind it, a label when there is not.** The
 * `+3 more` chip stands for several paths and has no single file to open, so it
 * stays inert rather than picking one of them — a control that opens *a* file
 * when you asked about four is worse than a control that does nothing, because
 * you have to read the tab to find out it guessed.
 *
 * `useOpenFile` is null outside a `Workbench`, which is the other reason this
 * branches: the chip renders the same either way and simply stops being a
 * control.
 */
function Chip({
  label, additions, deletions, title, path,
}: {
  label: string; additions: number; deletions: number; title: string;
  /** The single file this chip stands for, if it stands for one. */
  path?: string;
}) {
  const openFile = useOpenFile();
  const body = (
    <>
      <span className="truncate text-foreground/80">{label}</span>
      {additions > 0 && <span className="shrink-0 tnum text-success">+{additions}</span>}
      {deletions > 0 && <span className="shrink-0 tnum text-destructive">−{deletions}</span>}
    </>
  );
  const shell = "flex h-5 max-w-[200px] items-center gap-1.5 rounded-full bg-secondary px-2 font-mono text-[11px]";

  if (!path || !openFile) return <span title={title} className={shell}>{body}</span>;

  return (
    <button
      type="button"
      title={`Open ${path}`}
      onClick={() => openFile(path)}
      className={cn(shell, "cursor-pointer transition-colors hover:bg-hover-accent hover:text-foreground")}
    >
      {body}
    </button>
  );
}

/**
 * Continue the session.
 *
 * The same composer `/agents` starts a run with, so the model, effort and
 * repository controls are one component rather than two that nearly agree. It
 * passes `resumeSessionId`, so the agent picks this session's context up rather
 * than re-deriving it from a prompt describing it.
 *
 * **No toast.** A toast belongs to an attempt whose result is somewhere else;
 * here the result is this page — the field clears and the transcript grows —
 * and a notification saying what just happened in front of you is a second
 * thing to dismiss. A failure still needs saying, and it is said in place.
 */
function Continue({
  sessionId, repo, canContinue, reason, onSent, onFailed,
}: {
  sessionId: string; repo: string | null; canContinue: boolean; reason: string | null;
  onSent: (prompt: string) => void; onFailed: (prompt: string) => void;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  /**
   * **The repository is not a control here.** A reply continues *this* session,
   * and the session ran on one repository — that is a fact about it, shown in
   * the page header beside the branch, not a decision to re-make in the box you
   * type a reply into. Offering to change it would offer to continue this
   * conversation against a different codebase, which is not continuing it.
   *
   * So there is no picker and no `github.repos` query on this screen. The
   * repository comes from the session and goes straight to `start`.
   */

  const start = api.agents.start.useMutation({
    onSuccess: () => { setFailed(null); router.refresh(); },
    // The optimistic message is withdrawn on failure, or it would sit there
    // waiting for a reply that no agent was ever asked for.
    onError: (e, vars) => { setFailed(e.message); onFailed(vars.prompt); },
  });

  /**
   * A session with no repository recorded cannot be continued, and says so
   * rather than offering a box that fails on send. Old capture from a laptop
   * with no remote is the case; a background run always has one.
   */
  const noRepo = repo
    ? null
    : "This session has no repository recorded, so there is nothing to continue it against.";

  const send = () => {
    const prompt = text.trim();
    if (!prompt || !canContinue || !repo || start.isPending) return;
    // Cleared and shown before the request, not after it: the field emptying is
    // the acknowledgement, and waiting for a round trip to give it is what made
    // this feel slow.
    setText("");
    onSent(prompt);
    start.mutate({ prompt, repo, resumeSessionId: sessionId });
  };

  return (
    <div className="px-6 pb-5">
      <Composer
        picker={null}
        prompt={text}
        onPrompt={setText}
        onSubmit={send}
        pending={start.isPending}
        canStart={canContinue && !noRepo}
        // The two are different messages and only one of them is drawn: a
        // precondition explains a dead button and belongs on it, a failed send
        // has nowhere else to be said.
        reason={reason ?? noRepo ?? undefined}
        error={failed}
        placeholder="Reply to this session…"
      />
    </div>
  );
}

/**
 * A glyph per family of tool. The classifier is in `~/lib/transcript`; this is
 * the only part of it that is a component, and it is a map rather than a
 * function returning one because `react-hooks/static-components` cannot tell a
 * call that returns a component from a component defined during render.
 */
/**
 * One turn's work — the thinking and the tool calls — behind a single line.
 *
 * **Closed by default**, which is the decision worth defending. An open
 * transcript is honest and unreadable: a turn that ran forty tools puts forty
 * rows between the question and the answer, so the two things a reader almost
 * always wants are the two furthest apart. Folded, a session reads as the
 * conversation it was, and the work is one click away for the times it is the
 * point.
 *
 * **The line says what is inside rather than that something is.** `12 tool
 * calls` with a terminal and a pencil beside it is a different turn from `12
 * tool calls` with a magnifying glass, and knowing which is what decides whether
 * to open it. Icons are unique and in first-appearance order — twelve terminal
 * glyphs in a row is a texture, not a list.
 *
 * A `<details>`, so it is the browser's own state: nothing re-renders when it
 * toggles, and find-in-page can open it by itself to show a match inside.
 */
function Work({ steps, reasoning }: { steps: CaptureEvent[]; reasoning: string }) {
  // First appearance order, de-duplicated by family.
  const families: ToolFamily[] = [];
  for (const e of steps) {
    const f = toolFamily(e.tool);
    if (!families.includes(f)) families.push(f);
  }

  return (
    <details className="group/w">
      <summary className="flex w-full cursor-pointer list-none items-center gap-2 rounded-[var(--radius-nav)] px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-hover-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-open/w:rotate-90" />
        <span className="tnum">
          {steps.length > 0
            ? `${commas(steps.length)} ${steps.length === 1 ? "tool call" : "tool calls"}`
            : "Thought"}
        </span>
        {/* The thinking is named here rather than left to be discovered inside,
            because "did it reason about this" is a question people ask of a turn
            without wanting to read the reasoning. */}
        {reasoning && steps.length > 0 && (
          <span className="text-muted-foreground/60">· thought</span>
        )}
        <span className="flex items-center gap-1.5">
          {families.map((f) => {
            const Icon = ICONS[f];
            return <Icon key={f} className="size-3.5 shrink-0 opacity-70" aria-label={f} />;
          })}
        </span>
      </summary>

      <div className="mt-1.5 flex flex-col gap-3 pl-[22px]">
        {reasoning && (
          <Disclosure icon={Brain} label="Thought" note={`${commas(words(reasoning))} words`}>
            <div className="whitespace-pre-wrap text-[13px] leading-[1.6] text-muted-foreground">
              {reasoning}
            </div>
          </Disclosure>
        )}

        {runsOf(steps).map((run, i) =>
          run.events.length >= RUN_MIN ? (
            <StepRun key={i} tool={run.tool} events={run.events} />
          ) : (
            run.events.map((e, j) => <Step key={`${i}.${j}`} event={e} />)
          ),
        )}
      </div>
    </details>
  );
}

const ICONS: Record<ToolFamily, typeof Wrench> = {
  mcp: Plug,
  shell: Terminal,
  edit: Pencil,
  read: FileText,
  search: Search,
  web: Globe,
  agent: Bot,
  other: Wrench,
};
