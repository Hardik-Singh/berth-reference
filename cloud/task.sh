#!/usr/bin/env bash
# One background agent run: give a coding agent a task, then push what it did.
#
# **This is the whole job, and it deliberately runs anywhere.** Modal supplies a
# container and nothing else — `agent.py` builds an image and calls this file. So
# the thing that runs in the cloud is the thing you can run on your laptop, and a
# failure is reproducible without a Modal account. A cloud function whose logic
# only exists inside the cloud is one you debug by redeploying.
#
# One mode: clone `BERTH_REPO`, branch, let the agent work, push, open a PR.
# `BERTH_REPO` is required — the scratch mode that built a throwaway `utils.py`
# is gone, and the section below says why.
#
# The chain, and why each step is already someone else's code:
#
#   1. `claude -p` writes its transcript to `$HOME/.claude/projects/**`, as it
#      does for a person. **Nothing is installed into the agent** — no hook, no
#      wrapper, no MCP server. That is the product's central claim and this is the
#      cheapest place to keep it honest.
#   2. `berth collect` reads that transcript and pushes it. The server stamps
#      `engineer_id` and `machine_id` from the device token, so a session that ran
#      on a machine nobody owns still lands attributed.
#   3. `berth github pr` opens the pull request, which is idempotent and knows
#      the difference between "already exists" and "the agent changed nothing".
#
# **`HOME` is redirected, and that is load-bearing.** Claude Code writes to
# `$HOME/.claude/projects`, so running this on a laptop without redirecting it
# would mix synthetic agent runs into somebody's real captured history with no way
# to tell them apart afterwards. Every run gets its own home, and `collect` is
# pointed at it explicitly rather than left to find the default.
#
# **The GitHub App private key must never reach this script.** `GH_TOKEN` is
# minted by the caller — `berth github token --repo <slug>`, or the dashboard —
# and is one repository, ~one hour. Anyone holding the *key* can mint for every
# repository the App is on, so handing it to an agent hands over the ceiling
# rather than the slice, and every narrowing above it becomes decoration.
# `poke.sh`'s header makes the same argument; this is the same rule.
set -euo pipefail

PROMPT="${1:?usage: task.sh \"<prompt>\" [workdir]}"
WORK="${2:-${BERTH_AGENT_WORK:-$(mktemp -d)}}"

: "${BERTH_TOKEN:?BERTH_TOKEN is required — mint one with: berth device new -l <label> -e <email>}"
: "${BERTH_ENDPOINT:?BERTH_ENDPOINT is required — the full ingest URL, ending /v1/ingest}"

# The session id is chosen here, before the agent runs, and that is what makes a
# conversation possible.
#
# **The first attempt at this only mounted a persistent home when *resuming*, and
# so could never resume anything**: a cold run wrote its transcript to a
# directory that died with the container, and the follow-up found nothing and
# started fresh. The id and the home are chicken-and-egg — you cannot key a home
# by a session id the agent has not minted yet — and `claude --session-id` is
# what breaks it. We pick the uuid, the home is keyed by it from the first run,
# and `--resume` finds a transcript that is actually there.
#
# It is also the id berth captures, so the dashboard's session and the agent's
# conversation are the same identifier rather than two that have to be joined.
#
# **`uuidgen` is not in debian-slim, and its absence was silent and expensive.**
# The id came out empty, so the home became `/homes/` — one directory shared by
# every run — and `claude` picked up whatever conversation was already there.
# Runs that should have been separate appended to one session; the symptom was a
# session's record count growing when nobody had resumed it. Three sources, then
# a hard check, because the failure mode of an empty id is silent cross-talk
# between other people's runs rather than an error.
new_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then uuidgen | tr "A-Z" "a-z"; return; fi
  if [ -r /proc/sys/kernel/random/uuid ]; then cat /proc/sys/kernel/random/uuid; return; fi
  python3 -c "import uuid; print(uuid.uuid4())"
}

