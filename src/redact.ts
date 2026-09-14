/**
 * Secrets, removed from captured text before it is written down.
 *
 * ## The defect this exists to prevent
 *
 * The collector records what an agent actually did, and the most legible record
 * of that is the shell command it ran (`collector.ts`, where `detail` is the
 * command itself rather than the tool name). That is the right call for
 * legibility and the wrong one for secrets: a command is also where a token
 * appears in the clear. `berth login --token brt_…`, `gh auth login --with-token`,
 * `export GH_TOKEN=ghs_…` — every one of them is a command, and every command is
 * clipped to a few hundred characters and inserted into `berth_capture_events`,
 * which is pushed to a hosted database.
 *
 * Until now that was latent rather than live, for one reason: **no agent ever
 * typed a GitHub token, because it inherited an ambient `gh auth` login.** The
 * moment berth mints tokens and hands them to sandboxes, it creates exactly the
 * token-bearing commands this pipeline was built to record verbatim. So the
 * redactor lands first, before the credential exists.
 *
 * It cannot be retrofitted, either. `ingest.ts` sets `detail = excluded.detail`
 * on conflict, so a re-push *overwrites* — there is no re-running the extract
 * later to clean up rows that already left. The only moment this is fixable is
 * before the row is built.
 *
 * ## Why it lives at the `clip` funnel
 *
 * `clip` is already the single point every free-text field passes through, which
 * is why the NUL strip lives there too. A redactor applied per-call-site is a
 * redactor that is missing from the call site added next week.
 *
 * **Redaction runs before truncation, not after.** A token that straddles the
 * clip boundary is cut in half by truncation, and half a token no longer matches
 * a pattern that requires a minimum length — so redacting afterwards leaves the
 * first twenty characters of a live credential in the column. Redacting first
 * removes the whole match, and the character count reported in the `… [N more
 * characters]` suffix then honestly describes what was kept.
 *
 * ## Why the patterns are exported
 *
 * `core/scripts/freeze.mjs` needs the same set, and cannot import this file: it
 * is plain node ESM run directly by `refresh.sh`, with no build step and no
 * guarantee that `dist/` exists. So the patterns are duplicated there, and
 * `redact.test.ts` asserts by reading that file's source text that the two
 * agree — the same trick `schema-integrity.test.ts` uses, for the same reason.
 * Two redactors that silently disagree are worse than one, because the fixture
 * path looks audited while the live path is wider.
 *
 * ## Over-redaction is the safe failure
 *
 * The minimum lengths are deliberately shorter than the real credential formats,
 * so `ghp_fake` in a code sample is redacted along with the real thing. A
 * redacted example costs a reader a moment of confusion. A missed credential
 * costs a rotation.
 */

/** What replaced a secret, and what kind it was. Greppable on purpose. */
const mark = (kind: string) => `[redacted:${kind}]`;

/**
 * The left edge of a token, which is `\b` plus the case `\b` gets wrong.
 *
 * `\b` alone was the rule here, and it silently failed on the most ordinary
 * input this pipeline has: JSON. Tool output and tool arguments are stored as
 * encoded JSON text, so a newline inside them is the *two characters* `\` and
 * `n` — and `n` is a word character, so `\bxox…` does not match `\nxoxb-…`.
 * A multi-line command output is the normal case, not an edge one, which meant
 * every secret that began a line after the first was written out in full while
 * the one on the first line was redacted. The test that found it had a JWT
 * replaced and the Slack, AWS and berth tokens immediately below it untouched.
 *
 * So: a normal word boundary, **or** the position directly after a string
 * escape. Over-matching here costs a redaction marker in a log; under-matching
 * costs a live credential in a column that `ingest.ts` cannot clean up, because
 * `detail = excluded.detail` means re-pushing rewrites it rather than removing
 * it. The asymmetry is the whole argument for choosing this direction.
 */
const START = String.raw`(?:(?<![0-9A-Za-z_])|(?<=\\[nrtbf]))`;

/** Build one pattern with the boundary above in front of it. */
const secret = (body: string) => new RegExp(`${START}${body}`, "g");

/**
 * Every shape treated as a secret, in the order they are applied.
 *
 * PEM first, because it is the only multi-line match and the only one whose body
 * would otherwise be chewed on by the single-line patterns below it. The generic
 * `NAME=value` rule is last, so a value with a recognisable shape is labelled by
 * that shape rather than by the variable it happened to be assigned to.
 */
