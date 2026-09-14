"""
Berth's background agent: a coding agent that runs where nobody is sitting.

**What this is for.** Everything berth captures today happens on a laptop, while
somebody is at it. This runs the same agent in a container, and the session lands
in the ledger through the ordinary path — the dashboard cannot tell it apart from
work you did yourself, and that is the point. Nothing new is added to the read
side: `sessions.list` renders it because it is a session.

**Modal supplies a container and nothing else.** The work is `task.sh`, which runs
identically on a laptop, so a failure here is reproducible without an account and
you are never debugging by redeploy. Everything below is image-building and
plumbing; if you find product logic in this file, it is in the wrong file.

The chain, and where each link is decided:

    berth device new  ->  BERTH_TOKEN            the dashboard decides the engineer
    this function     ->  claude -p              the agent does the work
    berth collect     ->  POST /v1/ingest        the server decides the attribution

The container holds a device token, not an identity. It proposes nothing about
who ran the work; `ingestBatch` stamps `engineer_id` and `machine_id` from the
token, so an agent on a box nobody owns is still attributed to the person whose
key it is. That is why this needs no new tenancy story.

Setup, once — both need your accounts and neither can be done for you:

    pip install modal && modal token new
    modal secret create berth-agent \\
        ANTHROPIC_API_KEY=sk-ant-... \\
        BERTH_TOKEN=brt_... \\
        BERTH_ENDPOINT=https://<host>/v1/ingest \\
        BERTH_AGENT_SECRET=$(openssl rand -hex 16)

Then:

    modal run cloud/agent.py::doctor          # image only, needs no secret
    modal run cloud/agent.py --prompt "Add type hints to utils.py"
    modal deploy cloud/agent.py     # to call it from the dashboard instead
"""

from pathlib import Path

import modal

REPO = Path(__file__).parent.parent
app = modal.App("berth-agent")

# Where a session's agent home survives between runs.
#
# **This is what makes a follow-up message a conversation rather than a second
# cold start.** `claude --resume <id>` needs the transcript the first run wrote,
# and a Modal Function's filesystem does not outlive the call — so without a
# volume every message would re-derive the context from a prompt describing it,
# which is the expensive part of an agent's first minute and the whole reason a
# chat on a session is worth more than another run.
#
# A volume rather than a Sandbox: a Sandbox keeps a *container* alive between
# messages, which costs money while nobody is typing and still loses everything
# when it is reaped. What actually has to persist is a directory.
AGENT_HOMES = modal.Volume.from_name("berth-agent-homes", create_if_missing=True)

# The image builds berth from *this checkout*, not from npm.
#
# `@harbor-so/berth` on npm is 0.1.0 and behind the tree; an image built from the
# registry would run an extractor that is months from the schema the ledger has,
# and the symptom would be rows that land and look thin rather than an error. The
# copy is late in the layer order so a source edit does not reinstall node.
image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "curl", "ca-certificates", "uuid-runtime")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "apt-get install -y --no-install-recommends nodejs",
        # The agent under test. Pinned: an unpinned harness means the transcript
        # format can move underneath the extractor between two runs of the same
        # image, which is the one variable this container exists to hold still.
        "npm install -g @anthropic-ai/claude-code@2.1.251",
    )
    .add_local_dir(
        REPO,
        remote_path="/berth",
        # Everything the build does not need. `.next` and the fixtures are the
        # expensive ones — 3.9MB of frozen capture that this container will never
        # read, plus two node_modules trees it is about to rebuild anyway.
        ignore=[
            "**/node_modules", "**/.next", "**/dist", ".git",
            "core/src/fixtures", "**/__pycache__", "**/.venv",
        ],
        copy=True,
    )
    .run_commands(
        # Dev dependencies are needed *to build* and not only to build, so they
        # stay. `npm run build` is `tsc`, a devDependency — `--omit=dev` installed
        # 135 packages happily and then failed with `sh: 1: tsc: not found`. And
        # pruning them *after* the build broke `berth` itself: `drizzle-orm` and
        # `postgres` are declared as both peer and dev dependencies, so a prune
        # takes them out from under the CLI's import graph and every invocation
        # dies in node's module resolver. The image is a build artifact nobody
        # pays per megabyte for; correctness wins over slimming it.
        "cd /berth && npm ci --no-audit --no-fund || npm install --no-audit --no-fund",
        "cd /berth && npm run build",
        "ln -sf /berth/dist/cli.js /usr/local/bin/berth && chmod +x /berth/dist/cli.js",
    )
    # For the HTTP trigger below.
    .pip_install("fastapi[standard]")
)