# **The dashboard names the session, when it can.** `agents.start` mints the id
# before it calls Modal and writes it on the run row, so the browser can go
# straight to `/sessions/<id>` — the page exists the moment the run does,
# instead of appearing minutes later when capture lands. `new_uuid` is the
# fallback for a container started by hand.
SESSION_ID="${BERTH_RESUME_SESSION:-${BERTH_SESSION_ID:-$(new_uuid)}}"
case "$SESSION_ID" in
  [0-9a-f]*-[0-9a-f]*-[0-9a-f]*-[0-9a-f]*-[0-9a-f]*) ;;
  *) echo "could not generate a session id (got \"$SESSION_ID\")" >&2; exit 1 ;;
esac

# ------------------------------------------------------------ reporting back
# **Defined here, before anything that can fail.** It used to live two hundred
# lines down, next to the pull request — which meant every failure above it left
# the run row saying `running` for ever. A container that dies on `git clone` is
# indistinguishable, from the dashboard, from an agent still thinking, and the
# session page spins on it until somebody gives up.
REPORTED=0
report() {
  REPORTED=1
  [ -n "${BERTH_RUN_ID:-}" ] || return 0
  endpoint="${BERTH_ENDPOINT%/v1/ingest}/v1/agent-runs/${BERTH_RUN_ID}"
  curl -fsS -m 20 -X POST "$endpoint" \
    -H "authorization: Bearer $BERTH_TOKEN" \
    -H 'content-type: application/json' \
    -d "$1" >/dev/null 2>&1 || echo "  (could not report back — the capture is pushed regardless)"
}

# JSON-escape one line of shell output so a failure reason can be carried
# verbatim without a stray quote turning the report into a 400.
json_str() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'; }

# **Every exit reports, including the ones nobody wrote code for.** `set -e`
# means most failures here are an exit rather than a branch, so the terminal
# state has to be attached to the exit itself. A run that ends any other way
# than a `report` above ends as `failed`, with the code and the last thing
# printed, rather than as a row that stays `running` until it is archived.
LAST_ERROR=""
on_exit() {
  code=$?
  # Never leave the streamer running past the script that started it.
  if [ -n "${STREAM_PID:-}" ]; then kill "$STREAM_PID" 2>/dev/null || true; fi
  [ "$REPORTED" -eq 1 ] && return 0
  [ "$code" -eq 0 ] && return 0
  detail="${LAST_ERROR:-the container exited with code $code}"
  echo "→ reporting failure: $detail"
  report "$(printf '{"state":"failed","sessionId":%s,"error":%s}' \
    "$(json_str "$SESSION_ID")" "$(json_str "$detail")")"
}
trap on_exit EXIT

AGENT_HOME="${BERTH_HOMES_DIR:-$WORK/homes}/$SESSION_ID"
mkdir -p "$AGENT_HOME"
REPO="$WORK/repo"
mkdir -p "$AGENT_HOME" "$REPO"

BRANCH="${BERTH_BRANCH:-berth/agent-$(date +%Y%m%d-%H%M%S)}"
BASE="${BERTH_BASE:-main}"

# ------------------------------------------------------------------ the repo
# **`BERTH_REPO` is required.** There used to be a second mode here that built a
# throwaway `utils.py` and let the agent edit that — it existed to make the
# runner demonstrable before the GitHub App did. Every reason to keep it went
# when the App landed: the run produces a diff nobody wants, it cannot open a
# pull request, and it was reachable from the product as a menu item somebody
# could pick by accident.
: "${BERTH_REPO:?BERTH_REPO is required — every run names a repository}"

# A local clone URL is the testing path and needs no credential; anything else
# is a real host and does.
case "${BERTH_REPO_URL:-https://github.com/}" in
  http*) : "${GH_TOKEN:?GH_TOKEN is required with BERTH_REPO — mint it with: berth github token --repo $BERTH_REPO}" ;;
