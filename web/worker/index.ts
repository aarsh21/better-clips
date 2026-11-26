/* Clips API.
 *
 * Self-hosted: one person, one bucket bound as BUCKET. Sign-in is a password
 * (APP_PASSWORD), or Cloudflare Access when ACCESS_AUD is set. OBS uploads
 * with a token derived from APP_PASSWORD and a random salt in the bucket.
 *
 * Hosted (hosted.ts, when DB and the OAuth secrets are set): anyone signs in
 * with Cloudflare, and each person's clips stay in their own bucket, reached
 * with a key that only works for that bucket. Videos and thumbnails load
 * straight from that bucket through short-lived signed links.
 *
 * Bucket layout (both):
 *   replays/<day>/<time>_<label>.mp4   uploaded by OBS, deleted after N days
 *     (label: <category>[__<name>][-trim-N], see clip-title.ts)
 *   saved/<day>/<time>_<label>.mp4     kept clips, never deleted
 *   trash/<day>/<time>_<label>.mp4     deleted clips, purged after N days
 *   thumbs/<clip key>.jpg             thumbnail
 * Self-hosted only (the hosted app keeps these in D1, see meta.ts):
 *   shares/<id>.json, config/salt, config/settings.json, config/obs-seen
 */

import { Hono, type Context, type Next } from "hono"
import { getCookie, setCookie } from "hono/cookie"
import { createRemoteJWKSet, jwtVerify } from "jose"

import { clipTitle, labelParts } from "./clip-title"
import { HTTPException } from "hono/http-exception"
import { youtubeRoutes, youtubeClips, youtubeMaintenance } from "./youtube"
import {
  checkBucket,
  cleanupDone,
  currentObsToken,
  dueTenants,
  hostedRoutes,
  isHosted,
  loadTenant,
  obsTenant,
  rewrapStale,
  setupCode,
  signedIn,
  type HostedEnv,
  type SignedIn,
  type Tenant,
} from "./hosted"
import {
  bucketMeta,
  bucketShare,
  d1Share,
  REPLAY_DAYS,
  TRASH_DAYS,
  type Settings,
  type Share,
  type ThumbMeta,
} from "./meta"
import {
  bindingStore,
  ClipChanged,
  StorageError,
  type Obj,
  type Store,
} from "./store"

type Env = HostedEnv & {
  BUCKET?: R2Bucket
  ASSETS: Fetcher
  LOGIN_LIMIT: RateLimit
  APP_PASSWORD?: string
  ACCESS_TEAM?: string
  ACCESS_AUD?: string
  OWNER_EMAIL?: string
  DEV_NO_AUTH?: string
}

const FOLDERS = ["replays", "saved", "trash"] as const

type Folder = (typeof FOLDERS)[number]

/* Who is uploading (OBS with its token, or you from the trim editor), who
 * is signed in (hosted), and whose bucket this request works on. */
type App = {
  Bindings: Env
  Variables: { uploader: "obs" | "owner"; who: SignedIn; tenant: Tenant }
}

const app = new Hono<App>()

let selfTenantCache: Tenant | undefined

function selfTenant(env: Env): Tenant {
  selfTenantCache ??= {
    id: "self",
    store: bindingStore(env.BUCKET!),
    meta: bucketMeta(env.BUCKET!),
  }

  return selfTenantCache
}

/* ---- Sign-in ---- */

/* Routes that check who you are themselves. */
const OPEN = new Set([
  "/api/login",
  "/api/auth/login",
  "/api/auth/callback",
  "/api/auth/setup",
  "/api/auth/logout",
  "/api/youtube/connect",
  "/api/youtube/callback",
  "/api/youtube/obs/exchange",
  "/api/youtube/obs/unpair",
  "/api/youtube/upload/start",
  "/api/youtube/upload/complete",
  "/api/youtube/upload/status",
])

/* Hosted routes that work before storage is connected. */
const ACCOUNT = new Set(["/api/me", "/api/storage"])

const obsUpload = (c: Context<App>) =>
  c.req.path.startsWith("/api/upload/") &&
  Boolean(c.req.header("authorization"))

const bearerOf = (c: Context<App>) =>
  (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "")

app.use("/api/*", async (c, next) => {
  const hosted = isHosted(c.env)
  const path = c.req.path

  if (
    !hosted &&
    (path.startsWith("/api/auth/") ||
      path.startsWith("/api/youtube/") ||
      path === "/api/storage" ||
      path === "/api/obs/token")
  )
    return c.json({ error: "Not found" }, 404)

  if (hosted && path === "/api/login")
    return c.json({ error: "Not found" }, 404)

  if (OPEN.has(path)) return next()

  if (
    hosted &&
    path === "/api/youtube/disconnect" &&
    c.req.header("authorization")
  )
    return next()

  if (hosted) return hostedAuth(c, next)

  /* OBS sends its upload token; every other request needs you signed in. */
  if (obsUpload(c)) {
    const token = await uploadToken(c.env)

    if (!token || !(await sameText(bearerOf(c), token)))
      return c.json(
        { error: "Wrong upload token. Paste a new setup code." },
        401
      )
    c.set("uploader", "obs")
    c.set("tenant", selfTenant(c.env))

    return next()
  }

  c.set("uploader", "owner")
  c.set("tenant", selfTenant(c.env))

  if (devNoAuth(c)) return selfOnly(c, next)

  if (c.env.ACCESS_AUD) return (await checkAccess(c)) ?? selfOnly(c, next)
  const password = appPassword(c.env)

  if (!password)
    return c.json({ error: "Sign-in is not set up", auth: "none" }, 503)

  if (await validSession(c.env, password, getCookie(c, SESSION_COOKIE)))
    return selfOnly(c, next)

  return c.json({ error: "Not signed in", auth: "password" }, 401)
})

