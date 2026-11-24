/* The hosted app: anyone signs in with Cloudflare and keeps their clips in
 * their own R2 bucket. Turned on by a D1 binding (DB) plus the OAuth client
 * secrets; without them the app is the self-hosted, single-user one.
 *
 * Signing in only asks to read your Cloudflare profile. Connecting storage is
 * a separate step: either a one-time grant that creates a bucket and a key
 * for just that bucket (then the grant is revoked), or a bucket key you paste.
 * The app keeps that key encrypted and never stores Cloudflare tokens. */

import type { Context, Hono } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"

import { d1Meta, parseSettings, type Meta, type Settings } from "./meta"
import { parseS3Url, s3Store, StorageError, type Store } from "./store"

export type HostedEnv = {
  DB?: D1Database
  CREDS_KEY?: string
  /* Replacing CREDS_KEY: move the old one to CREDS_KEY_PREVIOUS and add one
   * to CREDS_KEY_VERSION (1 when unset). Stored secrets are re-encrypted
   * with the new key the next time they're used. */
  CREDS_KEY_VERSION?: string
  CREDS_KEY_PREVIOUS?: string
  OAUTH_CLIENT_ID?: string
  OAUTH_CLIENT_SECRET?: string
  /* Only honoured when they point at this computer, for tests. */
  CF_DASH?: string
  CF_API?: string
}

export type Tenant = { id: string; store: Store; meta: Meta }

export type SignedIn = {
  userId: string
  email: string
  tenantId: string | null
}

export function isHosted(env: HostedEnv) {
  return Boolean(
    env.DB && env.CREDS_KEY && env.OAUTH_CLIENT_ID && env.OAUTH_CLIENT_SECRET
  )
}

const local = (url: string | undefined) =>
  url && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url)
    ? url
    : null

const dash = (env: HostedEnv) =>
  local(env.CF_DASH) ?? "https://dash.cloudflare.com"

const api = (env: HostedEnv) =>
  local(env.CF_API) ?? "https://api.cloudflare.com/client/v4"

/* ---- Crypto ---- */

const encoder = new TextEncoder()

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

const unb64url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0)
  )

export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export async function sha256(text: string) {
  return b64url(await crypto.subtle.digest("SHA-256", encoder.encode(text)))
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text))

  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("")
}

/* CREDS_KEY is 32 random bytes, base64. Encrypting and signing each use
 * their own key derived from it, and every stored secret records which
 * CREDS_KEY version sealed it. */
type Keys = { aes: CryptoKey; mac: CryptoKey }

const keyCache = new Map<string, Promise<Keys>>()

const currentVersion = (env: HostedEnv) => Number(env.CREDS_KEY_VERSION) || 1

async function deriveKeys(base64: string): Promise<Keys> {
  const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))

  if (raw.length !== 32) throw new Error("CREDS_KEY must be 32 bytes, base64")

  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, [
    "deriveBits",
  ])

  const bits = (purpose: string) =>
    crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(32),
        info: encoder.encode(`clips ${purpose}`),
      },
      base,
      256
    )

  const [aes, mac] = await Promise.all([
    bits("encrypt").then((b) =>
      crypto.subtle.importKey("raw", b, "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ])
    ),
    bits("sign").then((b) =>
      crypto.subtle.importKey(
        "raw",
        b,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      )
    ),
  ])

  return { aes, mac }
}

function keys(env: HostedEnv, version = currentVersion(env)) {
  const base64 =
    version === currentVersion(env)
      ? env.CREDS_KEY
      : version === currentVersion(env) - 1
        ? env.CREDS_KEY_PREVIOUS
        : undefined

  if (!base64) throw new Error(`No CREDS_KEY for version ${version}`)
  let hit = keyCache.get(base64)

  if (!hit) {
    hit = deriveKeys(base64)
    keyCache.set(base64, hit)
  }

  return hit
}

async function encrypt(env: HostedEnv, text: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))

  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    (await keys(env)).aes,
    encoder.encode(text)
  )

  return `${b64url(iv)}.${b64url(sealed)}`
}

async function decrypt(env: HostedEnv, sealed: string, version: number) {
  const [iv, data] = sealed.split(".")

  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64url(iv) },
    (await keys(env, version)).aes,
    unb64url(data)
  )

  return new TextDecoder().decode(plain)
}

