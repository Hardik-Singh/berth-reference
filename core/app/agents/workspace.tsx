"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle, Archive, ArchiveRestore, Check, CheckCircle2, Clock, GitBranch,
  GitPullRequest, Loader2, Slash as SlashIcon,
} from "lucide-react";
import { Dithering } from "@paper-design/shaders-react";
import { cn } from "~/lib/utils";
import { Mono } from "~/components/ui";
import { RAISED } from "~/components/fleet/bits";
import { Composer } from "~/components/agents/composer";
import { resolveChoice, type RepoChoice } from "~/lib/pick-repo";
import { useToast } from "~/components/ui/toast";
import { api } from "~/trpc/client";

/**
 * The agent workspace: everything that has run, and one place to start another.
 *
 * The page this replaced had five regions — a prepared-work card carrying a
 * four-step story and a bar chart, a candidates panel, a replay panel, a
 * composer panel and a runs panel — stacked above each other, each with its own
 * heading and note. The work you came to look at was the fifth thing down.
 *
 * There are two things here now. The list is the page and it fills the height.
 * The composer is pinned to the foot of it, because starting a run is what you
 * do *after* reading the list, and a composer at the top pushes the list down
 * on the one screen where the list is the point.
 */

/** Quiet enough for a column of them: a dot and the word, not a filled badge. */
/**
 * State as one coloured icon, not a dot plus the word beside it.
 *
 * The word and the dot said the same thing twice and cost a column doing it. An
 * icon carries the meaning at a glance and leaves the row's width for the things
 * that differ between runs — the prompt, the repository, the branch.
 *
 * **Colour is never the only signal.** Each shape is distinct — a spinner, a
 * tick, a slash, a triangle — so the state survives a monochrome screen and the
 * roughly one man in twelve who would not separate the green from the red. The
 * word is still there for assistive tech, as the icon's label.
 */
const STATE: Record<string, { icon: typeof Check; className: string; label: string; spin?: boolean }> = {
  queued: { icon: Clock, className: "text-muted-foreground", label: "queued" },
  running: { icon: Loader2, className: "text-primary", label: "running", spin: true },
  done: { icon: CheckCircle2, className: "text-success", label: "done" },
  no_changes: { icon: SlashIcon, className: "text-warning", label: "ran, nothing to change" },
  failed: { icon: AlertTriangle, className: "text-destructive", label: "failed" },
};

/** "4m", "3h", "6d" — a list is scanned, and a full timestamp is not scannable. */
function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "now";
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * The artwork, which stays.
 *
 * **It used to render only while the list was empty**, so the first run made the
 * page it landed on visibly plainer — the reward for using the product was
 * losing its only piece of character. It is a backdrop now: always mounted,
 * always behind, and the rows sit over it.
 *
 * **Its opacity does not change with content.** Fading it as the list filled was
 * the same mistake as hiding it: the product looked thinner the more you used
 * it. Legibility is the rows' problem and the rows solve it — each carries its
 * own surface, so text sits on a panel rather than on moving dither.
 *
 * Faded out rather than cropped: the pane has no border of its own, so a hard
 * edge would draw a rectangle nothing else on the page has. `aria-hidden`, and
 * it pauses under `prefers-reduced-motion` — a slow warp is decoration, and
 * decoration is what that setting is about.
 *
 * The same `Dithering` as the sign-in panel, so the product has one piece of art
 * rather than two that nearly match.
 */
function Backdrop() {
  return (
    <div
      aria-hidden
      // Opacity does not change with content. Rows carry their own surface, so
      // the art keeps its weight instead of fading out as the page fills — the
      // dimming this used to do made the product look thinner the more you used
      // it, which is the same mistake as hiding it entirely.
      className="pointer-events-none absolute inset-0 opacity-[0.35]"
    >
      <Dithering
        className="h-full w-full motion-reduce:[animation-play-state:paused]"
        colorBack="#0f0f0f"
        colorFront="#e98663"
        shape="warp"
        type="4x4"
        size={2}
        scale={0.9}
        speed={0.12}
      />
      {/* Tighter when there is text over it: the transparent centre is where the
          rows are, so it closes from 20% to 4% and reaches full ground sooner. */}
      <div
        className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_20%,var(--background)_80%)]"
      />
    </div>
  );
}

/**
 * Which edges of a scroller have more behind them.
 *
 * **Only the edge you can actually scroll towards fades.** A permanent fade at
 * both ends of a short list says there is more above and below when there is
 * nothing either way, which is worse than no fade at all — the affordance is
 * only information if it appears when it is true.
 *
 * The measurement is the element's own, on scroll and on resize. There is no
 * `IntersectionObserver` sentinel and no scroll-driven animation: the first is
 * two extra nodes and a second source of truth, and the second
 * (`animation-timeline: scroll()`) is Chrome-only, so half the readers would
 * get no fade and nothing would say why.
 *
 * The 4px slack absorbs sub-pixel scroll positions — a list scrolled to the
 * literal bottom reports `scrollTop + clientHeight` a fraction under
 * `scrollHeight` on a fractional-DPI display, and without it the bottom fade
 * never quite turns off.
 */