/* A self-hosted app has no accounts: /api/me just says so. */
function selfOnly(c: Context<App>, next: Next) {
  if (c.req.path === "/api/me") return c.json({ hosted: false })

  return next()
}

async function hostedAuth(c: Context<App>, next: Next) {
  if (obsUpload(c)) {
    const tenant = await obsTenant(c.env, bearerOf(c))

    if (!tenant)
      return c.json(
        { error: "Wrong upload token. Copy the command from your app again." },
        401
      )
    c.set("uploader", "obs")
    c.set("tenant", tenant)

    return next()
  }

  const who = await signedIn(c)

  if (!who) return c.json({ error: "Not signed in", auth: "cloudflare" }, 401)
  c.set("who", who)
  /* Lets every open tab notice when someone else signs in, or storage
   * changes, and start over instead of mixing two accounts. A tab sends the
   * account it shows with each change it makes; a change meant for another
   * account is refused before anything happens. */
  const account = `${who.userId}:${who.tenantId ?? ""}`
  const expected = c.req.header("x-clips-account")

  c.header("x-clips-account", account)

  if (
    expected &&
    expected !== account &&
    !["GET", "HEAD"].includes(c.req.method)
  )
    return c.json(
      {
        error: "You signed in as someone else in another tab.",
        account: "changed",
      },
      409
    )
  c.set("uploader", "owner")

  if (ACCOUNT.has(c.req.path) || c.req.path.startsWith("/api/youtube/"))
    return next()
  const entry = who.tenantId ? await loadTenant(c.env, who.tenantId) : null

  if (!entry && c.req.path === "/api/clips" && c.req.method === "GET")
    return next()

  if (!entry)
    return c.json({ error: "Connect your storage first", storage: "none" }, 409)
  c.set("tenant", entry.tenant)

  return next()
}

/* DEV_NO_AUTH only works on your own machine, so copying it into a deployed
 * Worker's settings can't open the app. */
function devNoAuth(c: Context<App>) {
  const host = new URL(c.req.url).hostname

  return (
    c.env.DEV_NO_AUTH === "1" && (host === "localhost" || host === "127.0.0.1")
  )
}

/* Cloudflare Access sits in front of the app; check its token too, so the API
 * stays closed even if the Access app is misconfigured. */
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined

async function checkAccess(c: Context<App>) {
  const token =
    c.req.header("cf-access-jwt-assertion") ?? getCookie(c, "CF_Authorization")

  if (!token) return c.json({ error: "Not signed in", auth: "access" }, 401)
  const issuer = `https://${c.env.ACCESS_TEAM}.cloudflareaccess.com`
  jwks ??= createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: c.env.ACCESS_AUD,
    })

    const email = String(payload.email ?? "").toLowerCase()

    if (!c.env.OWNER_EMAIL || email !== c.env.OWNER_EMAIL.toLowerCase())
      return c.json({ error: "This account is not allowed" }, 403)
  } catch {
    return c.json({ error: "Invalid session", auth: "access" }, 401)
  }

  return null
}

const SESSION_COOKIE = "clips_session"
const SESSION_DAYS = 30
const MIN_PASSWORD = 12
const encoder = new TextEncoder()

/* APP_PASSWORD, or null when it is missing or too short to use. */
function appPassword(env: Env) {
  const password = env.APP_PASSWORD ?? ""

  return password.length >= MIN_PASSWORD ? password : null
}

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("")
}

async function hmac(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )

  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)))
}

/* Made once, the first time it is needed; it never changes after that. */
let saltCache: string | undefined

async function salt(bucket: R2Bucket) {
  if (saltCache) return saltCache
  const existing = await bucket.get("config/salt")

  if (existing) return (saltCache = await existing.text())
  const fresh = randomId(32)

  /* Only the first of two racing requests writes its salt. */
  const written = await bucket.put("config/salt", fresh, {
    onlyIf: { etagDoesNotMatch: "*" },
  })

  saltCache = written ? fresh : await (await bucket.get("config/salt"))!.text()

  return saltCache
}

/* A secret for one purpose, from the password and the salt. Changing the
 * password changes all of them: it signs you out and OBS needs a new code. */
async function derive(env: Env, password: string, purpose: string) {
  return hmac(password, `${purpose}:${await salt(env.BUCKET!)}`)
}

