# cloud — background agents

A coding agent that runs where nobody is sitting, whose session lands in the
ledger through the ordinary capture path. The dashboard cannot tell it apart from
work you did on your laptop, and that is the point: **no new read surface, no new
tenancy story, no new table.** A row is a row.

```
berth device new   →  BERTH_TOKEN        the dashboard decides the engineer
run_task           →  claude -p          the agent does the work
berth collect      →  POST /v1/ingest    the server decides the attribution
```

## The two files

| | |
|---|---|
| `task.sh` | the whole job. Scratch repo, run the agent, collect, push. **Runs anywhere** |
| `agent.py` | a Modal image and two functions that call `task.sh`. Plumbing only |

`task.sh` is deliberately not Modal-shaped. A cloud function whose logic only
exists in the cloud is one you debug by redeploying; this one runs on a laptop
against a local `berth serve`, which is how it was verified before it had ever
been deployed.

## Setup — both steps need your accounts

```sh
pip install modal && modal token new

modal secret create berth-agent \
    ANTHROPIC_API_KEY=sk-ant-...      # the agent's own credential
    BERTH_TOKEN=brt_...               # berth device new -l "modal" -e you@corp.com
    BERTH_ENDPOINT=https://<host>/v1/ingest
    BERTH_AGENT_SECRET=$(openssl rand -hex 16)
```

## Running one

```sh
modal run cloud/agent.py --prompt "Add type hints to utils.py"

modal deploy cloud/agent.py           # then, from anywhere:
curl -X POST https://<you>--berth-agent-submit.modal.run \
     -H 'content-type: application/json' \
     -d '{"secret":"...","prompt":"Add type hints to utils.py"}'
# {"call_id":"fc-...","prompt":"..."}
```

`submit` spawns and returns immediately — an agent run takes minutes, and a
caller holding an HTTP connection open for one has built a synchronous dependency
on a thing that fails. Watch the ledger, not the response.

## Four things that are easy to get wrong

**Both transcript roots must be redirected, not one.** `collect` walks Claude Code
*and* Codex, and they have separate overrides — `BERTH_TRANSCRIPTS` and
`BERTH_CODEX_TRANSCRIPTS`. Setting only the first leaves Codex pointing at the
real `~/.codex/sessions`, so a rehearsal on a laptop pushes the machine's whole
Codex history to whatever endpoint is configured. Measured here: 103 unrelated
sessions in a run that should have had one. In a container both are empty and the
mistake is invisible, which is the worst place for it to hide.

**`HOME` is redirected too.** Claude Code writes to `$HOME/.claude/projects`, so
without this a local run mixes synthetic agent sessions into somebody's real
captured history with no way to separate them afterwards.

**A container is attributed even though it stores nothing.** It holds a device
token, not an identity, and proposes nothing about who ran the work — `ingestBatch`
stamps `engineer_id` and `machine_id` from the token, server-side. On the
`BERTH_TOKEN` path there is no credentials file to cache the reply in, so `berth
collect` re-registers every run and says so. That is a note about the cache, not
about the data.

**The image builds berth from this checkout, not from npm.** `@harbor-so/berth` on
npm is behind the tree, and an image built from the registry would run an
extractor older than the schema the ledger has — landing rows that look thin
rather than failing.

## What this is not, yet

- **Scratch repo only.** `task.sh` builds the same throwaway `utils.py` that
  `core/scripts/poke.sh` does. Pointing it at a real repository means deciding how
  a container gets a narrowed GitHub credential — `poke.sh`'s header has the
  argument, and the App private key must not be the thing that reaches the agent.
- **No result beyond the session.** The agent's diff stays in the container. There
  is no branch, no PR, no artifact — the session is the deliverable.
- **Not wired to a dashboard button.** `submit` exists so it can be, and takes a
  shared secret rather than a user session, so that wiring is a real decision
  rather than a fetch call.
