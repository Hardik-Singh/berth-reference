import { AgentsWorkspace } from "./workspace";

import type { Metadata } from "next";

import { requireActiveOrTrial } from "~/server/billing/trial";
export const metadata: Metadata = {
  title: "Agents",
  description: "Agents that have run, and one place to start another.",
};

/**
 * Two things: what has run, and a box to start another.
 *
 * This page used to carry five regions — a prepared-work card with a four-step
 * story and a bar chart, a candidates list, a replay panel that had never run,
 * the composer and the runs list — each with its own heading and explanatory
 * note. The runs were the fifth thing down the page and the smallest of the
 * five, which is backwards: they are the only part that changes, and the only
 * part anybody opens this page to see.
 *
 * The three that were removed are not deleted work — they are derivations that
 * belong on a page about what Berth *noticed*, not on the one where you watch
 * agents run. `git show` has them.
 */
export default async function AgentsPage() {
  // The trial gate. Expired sends them to /settings/billing; every
  // other state, including "we could not tell", falls through.
  await requireActiveOrTrial();
  // No `PageHead`. The rail already says which page this is, and a full-width
  // bordered band restating one word is a region that costs a region.
  return <AgentsWorkspace />;
}