async function signSession(env: Env, password: string, expires: number) {
  return hmac(await derive(env, password, "session"), `session:${expires}`)
}

async function validSession(
  env: Env,
  password: string,
  cookie: string | undefined
) {
  const [expires, signature] = (cookie ?? "").split(".")

  if (!(Number(expires) > Date.now()) || !signature) return false

  return sameText(signature, await signSession(env, password, Number(expires)))
}

/* Compares secrets in constant time. */
async function sameText(given: string, expected: string) {
  const [a, b] = await Promise.all(
    [given, expected].map((t) =>
      crypto.subtle.digest("SHA-256", encoder.encode(t))
    )
  )

  return crypto.subtle.timingSafeEqual(a, b)
}

app.post("/api/login", async (c) => {
  const password = appPassword(c.env)

  if (c.env.ACCESS_AUD) return c.json({ error: "Password sign-in is off" }, 404)

  if (!password)
    return c.json(
      {
        error: `Set an APP_PASSWORD with ${MIN_PASSWORD} or more characters.`,
        auth: "none",
      },
      503
    )

  const ip = c.req.header("cf-connecting-ip") ?? "local"
  const { success } = await c.env.LOGIN_LIMIT.limit({ key: ip })

  if (!success) return c.json({ error: "Too many tries. Wait a minute." }, 429)
  const body = await c.req.json<{ password?: string }>().catch(() => null)

  if (!(await sameText(String(body?.password ?? ""), password)))
    return c.json({ error: "Wrong password" }, 401)

  const expires = Date.now() + SESSION_DAYS * 86_400_000

  setCookie(
    c,
    SESSION_COOKIE,
    `${expires}.${await signSession(c.env, password, expires)}`,
    {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: SESSION_DAYS * 86_400,
    }
  )

  return c.json({ ok: true })
})

/* ---- Helpers ---- */

function folderOf(key: string): Folder | undefined {
  return FOLDERS.find((f) => key.startsWith(`${f}/`))
}

function clipKey(key: string): { key: string; folder: Folder } | null {
  const folder = folderOf(key)

  if (!folder || key.includes("..") || !key.endsWith(".mp4")) return null

  return { key, folder }
}

/* The clip key at the end of a URL path such as /api/media/<key>. */
function pathClip(c: Context<App>, prefix: string) {
  try {
    return clipKey(
      decodeURIComponent(new URL(c.req.url).pathname.slice(prefix.length))
    )
  } catch {
    return null /* a broken escape */
  }
}

/* Letters, digits and dashes, matching the names the OBS plugin writes. */
function slug(text: string) {
  return text
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
}

/* wanted, or wanted-2, -3 and so on: the first name not in the bucket and
 * not in skip. */
async function uniqueKey(store: Store, key: string, skip = new Set<string>()) {
  const base = key.replace(/\.mp4$/, "")

  for (let i = 0; ; i++) {
    const candidate = i === 0 ? key : `${base}-${i + 1}.mp4`

    if (!skip.has(candidate) && !(await store.head(candidate))) return candidate
  }
}

/* Copies to wanted, or wanted-2, -3…; another move can take a name between
 * the check and the copy, so a refused copy tries the next name. */
async function copyToFreeKey(
  store: Store,
  from: { key: string; etag: string },
  wanted: string,
  taken: Set<string>,
  tries: number
): Promise<{ key: string; etag: string }> {
  if (!tries) throw new Error("Could not find a free name for this clip")
  const candidate = await uniqueKey(store, wanted, taken)
  const etag = await store.copy(from.key, candidate, true, from.etag)

  if (etag !== null) return { key: candidate, etag }

  return copyToFreeKey(store, from, wanted, taken.add(candidate), tries - 1)
}

/* Deletes clips and their thumbnails, thumbnail first, so a failure never
 * leaves a thumbnail behind its clip. Returns the clips that are gone. */
async function deleteClips(store: Store, keys: string[]) {
  const thumbs = new Set(await store.delete(keys.map((k) => `thumbs/${k}.jpg`)))

  const ready = keys.filter((k) => !thumbs.has(`thumbs/${k}.jpg`))
  const failed = new Set(await store.delete(ready))

  return ready.filter((k) => !failed.has(k))
}

/* Moves a clip and its thumbnail: copy, then delete the original. The copy
 * only happens onto a free name, and only while the clip is still the
 * recording that was looked at. */