esac
echo "→ cloning $BERTH_REPO"
# The token goes in a credential helper, never in the remote URL: a URL with a
# credential in it lands in `.git/config`, in `git remote -v`, and in the
# transcript this very run is about to have captured.
#
# **The helper has to exist before the clone, and it did not.** It was written
# with `git -C "$REPO" config --local` *after* this line — but `--local` needs a
# repository and there is no repository until the clone has already succeeded.
# So the clone itself ran with no credential at all, and every private
# repository failed at it:
#
#     fatal: could not read Username for 'https://github.com': No such device
#
# It looked like it worked because the only repositories anyone had pointed it
# at were public, where an anonymous clone is fine. `harbor-so/berth` is
# private, so the first real run hit it immediately.
#
# `-c` rather than `config --global`: `-c` passes the helper to this one command
# through the environment and writes nothing to disk, where `--global` would put
# a live GitHub token in `$HOME/.gitconfig` — and `$HOME` here is a directory in
# a Modal volume that outlives the container and is keyed by session id.
#
# `BERTH_REPO_URL` overrides where the clone comes from. Default is github.com;
# it exists so the git half of this script can be exercised against a local
# bare repository with no credential and no blast radius, and so an Enterprise
# host is a variable rather than a fork of this file.
CRED_HELPER='!f(){ echo username=x-access-token; echo "password=$GH_TOKEN"; };f'
CLONE_URL="${BERTH_REPO_URL:-https://github.com/$BERTH_REPO.git}"
# Captured rather than streamed, so the reason reaches the run row. git's
# failures here are one line and they are the useful one — "could not read
# Username" and "Repository not found" are different problems with different
# fixes, and neither is legible as "the container exited with code 128".
if [ -n "${GH_TOKEN:-}" ]; then
  CLONE_OUT=$(git -c credential."https://github.com".helper="$CRED_HELPER" \
    clone --quiet --depth 50 "$CLONE_URL" "$REPO" 2>&1) || {
      LAST_ERROR="could not clone $BERTH_REPO: $(printf '%s' "$CLONE_OUT" | tail -1)"
      echo "$LAST_ERROR" >&2
      exit 1
    }
  # Now that there is a repository, the same helper is recorded locally so the
  # push at the end of the run has it too.
  git -C "$REPO" config --local credential.'https://github.com'.helper "$CRED_HELPER"
else
  CLONE_OUT=$(git clone --quiet --depth 50 "$CLONE_URL" "$REPO" 2>&1) || {
      LAST_ERROR="could not clone $BERTH_REPO: $(printf '%s' "$CLONE_OUT" | tail -1)"
      echo "$LAST_ERROR" >&2
      exit 1
    }
fi
# **The commits belong to the person who asked for them.**
#
# Every commit an agent made used to be authored by `berth agent
# <agent@berth.local>`, so a branch full of somebody's work carried a robot's
# name into `git log`, `git blame`, the PR's commit list and every review — and
# the person whose idea it was appeared nowhere in the history of it.
#
# The dashboard resolves the identity from its own session and passes it here;
# it is never derived in the container, which has no session and must not be
# given one. Unset means the person has not linked GitHub, and berth's own name
# is the honest fallback rather than a guess at theirs.
GIT_NAME="${BERTH_GIT_AUTHOR_NAME:-berth agent}"
GIT_EMAIL="${BERTH_GIT_AUTHOR_EMAIL:-agent@berth.local}"
git -C "$REPO" config --local user.email "$GIT_EMAIL"
git -C "$REPO" config --local user.name "$GIT_NAME"
echo "→ committing as $GIT_NAME <$GIT_EMAIL>"
# Base first, so a repo whose default is not `main` still branches off the
# right thing rather than off whatever `clone` happened to check out.
git -C "$REPO" checkout --quiet "$BASE" 2>/dev/null || echo "  (no $BASE; staying on the default branch)"
git -C "$REPO" checkout --quiet -b "$BRANCH"
# **The commit the agent started from.** Everything below asks "is HEAD ahead of
# this", which is a question about history rather than about the working tree —
# and the working tree is exactly what stopped being a reliable signal when the
# agent got a shell and started committing for itself. A SHA rather than a ref
# name, because the agent may rename, branch or reset, and a SHA survives all of
# it.
BASE_SHA=$(git -C "$REPO" rev-parse HEAD)

