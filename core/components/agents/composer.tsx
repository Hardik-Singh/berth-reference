"use client";

import { useRef, useState } from "react";
import {
  ArrowUp, ChevronDown, FolderGit2, ListChecks, Loader2, Plus, X, Zap,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import {
  Select, SelectContent, SelectItem, SelectTrigger,
} from "~/components/ui";
import { Button } from "~/components/ui/button";
import { Toggle } from "~/components/ui/toggle";
import { LinkGitHub } from "./link-github";
import { cn } from "~/lib/utils";
import type { AutoPick, RepoChoice } from "~/lib/pick-repo";

/**
 * The composer — shared by `/agents`, where it starts a run, and a session
 * page, where it continues one.
 *
 * The field is a bare `<textarea>` with four classes on it. It was the
 * `Textarea` component before, and every line of that component had to be
 * overridden here — its border, its background, its focus treatment, its
 * minimum height — which is not styling a component, it is fighting one. The
 * component is right for a field in a form; this is a surface that happens to
 * contain a caret, and the box around it owns everything a field would.
 *
 * `field-sizing-content` is the one thing kept from it: the field grows with
 * what is typed, and the cap stops a pasted essay from eating the list behind
 * it.
 */

/** Radix reserves the empty string, so the Auto mode needs a real value. */
const AUTO = "__auto__";

/**
 * Claude only, and that is not a preference — it is what the runner is.
 *
 * `cloud/task.sh` runs `claude -p`, the Claude Code CLI, installed by
 * `cloud/agent.py` and authenticated with `ANTHROPIC_API_KEY`. There is no
 * OpenAI path and no open-weights path; a menu offering `GPT-5` or `Qwen3
 * Coder` — as this one did — was offering something the container cannot load.
 *
 * The ids are what `claude --model` takes. Nothing reads them yet: `task.sh`
 * passes no `--model` flag, so every run is whatever the CLI defaults to. See
 * the note on the state below.
 */
const MODELS = [
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  { id: "claude-fable-5", label: "Fable 5" },
] as const;

/**
 * The real ladder, not the three rungs this had invented.
 *
 * `Ultracode` is last and behind a rule because it is not the next rung — the
 * five above it are one agent thinking for longer, and this one fans out into
 * many. It costs accordingly. Keeping it in the same column says it is the
 * same *decision*; the rule says it is not the same *kind* of answer.
 */
const EFFORTS = ["Low", "Medium", "High", "Xhigh", "Max"] as const;
const ULTRA = "Ultracode";

/** One row of a column. Extracted so the rule-separated option shares it. */
function Row({
  value, selected, onSelect,
}: { value: string; selected: boolean; onSelect: (v: string) => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(value)}
      className={cn(
        "flex h-7 items-center rounded-[var(--radius-nav)] px-2 text-left text-[13px] transition-colors",
        selected
          ? "bg-darkest_primary text-light_primary"
          : "text-muted-foreground hover:bg-hover-muted hover:text-foreground",
      )}
    >
      <span className="truncate">{value}</span>
    </button>
  );
}

/** One column of the model/effort popover: a heading and a list you pick from. */
function Column({
  label, options, value, onChange, className, after,
}: {
  label: string;
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
  className?: string;
  /** Rendered inside the group, after the options — see `EFFORTS`. */
  after?: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0 p-1.5", className)}>
      <div className="px-2 pt-1 pb-1.5 text-[10.5px] font-medium uppercase tracking-[0.09em] text-muted-foreground/70">
        {label}
      </div>
      {/* Radio semantics, because this is one-of-several. A row of buttons
          would put every option in the tab order; a radiogroup is one stop and
          the arrow keys move inside it. */}
      <div role="radiogroup" aria-label={label} className="flex flex-col">
        {options.map((o) => (
          <Row key={o} value={o} selected={o === value} onSelect={onChange} />
        ))}
        {after}
      </div>
    </div>
  );
}