async function move(t: Tenant, from: string, wanted: string) {
  if (from === wanted) return from

  const [clip, thumb] = await Promise.all([
    t.store.head(from),
    t.store.head(`thumbs/${from}.jpg`),
  ])

  if (!clip?.etag) throw new Error("Clip not found")

  const to = await copyToFreeKey(
    t.store,
    { key: from, etag: clip.etag },
    wanted,
    new Set(),
    5
  )

  /* A thumbnail that changed meanwhile isn't copied; the app makes a new
   * one. */
  const thumbEtag = thumb
    ? await t.store
        .copy(`thumbs/${from}.jpg`, `thumbs/${to.key}.jpg`, false, thumb.etag)
        .catch((err) => {
          if (err instanceof ClipChanged) return null
          throw err
        })
    : null

  /* R2 can't delete a file only if it's unchanged, so check right before
   * deleting: if the clip was replaced since the copy, keep both files. */
  if ((await t.store.head(from))?.etag !== clip.etag) throw new ClipChanged()

  await t.meta.moved({
    from,
    to: to.key,
    etag: [clip.etag, to.etag],
    thumb: thumb && thumbEtag ? [thumb.etag, thumbEtag] : null,
  })

  if (!(await deleteClips(t.store, [from])).length)
    console.error("moved a clip but couldn't delete the original")

  return to.key
}

/* Sends an object. A <video>, <img> or download loads straight from the
 * bucket when the store can sign a link, which is fastest; fetch() calls
 * (thumbnails, the trim editor) stream through here, so the bucket needs no
 * CORS rules. */
async function sendObject(
  c: Context<App>,
  store: Store,
  key: string,
  opts: {
    seconds: number
    cache: string
    redirectCache: string
    type: string
    download?: string
    /* Only send the object while it still has this ETag. */
    etag?: string
    /* Changes the signed link when the object changes. */
    version?: string
  }
) {
  const mode = c.req.header("sec-fetch-mode")

  /* A pinned share can't redirect: a signed link would keep working if the
   * file were replaced. */
  if (!opts.etag && (mode === "no-cors" || mode === "navigate")) {
    const url = await store.signedUrl(key, {
      seconds: opts.seconds,
      download: opts.download,
      version: opts.version,
    })

    if (url)
      return new Response(null, {
        status: 302,
        headers: {
          location: url,
          "cache-control": opts.redirectCache,
          "referrer-policy": "no-referrer",
        },
      })
  }

  return store.serve(
    key,
    c.req.raw,
    {
      "cache-control": opts.cache,
      "content-type": opts.type,
      ...(opts.download && {
        "content-disposition": `attachment; filename="${opts.download}"`,
      }),
    },
    opts.etag
  )
}

/* ---- Clips ---- */

export type Clip = {
  key: string
  folder: Folder
  size: number
  etag: string
  uploaded: string
  thumb?: ThumbMeta
}

/* One listing of the whole bucket, plus what the app knows about thumbs. */
app.get("/api/clips", async (c) => {
  const t = c.get("tenant")

  const youtube = isHosted(c.env)
    ? await youtubeClips(c.env, c.get("who").userId, c.executionCtx)
    : undefined

  if (!t)
    return c.json({ clips: [], youtube }, 200, { "cache-control": "no-store" })

  const [objects, thumbs] = await Promise.all([
    t.store.list(""),
    t.meta.thumbs(),
  ])

  const hasThumb = new Set(
    objects
      .filter((o) => o.key.startsWith("thumbs/"))
      .map((o) => o.key.slice(7, -4))
  )

  const clips: Clip[] = objects.flatMap((o) => {
    const folder = folderOf(o.key)

    if (!folder || !o.key.endsWith(".mp4")) return []
    const thumb = hasThumb.has(o.key) ? thumbs.get(o.key) : undefined

    return [
      {
        key: o.key,
        folder,
        size: o.size,
        etag: o.etag,
        uploaded: o.uploaded.toISOString(),
        ...(thumb && { thumb }),
      },
    ]
  })

  return c.json({ clips, youtube }, 200, { "cache-control": "no-store" })
})

app.get("/api/media/*", async (c) => {
  const clip = pathClip(c, "/api/media/")

  if (!clip) return c.text("Bad key", 400)

  /* /api/media/<key> is the same URL for every account, so the browser
   * mustn't keep the answer: after switching accounts it would show the
   * last one's clip. The signed bucket URL it redirects to is per account
   * and is cached instead. */
  return sendObject(c, c.get("tenant").store, clip.key, {
    seconds: 3600,
    cache: "no-store",
    redirectCache: "no-store",
    type: "video/mp4",
    download:
      c.req.query("download") !== undefined
        ? clip.key.split("/").pop()
        : undefined,
  })
})

app.get("/api/thumb/*", async (c) => {
  const clip = pathClip(c, "/api/thumb/")

  if (!clip) return c.text("Bad key", 400)

  /* Self-hosted has one account, so its thumbnails cache for good. */
  const hosted = isHosted(c.env)

  return sendObject(c, c.get("tenant").store, `thumbs/${clip.key}.jpg`, {
    seconds: 3600,
    cache: hosted ? "no-store" : "private, max-age=31536000, immutable",
    redirectCache: "no-store",
    type: "image/jpeg",
    version: c.req.query("v") || undefined,
  })
})