export const SECRET_PATTERNS: readonly { kind: string; re: RegExp }[] = [
	// Any PEM private key block — an App private key, an SSH key, a TLS key.
	// Non-greedy so two keys in one blob are two matches, not one span that
	// swallows everything between them.
	{ kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },

	// GitHub: ghp_ (classic PAT), gho_ (OAuth), ghu_ (user-to-server),
	// ghs_ (installation — what berth mints), ghr_ (refresh).
	{ kind: "github-token", re: secret(String.raw`gh[pousr]_[A-Za-z0-9]{8,}`) },
	// Fine-grained PAT. Missed by the `gh[pousr]_` pattern above: `github_pat_`
	// has an `i` where that one requires one of `pousr`.
	{ kind: "github-token", re: secret(String.raw`github_pat_[A-Za-z0-9_]{8,}`) },

	// A three-segment JWT. This is the App JWT — short-lived but maximally
	// privileged, since it can mint an installation token for any installation —
	// and also every Supabase `service_role` key, which is the database wearing a
	// bearer token.
	{ kind: "jwt", re: secret(String.raw`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`) },

	// berth's own device tokens. `berth login --token brt_…` is precisely the
	// shape of command this pipeline stores in `detail`.
	{ kind: "berth-token", re: secret(String.raw`brt_[A-Za-z0-9_-]{8,}`) },

	// Supabase: `sb_secret_` bypasses RLS entirely; `sbp_` is a personal access
	// token for the management API.
	{ kind: "supabase-key", re: secret(String.raw`sb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}`) },
	{ kind: "supabase-key", re: secret(String.raw`sbp_[A-Za-z0-9]{16,}`) },

	// Anthropic and OpenAI.
	{ kind: "api-key", re: secret(String.raw`sk-[A-Za-z0-9_-]{8,}`) },
	// Slack.
	{ kind: "api-key", re: secret(String.raw`xox[abprs]-[A-Za-z0-9-]{8,}`) },
	// AWS access key id. Fixed length, so no minimum to guess at.
	{ kind: "aws-key", re: secret(String.raw`AKIA[0-9A-Z]{16}\b`) },

	// Stripe. Missed by the `sk-` pattern above, which requires a hyphen where
	// these have an underscore — and `sk_live_` is a live payments credential, so
	// it is close to the worst single shape in this list to miss.
	{ kind: "api-key", re: secret(String.raw`sk_(?:live|test)_[A-Za-z0-9]{8,}`) },
	{ kind: "api-key", re: secret(String.raw`rk_(?:live|test)_[A-Za-z0-9]{8,}`) },

	// Google API key. Fixed prefix, so the minimum length is only there to keep
	// the word "AIzaz" in prose from being redacted.
	{ kind: "google-key", re: secret(String.raw`AIza[0-9A-Za-z_-]{30,}`) },

	// npm automation and publish tokens — `npm_` then 36 base62 characters.
	{ kind: "npm-token", re: secret(String.raw`npm_[A-Za-z0-9]{30,}`) },

	// SendGrid, which is three dot-separated segments beginning `SG.`.
	{ kind: "api-key", re: secret(String.raw`SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`) },

	// The two HTTP authorization schemes, last so a recognised value above is
	// labelled by its own shape first. These are what a provider echoes back when
	// it quotes the failing request, which is the ordinary way a credential lands
	// in `berth_learn_jobs.error` — the column `learn.ts` now runs this function
	// over. Narrow on purpose: the literal scheme word is required, so this
	// cannot eat an ordinary base64 blob.
	{ kind: "bearer-token", re: /Bearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/g },
	{ kind: "basic-auth", re: /Basic\s+[A-Za-z0-9+/]{16,}={0,2}/g },
];

/** `scheme://user:password@host` — the credential-in-a-URL shape. */
const URL_CREDENTIALS = /([a-z+]+:\/\/)[^:@\s/]+:[^@\s/]+@/gi;

/**
 * `SOMETHING_TOKEN=value`, and its `SECRET` / `KEY` / `PASSWORD` siblings.
 *
 * The catch-all for credential shapes not listed above. It matches on the
 * *name*, so it does not need to recognise the value — which is the only way to
 * cover a provider nobody here has thought of yet.
 */
const SECRET_ASSIGNMENT = secret(String.raw`([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*)(\S+)`);

/**
 * The same catch-all for a command-line flag: `--api-key sk_live_…`.
 *
 * The rule above matches on an UPPERCASE name followed by `=` or `:`, which is
 * an environment variable and not a command — and a command line is precisely
 * what this pipeline stores. The leading `--` is what makes lowercasing safe:
 * making `SECRET_ASSIGNMENT` itself case-insensitive and space-separated would
 * redact the phrase "key to the fix" out of every transcript in the corpus,
 * which is over-redaction of a different order from the kind `redact.ts` argues
 * for. A flag is not a sentence, so this can be lowercase without eating prose.
 */
const FLAG_ASSIGNMENT = /(--[a-z0-9-]*(?:token|secret|key|password|passwd|credential)[a-z0-9-]*[= \t]+)(\S+)/gi;

/**
 * A cheap union of literal anchors from every pattern above.
 *
 * `clip` runs on every free-text field of every event — thousands per collect —
 * and the overwhelming majority contain no secret and no near-miss. One failed
 * match here skips ten regex passes. Any anchor added below must also appear in
 * a pattern above, or that pattern becomes unreachable; the test asserts it.
 */
const TRIGGERS = /-----BEGIN|gh[pousr]_|github_pat_|eyJ|brt_|sb_secret|sb_publishable|sbp_|sk-|sk_|rk_|AIza|npm_|SG\.|xox|AKIA|Bearer |Basic |:\/\/|TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|-key|-token|-secret|-password|-passwd|-credential/;

/**
 * Remove every recognised secret from `text`.
 *
 * Total: always returns a string, never throws, and is safe to call on anything.
 * A redactor that can fail is a redactor somebody wraps in a try/catch that
 * swallows the failure and writes the original.
 */
export function redactSecrets(text: string): string {
	if (!TRIGGERS.test(text)) return text;
	let out = text;
	for (const { kind, re } of SECRET_PATTERNS) out = out.replace(re, mark(kind));
	out = out.replace(URL_CREDENTIALS, "$1[redacted]:[redacted]@");
	out = out.replace(SECRET_ASSIGNMENT, `$1${mark("secret-assignment")}`);
	out = out.replace(FLAG_ASSIGNMENT, `$1${mark("secret-assignment")}`);
	return out;
}