def _secrets() -> list[modal.Secret]:
    """The `berth-agent` secret, or an empty stand-in if it does not exist yet.

    Modal resolves every secret an app declares when the app *loads*, not when the
    function that uses it runs — so a missing `berth-agent` stopped `doctor` from
    running at all, and `doctor` is precisely the thing you want before you go and
    mint credentials. A diagnostic that requires the thing it is diagnosing is no
    diagnostic; `berth doctor` has the same rule written on it.

    Falling back is safe because nothing here reads a credential in Python.
    `task.sh` asserts `BERTH_TOKEN` and `BERTH_ENDPOINT` at its top and exits with
    the command that fixes it, so an unset secret fails one run loudly rather than
    pushing somewhere unintended.
    """
    try:
        found = modal.Secret.from_name("berth-agent")
        found.hydrate()
        return [found]
    except Exception:
        return [modal.Secret.from_dict({})]


secrets = _secrets()


@app.function(image=image)
def doctor() -> str:
    """Is the image sane? Deliberately takes no secrets.

    The image is the expensive, failure-prone half — a node install, an `npm ci`
    over two lockfiles, and a TypeScript build, any of which can break without the
    agent ever being reached. This proves the container can run `berth` and
    `claude` before anybody mints a credential for it, so a first failure is
    "the build broke" rather than "something is wrong, possibly the key".

        modal run cloud/agent.py::doctor
    """
    import shutil
    import subprocess

    lines = []
    for name, argv in (("node", ["node", "-v"]), ("claude", ["claude", "--version"]),
                       ("berth", ["berth", "whoami"]), ("git", ["git", "--version"]),
                       ("uuidgen", ["uuidgen"])):
        where = shutil.which(name)
        if not where:
            lines.append(f"{name:8} MISSING")
            continue
        try:
            got = subprocess.run(argv, capture_output=True, text=True, timeout=60)
            lines.append(f"{name:8} {where}  {(got.stdout or got.stderr).strip().splitlines()[0][:60]}")
        except Exception as error:  # noqa: BLE001 — a probe reports, it does not raise
            lines.append(f"{name:8} {where}  (failed: {error})")
    lines.append(f"task.sh  {'present' if shutil.which('bash') else 'no bash'} "
                 f"{subprocess.run(['bash', '-n', '/berth/cloud/task.sh'], capture_output=True).returncode == 0 and 'syntax ok' or 'SYNTAX ERROR'}")
    out = "\n".join(lines)
    print(out)
    return out