app.put("/api/thumb/*", async (c) => {
  const clip = pathClip(c, "/api/thumb/")

  if (!clip) return c.text("Bad key", 400)
  const body = await c.req.arrayBuffer()

  if (body.byteLength > 2_000_000) return c.text("Too large", 413)
  const t = c.get("tenant")

  const meta = {
    duration: Math.max(0, Number(c.req.header("x-duration")) || 0),
    width: Math.max(0, Math.round(Number(c.req.header("x-width")) || 0)),
    height: Math.max(0, Math.round(Number(c.req.header("x-height")) || 0)),
  }

  await t.store.put(`thumbs/${clip.key}.jpg`, body, {
    contentType: "image/jpeg",
    meta: {
      duration: String(meta.duration),
      width: String(meta.width),
      height: String(meta.height),
    },
  })
  await t.meta.putThumb(clip.key, meta)

  return c.json({ ok: true })
})

/* Keep, un-keep, delete, restore and rename are all a move. */
app.post("/api/move", async (c) => {
  const { key, to, name } = await c.req.json<{
    key: string
    to?: Folder
    name?: string
  }>()

  const clip = clipKey(key)

  if (!clip) return c.json({ error: "Bad key" }, 400)
  const folder = to ?? clip.folder

  if (!FOLDERS.includes(folder)) return c.json({ error: "Bad folder" }, 400)

  const parts = clip.key.split("/")
  let file = parts.pop()!

  /* A rename sets the name and keeps the category and any trim number;
   * an empty name goes back to the numbered default. */
  if (name !== undefined) {
    const m = file.match(/^(\d{2}-\d{2}-\d{2})?_?(.*)\.mp4$/)
    const parts = labelParts(m?.[2] ?? "")
    const label = [parts.categoryKey, slug(name)].filter(Boolean).join("__")
    file = [m?.[1], label].filter(Boolean).join("_") + parts.trimSuffix + ".mp4"
  }

  parts[0] = folder

  const target = await move(
    c.get("tenant"),
    clip.key,
    [...parts, file].join("/")
  )

  return c.json({ key: target })
})

app.delete("/api/clips/*", async (c) => {
  const clip = pathClip(c, "/api/clips/")

  if (!clip || clip.folder !== "trash")
    return c.json({ error: "Only clips in the trash can be deleted" }, 400)
  const t = c.get("tenant")

  const gone = await deleteClips(t.store, [clip.key])

  await t.meta.forget(gone)

  if (!gone.length)
    return c.json({ error: "Couldn't delete it. Try again." }, 500)

  return c.json({ ok: true })
})

/* POST so a new client cannot accidentally call an older Worker's delete-all. */
app.post("/api/trash", async (c) => {
  const targets = await c.req.json().catch(() => null)

  if (!Array.isArray(targets) || !targets.length)
    return c.json({ error: "Select the trash clips to delete" }, 400)

  const confirmed = new Map<string, string>()

  for (const target of targets) {
    const key = target?.key,
      etag = target?.etag

    // Validate both fields at the JSON boundary before authorizing any deletion.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    const strings = typeof key === "string" && typeof etag === "string"

    if (!strings || !etag || clipKey(key)?.folder !== "trash")
      return c.json({ error: "Invalid trash clip" }, 400)
    confirmed.set(key, etag)
  }

  const t = c.get("tenant")

  const keys = (await t.store.list("trash/")).flatMap((o) =>
    confirmed.get(o.key) === o.etag ? [o.key] : []
  )

  const gone = keys.length ? await deleteClips(t.store, keys) : []

  if (gone.length) await t.meta.forget(gone)

  return c.json({
    deleted: gone.length,
    skipped: confirmed.size - keys.length,
    failed: keys.length - gone.length,
  })
})

/* ---- Sharing ---- */

app.post("/api/share", async (c) => {
  const { key, days } = await c.req.json<{ key: string; days: number | null }>()
  let clip = clipKey(key)

  if (!clip) return c.json({ error: "Bad key" }, 400)

  if (days !== null && !(Number.isInteger(days) && days > 0 && days <= 365))
    return c.json({ error: "Bad expiry" }, 400)
  const t = c.get("tenant")

  /* Shared clips are kept, so the link doesn't die with the cleanup. */
  if (clip.folder !== "saved") {
    const target = await move(t, clip.key, clip.key.replace(/^[^/]+/, "saved"))

    clip = { key: target, folder: "saved" }
  }

  const id = randomId(10)
  const hosted = isHosted(c.env)

  const [object, thumb] = await Promise.all([
    t.store.head(clip.key),
    t.store.head(`thumbs/${clip.key}.jpg`),
  ])

  if (!object || (hosted && !object.etag))
    return c.json({ error: "Clip not found" }, 404)

  /* The hosted app pins the link to this recording and this thumbnail. */
  await t.meta.createShare(id, {
    key: clip.key,
    expires: days ? Date.now() + days * 86_400_000 : null,
    etag: hosted ? object.etag : undefined,
    thumbEtag: hosted ? thumb?.etag || undefined : undefined,
  })
  const url = new URL(`/s/${id}`, c.req.url).toString()

  return c.json({ url, key: clip.key })
})

function randomId(length: number) {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const bytes = crypto.getRandomValues(new Uint8Array(length))

  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")
}