export function Composer({
  picker, prompt, onPrompt, onSubmit, pending, canStart, reason, error,
  placeholder = "What are we building today?",
}: {
  /**
   * The repository control, or `null` for a composer that does not choose one.
   *
   * **Null is the session page**, where a reply continues a run that already
   * happened somewhere: the repository is a fact about the session, shown in its
   * header, and offering to change it would offer to continue this conversation
   * against a different codebase. A picker that must not be used is worse than
   * no picker, because it looks like a decision you are being asked to make.
   */
  picker: {
    choice: RepoChoice;
    onChoice: (v: RepoChoice) => void;
    /**
     * What Auto resolved to, from the caller's `resolveChoice`. Null when the
     * picker is set to an explicit repository.
     *
     * **It is resolved outside this component and displayed inside it**, which
     * is the arrangement that makes Auto safe: the caller needs the slug to
     * submit, and the trigger shows the same slug while the prompt is still
     * being typed. A mode that decided at submit time would be a repository you
     * find out about from the run history.
     */
    auto: AutoPick | null;
    repos: string[];
  } | null;
  prompt: string;
  onPrompt: (v: string) => void;
  onSubmit: () => void;
  pending: boolean;
  canStart: boolean;
  /**
   * Why the run cannot start. **Not rendered** — it is the send button's
   * `title`. See the note where `error` is drawn.
   */
  reason?: string;
  /** An attempt that failed. Rendered under the box, and only this is. */
  error?: string | null;
  /**
   * The only thing that differs between the two places this is mounted.
   *
   * Starting a run and continuing one are the same control with the same
   * options — a second composer for the session page would be a second answer
   * to what a model picker looks like, and the two would drift a row height
   * apart the way the rail and the library did.
   */
  placeholder?: string;
}) {
  /**
   * Model, effort, fast and plan are **not wired to `agents.start` yet** — the
   * mutation takes a prompt and a repository and nothing else, and `task.sh`
   * invokes `claude -p` with no `--model` flag, so every run uses the CLI
   * default whatever this says.
   *
   * Wiring model is three edits and no new infrastructure: the field on the
   * tRPC input, `BERTH_MODEL` in the payload `agent.py` turns into an
   * environment variable, and `--model "$BERTH_MODEL"` in `task.sh`. Effort,
   * fast and plan have no CLI flag behind them and are a larger question.
   */
  const [model, setModel] = useState<string>("claude-opus-5");
  const [effort, setEffort] = useState<string>("Medium");
  const [fast, setFast] = useState(false);
  const [plan, setPlan] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <form
      // `method="post"` on a form this component handles itself: without it the
      // element defaults to GET, so a submit that lands before hydration
      // navigates and puts the prompt in the URL.
      method="post"
      onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
      className="mx-auto w-full max-w-3xl"
    >
      <div className="border border-border bg-panel focus-within:border-foreground/20">
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {files.map((f, i) => (
              <span
                key={`${f.name}-${i}`}
                className="flex h-6 items-center gap-1.5 rounded-full bg-secondary px-2.5 text-[11px]"
              >
                <span className="max-w-[160px] truncate">{f.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => setFiles((v) => v.filter((_, x) => x !== i))}
                  className="grid size-3.5 place-items-center rounded-full opacity-60 hover:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          value={prompt}
          onChange={(e) => onPrompt(e.target.value)}
          // Enter sends; Shift+Enter is a newline. The chord is the other way
          // round in a document and this way round in a message box, and this
          // is a message box.
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(); }
          }}
          rows={2}
          placeholder={placeholder}
          // `edge-focus`, not `outline-none`. The global focus rule is unlayered, so
          // it beats any utility — the field kept drawing a 2px outline two pixels
          // outside itself, inside a box that was already showing focus on its
          // border. `edge-focus` is the documented opt-out for exactly this: a
          // control whose container carries the affordance.
          className="edge-focus field-sizing-content max-h-64 w-full resize-none bg-transparent px-4 py-3.5 text-[14.5px] leading-[1.6] placeholder:text-muted-foreground/60"
        />

        <div className="flex items-center gap-1 px-2 pb-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            accept="image/*"
            className="sr-only"
            onChange={(e) => {
              setFiles((v) => [...v, ...Array.from(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          {/* `variant="icon"`, not a hand-rolled pill. The compound variant
              makes it `aspect-square` with no padding, which is what makes it a
              circle — the local version had `px-2.5` on a 28px row and came out
              an oval. */}
          <Button
            type="button"
            variant="icon"
            size="sm"
            aria-label="Attach files"
            onClick={() => fileInput.current?.click()}
          >
            <Plus />
          </Button>

          {/* The trigger renders the *resolution*, not the mode. In Auto with a
              repository found it reads `Auto · harbor-so/berth`, so the thing
              about to be cloned is on screen before send is pressed; unresolved
              it reads `Auto` and the send button is disabled with the reason
              underneath. `SelectValue` cannot say that — it renders the item's
              own text — so the trigger names its content itself. */}
          {picker && (
            <Select
              value={picker.choice.kind === "repo" ? picker.choice.slug : AUTO}
              onValueChange={(v) =>
                picker.onChoice(v === AUTO ? { kind: "auto" } : { kind: "repo", slug: v })
              }
            >
              <SelectTrigger
                aria-label="Repository"
                className="h-8 w-auto max-w-[280px] gap-1.5 border-0 bg-transparent px-2.5 text-[13px] text-muted-foreground hover:bg-hover-muted hover:text-foreground"
              >
                <FolderGit2 className="size-3.5 shrink-0" />
                <span className="truncate">
                  {picker.choice.kind === "repo" ? (
                    picker.choice.slug
                  ) : picker.auto?.state === "picked" ? (
                    <>
                      Auto
                      <span className="text-muted-foreground/50"> · </span>
                      <span className="text-foreground">{picker.auto.slug}</span>
                    </>
                  ) : (
                    "Auto"
                  )}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO}>Auto</SelectItem>
                {picker.repos.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
              </SelectContent>
            </Select>
          )}

          {/* Model and effort are one popover because they are one decision:
              how much to spend on this. Two triggers side by side invite
              picking a large model and low effort, which is a combination
              nobody wants. Two plain lists rather than two `Select`s — a
              dropdown inside a popover is a second layer to dismiss, and the
              lists are short enough to show whole. */}
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="text" size="sm" aria-label="Model and effort">
                {MODELS.find((m) => m.id === model)?.label ?? model}
                <span className="text-muted-foreground/60">· {effort.toLowerCase()}</span>
                <ChevronDown className="size-3" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="flex w-[360px] gap-0 p-0">
              <Column
                label="Model"
                options={MODELS.map((m) => m.label)}
                value={MODELS.find((m) => m.id === model)?.label ?? ""}
                onChange={(label) =>
                  setModel(MODELS.find((m) => m.label === label)?.id ?? model)
                }
                className="flex-1 border-r border-border"
              />
              <Column
                label="Effort"
                options={EFFORTS}
                value={effort}
                onChange={setEffort}
                className="w-[150px]"
                after={
                  <>
                    <div className="my-1 h-px bg-border" />
                    <Row value={ULTRA} selected={effort === ULTRA} onSelect={setEffort} />
                  </>
                }
              />
            </PopoverContent>
          </Popover>

          {/* `Toggle` carries `aria-pressed` and the on/off state for us. These
              were two more hand-rolled pills with a boolean and a class. */}
          <Toggle variant="accent" size="sm" pressed={fast} onPressedChange={setFast} className="px-2.5">
            <Zap />Fast
          </Toggle>
          <Toggle variant="accent" size="sm" pressed={plan} onPressedChange={setPlan} className="px-2.5">
            <ListChecks />Plan
          </Toggle>

          <Button
            type="submit"
            size="icon-sm"
            aria-label="Start agent"
            // The reason lives here rather than under the box: reachable when
            // somebody wonders why the button is dead, and occupying no layout
            // while they are still typing.
            title={!canStart && reason ? reason : undefined}
            className="ml-auto"
            disabled={!canStart || pending || !prompt.trim()}
          >
            {pending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          </Button>
        </div>
      </div>

      {/* **A failure, and nothing else.**
          A line of standing text under the box was the wrong shape for a
          precondition: "The prompt doesn't name a repository — pick one" sat
          there for as long as the box was empty of a repository name, which is
          most of the time somebody is typing, and it pushed the list above it
          every time it appeared and vanished. The button already refuses, the
          repository control already reads `Auto` rather than a slug, and
          `reason` is on the button as a title for anyone who wants it.

          What is left here is the other kind of message: something that was
          attempted and failed. That has no other place to be said — the send
          was not toasted deliberately — and it goes away on the next attempt. */}
      {error && <p className="mt-2 text-[12px] text-destructive">{error}</p>}

      {/* Who the run will commit as. It sits under the box rather than over it
          for the reason the block above gives: the field is what somebody came
          to use, and a standing line above it pushes the page down every time
          it resolves. */}
      <LinkGitHub className="mt-2" />
    </form>
  );
}