async function mac(env: HostedEnv, message: string) {
  return b64url(
    await crypto.subtle.sign(
      "HMAC",
      (await keys(env)).mac,
      encoder.encode(message)
    )
  )
}

async function sameText(a: string, b: string) {
  const [x, y] = await Promise.all(
    [a, b].map((t) => crypto.subtle.digest("SHA-256", encoder.encode(t)))
  )

  return crypto.subtle.timingSafeEqual(x, y)
}

/* ---- Tenants ----
 * Lookups are cached in this isolate for a few seconds, so a busy page makes
 * one D1 query, not one per request. Disconnecting takes effect everywhere
 * within CACHE_MS. */

const CACHE_MS = 10_000
const MAX_CACHED = 1000

/* Adds to a cache, dropping expired and then the oldest entries past
 * MAX_CACHED, so a quiet isolate doesn't keep every user it ever saw. */
function remember<K, V extends { until: number }>(
  cache: Map<K, V>,
  key: K,
  value: V
) {
  cache.delete(key)
  cache.set(key, value)

  if (cache.size <= MAX_CACHED) return
  const now = Date.now()

  for (const [k, v] of cache) if (v.until <= now) cache.delete(k)

  for (const k of cache.keys()) {
    if (cache.size <= MAX_CACHED) break
    cache.delete(k)
  }
}

type TenantRow = {
  id: string
  user_id: string
  endpoint: string
  bucket: string
  access_key_id: string
  secret_enc: string
  key_version: number
  created_by_app: number
  obs_token_hash: string
  obs_token_enc: string
}

const tenantCache = new Map<
  string,
  { until: number; row: TenantRow; tenant: Tenant }
>()

/* Re-encrypts a tenant's secrets with the current CREDS_KEY. */
async function rewrap(env: HostedEnv, row: TenantRow, secret: string) {
  const version = currentVersion(env)

  const next = {
    ...row,
    secret_enc: await encrypt(env, secret),
    obs_token_enc: await encrypt(
      env,
      await decrypt(env, row.obs_token_enc, row.key_version)
    ),
    key_version: version,
  }

  await env
    .DB!.prepare(
      `UPDATE tenants SET secret_enc = ?, obs_token_enc = ?, key_version = ?
       WHERE id = ? AND key_version = ?`
    )
    .bind(next.secret_enc, next.obs_token_enc, version, row.id, row.key_version)
    .run()

  return next
}

export async function loadTenant(env: HostedEnv, id: string) {
  const hit = tenantCache.get(id)

  if (hit && hit.until > Date.now()) return hit

  let row = await env
    .DB!.prepare("SELECT * FROM tenants WHERE id = ?")
    .bind(id)
    .first<TenantRow>()

  if (!row) {
    tenantCache.delete(id)

    return null
  }

  const secretAccessKey = await decrypt(env, row.secret_enc, row.key_version)

  if (row.key_version !== currentVersion(env))
    row = await rewrap(env, row, secretAccessKey)

  const store = s3Store({
    endpoint: row.endpoint,
    bucket: row.bucket,
    accessKeyId: row.access_key_id,
    secretAccessKey,
  })

  const entry = {
    until: Date.now() + CACHE_MS,
    row,
    tenant: { id, store, meta: d1Meta(env.DB!, id) },
  }

  remember(tenantCache, id, entry)

  return entry
}

/* Buckets whose daily clean-up is due, oldest first, at most limit. */
/* Buckets whose clean-up is due, longest waiting first, at most limit.
 * Buckets you connected yourself wait until you confirm the lengths. */
export async function dueTenants(env: HostedEnv, limit: number) {
  const { results } = await env
    .DB!.prepare(
      `SELECT id FROM tenants WHERE cleanup_on = 1 AND next_cleanup <= ?
       ORDER BY next_cleanup LIMIT ?`
    )
    .bind(Date.now(), limit)
    .all<{ id: string }>()

  return results.map((r) => r.id)
}

const QUARTER_HOUR = 900_000
const DAY = 86_400_000

/* Schedules a bucket's next clean-up: tomorrow, or soon when there's more
 * to clear. A failing bucket waits longer each time (15 min, 30 min, 1 h…
 * up to a day), so it can't hold up the others. */