async function findShare(env: Env, id: string) {
  if (!/^[A-Za-z0-9]{6,20}$/.test(id)) return null

  if (isHosted(env)) {
    const share = await d1Share(env.DB!, id)

    const entry =
      share && clipKey(share.key) ? await loadTenant(env, share.tenant) : null

    return entry && share ? { share, tenant: entry.tenant } : null
  }

  const share = await bucketShare(env.BUCKET!, id)

  return share && clipKey(share.key) ? { share, tenant: selfTenant(env) } : null
}

/* Seconds a share's files may be cached or signed for: up to max, but never
 * past the link's expiry. */
function shareSeconds(share: Share, max: number) {
  const left = share.expires
    ? Math.floor((share.expires - Date.now()) / 1000)
    : max

  return Math.max(0, Math.min(max, left))
}

app.get("/s/:id/clip.mp4", async (c) => {
  const found = await findShare(c.env, c.req.param("id"))

  if (!found) return c.text("This link has expired.", 404)

  return sendObject(c, found.tenant.store, found.share.key, {
    seconds: Math.max(1, shareSeconds(found.share, 3600)),
    cache: `public, max-age=${shareSeconds(found.share, 300)}`,
    redirectCache: "no-store",
    type: "video/mp4",
    etag: found.share.etag,
  })
})

app.get("/s/:id", async (c) => {
  const id = c.req.param("id")
  const found = await findShare(c.env, id)

  if (!found) return c.html(sharePage(null, ""), 404)
  const { share, tenant } = found

  const [thumb, thumbFile] = await Promise.all([
    tenant.meta.thumb(share.key),
    tenant.store.head(`thumbs/${share.key}.jpg`),
  ])

  /* A pinned link only shows the thumbnail it was shared with. */
  const hasThumb = isHosted(c.env)
    ? Boolean(share.thumbEtag) && thumbFile?.etag === share.thumbEtag
    : Boolean(thumbFile)

  return c.html(
    sharePage(
      share.key,
      new URL(`/s/${id}`, c.req.url).toString(),
      hasThumb ? (thumb ?? { duration: 0, width: 0, height: 0, v: "" }) : null
    )
  )
})

app.get("/s/:id/thumb.jpg", async (c) => {
  const found = await findShare(c.env, c.req.param("id"))

  if (!found || (isHosted(c.env) && !found.share.thumbEtag))
    return c.text("Not found", 404)

  return sendObject(c, found.tenant.store, `thumbs/${found.share.key}.jpg`, {
    seconds: Math.max(1, shareSeconds(found.share, 3600)),
    cache: `public, max-age=${shareSeconds(found.share, 3600)}`,
    redirectCache: "no-store",
    type: "image/jpeg",
    etag: found.share.thumbEtag,
  })
})

/* A pixel size from thumbnail metadata, as a plain number. */
function dimension(value: number | undefined, fallback: number) {
  const n = Math.round(Number(value))

  return n > 0 && n <= 16_384 ? n : fallback
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}