# ------------------------------------------------------------------- the agent
# **`acceptEdits` auto-approves file edits and nothing else** — every `Bash` call
# still asks, and under `claude -p` there is nobody to ask, so each one was
# denied. The agent could not run a test, a build, a linter or `git`; it said so,
# and that got read as "the container has no git access". The container has git.
# The agent had no permission to call it.
#
# That is not a small quality difference: an agent that cannot run the suite
# cannot check its own work, so every run shipped a diff with "not verified"
# under it.
#
# **`--allowedTools`, not `bypassPermissions`.** The wider mode was tried here
# first and does not start at all in this image — the CLI refuses it for root,
# which is what this container runs as, and the run died before writing a
# transcript. An allowlist is the better answer anyway: it names the tools an
# unattended coding agent needs and leaves the rest asking, where bypass is a
# blanket yes that also covers whatever a future CLI version adds.
#
# `BERTH_PERMISSION_MODE` exists so the mode can be *tested* against a real
# container rather than deployed and discovered, which is how the above was
# found.
#
# **So the credentials leave with the permission.** Handing an agent an
# unrestricted shell in the same environment that holds a GitHub token and a
# berth device token is handing it those tokens. It needs neither: the clone
# already happened, this script does the push, and this script does the collect.
# `env -u` at the launch is the only thing that actually removes them, because
# `claude -p` inherits this script'"'"'s whole environment.
#
#   BERTH_GITHUB_APP_*   the App key. Never anywhere near an agent — it mints for
#                        every installation, so narrowing means nothing near it.
#   GH_TOKEN             one repo, one hour, and still not the agent'"'"'s to spend.
#                        Local git works without it; only the network needs it.
#   BERTH_TOKEN          the device token. `read` scope drains the org'"'"'s corpus.
#
# `ANTHROPIC_API_KEY` stays, because it is what the agent runs on.
#
# Be honest about what this is: a container boundary, not a sandbox for hostile
# code. It stops an agent stumbling into a credential, not a determined one
# reaching the network.
# Resume only when the transcript is actually there.
#
# `--resume` against a session id the home does not hold fails the run outright,
# and the two ways to arrive without one are ordinary: the first message of a
# conversation, and a volume that was pruned. Both should start a fresh session
# rather than error, so the check is for the file rather than for the flag.
# Resume when the transcript is actually there, otherwise take the id as ours.
#
# `--resume` against an id the home does not hold fails the run outright, and
# there are ordinary ways to arrive without one: a session captured on somebody's
# laptop has no home here and never will, and a volume can be pruned. Both should
# produce a working run rather than an error — so the check is for the file, and
# a miss falls through to `--session-id`, which still pins the id so the *next*
# message can resume this one.
SESSION_ARGS=(--session-id "$SESSION_ID")
if [ -n "${BERTH_RESUME_SESSION:-}" ]; then
  if ls "$AGENT_HOME/.claude/projects"/*/"$BERTH_RESUME_SESSION".jsonl >/dev/null 2>&1; then
    SESSION_ARGS=(--resume "$BERTH_RESUME_SESSION")
    echo "→ resuming $BERTH_RESUME_SESSION"
  else
    echo "→ no transcript for $BERTH_RESUME_SESSION here — starting a session under that id"
  fi
else
  echo "→ new session $SESSION_ID"
fi

# ---------------------------------------------------------- streaming capture
# **The transcript used to arrive in one lump, after the agent had finished.**
# `collect` ran once, below, so a run that took six minutes showed nothing at all
# for six minutes and then everything at once. From the dashboard that is
# indistinguishable from a hang, and it is why the session page had to be
# reloaded to see anything: there was nothing to see until the end.
#
# So the same push runs on a loop *while* the agent works. Three properties make
# that safe rather than merely faster:
#
#   - **Ingest is idempotent by construction.** Every write is an upsert and
#     `detail = excluded.detail` on conflict, so re-sending a session that has
#     grown by two turns converges rather than duplicating. This is the property
#     `src/ingest.ts` already had; nothing new is being relied on.
#   - **It never fails the run.** A push that cannot reach the API is a lost
#     preview, not a lost session — the authoritative collect still runs at the
#     end, after the agent has stopped writing.
#   - **It reads the same two roots, both of them.** Setting only
#     `BERTH_TRANSCRIPTS` leaves the Codex root pointing at the real home, which
#     is the mistake documented under the collect below.
#
# Twelve seconds is a guess with a shape: fast enough that a reader watching the
# page sees the conversation move, slow enough that a long run is tens of pushes
# rather than hundreds. `BERTH_STREAM_SECONDS=0` turns it off.
STREAM_PID=""
stream_capture() {
  while :; do
    sleep "${BERTH_STREAM_SECONDS:-12}"
    BERTH_TRANSCRIPTS="$AGENT_HOME/.claude/projects" \
    BERTH_CODEX_TRANSCRIPTS="$AGENT_HOME/.codex/sessions" \
    BERTH_NO_DAEMON=1 \
      berth collect >/dev/null 2>&1 || true
  done
}

stop_streaming() {
  [ -n "$STREAM_PID" ] || return 0
  kill "$STREAM_PID" 2>/dev/null || true
  wait "$STREAM_PID" 2>/dev/null || true
  STREAM_PID=""
}

if [ "${BERTH_STREAM_SECONDS:-12}" != "0" ]; then
  stream_capture &
  STREAM_PID=$!
  echo "→ streaming capture every ${BERTH_STREAM_SECONDS:-12}s while the agent works"
fi

# What an unattended coding agent needs, named. `Bash` is the one that was
# missing and the one that matters — a build, a test run, a linter, `git`.
ALLOWED_TOOLS="${BERTH_ALLOWED_TOOLS:-Bash,Edit,Write,Read,Glob,Grep,NotebookEdit,TodoWrite,Task,WebFetch,WebSearch}"

# **The agent is told whose work this is.** It has a shell now, so it can run
# `git commit` itself — and an agent that does not know the repository is already
# configured will helpfully set `user.name` to something it invented, or open a
# pull request describing itself as the author. Saying it once, in the system
# prompt, is cheaper than correcting it afterwards.
#
# Built as an array so an empty value is *no flag* rather than an empty flag:
# `--append-system-prompt ""` is a valid argument and a wasted one.
AUTHOR_LINE=""
if [ -n "${BERTH_GIT_AUTHOR_NAME:-}" ]; then
  AUTHOR_LINE="You are working on behalf of ${BERTH_GIT_AUTHOR_NAME}\
 <${BERTH_GIT_AUTHOR_EMAIL:-}>${BERTH_GITHUB_LOGIN:+ (GitHub @${BERTH_GITHUB_LOGIN})}.\
 This repository is already configured to author commits as them, so commit\
 normally and do not set user.name or user.email yourself. The change is their\
 work, not yours: describe the change, not the fact that an agent made it. "
fi

# **What it must not attempt, and why it would.** The agent has a shell, so its
# instinct is to finish the job: push the branch, open the pull request. It
# cannot. The GitHub token is deliberately not in its environment — an
# unrestricted shell in a process holding a credential is a process handing that
# credential over — so it gets as far as `git push`, fails on a credential helper
# reading an unset variable, and reports *that* as the blocker. Which reads as
# berth being broken rather than as the division of labour it is.
#
# One sentence removes the whole confusion. This is now unconditional, because
# the instruction matters whether or not anybody is linked; the authorship half
# is what varies.
SYSTEM_ARGS=(--append-system-prompt "${AUTHOR_LINE}Commit your work when you are\
 done. Do not push and do not open a pull request — you hold no GitHub\
 credential and pushing will fail. berth pushes whatever branch you leave\
 checked out and opens the pull request itself once you stop, so committing is\
 the last step that is yours.")

echo "→ agent: $PROMPT"
set +e
( cd "$REPO" && env -u BERTH_GITHUB_APP_ID -u BERTH_GITHUB_APP_PRIVATE_KEY \
    -u GH_TOKEN -u BERTH_TOKEN \
    HOME="$AGENT_HOME" claude -p "$PROMPT" \
    --permission-mode "${BERTH_PERMISSION_MODE:-acceptEdits}" \
    --allowedTools "$ALLOWED_TOOLS" \
    ${SYSTEM_ARGS[@]+"${SYSTEM_ARGS[@]}"} \
    "${SESSION_ARGS[@]}" ) >"$WORK/agent.log" 2>&1
AGENT_EXIT=$?
set -e
# A non-zero agent is not a failed run. The turns it took before giving up are
# exactly what this exists to capture, and reporting the run as failed would throw
# away the most interesting sessions in the corpus.
# **A non-zero agent prints its log, and that absence cost a deploy.** The line
# below used to be the only trace: "agent exited 1 — its turns are still
# captured", with the log sitting unread in `$WORK`. When a flag change made the
# CLI refuse to start at all, the container reported exactly the same sentence as
# a run where the agent worked and gave up — and then said "no transcripts
# found", which reads as a capture bug rather than an agent that never ran.
#
# Twenty lines, because the useful part of a refusal is the last thing it said.
if [ "$AGENT_EXIT" -ne 0 ]; then
  echo "  (agent exited $AGENT_EXIT — its turns are still captured if it wrote any)"
  echo "  --- last 20 lines of the agent log ---"
  tail -n 20 "$WORK/agent.log" 2>/dev/null | sed "s/^/  | /" || true
  echo "  --------------------------------------"
  # Kept for the exit trap, so a run that captured nothing at all reports *why*
  # rather than a bare exit code.
  LAST_ERROR="the agent exited $AGENT_EXIT: $(tail -n 3 "$WORK/agent.log" 2>/dev/null | tr '\n' ' ' | cut -c1-300)"
fi

# Stopped before the authoritative collect below, so the two are never pushing
# the same session at once. Idempotence would survive it; the log would not be
# readable, and a partial push racing a complete one is a state nobody wants to
# reason about at three in the morning.
stop_streaming

# ------------------------------------------------------------------ the push
# Pointed at this run's home rather than the default, so nothing but this task's
# transcript is in scope.
#
# **Both roots, not one.** `collect` walks Claude Code *and* Codex, and they have
# separate overrides. Setting only `BERTH_TRANSCRIPTS` leaves the Codex root
# pointing at the real `~/.codex/sessions`, which on a laptop means a rehearsal
# quietly pushes the machine's whole Codex history — measured as 103 unrelated
# sessions in a run that should have had one. In a container both are empty and
# the mistake is invisible, which is the worst place for it to hide.
#
# **No `--full`, and its absence is the fix rather than a downgrade.**
#
# That flag used to select diffs and command output; capture is complete by
# default now and the only remaining choice is `--no-content`. The flag was
# *removed* from the CLI, and `parseArgs` throws on an option it does not know —
# so every container run since that change failed here, exited 1, and reported
# itself failed with no capture at all. The transcript was written, read and
# thrown away at the last step.
#
# Nothing about what is captured changes: full is what this always asked for and
# what it still gets. `src/task-script.test.ts` now checks every flag this file
# passes against the CLI that has to accept it, because these are two projects
# with no compiler between them and the failure is a runtime throw in a
# container nobody is watching.
echo "→ collecting"
BERTH_TRANSCRIPTS="$AGENT_HOME/.claude/projects" \
BERTH_CODEX_TRANSCRIPTS="$AGENT_HOME/.codex/sessions" \
BERTH_NO_DAEMON=1 \
  berth collect 2>&1 | tee "$WORK/collect.txt"
[ "${PIPESTATUS[0]}" -eq 0 ] || { echo "collect failed" >&2; exit 1; }

# The session this run produced, read off the transcript rather than off the
# collector's output: the summary is a table for a person, not a contract, and
# parsing it would break the next time somebody adjusts a column.
# Known before the agent ran — see the header. No need to guess it off disk.

# Tell the row that is already on screen what happened.
#
# `report` is best-effort and never fails the run: the capture is already pushed
# and durable at this point, and a dashboard row that stays `running` is a worse
# outcome than a missing one only if you also throw away the work. It carries the
# device token, which is the same credential the ingest above used.
# --------------------------------------------------------------- the pull request
echo ""
echo "→ what the agent changed:"
git -C "$REPO" --no-pager diff --stat || true

# **The branch the agent is actually on, which may not be the one we made.**
# It has a shell now, so `git checkout -b my-feature` is a thing it does — and
# pushing `$BRANCH` after that pushes the commit the agent branched *away* from,
# which is an empty pull request. A detached HEAD goes back onto our branch,
# because a detached HEAD cannot be pushed by name.
HEAD_BRANCH=$(git -C "$REPO" rev-parse --abbrev-ref HEAD)
if [ "$HEAD_BRANCH" = "HEAD" ]; then
  git -C "$REPO" checkout --quiet -B "$BRANCH"
  HEAD_BRANCH="$BRANCH"
fi
[ "$HEAD_BRANCH" = "$BRANCH" ] || echo "→ the agent moved to $HEAD_BRANCH"

# Anything it edited and did not commit. An agent that commits some of its work
# and leaves the rest staged is not a case to lose the remainder over.
if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "$(printf '%s\n\nOpened by a berth background agent.' "$PROMPT" | head -c 2000)"
fi

# **Asked of the history, not of the working tree.** `git status --porcelain`
# was the test here, and it stopped meaning anything the moment the agent could
# commit: a turn that did the work *and committed it* leaves a clean tree, so
# this branch reported `no_changes` and exited — throwing away a real commit and
# telling the dashboard nothing had happened.
AHEAD=$(git -C "$REPO" rev-list --count "$BASE_SHA"..HEAD)
if [ "$AHEAD" -eq 0 ]; then
  # Said here rather than discovered as a 422 three steps later. An agent that
  # changed nothing is the likeliest result of a badly-scoped prompt.
  echo "→ the agent changed nothing — no branch pushed, no pull request"
  # `no_changes`, not `failed`. The agent ran, read the code, and concluded there
  # was nothing to do — see `AGENT_RUN_STATES` for why that is a success.
  report "$(printf '{"state":"no_changes","sessionId":%s}' "\"$SESSION_ID\"")"
  exit 0
fi

echo "→ pushing $HEAD_BRANCH ($AHEAD commit(s))"
git -C "$REPO" push --quiet -u origin "$HEAD_BRANCH"
BRANCH="$HEAD_BRANCH"

if [ -z "${GH_TOKEN:-}" ]; then
  echo "→ pushed $BRANCH; no GH_TOKEN, so no pull request was opened"
  report "$(printf '{"state":"done","sessionId":%s,"branch":%s}' "\"$SESSION_ID\"" "\"$BRANCH\"")"
  exit 0
fi

echo "→ opening the pull request"
# **`BERTH_GITHUB_TOKEN`, because that is the name the CLI reads.** The caller
# passes the minted, repo-scoped token as `GH_TOKEN` — the name git's credential
# helper wants — and `berth github pr` looks for `BERTH_GITHUB_TOKEN` or the App
# key, finds neither, and stops with "no GitHub credential configured" *after*
# the branch has already been pushed. So the run ended with the work on GitHub,
# no pull request, and a message naming two variables nobody set.
#
# One token, handed to each half under the name that half expects, and never
# exported into the shell that runs the agent.
set +e
PR_URL=$(BERTH_GITHUB_TOKEN="$GH_TOKEN" berth github pr --repo "$BERTH_REPO" --head "$BRANCH" --base "$BASE" \
  --title "$(printf '%s' "$PROMPT" | head -c 72)" \
  --body "$(printf 'Opened by a berth background agent.\n\n> %s' "$PROMPT" | head -c 4000)")
PR_EXIT=$?
set -e
# Exit 3 is `berth github pr`'s "nothing to open one for" — a real outcome, not a
# failure, so the run does not report itself broken over it.
if [ "$PR_EXIT" -eq 3 ]; then
  echo "→ nothing to open a pull request for"
  report "$(printf '{"state":"no_changes","sessionId":%s,"branch":%s}' "\"$SESSION_ID\"" "\"$BRANCH\"")"
  exit 0
fi
if [ "$PR_EXIT" -ne 0 ]; then
  echo "could not open a pull request" >&2
  report "$(printf '{"state":"failed","sessionId":%s,"branch":%s,"error":"could not open a pull request"}' "\"$SESSION_ID\"" "\"$BRANCH\"")"
  exit 1
fi
echo "→ pull request: $PR_URL"
report "$(printf '{"state":"done","sessionId":%s,"branch":%s,"prUrl":%s}' "\"$SESSION_ID\"" "\"$BRANCH\"" "\"$PR_URL\"")"
