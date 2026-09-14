"use client";

import { useState } from "react";
import { Check, Github, Loader2 } from "lucide-react";
import { authClient } from "~/lib/auth-client";
import { api } from "~/trpc/client";
import { useToast } from "~/components/ui/toast";
import { cn } from "~/lib/utils";

/**
 * Who the agent will commit as, above the box you type into.
 *
 * **Every commit an agent made was authored by `berth agent
 * <agent@berth.local>`.** A branch full of somebody's work carried a robot's
 * name into `git log`, `git blame`, the PR's commit list and every review — and
 * the person whose idea it was appeared nowhere in the history of it. Linking
 * fixes the attribution and nothing else: the push is still the App's, narrowed
 * to one repository for an hour, and no new token is stored. See
 * `~/server/github/identity`.
 *
 * **It sits above the composer rather than in settings** because that is where
 * the decision is made. A person about to start a run is the only person who
 * cares whose name is on it, and a notice on a settings page they have no reason
 * to visit is a notice nobody reads.
 *
 * **Linked is a quiet line, not a green banner.** The state worth interrupting
 * for is the one you can act on; a confirmation that everything is correct,
 * drawn as loudly as a problem, is what teaches people to skim past both. So the
 * linked case is one muted line naming the login, and it is there so the answer
 * to "who will this commit as" is never a guess.
 */
export function LinkGitHub({ className }: { className?: string }) {
  const identity = api.github.identity.useQuery(undefined, {
    // A person who links in another tab comes back to this one; without this the
    // notice claims they are unlinked until a reload.
    refetchOnWindowFocus: true,
    retry: false,
  });
  const toast = useToast();
  const [going, setGoing] = useState(false);

  if (identity.isLoading || !identity.data) return null;

  if (identity.data.linked) {
    return (
      <p className={cn("flex items-center gap-1.5 text-[11.5px] text-muted-foreground", className)}>
        <Check className="size-3 shrink-0 text-success" />
        Commits will be authored by
        <span className="font-mono text-foreground/80">@{identity.data.login}</span>
      </p>
    );
  }

  // The two ways to be unlinked need different sentences: one is a thing you
  // never did, the other is a thing that stopped working.
  const expired = identity.data.reason === "expired";

  const link = async () => {
    setGoing(true);
    try {
      await authClient.linkSocial({
        provider: "github",
        // Back to where they were. `linkSocial` leaves the browser at GitHub and
        // returns to this origin, and landing on the dashboard root after
        // linking from a session page loses the transcript they were reading.
        callbackURL: window.location.pathname + window.location.search,
      });
    } catch (error) {
      setGoing(false);
      toast.error(error instanceof Error ? error.message : "GitHub could not be reached.");
    }
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]", className)}>
      <Github className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="text-muted-foreground">
        {expired
          ? "Your GitHub link expired, so commits will be authored by berth."
          : "Commits will be authored by berth, not you."}
      </span>
      <button
        type="button"
        onClick={() => void link()}
        disabled={going}
        className="flex items-center gap-1 text-primary underline-offset-4 hover:underline disabled:opacity-60"
      >
        {going && <Loader2 className="size-3 animate-spin" />}
        {expired ? "Reconnect GitHub" : "Link GitHub account"}
      </button>
    </div>
  );
}