/* A bare page with Open Graph video tags, so Discord and others embed it. */
function sharePage(key: string | null, url: string, thumb?: ThumbMeta | null) {
  if (!key) {
    return `<!doctype html><meta name=viewport content="width=device-width"><title>Link expired</title>
<body style="margin:0;display:grid;place-items:center;height:100vh;background:#0b0b0b;color:#888;font:13px ui-monospace,monospace">This link has expired.</body>`
  }

  const file = key
    .split("/")
    .pop()!
    .replace(/\.mp4$/, "")

  const label = file.match(/^\d{2}-\d{2}-\d{2}_?(.*)$/)?.[1] ?? file
  const t = clipTitle(label)

  const title = escapeHtml(
    [t.name || t.category || "Clip", t.trim].filter(Boolean).join(" · ")
  )

  const width = dimension(thumb?.width, 1280)
  const height = dimension(thumb?.height, 720)
  const video = `${url}/clip.mp4`

  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta property="og:type" content="video.other">
<meta property="og:title" content="${title}">
<meta property="og:url" content="${url}">
${thumb ? `<meta property="og:image" content="${url}/thumb.jpg">` : ""}
<meta property="og:video" content="${video}">
<meta property="og:video:secure_url" content="${video}">
<meta property="og:video:type" content="video/mp4">
<meta property="og:video:width" content="${width}">
<meta property="og:video:height" content="${height}">
<meta name="twitter:card" content="player">
<style>html,body{margin:0;height:100%;background:#0a0a0a}body{display:grid;place-items:center}
video{max-width:100vw;max-height:100vh;width:100%;outline:none}</style></head>
<body><video src="${video}" controls autoplay playsinline ${thumb ? `poster="${url}/thumb.jpg"` : ""}></video></body></html>`
}

/* ---- Uploads ----
 * A Worker request body is capped at 100 MB, so OBS and the trim editor send
 * clips as a multipart upload: start, then parts of up to 50 MB, then
 * complete. OBS can only write new clips to replays/. */

async function uploadToken(env: Env) {
  const password = appPassword(env)

  return password ? derive(env, password, "upload") : null
}

/* The plugin's names: 2026-11-24/14-35-07_Valorant.mp4 */
const UPLOAD_NAME = /^\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_-]{1,100}\.mp4$/

const MAX_PART = 100 * 1024 * 1024

/* The upload a part or complete call is about, if this caller may touch it. */
async function uploadTarget(c: Context<App>) {
  const clip = clipKey(c.req.query("key") ?? "")
  const uploadId = c.req.query("uploadId")

  const allowed =
    clip?.folder === "replays" ||
    (clip?.folder === "saved" && c.get("uploader") === "owner")

  if (!clip || !allowed || !uploadId) return null
  const t = c.get("tenant")

  const state = await t.meta.uploadState(uploadId, clip.key)
  if (!state || (state === "complete" && c.req.path !== "/api/upload/complete")) return null

  return { t, key: clip.key, uploadId, state }
}

/* Where an upload goes: OBS names a new replay; the trim editor saves next
 * to its source. */
async function uploadKey(c: Context<App>) {
  const name = c.req.query("name") ?? ""
  const from = clipKey(c.req.query("from") ?? "")

  if (from && c.get("uploader") === "owner")
    return trimKey(c.get("tenant").store, from)

  return UPLOAD_NAME.test(name) ? `replays/${name}` : null
}

/* Trims are numbered after their source: ..._Valorant-trim-1.mp4, then
 * -trim-2. A trim of a trim takes the original's next number, so names
 * never stack up. Numbers already used in any folder are skipped, so a kept
 * or trashed trim doesn't share its number with a new one. */
async function trimKey(store: Store, from: { key: string; folder: Folder }) {
  const folder = from.folder === "trash" ? "replays" : from.folder

  const path = from.key
    .slice(from.folder.length + 1)
    .replace(/(?:-trim)+(?:-\d+)?\.mp4$|\.mp4$/, "")

  for (let n = 1; ; n++) {
    const file = `${path}-trim-${n}.mp4`

    const taken = await Promise.all(
      FOLDERS.map((f) => store.head(`${f}/${file}`))
    )

    if (!taken.some(Boolean)) return `${folder}/${file}`
  }
}

/* Lets the app show that OBS is connected, right after Test Upload. */
function obsCheckedIn(c: Context<App>) {
  if (c.get("uploader") === "obs")
    c.executionCtx.waitUntil(
      c
        .get("tenant")
        .meta.markObsSeen()
        .catch(() => {})
    )
}

app.get("/api/upload/check", async (c) => {
  await checkBucket(c.get("tenant").store, false)
  obsCheckedIn(c)

  return c.json({ ok: true })
})

/* Reserves the key before uploading, so two saves of the same second get
 * two names instead of one overwriting the other. */
app.post("/api/upload/start", async (c) => {
  const wanted = await uploadKey(c)

  if (!wanted) return c.json({ error: "Bad clip name" }, 400)
  const t = c.get("tenant")
  const taken = new Set<string>()

  for (let tries = 0; tries < 5; tries++) {
    const key = await uniqueKey(t.store, wanted, taken)
    const uploadId = await t.store.createUpload(key)

    if (await t.meta.startUpload(uploadId, key))
      return c.json({ key, uploadId })
    await t.store.abortUpload(key, uploadId)
    taken.add(key)
  }

  return c.json({ error: "Could not find a free name for this clip" }, 409)
})

app.put("/api/upload/part", async (c) => {
  const target = await uploadTarget(c)
  const part = Number(c.req.query("part"))
  const length = Number(c.req.header("content-length"))
  const body = c.req.raw.body

  if (!target || !body || !Number.isInteger(part) || part < 1 || part > 10_000)
    return c.json({ error: "Bad upload" }, 400)

  if (!(Number.isInteger(length) && length > 0 && length <= MAX_PART))
    return c.json({ error: "Send each part with its Content-Length" }, 411)

  const etag = await target.t.store.uploadPart(
    target.key,
    target.uploadId,
    part,
    body,
    length
  )

  return c.json({ etag })
})

app.post("/api/upload/complete", async (c) => {
  const [target, body] = await Promise.all([
    uploadTarget(c),
    c.req
      .json<{ parts?: { partNumber: number; etag: string }[] }>()
      .catch(() => null),
  ])

  if (!target || !body?.parts?.length)
    return c.json({ error: "Unknown upload for this bucket and key." }, 400)
  if (target.state === "complete") return c.json({ key: target.key })

  const done = await target.t.store.completeUpload(
    target.key,
    target.uploadId,
    body.parts
  )

  /* Something took the name meanwhile; it's never overwritten. */
  if (!done) {
    await target.t.store.abortUpload(target.key, target.uploadId)
    await target.t.meta.endUpload(target.uploadId)

    return c.json({ error: "A clip with this name appeared. Save again." }, 409)
  }

  await target.t.meta.finishUpload(target.uploadId,target.key)
  obsCheckedIn(c)

  return c.json({ key: target.key })
})

/* Throws away the parts of an upload that failed. */
app.post("/api/upload/abort", async (c) => {
  const target = await uploadTarget(c)

  if (!target) return c.json({ error: "Bad upload" }, 400)
  await target.t.store.abortUpload(target.key, target.uploadId)
  await target.t.meta.endUpload(target.uploadId)

  return c.json({ ok: true })
})

/* ---- OBS setup code ---- */

app.get("/api/setup", async (c) => {
  let token: string | null

  if (isHosted(c.env)) token = await currentObsToken(c.env, c.get("tenant").id)
  else token = await uploadToken(c.env)

  if (!token)
    return c.json(
      {
        error: `Set an APP_PASSWORD secret with ${MIN_PASSWORD} or more characters first. OBS's upload token is made from it.`,
      },
      500
    )

  return c.json({ code: setupCode(new URL(c.req.url).origin, token) }, 200, {
    "cache-control": "no-store",
  })
})