export async function cleanupDone(
  env: HostedEnv,
  id: string,
  outcome: "done" | "more" | "failed"
) {
  const now = Date.now()

  await env
    .DB!.prepare(
      outcome === "failed"
        ? `UPDATE tenants SET cleanup_failures = cleanup_failures + 1,
             next_cleanup = ?1 + MIN(?2, ?3 * (1 << MIN(cleanup_failures, 7)))
           WHERE id = ?4`
        : `UPDATE tenants SET cleanup_failures = 0, last_cleanup = ?1,
             next_cleanup = ?1 + ?2 WHERE id = ?4`
    )
    .bind(now, outcome === "more" ? QUARTER_HOUR : DAY, QUARTER_HOUR, id)
    .run()
}

/* Re-encrypts a few buckets still sealed with the previous CREDS_KEY, so
 * none is left behind when it's retired. Returns how many are left; retire
 * CREDS_KEY_PREVIOUS only when that's 0. */
export async function rewrapStale(env: HostedEnv, limit: number) {
  const version = currentVersion(env)

  const { results } = await env
    .DB!.prepare("SELECT id FROM tenants WHERE key_version < ? LIMIT ?")
    .bind(version, limit)
    .all<{ id: string }>()

  await Promise.all(
    results.map(async ({ id }) => {
      tenantCache.delete(id)
      await loadTenant(env, id).catch((err) =>
        console.error("couldn't re-encrypt one bucket", id, err)
      )
    })
  )

  const left = await env
    .DB!.prepare("SELECT COUNT(*) AS n FROM tenants WHERE key_version < ?")
    .bind(version)
    .first<{ n: number }>()

  if (left?.n) console.log(`${left.n} buckets still use the previous CREDS_KEY`)

  return left?.n ?? 0
}

/* ---- OBS tokens ----
 * c2.<tenant>.<random>. Only its hash is checked; the token itself is kept
 * encrypted so the app can show the install command again. Resetting it
 * turns the old one off. */

const newObsToken = (tenantId: string) => `c2.${tenantId}.${randomToken(24)}`

/* The OBS token as stored right now, never from this isolate's cache, so
 * the install command is the current one even just after a reset. */
export async function currentObsToken(env: HostedEnv, tenantId: string) {
  const row = await env
    .DB!.prepare("SELECT obs_token_enc, key_version FROM tenants WHERE id = ?")
    .bind(tenantId)
    .first<{ obs_token_enc: string; key_version: number }>()

  return row && decrypt(env, row.obs_token_enc, row.key_version)
}

/* The setup code OBS takes: the app's address and the upload token. */
export function setupCode(origin: string, token: string) {
  return "r2obs2:" + btoa(JSON.stringify({ a: origin, t: token }))
}

export async function obsTenant(env: HostedEnv, bearer: string) {
  const [prefix, id, secret] = bearer.split(".")

  if (prefix !== "c2" || !id || !secret) return null
  const entry = await loadTenant(env, id)

  if (!entry) return null

  return (await sameText(await sha256(bearer), entry.row.obs_token_hash))
    ? entry.tenant
    : null
}

/* ---- Sessions ---- */

const SESSION_COOKIE = "clips_sid"
const SESSION_DAYS = 30

const sessionCache = new Map<string, { until: number; who: SignedIn }>()

export async function signedIn(c: Context) {
  const env: HostedEnv = c.env
  const sid = getCookie(c, SESSION_COOKIE)

  if (!sid) return null
  const hash = await sha256(sid)
  const hit = sessionCache.get(hash)

  if (hit && hit.until > Date.now()) return hit.who

  const row = await env
    .DB!.prepare(
      `SELECT u.id AS user_id, u.email, t.id AS tenant_id
       FROM sessions s JOIN users u ON u.id = s.user_id
       LEFT JOIN tenants t ON t.user_id = u.id
       WHERE s.id_hash = ? AND s.expires > ?`
    )
    .bind(hash, Date.now())
    .first<{ user_id: string; email: string; tenant_id: string | null }>()

  if (!row) {
    sessionCache.delete(hash)

    return null
  }

  const who = { userId: row.user_id, email: row.email, tenantId: row.tenant_id }
  remember(sessionCache, hash, { until: Date.now() + CACHE_MS, who })

  return who
}

