/**
 * Device tokens — the credential a collector uses to push captured sessions.
 *
 * The design constraint is that this credential lives on a laptop, in a file, on
 * a machine berth does not control. Everything here follows from assuming it will
 * eventually leak:
 *
 *   - **The secret is never stored.** Only sha256 of it, so a dump of
 *     `berth_devices` is not a set of working credentials. It is shown once at
 *     creation and cannot be recovered — losing it means minting a new one, which
 *     is the correct trade for a machine credential.
 *   - **A prefix is stored** so a human can tell two devices apart in a list
 *     without the table holding anything that authenticates.
 *   - **Revocation is a timestamp, not a delete.** After an incident the question
 *     is what that device sent *before* it was cut off, and a deleted row takes
 *     its own history's join key with it.
 *   - **`ingest` is the only scope, and it gates the write routes only.** A
 *     device token can push capture for its org, touch its own `last_seen_at`,
 *     and read that org's captured sessions through `/v1/sessions`, `/v1/find`,
 *     `/v1/reflect` and the `/api/session*` views. It cannot mint keys, manage
 *     machines, or reach any other org.
 *
 *     Be exact about the exposure rather than reassuring: those reads return
 *     prompts, reasoning and command output, and `readRoute` in `api.ts` does
 *     not check a scope — see the note on `DEVICE_SCOPES` below. A stolen laptop
 *     credential can read everything its org has captured.
 */

import { timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { BerthDb, Executor } from "./db.js";
import { devices } from "./schema.js";
import { TOKEN_PREFIX, hashToken, mintToken, tokenPrefixOf } from "./token.js";
import { bearerToken } from "./wire.js";

/**
 * The token algebra lives in `./token.js` so the dashboard can share it without
 * pulling Drizzle into an app that reaches this table over PostgREST. Re-exported
 * here because this was its original home and every existing caller imports it
 * from `device.js`.
 */
export { TOKEN_PREFIX, hashToken, mintToken, tokenPrefixOf };

export interface CreatedDevice {
	id: string;
	label: string;
	/** The only time this is ever available. Not recoverable afterwards. */
	token: string;
	tokenPrefix: string;
}

/**
 * Register a machine and return its one-time secret.
 *
 * `engineerId` is optional here and not defaulted, because the two callers know
 * different things: the dashboard resolves the signed-in person and must always
 * pass one, while `berth setup` on a machine with a local database has nobody to
 * resolve. Leaving it out produces a working but unattributed token — which
 * `berth doctor` reports, rather than this function inventing an owner.
 */
export async function createDevice(
	// `Executor` rather than `BerthDb`, because `joinOrg` mints inside a
	// transaction and everything in this codebase accepts either — see `db.ts`.
	// The alternative was a cast at the one call site that needs it, which is a
	// claim about the type rather than a fact about the function.
	db: Executor,
	input: { orgId: string; label: string; engineerId?: string | null },
): Promise<CreatedDevice> {
	const label = input.label.trim();
	if (!label) throw new Error("a device needs a label — it is how you revoke the right one");

	const token = mintToken();
	const [row] = await db
		.insert(devices)
		.values({
			orgId: input.orgId,
			label,
			tokenHash: hashToken(token),
			tokenPrefix: tokenPrefixOf(token),
			engineerId: input.engineerId ?? null,
			// Written rather than left to the column default, so a database whose
			// default was never migrated cannot mint a key narrower than the one this
			// process believes it made — which would fail as a 403 on a read, far
			// from here, against a token that looks correct.
			scopes: [...DEFAULT_DEVICE_SCOPES],
		})
		.returning({ id: devices.id });

	if (!row) throw new Error("device insert returned nothing");
	return { id: row.id, label, token, tokenPrefix: tokenPrefixOf(token) };
}

export interface AuthedDevice {
	id: string;
	orgId: string;
	label: string;
	/**
	 * Who owns this token, and which box last registered against it.
	 *
	 * **This is the identity, and it is why the token is presented at all.** An
	 * ingest request carries a claim about who is pushing; the only version of
	 * that claim worth writing down is the one read off the credential rather
	 * than out of the request body. Both are nullable because keys minted before
	 * this column existed cannot be attributed retroactively without guessing —
	 * but a *new* row written with either of them null is a bug, not a mode.
	 */
	engineerId: string | null;
	machineId: string | null;
	/** What this credential may do. See `DEVICE_SCOPES`. */
	scopes: string[];
}

/**
 * Everything a device token may be allowed to do.
 *
 * Two entries, and the list stays short on purpose: this credential lives in a
 * file on a machine berth does not control, so the answer to "what can somebody
 * do with a stolen one" has to be sayable in a sentence.
 *
 * | scope | gates | checked in |
 * |---|---|---|
 * | `ingest` | `POST /v1/register`, `POST /v1/ingest` | `http.ts` |
 * | `read` | `/v1/sessions`, `/v1/find`, `/v1/reflect`, `/api/sessions`, `/api/session/<id>` | `readRoute` in `api.ts`, `tenantOf` in `views.ts` |
 *
 * **`read` had to arrive with a backfill, and that is the whole difficulty of
 * it.** Until it existed, every token could read its org's captured sessions —
 * prompts, reasoning and command output — because neither read surface checked
 * anything at all. Every credential ever issued therefore carries `{ingest}`
 * alone, and a bare `deviceCan(device, "read")` would have silently broken
 * `berth sessions`, `berth find` and `berth reflect` for everyone who had
 * already run `berth login`, against a hosted endpoint, with a 403 naming a
 * scope their key predates.
 *
 * So the migration grants `read` to every non-revoked device. **That grants
 * nothing anybody did not already have** — it records a privilege that was
 * always there and makes it separable from now on, which is the point: a key
 * minted for a CI box that only pushes can now be `{ingest}` and be unable to
 * drain the corpus, and that was not expressible before.
 *
 * A closed vocabulary as an `as const` array over a `text[]` column rather than a
 * CHECK constraint, matching the same convention elsewhere: widening it is then a
 * TypeScript change every call site sees, rather than a migration nobody reviews.
 */
export const DEVICE_SCOPES = ["ingest", "read"] as const;
export type DeviceScope = (typeof DEVICE_SCOPES)[number];

/**
 * What a key gets when nobody says otherwise.
 *
 * Both scopes, because that is what every key has always been able to do and a
 * new key that could do *less* than the one minted yesterday would be a
 * surprising thing to hand somebody with no UI to explain it. Narrowing is a
 * deliberate act, and the moment there is a control for it, this is the default
 * it departs from.
 *
 * Stated here rather than left to the column default so the two cannot drift:
 * `schema.ts`, `bootstrap.ts` and the migration all have to agree with this, and
 * `device.test.ts` asserts a freshly minted key carries exactly it.
 */
export const DEFAULT_DEVICE_SCOPES: readonly DeviceScope[] = ["ingest", "read"];

/**
 * May this device do that?
 *
 * Separate from authentication because the two failures are different and must
 * stay tellable apart: an unknown token is somebody who should go away, and a
 * valid token missing a scope is a real operator whose key was minted too narrow
 * — and telling them apart is the difference between "check your token" and
 * "mint a new key". Collapsing them into one 401 is how the second becomes
 * unfixable without database access.
 */
export function deviceCan(device: AuthedDevice, scope: DeviceScope): boolean {
	return device.scopes.includes(scope);
}

/**
 * Resolve a presented token to a device, or null.
 *
 * The lookup is by hash, which is a unique-indexed equality match, so the
 * database does the work in constant-ish time and no candidate rows are scanned.
 * The extra `timingSafeEqual` is belt-and-braces against a future refactor that
 * reintroduces a string compare on the hot path — it costs nothing and the
 * failure it prevents is silent.
 *
 * A revoked device authenticates as nothing: the same null as an unknown token,
 * because telling a caller "that token was real but is revoked" is a fact worth
 * withholding from whoever holds a stolen one.
 */
export async function authenticateDevice(
	db: Executor,
	token: string | undefined | null,
): Promise<AuthedDevice | null> {
	if (!token) return null;
	const presented = token.trim();
	if (!presented.startsWith(TOKEN_PREFIX)) return null;

	const hash = hashToken(presented);
	const [row] = await db
		.select({
			id: devices.id,
			orgId: devices.orgId,
			label: devices.label,
			tokenHash: devices.tokenHash,
			engineerId: devices.engineerId,
			machineId: devices.machineId,
			scopes: devices.scopes,
		})
		.from(devices)
		.where(and(eq(devices.tokenHash, hash), isNull(devices.revokedAt)))
		.limit(1);

	if (!row) return null;
	const a = Buffer.from(row.tokenHash, "hex");
	const b = Buffer.from(hash, "hex");
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

	return {
		id: row.id,
		orgId: row.orgId,
		label: row.label,
		engineerId: row.engineerId,
		machineId: row.machineId,
		// Defensive `?? []`: a row written before the column existed reads as null
		// through a driver that has not been told about the default, and an
		// undefined here would make `deviceCan` throw rather than refuse.
		scopes: row.scopes ?? [],
	};
}

/**
 * The device on a request's `Authorization` header, or null.
 *
 * It lives here rather than in `wire.ts` because this is the module that owns
 * "what is this token", and every surface that answers the question has to get
 * the same answer. Before this existed the parse was written twice — once in
 * `ingest.ts` and once in `api.ts` — and the comment on one of them said the
 * two must not drift into telling a caller different things about the same bad
 * token, which is an argument for one function rather than for two that happen
 * to agree today.
 */
export async function authenticateRequest(
	db: Executor,
	headers: Headers,
): Promise<AuthedDevice | null> {
	return authenticateDevice(db, bearerToken(headers));
}

/**
 * Point a device token at the machine that just registered against it.
 *
 * Called by registration, after the machine row exists, so `authenticateDevice`
 * can answer "which box is this" on every subsequent push without a second
 * query. Rebinding is allowed and is not an error: one token moved to a new
 * laptop is a real thing people do, and refusing it would mean the only recovery
 * is minting a new key.
 *
 * Scoped by org in the same statement as the id so a forged device id from
 * another tenant matches nothing rather than repointing somebody else's key.
 */
export async function bindDeviceMachine(
	db: Executor,
	input: { orgId: string; deviceId: string; machineId: string },
): Promise<void> {
	await db
		.update(devices)
		.set({ machineId: input.machineId })
		.where(and(eq(devices.orgId, input.orgId), eq(devices.id, input.deviceId)));
}

/**
 * Note that a device just spoke.
 *
 * Separate from `authenticateDevice` and not awaited by it, because a write on
 * every ingest request is the kind of thing that turns a read path into a lock
 * contention problem. Callers fire it after they have accepted the batch.
 */
export async function touchDevice(db: BerthDb, deviceId: string): Promise<void> {
	try {
		await db.update(devices).set({ lastSeenAt: sql`now()` }).where(eq(devices.id, deviceId));
	} catch {
		// Liveness must never be the reason an accepted batch is reported as failed.
	}
}

/** Cut a device off. Idempotent: revoking twice is not an error. */
export async function revokeDevice(
	db: BerthDb,
	input: { orgId: string; idOrPrefix: string },
): Promise<number> {
	const target = input.idOrPrefix.trim();
	const rows = await db
		.update(devices)
		.set({ revokedAt: sql`now()` })
		.where(
			and(
				eq(devices.orgId, input.orgId),
				isNull(devices.revokedAt),
				// Accept either the uuid or the displayed prefix, because the prefix is
				// what a human has in front of them in `berth devices`.
				sql`(${devices.id}::text = ${target} or ${devices.tokenPrefix} = ${target})`,
			),
		)
		.returning({ id: devices.id });
	return rows.length;
}

export async function listDevices(db: Executor, orgId: string) {
	return db
		.select()
		.from(devices)
		.where(eq(devices.orgId, orgId))
		.orderBy(devices.createdAt);
}