/* ---- Settings ---- */

app.get("/api/settings", async (c) => {
  const t = c.get("tenant")

  const [settings, obsSeen] = await Promise.all([
    t.meta.settings(),
    t.meta.obsSeen(),
  ])

  return c.json({ ...settings, obsSeen }, 200, { "cache-control": "no-store" })
})

app.put("/api/settings", async (c) => {
  const t = c.get("tenant")
  const body = await c.req.json<Partial<Settings>>().catch(() => null)
  const next = { ...(await t.meta.settings()), ...body }

  if (
    !REPLAY_DAYS.includes(next.replaysDays) ||
    !TRASH_DAYS.includes(next.trashDays)
  )
    return c.json({ error: "Pick one of the listed lengths" }, 400)

  const settings: Settings = {
    replaysDays: next.replaysDays,
    trashDays: next.trashDays,
  }

  await t.meta.saveSettings(settings)

  return c.json(settings)
})

hostedRoutes(app)

youtubeRoutes(app)

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404))

/* JSON errors, so OBS and the app can show what went wrong. A bucket key
 * that stopped working (deleted, or the bucket is gone) says so. */
app.onError((err, c) => {
  if (err instanceof HTTPException)
    return c.json({ error: err.message, ...(err.status === 401 && c.req.header("authorization") && { reason: "revoked" }) }, err.status)

  if (err instanceof ClipChanged) return c.json({ error: err.message }, 409)

  if (err instanceof StorageError && [401, 403].includes(err.status))
    return c.json(
      {
        error:
          "Your bucket's key stopped working. Disconnect storage in Settings and connect it again.",
        storage: "broken",
      },
      502
    )

  if (!(err instanceof StorageError)) console.error(err)

  return c.json({ error: err.message }, 500)
})

/* ---- Daily cleanup ----
 * Clears new clips and the trash after the days set in Settings. Kept clips
 * stay. The hosted app does this for every connected bucket. */

/* At most this many clips per folder per run, so a huge bucket is cleared
 * over several runs. Keys start with the day, so the oldest come first. */
const CLEANUP_BATCH = 2000

/* Clears old clips. Returns "more" when there's more to clear. */
async function cleanup(t: Tenant) {
  const now = Date.now()
  const settings = await t.meta.settings()

  if (settings.paused) return "done"

  const maxAge = [
    ["replays", settings.replaysDays],
    ["trash", settings.trashDays],
  ] as const

  const found = await Promise.all(
    maxAge.map(async ([folder, days]) => {
      if (days === null) return { keys: [], more: false }
      const old = (o: Obj) => now - o.uploaded.getTime() > days * 86_400_000
      const objects = await t.store.list(`${folder}/`, CLEANUP_BATCH)

      return {
        keys: objects.filter((o) => clipKey(o.key) && old(o)).map((o) => o.key),
        more: objects.length === CLEANUP_BATCH && old(objects.at(-1)!),
      }
    })
  )

  const keys = found.flatMap((f) => f.keys)

  if (keys.length) await t.meta.forget(await deleteClips(t.store, keys))

  return found.some((f) => f.more) ? "more" : "done"
}

/* The hosted app cleans a few buckets per run, the ones waiting longest,
 * so one run never has more work than a Worker may do. A bucket that fails
 * waits longer each time before it's tried again. */
const CLEANUPS_PER_RUN = 10

async function cleanupAll(env: Env) {
  if (!isHosted(env)) return void (await cleanup(selfTenant(env)))

  await Promise.all(
    (await dueTenants(env, CLEANUPS_PER_RUN)).map(async (id) => {
      try {
        const entry = await loadTenant(env, id)

        await cleanupDone(env, id, entry ? await cleanup(entry.tenant) : "done")
      } catch (err) {
        console.error("cleanup failed for one bucket", id, err)
        await cleanupDone(env, id, "failed").catch(() => {})
      }
    })
  )
  await rewrapStale(env, 25)
  await youtubeMaintenance(env)
}

export default {
  fetch: app.fetch,
  scheduled: (_event, env, ctx) => ctx.waitUntil(cleanupAll(env)),
} satisfies ExportedHandler<Env>