@app.function(image=image, secrets=secrets, timeout=1800, volumes={"/homes": AGENT_HOMES})
def run_task(
    prompt: str,
    repo: str | None = None,
    base: str | None = None,
    run_id: str | None = None,
    gh_token: str | None = None,
    resume_session_id: str | None = None,
    session_id: str | None = None,
    permission_mode: str | None = None,
    git_author_name: str | None = None,
    git_author_email: str | None = None,
    github_login: str | None = None,
) -> str:
    """One agent run, captured and pushed. Returns the log for the caller to read.

    `timeout` is thirty minutes because the interesting sessions are the long
    ones — a cap that kills them keeps only the corpus that was never in doubt.

    **`gh_token` is minted by the caller, not here.** The dashboard holds the App
    private key and calls `tokenForRepo`, so what arrives is scoped to one
    repository and expires in about an hour. The container never sees the key, and
    could not widen the grant if it wanted to. The alternative — the container
    asking berth for a token with its own device token — would let any device
    token mint GitHub credentials for any repository, which is the narrowing
    undone.

    `run_id` is berth's `berth_agent_runs.id`, carried so `task.sh` can report the
    session and pull request back to the row that is already on screen.
    """
    import os
    import subprocess

    env = dict(os.environ)
    # Only set what was actually asked for. `task.sh` refuses an unset or empty
    # `BERTH_REPO` outright — every run names a repository — so a missing one
    # fails at the top of the script with that sentence rather than midway
    # through a clone of nothing.
    if repo:
        env["BERTH_REPO"] = repo
    if base:
        env["BERTH_BASE"] = base
    if run_id:
        env["BERTH_RUN_ID"] = run_id
    if gh_token:
        env["GH_TOKEN"] = gh_token
    # Every run's home lives in the volume, not only a resuming one.
    #
    # **The first version mounted a persistent home only when resuming, and so
    # could never resume anything**: a cold run wrote its transcript to a
    # directory that died with the container, and the follow-up found nothing.
    # `task.sh` picks the session id (or takes the one being resumed) and keys the
    # home by it under here.
    env["BERTH_HOMES_DIR"] = "/homes"
    if resume_session_id:
        env["BERTH_RESUME_SESSION"] = resume_session_id
    # The dashboard minted this before it called us and already wrote it on the
    # run row, so the browser can open the session page immediately rather than
    # waiting for capture to land and tell it what the session was called.
    if session_id:
        env["BERTH_SESSION_ID"] = session_id
    # `acceptEdits` by default, which is what the CLI will actually start under
    # in this image. Overridable per run so the wider mode can be *tested* here
    # rather than deployed and discovered.
    if permission_mode:
        env["BERTH_PERMISSION_MODE"] = permission_mode
    # Who the commits belong to, resolved by the dashboard from its own session.
    # Absent means the person has not linked GitHub, and `task.sh` falls back to
    # berth's own name rather than inventing one.
    if git_author_name:
        env["BERTH_GIT_AUTHOR_NAME"] = git_author_name
    if git_author_email:
        env["BERTH_GIT_AUTHOR_EMAIL"] = git_author_email
    if github_login:
        env["BERTH_GITHUB_LOGIN"] = github_login

    done = subprocess.run(
        ["bash", "/berth/cloud/task.sh", prompt, "/tmp/run"],
        capture_output=True,
        text=True,
        env=env,
    )
    # Committed before the return, or the next message reads a home that was
    # written and never persisted. Modal volumes are explicit about this.
    try:
        AGENT_HOMES.commit()
    except Exception as error:  # noqa: BLE001 — a failed commit must not lose the run
        print(f"(volume commit failed: {error})")

    out = done.stdout + done.stderr
    print(out)
    if done.returncode != 0:
        # The agent failing is not this failing — `task.sh` already swallows that
        # and captures the turns. Reaching here means the *capture* broke, which
        # is worth surfacing as an error rather than a log nobody reads.
        raise RuntimeError(f"capture failed ({done.returncode})\n{out}")
    return out


# **Kept warm, because this is the only part of the run a person waits for.**
# `run_task` booting is minutes of agent work either way; *this* function is what
# the dashboard's `agents.start` blocks on, and a cold start here is a spinner in
# front of somebody who has just pressed send. It does nothing but validate a
# body and spawn, so one idle container is cheap.
@app.function(image=image, secrets=secrets, min_containers=1)
@modal.fastapi_endpoint(method="POST")
def submit(body: dict):
    """Kick off a run and return immediately. This is the *background* half.

    `spawn` rather than `remote`: an agent run takes minutes, and a caller that
    holds an HTTP connection open for one has built a synchronous dependency on a
    thing that fails — which is the shape HAR-9 was cut for. The caller gets a
    call id and watches the ledger, where the session appears through the ordinary
    capture path like any other.

    Authenticated by a shared secret in the same Modal secret as everything else.
    A `modal deploy` publishes a public URL, and an unauthenticated endpoint that
    runs a coding agent is somebody else's compute budget.
    """
    import os

    from fastapi import HTTPException
    from fastapi.responses import JSONResponse

    expected = os.environ.get("BERTH_AGENT_SECRET")
    if not expected:
        # Refuse rather than default to open. A misconfigured secret must not be
        # the reason this is reachable by anybody.
        raise HTTPException(status_code=503, detail="BERTH_AGENT_SECRET is not set")
    if body.get("secret") != expected:
        raise HTTPException(status_code=401, detail="bad secret")

    prompt = (body.get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")

    call = run_task.spawn(
        prompt,
        repo=(body.get("repo") or None),
        base=(body.get("base") or None),
        run_id=(body.get("run_id") or None),
        gh_token=(body.get("gh_token") or None),
        resume_session_id=(body.get("resume_session_id") or None),
        session_id=(body.get("session_id") or None),
        permission_mode=(body.get("permission_mode") or None),
        git_author_name=(body.get("git_author_name") or None),
        git_author_email=(body.get("git_author_email") or None),
        github_login=(body.get("github_login") or None),
    )
    return JSONResponse({"call_id": call.object_id, "prompt": prompt})


@app.local_entrypoint()
def main(prompt: str = "Add type hints to utils.py, and a docstring saying what each returns."):
    print(run_task.remote(prompt))