/* Forgets cached lookups for this user right away, in this isolate. */
function forgetUser(userId: string, tenantId?: string | null) {
  for (const [hash, entry] of sessionCache)
    if (entry.who.userId === userId) sessionCache.delete(hash)

  if (tenantId) tenantCache.delete(tenantId)
}

async function startSession(c: Context, userId: string) {
  const env: HostedEnv = c.env
  const sid = randomToken()
  const expires = Date.now() + SESSION_DAYS * 86_400_000

  await env.DB!.batch([
    env
      .DB!.prepare("DELETE FROM sessions WHERE user_id = ? AND expires < ?")
      .bind(userId, Date.now()),
    env
      .DB!.prepare(
        "INSERT INTO sessions (id_hash, user_id, expires) VALUES (?, ?, ?)"
      )
      .bind(await sha256(sid), userId, expires),
  ])

  setCookie(c, SESSION_COOKIE, sid, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: SESSION_DAYS * 86_400,
  })
}

/* ---- Cloudflare OAuth ---- */

const OAUTH_COOKIE = "clips_oauth"

/* Signing in only reads who you are. */
const LOGIN_SCOPES = ["user-details.read"]

/* Used once to make the bucket and its key, then revoked. */
const SETUP_SCOPES = [
  "account-settings.read",
  "workers-r2.write",
  "workers-r2-bucket-item.write",
  "account-api-tokens.write",
]

/* "Workers R2 Storage Bucket Item Write": read, list and write objects in
 * one bucket, but not change the bucket or reach any other. */
const BUCKET_ITEM_WRITE = "2efd5506f9c8494dacb1fa10a3e7d5b6"

type Purpose = "login" | "setup"

type TokenResponse = { access_token?: string; scope?: string }

function redirectUri(c: Context) {
  return new URL("/api/auth/callback", c.req.url).toString()
}

async function startOAuth(c: Context, purpose: Purpose, userId = "") {
  const env: HostedEnv = c.env
  const state = randomToken(18)
  const verifier = randomToken(32)
  const payload = [state, verifier, purpose, userId].join(".")

  setCookie(
    c,
    OAUTH_COOKIE,
    `${payload}.${await mac(env, `oauth:${payload}`)}`,
    {
      path: "/api/auth",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 600,
    }
  )

  const url = new URL(`${dash(env)}/oauth2/auth`)

  url.search = new URLSearchParams({
    response_type: "code",
    client_id: env.OAUTH_CLIENT_ID!,
    redirect_uri: redirectUri(c),
    scope: (purpose === "login" ? LOGIN_SCOPES : SETUP_SCOPES).join(" "),
    state,
    code_challenge: b64url(
      await crypto.subtle.digest("SHA-256", encoder.encode(verifier))
    ),
    code_challenge_method: "S256",
  }).toString()

  return c.redirect(url.toString())
}

/* Checks the callback against the cookie set when it started, then trades
 * the code for an access token. */
