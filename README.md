# reference/berth — vendored reference code

Read-only reference for the Crystal isolated execution workspace module. **Do not modify
these files and do not import them.** Copy patterns out into `packages/*` and adapt them to
the conventions in `MODULE-CONVENTIONS.md` (Prisma, tRPC, `@prescience/*` Tier 0 packages).

Source: `harbor-so/berth` (private), `main` @ `19408c3` (2026-08-31), except
`src/validate.ts` which is from branch `kb-layer-done` @ `6c627f6`. Authors: Hardik Singh
and Ethan Ng. IP assigned to Hardik Singh; vendored here with permission.

Berth is a coding-agent ledger: it runs Claude Code in a Modal container, captures the
transcript, and renders it in a Next 15 + tRPC + Drizzle dashboard. None of it is
healthcare code. What is worth lifting:

## The isolated agent run (the reason this folder exists)

| File | What to take |
|---|---|
| `cloud/task.sh` | The whole job as one script that runs identically on a laptop and in the cloud. Per-run redirected `HOME`; credential in a git helper, never in a URL; `env -u` scrubs the App key and tokens at launch; `--allowedTools` allowlist instead of bypass; a streaming capture loop while the agent works, then an authoritative collect; report-back to `/v1/agent-runs/:id` on every exit path. |
| `cloud/agent.py` | Modal image (pinned agent CLI) + `submit` endpoint that **spawns and returns a call id** behind a shared secret, refusing when the secret is unset. |
| `cloud/README.md` | Setup, and what the run is not yet. |
| `src/agentrun.ts` (+ test) | The run row's write path. Org scoped from the device token, never the caller. Terminal states cannot be walked back, enforced in the `WHERE`, not read-then-write. Absent fields are left alone, not nulled. |
| `core/server/trpc/routers/agents.ts` | `capability` / `list` / `start` / `archive`. `start` creates the row first, then triggers Modal, so the run has a URL before the container is warm. |
| `core/app/agents/workspace.tsx`, `page.tsx` | Run list + pinned composer. Polls `agents.list` and stops when nothing is running. State as icon + label, never colour alone. |
| `core/app/sessions/conversation.tsx` | A session rendered as a continuable conversation; follows the transcript as it streams. |
| `core/components/agents/*`, `core/lib/transcript.ts` | Composer, markdown with opt-in highlighting, and the tool-family → component registry (`toolFamily`, `toolLabel`). This registry is the seam to extend for dynamic in-line UI. |

## Trust boundaries worth copying

| File | What to take |
|---|---|
| `src/mcp.ts` (+ test) | MCP **server** shape: tenant and agent identity bound at construction via `ReadSource`; refusals as text results, not protocol errors. The test pins the serialized tool surface under a token budget and asserts the server "offers nothing that writes". |
| `src/api.ts` | `ReadSource` with `localSource(db, orgId)` and `remoteSource(url, token)` — tools never learn which they are reading. |
| `src/device.ts` | RFC 8628 device authorization, sha256-only token storage, scopes, constant-time compare. How a connector gets authorised without pasting a token. |
| `src/redact.ts` | Secret redaction applied **before the row is built**. |
| `src/validate.ts` | Screen for model-written text that will be re-served into a later context: refuses injection shape, URLs, runnable commands, secret shape, settled verbs. |
| `src/harness.ts` | A JSON-action tool loop with step and token caps and read-only tools. |
| `src/ingest.ts` | Idempotent, partial-batch-tolerant write path; server stamps identity from the credential and ignores the client's claim. |
| `src/schema.ts` | Drizzle schema. Relevant tables: `berth_capture_sessions/events/turns/decisions` (what an agent actually did, per tool call), `berth_agent_runs` + `AGENT_RUN_STATES`, `berth_devices`. |

## What berth does NOT have (build net-new)

- An exec / file-in / file-out seam. Berth's run is git-shaped (clone → branch → PR).
- Computer use or any browser automation.
- An MCP **client**.
- Token-level streaming (it polls) or model-emitted UI.
- Resource caps on the container beyond Modal's timeout.