function useScrollEdges(ref: React.RefObject<HTMLElement | null>, deps: unknown[]) {
  const [edges, setEdges] = useState({ top: false, bottom: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const top = el.scrollTop > 4;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 4;
      // Compared before setting: `scroll` fires per frame while dragging, and
      // a state write per frame would re-render the whole list for a boolean
      // that did not change.
      setEdges((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
    };

    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
    // The observer catches the *container* changing size; the deps catch its
    // content changing, which is the case a resize never fires for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, ...deps]);

  return edges;
}

/**
 * The fade itself: painted over the list, not masked onto it.
 *
 * A `mask-image` on the scroller would be tidier and is the wrong tool here —
 * masking forces the element into its own layer, and every row inside is
 * `backdrop-blur-sm` over the artwork behind, so the blur would lose the
 * backdrop it is sampling. An overlay cannot disturb that. It is invisible over
 * the art on its own account, because the backdrop's radial has already reached
 * full `--background` by the top and bottom of the pane.
 */
function Fade({ side, show }: { side: "top" | "bottom"; show: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0 z-20 h-8 transition-opacity duration-150",
        side === "top"
          ? "top-0 bg-gradient-to-b from-background to-transparent"
          : "bottom-0 bg-gradient-to-t from-background to-transparent",
        show ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

/** The Active/Archived switch. Two buttons, so the styling is written once. */
const TAB = "h-7 rounded-[var(--radius-nav)] px-2.5 text-[12.5px] transition-colors";
const TAB_ON = "bg-secondary text-foreground";
const TAB_OFF = "text-muted-foreground hover:bg-hover-muted hover:text-foreground";

export function AgentsWorkspace() {
  const router = useRouter();
  const toast = useToast();
  const [prompt, setPrompt] = useState("");
  // Auto by default. Every run names a repository — see `~/lib/pick-repo`,
  // which also says why resolving one needs no index of anything.
  const [choice, setChoice] = useState<RepoChoice>({ kind: "auto" });

  const capability = api.agents.capability.useQuery();
  const repos = api.github.repos.useQuery();
  /**
   * Live or archived, and never both. A list that mixed them would be the state
   * archiving exists to remove; switching views is what makes an archive feel
   * like one. The count of what is filed away is deliberately not shown — a
   * badge counting things you chose to stop looking at is a nag.
   */
  const [showArchived, setShowArchived] = useState(false);

  const runs = api.agents.list.useQuery(
    { limit: 50, archived: showArchived },
    {
      // Only while something is moving. A finished list does not need re-asking,
      // and a tab left open overnight should not be a query every four seconds
      // until morning.
      // Two seconds while something is moving. Four made a list of runs feel
      // like it had stopped updating; a finished list is still asked nothing at
      // all, which is the part that matters for a tab left open overnight.
      refetchInterval: (q) =>
        q.state.data?.some((r) => r.state === "queued" || r.state === "running") ? 2000 : false,
    },
  );

  /**
   * No confirmation before, and none needed: archiving deletes nothing and the
   * Archived view has a Restore on every row, so the undo is a place rather than
   * a countdown. A dialog per row would cost more than the mistake it prevents.
   */
  const archive = api.agents.archive.useMutation({
    onSuccess: (run) => {
      void runs.refetch();
      toast.success(run.archivedAt ? "Session successfully archived" : "Session successfully restored");
    },
    onError: (error) => toast.error(error.message),
  });

  /**
   * **Straight into the session, and no toast.**
   *
   * `agents.start` names the session before it calls Modal, so the run has a URL
   * from the moment it exists — and the place to watch a run is the conversation
   * it is having, not a row on a list. A notification saying "agent started" is
   * a second thing to dismiss on the way to the only page that answers the
   * question you asked; going there *is* the confirmation.
   *
   * A failure still needs saying, and still gets a toast: the run failed on a
   * page you are staying on, and there is nothing else on screen to say so.
   */
  const start = api.agents.start.useMutation({
    onSuccess: (run) => {
      setPrompt("");
      if (run.sessionId) {
        router.push(`/sessions/${run.sessionId}`);
        return;
      }
      // No session id means `start` failed early enough not to name one. The
      // row on this list carries the reason.
      void runs.refetch();
      router.refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const canStart = capability.data?.canStart ?? false;
  const list = runs.data ?? [];
  const scroller = useRef<HTMLDivElement>(null);
  // Remeasured when the list changes length or the view swaps: both change the
  // scroll height without resizing the container, which is the one case a
  // `ResizeObserver` on the scroller never fires for.
  const edges = useScrollEdges(scroller, [list.length, showArchived]);
  const slugs = (repos.data?.repos ?? []).map((r) => r.slug);
  // Only a tie-break, and only between repositories the prompt already named —
  // never a pick of its own. The list is already loaded for the picker.
  const recent = [...new Set(list.map((r) => r.repo).filter((r): r is string => Boolean(r)))];
  const target = resolveChoice(choice, prompt, slugs, recent);

  /**
   * Whether the switch is worth drawing at all — asked once, cheaply, and only
   * while looking at the active list. A second query counting archived rows on
   * every render would be a round trip whose entire purpose is deciding whether
   * to render two buttons.
   */
  const archivedProbe = api.agents.list.useQuery(
    { limit: 1, archived: true },
    { enabled: !showArchived },
  );
  const hasArchive = (archivedProbe.data?.length ?? 0) > 0;

  const submit = () => {
    // `target.repo` is what makes this callable at all: a run names a repository,
    // so an unresolved Auto has already disabled the button and this is the
    // guard that says the same thing to the type system.
    if (!prompt.trim() || !canStart || start.isPending || target.blocked || !target.repo) return;
    start.mutate({ prompt: prompt.trim(), repo: target.repo });
  };

  return (
    <div className="flex h-full flex-col">
      {/* **The switch is outside the scroller and the list is inside it.**
          They were one overflowing box, so Active/Archived scrolled away with
          the runs — the control that changes what the list is could be off
          screen while you were reading the list. The backdrop was in there too,
          which is why it slid up the page: `absolute inset-0` on a child of an
          `overflow-y-auto` box covers the first screenful and then scrolls with
          the content. Both belong to the pane, so both hang off this element,
          which does not scroll. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Behind everything, at every state. An empty pane is the artwork alone —
            a line of copy explaining that a list is empty is a caption on an
            absence, and the composer beneath already says what to do next in a
            field you can type into rather than a sentence you read first. */}
        <Backdrop />

        {/* The switch, and only when there is something on the other side of
            it. An empty product should not offer to show you an empty archive —
            that is a control whose only function is to explain itself. Once
            anything has been filed away it stays, because the way back from the
            archived view has to exist even when the archive is now empty. */}
        {(showArchived || hasArchive) && (
          <div className="relative z-10 mx-auto flex w-full max-w-3xl shrink-0 items-center gap-1 px-6 pt-5">
            <button
              type="button"
              onClick={() => setShowArchived(false)}
              className={cn(TAB, !showArchived ? TAB_ON : TAB_OFF)}
            >
              Active
            </button>
            <button
              type="button"
              onClick={() => setShowArchived(true)}
              className={cn(TAB, showArchived ? TAB_ON : TAB_OFF)}
            >
              Archived
            </button>
          </div>
        )}

        {/* The scroller is absolutely filled rather than the flex child itself,
            so the two fades can pin to its box: an `absolute` child *inside* an
            overflow container scrolls away with the content. */}
        <div className="relative z-10 min-h-0 flex-1">
        <Fade side="top" show={edges.top} />
        <Fade side="bottom" show={edges.bottom} />
        <div ref={scroller} className="h-full overflow-y-auto">
        {showArchived && list.length === 0 && !runs.isLoading && (
          <p className="relative z-10 mx-auto w-full max-w-3xl px-6 py-6 text-[12.5px] text-muted-foreground">
            Nothing archived.
          </p>
        )}

        {/**
         * **The live list had no empty state, only the archived one.** So an
         * org that has never started a run got this page as a composer and
         * nothing else — 175 characters, all of them control labels — with no
         * statement of what the box does or where the result appears. Somebody
         * arriving from the rail could not tell the page from a broken one.
         *
         * It says where the run *goes*, because that is the part that is not
         * guessable: a started run opens its own session and is watched there,
         * not here, and this list is the history afterwards.
         */}
        {!showArchived && list.length === 0 && !runs.isLoading && (
          <div className="relative z-10 mx-auto w-full max-w-3xl px-6 py-6">
            <p className="text-[13px] text-muted-foreground">
              No agents have run yet.
            </p>
            <p className="mt-1.5 text-[12.5px] text-muted-foreground">
              {canStart
                ? "Describe a change above and Berth starts a container on the repository it names. It opens the session straight away, so you watch the agent work turn by turn — every run you start shows up here afterwards."
                : capability.data?.reason
                  ?? "Starting an agent needs a configured runner and a connected GitHub App. Everything else on this page works without them."}
            </p>
          </div>
        )}

        {list.length > 0 && (
          <ul className="relative z-10 mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 py-6">
            {list.map((run) => {
              const st = STATE[run.state] ?? STATE.queued;
              const Icon = st.icon;
              // The icon centres on the row, the age stays on the first
              // line. `items-start` with a hand-tuned `mt-[3px]` lined the icon
              // up with the prompt's cap height, which is right for a one-line
              // row and drifts further off the more the row grows — a run with
              // a branch, a PR and an error put the state glyph up in a corner.
              // Centring is what a row-level status is.
              const row = (
                <div className="flex items-center gap-3 px-3.5 py-3">
                  {/* Shape carries the state; colour only reinforces it. */}
                  <Icon
                    aria-label={st.label}
                    className={cn("size-4 shrink-0", st.className, st.spin && "animate-spin")}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] leading-snug">{run.prompt}</div>
                    {/* What differs between runs, and nothing that does not. The
                        state is the icon, so it is not repeated here. */}
                    <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-muted-foreground">
                      <Mono>{run.repo ?? "no repository"}</Mono>
                      {run.branch && (
                        <span className="flex min-w-0 items-center gap-1">
                          <GitBranch className="size-3 shrink-0" />
                          <span className="truncate">{run.branch.replace(/^berth\//, "")}</span>
                        </span>
                      )}
                      {run.prNumber && (
                        <span className="flex items-center gap-1 text-primary">
                          <GitPullRequest className="size-3" />#{run.prNumber}
                        </span>
                      )}
                    </div>
                    {/* Verbatim. A run that failed is worth reading, not summarising. */}
                    {run.error && <div className="mt-1 text-[11.5px] text-destructive">{run.error}</div>}
                  </div>

                  {/* The trailing column: when it happened, and the one thing
                      you can do about it, stacked. Side by side they read as
                      two peers of equal weight — a timestamp is a fact and an
                      archive button is an action, and putting the action under
                      the fact is what says so. The column reserves the button's
                      height at every row, so a row does not grow under the
                      cursor when it fades in. */}
                  <div className="flex w-8 shrink-0 flex-col items-end gap-1 self-start">
                    <span className="pt-[3px] text-[11.5px] tnum text-muted-foreground">
                      {ago(run.createdAt)}
                    </span>
                    <button
                      type="button"
                      onClick={() => archive.mutate({ id: run.id, archived: !showArchived })}
                      disabled={archive.isPending}
                      aria-label={showArchived ? `Restore: ${run.prompt}` : `Archive: ${run.prompt}`}
                      title={showArchived ? "Restore" : "Archive"}
                      /* `RAISED`, because the link covering this row sits at
                         z-10: a control at the default level is underneath it,
                         the click reaches the anchor, and the button looks
                         broken rather than absent. Visible on hover and on
                         keyboard focus — `opacity-0` alone would leave it in
                         the tab order and invisible while focused. */
                      className={cn(
                        RAISED,
                        "grid size-6 place-items-center rounded-[var(--radius-nav)]",
                        "text-muted-foreground transition-opacity hover:bg-hover-muted hover:text-foreground",
                        "opacity-0 focus-visible:opacity-100 group-hover/run:opacity-100",
                      )}
                    >
                      {showArchived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
                    </button>
                  </div>
                </div>
              );
              const cls = "block rounded-lg border border-border bg-panel/80 backdrop-blur-sm "
                + "transition-colors hover:bg-hover-muted";
              return (
                /* The link is a stretched overlay rather than a wrapper —
                   `SessionRowShell` does the same thing for the same reason. A
                   button nested inside an anchor is invalid markup and its
                   click navigates as well as acting, so the row's one control
                   has to sit beside the link, not inside it. */
                <li key={run.id} className={cn("group/run relative", cls)}>
                  {run.sessionId && (
                    <Link
                      href={`/sessions/${run.sessionId}`}
                      aria-label={`Open session for: ${run.prompt}`}
                      className="absolute inset-0 z-10 rounded-[inherit]"
                    />
                  )}
                  {row}
                </li>
              );
            })}
          </ul>
        )}
        </div>
        </div>
      </div>

      <div className="shrink-0 px-6 pt-3 pb-16">
        <Composer
          picker={{ choice, onChoice: setChoice, auto: target.auto, repos: slugs }}
          prompt={prompt}
          onPrompt={setPrompt}
          onSubmit={submit}
          pending={start.isPending}
          // An unresolved Auto stops the run for the same reason a missing
          // runner does, and says so in the same place — the alternative is a
          // send button that silently does nothing.
          canStart={canStart && !target.blocked}
          reason={capability.data?.reason ?? target.blocked ?? undefined}
        />
      </div>
    </div>
  );
}