async function finishOAuth(c: Context) {
  const env: HostedEnv = c.env
  const cookie = getCookie(c, OAUTH_COOKIE) ?? ""

  deleteCookie(c, OAUTH_COOKIE, { path: "/api/auth", secure: true })
  const parts = cookie.split(".")
  const sig = parts.pop() ?? ""
  const payload = parts.join(".")
  const [state, verifier, purpose, userId] = parts

  if (
    parts.length !== 4 ||
    !(await sameText(sig, await mac(env, `oauth:${payload}`))) ||
    !(await sameText(c.req.query("state") ?? "", state))
  )
    throw new UserError("That sign-in link expired. Try again.")

  if (c.req.query("error"))
    throw new UserError(
      c.req.query("error") === "access_denied"
        ? "You cancelled on Cloudflare's page."
        : `Cloudflare said: ${c.req.query("error_description") ?? c.req.query("error")}`
    )

  const res = await fetch(`${dash(env)}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: c.req.query("code") ?? "",
      redirect_uri: redirectUri(c),
      client_id: env.OAUTH_CLIENT_ID!,
      client_secret: env.OAUTH_CLIENT_SECRET!,
      code_verifier: verifier,
    }),
  })

  if (!res.ok)
    throw new UserError("Cloudflare didn't accept the sign-in. Try again.")
  const token: TokenResponse = await res.json<TokenResponse>().catch(() => ({}))

  if (!token.access_token)
    throw new UserError("Cloudflare didn't accept the sign-in. Try again.")

  return {
    purpose: (purpose === "setup" ? "setup" : "login") satisfies Purpose,
    userId,
    accessToken: token.access_token,
    scopes: (token.scope ?? "").split(" ").filter(Boolean),
  }
}

/* We never keep Cloudflare's tokens: ask Cloudflare to cancel each one as
 * soon as it's used, retrying a busy or unreachable server. Tokens also
 * expire by themselves within an hour. */
async function revoke(env: HostedEnv, token: string) {
  let status = 0

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${dash(env)}/oauth2/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token,
        client_id: env.OAUTH_CLIENT_ID!,
        client_secret: env.OAUTH_CLIENT_SECRET!,
      }),
    }).catch(() => null)

    status = res?.status ?? 0

    if (res?.ok) return

    if (res && status < 500 && status !== 429) break
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
  }

  console.error(`Cloudflare didn't confirm revoking a grant (${status})`)
}

class UserError extends Error {}

type CfResponse<T> = {
  success: boolean
  result: T
  errors?: { code: number; message: string }[]
}

async function cf<T>(
  env: HostedEnv,
  token: string,
  path: string,
  init?: RequestInit
) {
  const res = await fetch(`${api(env)}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init?.headers,
    },
  })

  /* Cloudflare explains failures in the JSON body too (error codes such as
   * R2 not being turned on); a 5xx from a proxy may not be JSON. */
  if (!res.ok) {
    const body =
      res.status < 500
        ? await res.json<CfResponse<T>>().catch(() => null)
        : null

    return { ok: false, status: res.status, body }
  }

  const body = await res.json<CfResponse<T>>().catch(() => null)

  return { ok: Boolean(body?.success), status: res.status, body }
}

/* ---- Automatic storage setup ---- */

const R2_DISABLED = 10042

/* What one setup attempt made, so a failure can take it back. */
type Made = { account: string; bucket?: string; tokenId?: string }

async function autoSetup(env: HostedEnv, token: string, userId: string) {
  const accounts = await cf<{ id: string; name: string }[]>(
    env,
    token,
    "/accounts?per_page=50"
  )

  const list = accounts.body?.result ?? []

  if (!accounts.ok || !list.length)
    throw new UserError("Cloudflare didn't share an account with clips.")

  /* Storage is billed to the account, so never guess between several. */
  if (list.length > 1)
    throw new UserError(
      `Your Cloudflare login reaches ${list.length} accounts, and clips won't guess which one should hold your clips. Connect your own bucket and key instead.`
    )

  const made: Made = { account: list[0].id }

  try {
    await makeStorage(env, token, userId, made)
  } catch (err) {
    const left = await undo(env, token, userId, made)

    if (left)
      throw new UserError(
        `${err instanceof Error ? err.message : "Setup failed."} clips couldn't remove ${left} it made; delete them in the Cloudflare dashboard.`
      )
    throw err
  }
}

async function makeStorage(
  env: HostedEnv,
  token: string,
  userId: string,
  made: Made
) {
  const account = made.account

  /* Never reuse an existing bucket: its files could fall under clean-up rules
   * they were never meant for. Take clips, or clips-<random> when it's used. */
  for (const name of ["clips", `clips-${crypto.randomUUID().slice(0, 6)}`]) {
    const res = await cf(env, token, `/accounts/${account}/r2/buckets`, {
      method: "POST",
      body: JSON.stringify({ name }),
    })

    if (res.ok) {
      made.bucket = name
      break
    }

    if (res.body?.errors?.some((e) => e.code === R2_DISABLED))
      throw new UserError(
        "R2 isn't turned on in your Cloudflare account yet. Open R2 in the Cloudflare dashboard, turn it on (it's free up to 10 GB), then try again."
      )

    if (res.status !== 409)
      throw new UserError(
        `Couldn't create a bucket: ${res.body?.errors?.[0]?.message ?? res.status}`
      )
  }

  const bucket = made.bucket

  if (!bucket)
    throw new UserError("Couldn't find a free bucket name. Try again.")

  const minted = await cf<{ id: string; value: string }>(
    env,
    token,
    `/accounts/${account}/tokens`,
    {
      method: "POST",
      body: JSON.stringify({
        name: `clips app: ${bucket} bucket only`,
        policies: [
          {
            effect: "allow",
            permission_groups: [{ id: BUCKET_ITEM_WRITE }],
            resources: {
              [`com.cloudflare.edge.r2.bucket.${account}_default_${bucket}`]:
                "*",
            },
          },
        ],
      }),
    }
  )

  if (!minted.ok || !minted.body?.result?.id)
    throw new UserError(
      `Couldn't create a key for the bucket: ${minted.body?.errors?.[0]?.message ?? minted.status}. That needs a Super Administrator, or the API Token Provisioning role. You can connect your own bucket and key instead.`
    )

  made.tokenId = minted.body.result.id

  /* Unfinished uploads clean themselves up after a day. Best effort: the
   * app works without it. */
  await cf(env, token, `/accounts/${account}/r2/buckets/${bucket}/lifecycle`, {
    method: "PUT",
    body: JSON.stringify({
      rules: [
        {
          id: "Abort unfinished uploads",
          enabled: true,
          conditions: { prefix: "" },
          abortMultipartUploadsTransition: {
            condition: { maxAge: 86_400, type: "Age" },
          },
        },
      ],
    }),
  })

  /* An API token's S3 secret is the SHA-256 of its value. */
  await saveTenant(env, userId, {
    endpoint: `https://${account}.r2.cloudflarestorage.com`,
    bucket,
    accessKeyId: made.tokenId,
    secretAccessKey: await sha256Hex(minted.body.result.value),
    createdByApp: true,
  })
}

/* Deletes the key and the (still empty) bucket a failed setup made. Never
 * touches anything it didn't make; Cloudflare refuses to delete a bucket
 * with files in it anyway. */
async function undo(env: HostedEnv, token: string, userId: string, made: Made) {
  /* Each step is tried a few times; a 404 means it's already gone. */
  const remove = async (path: string) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await cf(env, token, path, { method: "DELETE" })

      if (res.ok || res.status === 404) return true
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
    }

    return false
  }

  /* The key first: it's the part that grants access. */
  const keyGone =
    !made.tokenId ||
    (await remove(`/accounts/${made.account}/tokens/${made.tokenId}`))

  const bucketGone =
    !made.bucket ||
    (await remove(`/accounts/${made.account}/r2/buckets/${made.bucket}`))

  if (keyGone && bucketGone) return ""

  const left = {
    bucket: bucketGone ? null : (made.bucket ?? null),
    tokenId: keyGone ? null : (made.tokenId ?? null),
  }

  await env
    .DB!.prepare(
      "INSERT INTO leftovers (user_id, account, bucket, token_id, created) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(userId, made.account, left.bucket, left.tokenId, Date.now())
    .run()
    .catch(() => {})
  console.error("A failed setup left resources behind", {
    account: made.account,
    ...left,
  })

  return [
    left.bucket && `the bucket ${left.bucket} (R2)`,
    left.tokenId && `the API token "clips app: ${made.bucket} bucket only"`,
  ]
    .filter(Boolean)
    .join(" and ")
}

/* One automatic setup per user at a time; a stuck one expires. */
async function lockSetup(env: HostedEnv, userId: string) {
  const now = Date.now()

  const { meta } = await env
    .DB!.prepare(
      `INSERT INTO setups (user_id, started) VALUES (?1, ?2)
       ON CONFLICT (user_id) DO UPDATE SET started = ?2
       WHERE setups.started < ?3`
    )
    .bind(userId, now, now - 600_000)
    .run()

  return meta.changes === 1
}

async function unlockSetup(env: HostedEnv, userId: string) {
  await env
    .DB!.prepare("DELETE FROM setups WHERE user_id = ?")
    .bind(userId)
    .run()
}

/* Checks the key can list, write and delete in the bucket before saving it,
 * with a new file of its own that it removes again. A brand-new key can take
 * a few seconds to start working. */
async function checkBucket(store: Store, patient: boolean) {
  const probe = `config/.clips-check-${randomToken(9)}`

  for (let attempt = 0; ; attempt++) {
    try {
      await store.list("config/")

      if (!(await store.put(probe, "ok", { createOnly: true })))
        throw new StorageError(409, "Storage error: the check file exists")
      await store.delete([probe])

      return
    } catch (err) {
      const denied =
        err instanceof StorageError && [401, 403].includes(err.status)

      if (!patient || attempt >= 10 || !denied) throw err
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
}

async function saveTenant(
  env: HostedEnv,
  userId: string,
  b: {
    endpoint: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
    createdByApp: boolean
  }
) {
  const store = s3Store(b)

  await checkBucket(store, b.createdByApp)

  /* Settings shows the lengths the bucket was set to before, as a starting
   * point; nothing is cleared until you confirm them. */
  const settings: Settings | null = b.createdByApp
    ? null
    : (parseSettings(await store.getText("config/settings.json")) ?? {
        replaysDays: null,
        trashDays: 30,
      })

  /* A new ID each time, so reconnecting never revives an old OBS token. */
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 20)
  const obs = newObsToken(id)

  await env
    .DB!.prepare(
      `INSERT INTO tenants (id, user_id, endpoint, bucket, access_key_id, secret_enc,
         key_version, created_by_app, obs_token_hash, obs_token_enc, settings,
         cleanup_on, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      userId,
      b.endpoint,
      b.bucket,
      b.accessKeyId,
      await encrypt(env, b.secretAccessKey),
      currentVersion(env),
      b.createdByApp ? 1 : 0,
      await sha256(obs),
      await encrypt(env, obs),
      settings && JSON.stringify(settings),
      /* A bucket you bring may hold clips the app never saw: clean-up
       * waits until you confirm the lengths in Settings. */
      b.createdByApp ? 1 : 0,
      Date.now()
    )
    .run()
  forgetUser(userId)
}

/* ---- Routes ---- */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- shared with index.ts's app type
export function hostedRoutes(app: Hono<any>) {
  app.get("/api/auth/login", (c) => startOAuth(c, "login"))

  app.get("/api/auth/setup", async (c) => {
    const who = await signedIn(c)

    if (!who) return c.redirect("/")

    if (who.tenantId) return c.redirect("/")

    return startOAuth(c, "setup", who.userId)
  })

  app.get("/api/auth/callback", async (c) => {
    const env: HostedEnv = c.env
    let token = ""

    try {
      const done = await finishOAuth(c)
      token = done.accessToken

      if (done.purpose === "login") {
        const me = await cf<{ id: string; email: string }>(env, token, "/user")

        if (!me.ok || !me.body?.result?.id)
          throw new UserError("Couldn't read your Cloudflare profile.")
        const { id, email } = me.body.result

        await env
          .DB!.prepare(
            `INSERT INTO users (id, email, created) VALUES (?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET email = excluded.email`
          )
          .bind(id, email, Date.now())
          .run()
        await startSession(c, id)

        return c.redirect("/")
      }

      /* Setup must finish as the person who started it. */
      const who = await signedIn(c)

      if (!who || who.userId !== done.userId)
        throw new UserError("Sign in again, then set up storage.")

      if (who.tenantId) return c.redirect("/")

      const missing = SETUP_SCOPES.filter((s) => !done.scopes.includes(s))

      if (done.scopes.length && missing.length)
        throw new UserError(
          `Setup needs every permission on Cloudflare's page. Missing: ${missing.join(", ")}.`
        )

      if (!(await lockSetup(env, who.userId)))
        throw new UserError(
          "Setup is already running in another tab. Wait a moment and reload."
        )

      try {
        const has = await env
          .DB!.prepare("SELECT 1 FROM tenants WHERE user_id = ?")
          .bind(who.userId)
          .first()

        if (!has) await autoSetup(env, token, who.userId)
      } finally {
        await unlockSetup(env, who.userId)
      }

      return c.redirect("/?connected=1")
    } catch (err) {
      const message =
        err instanceof UserError || err instanceof StorageError
          ? err.message
          : "Something went wrong. Try again."

      if (!(err instanceof UserError)) console.error("oauth callback", err)

      return c.redirect(`/?auth_error=${encodeURIComponent(message)}`)
    } finally {
      if (token) c.executionCtx.waitUntil(revoke(env, token))
    }
  })

  app.post("/api/auth/logout", async (c) => {
    const env: HostedEnv = c.env
    const sid = getCookie(c, SESSION_COOKIE)

    if (sid) {
      const hash = await sha256(sid)

      sessionCache.delete(hash)
      await env
        .DB!.prepare("DELETE FROM sessions WHERE id_hash = ?")
        .bind(hash)
        .run()
    }

    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true })

    return c.json({ ok: true })
  })

  app.get("/api/me", async (c) => {
    const env: HostedEnv = c.env
    const who: SignedIn = c.get("who")
    const entry = who.tenantId ? await loadTenant(env, who.tenantId) : null

    return c.json(
      {
        email: who.email,
        storage: entry && {
          id: entry.row.id,
          bucket: entry.row.bucket,
          auto: entry.row.created_by_app === 1,
        },
      },
      200,
      { "cache-control": "no-store" }
    )
  })

  /* Use my own key: a bucket's S3 URL and an Object Read & Write key. */
  app.post("/api/storage", async (c) => {
    const env: HostedEnv = c.env
    const who: SignedIn = c.get("who")

    if (who.tenantId)
      return c.json({ error: "Storage is already connected" }, 409)

    const body = await c.req
      .json<{
        s3Url?: string
        accessKeyId?: string
        secretAccessKey?: string
      }>()
      .catch(() => null)

    const where = parseS3Url(body?.s3Url ?? "")
    const accessKeyId = body?.accessKeyId?.trim() ?? ""
    const secretAccessKey = body?.secretAccessKey?.trim() ?? ""

    if (!where)
      return c.json(
        {
          error:
            "Paste the bucket's S3 API URL, like https://<account id>.r2.cloudflarestorage.com/<bucket>.",
        },
        400
      )

    if (
      !/^[0-9a-f]{32}$/.test(accessKeyId) ||
      !/^[0-9a-f]{64}$/.test(secretAccessKey)
    )
      return c.json({ error: "That doesn't look like an R2 key pair." }, 400)

    try {
      await saveTenant(env, who.userId, {
        ...where,
        accessKeyId,
        secretAccessKey,
        createdByApp: false,
      })
    } catch (err) {
      if (!(err instanceof StorageError)) throw err

      return c.json(
        {
          error:
            err.status === 404
              ? "There's no bucket with that name in that account."
              : [401, 403].includes(err.status)
                ? "That key can't read and write this bucket. Give it Object Read & Write on it."
                : err.message,
        },
        400
      )
    }

    return c.json({ ok: true })
  })

  /* A new OBS upload token; the old one stops working at once here and
   * within CACHE_MS everywhere else. */
  app.post("/api/obs/token", async (c) => {
    const env: HostedEnv = c.env
    const who: SignedIn = c.get("who")
    const entry = who.tenantId ? await loadTenant(env, who.tenantId) : null

    if (!entry) return c.json({ error: "Connect your storage first" }, 409)
    const id = entry.row.id
    const obs = newObsToken(id)

    /* The new token is sealed with the current key, so only write it to a
     * row that is too; reloading the row brings an older one up to date. */
    const write = async () => {
      const { meta } = await env
        .DB!.prepare(
          `UPDATE tenants SET obs_token_hash = ?, obs_token_enc = ?, obs_seen = NULL
           WHERE id = ? AND key_version = ?`
        )
        .bind(
          await sha256(obs),
          await encrypt(env, obs),
          id,
          currentVersion(env)
        )
        .run()

      return meta.changes === 1
    }

    let written = await write()

    if (!written) {
      tenantCache.delete(id)
      written = Boolean(await loadTenant(env, id)) && (await write())
    }

    forgetUser(who.userId, id)

    if (!written)
      return c.json({ error: "Couldn't make a new command. Try again." }, 409)

    return c.json({ code: setupCode(new URL(c.req.url).origin, obs) }, 200, {
      "cache-control": "no-store",
    })
  })

  /* Stops using the bucket at once. Clips stay in it; Cloudflare's key has
   * to be deleted in the dashboard, which the app can't do with it. */
  app.delete("/api/storage", async (c) => {
    const env: HostedEnv = c.env
    const who: SignedIn = c.get("who")

    await env
      .DB!.prepare("DELETE FROM tenants WHERE user_id = ?")
      .bind(who.userId)
      .run()
    forgetUser(who.userId, who.tenantId)

    return c.json({ ok: true })
  })
}
