/* Clips API. Runs next to the R2 bucket, so the browser never sees bucket keys.
 *
 * Sign-in is a password (APP_PASSWORD), or Cloudflare Access when ACCESS_AUD
 * is set. OBS uploads with the token from the setup code instead. Session
 * signatures and the upload token are made from APP_PASSWORD and a random
 * salt in the bucket, so neither one alone is enough to forge them.
 *
 * Bucket layout:
 *   replays/<day>/<time>_<label>.mp4   uploaded by OBS, deleted after 30 days
 *   saved/<day>/<time>_<label>.mp4     kept clips, never deleted
 *   trash/<day>/<time>_<label>.mp4     deleted clips, purged after 7 days
 *   thumbs/<clip key>.jpg             thumbnail, metadata holds duration and size
 *   shares/<id>.json                  share link -> clip key and expiry
 *   config/salt                       random salt for sessions and the upload token
 */

import { Hono, type Context } from "hono"
import { getCookie, setCookie } from "hono/cookie"
import { createRemoteJWKSet, jwtVerify } from "jose"

type Env = {
  BUCKET: R2Bucket
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

/* Who is uploading: OBS with its token, or you from the trim editor. */
type App = { Bindings: Env; Variables: { uploader: "obs" | "owner" } }

const app = new Hono<App>()

/* ---- Sign-in ---- */

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/login") return next()

  /* OBS sends its upload token; every other request needs you signed in. */
  const bearer = c.req.header("authorization")

  if (c.req.path.startsWith("/api/upload/") && bearer) {
    const token = await uploadToken(c.env)

    if (!token || !(await sameText(bearer.replace(/^Bearer\s+/i, ""), token)))
      return c.json(
        { error: "Wrong upload token. Paste a new setup code." },
        401
      )
    c.set("uploader", "obs")

    return next()
  }

  c.set("uploader", "owner")

  if (devNoAuth(c)) return next()

  if (c.env.ACCESS_AUD) return (await checkAccess(c)) ?? next()
  const password = appPassword(c.env)

  if (!password)
    return c.json({ error: "Sign-in is not set up", auth: "none" }, 503)

  if (await validSession(c.env, password, getCookie(c, SESSION_COOKIE)))
    return next()

  return c.json({ error: "Not signed in", auth: "password" }, 401)
})

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
  return hmac(password, `${purpose}:${await salt(env.BUCKET)}`)
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

async function listAll(bucket: R2Bucket, prefix: string, metadata = false) {
  const objects: R2Object[] = []
  let cursor: string | undefined

  do {
    const page = await bucket.list({
      prefix,
      cursor,
      limit: 1000,
      include: metadata ? ["customMetadata"] : [],
    })

    objects.push(...page.objects)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)

  return objects
}

/* Copies an object to a new key in one stream, then deletes the original.
 * Its thumbnail and share links follow it, except into the trash, which
 * turns its links off. */
async function move(bucket: R2Bucket, from: string, wanted: string) {
  if (from === wanted) return from

  const [to, thumb] = await Promise.all([
    copyToFreeKey(bucket, from, wanted),
    bucket.get(`thumbs/${from}.jpg`),
  ])

  if (thumb) {
    await bucket.put(`thumbs/${to}.jpg`, await thumb.arrayBuffer(), {
      httpMetadata: thumb.httpMetadata,
      customMetadata: thumb.customMetadata,
    })
  }

  const shares = await listAll(bucket, "shares/")

  await Promise.all(
    shares.map(async (share) => {
      const obj = await bucket.get(share.key)
      const data = obj ? await obj.json<ShareRecord>() : null

      if (data?.key !== from) return

      if (folderOf(to) === "trash") await bucket.delete(share.key)
      else await bucket.put(share.key, JSON.stringify({ ...data, key: to }))
    })
  )

  await bucket.delete([from, `thumbs/${from}.jpg`])

  return to
}

/* Copies a clip to wanted, or wanted-2, -3 and so on when that is taken. The
 * write only succeeds on a free key, so two moves at once can't overwrite
 * each other. */
async function copyToFreeKey(bucket: R2Bucket, from: string, wanted: string) {
  for (let tries = 0; tries < 5; tries++) {
    const to = await uniqueKey(bucket, wanted)
    const src = await bucket.get(from)

    if (!src) throw new Error("Clip not found")
    const { readable, writable } = new FixedLengthStream(src.size)

    const [, written] = await Promise.all([
      src.body.pipeTo(writable),
      bucket.put(to, readable, {
        httpMetadata: src.httpMetadata,
        customMetadata: src.customMetadata,
        onlyIf: { etagDoesNotMatch: "*" },
      }),
    ])

    if (written) return to
  }

  throw new Error("Could not find a free name for this clip")
}

async function uniqueKey(bucket: R2Bucket, key: string) {
  const base = key.replace(/\.mp4$/, "")

  for (let i = 0; ; i++) {
    const candidate = i === 0 ? key : `${base}-${i + 1}.mp4`

    if (!(await bucket.head(candidate))) return candidate
  }
}

/* R2 fills in every field of the range, setting the unused ones to
 * undefined, so check values rather than which keys exist. */
function rangeBounds(range: R2Range, size: number) {
  if ("suffix" in range && range.suffix !== undefined)
    return { start: Math.max(0, size - range.suffix), end: size - 1 }

  const start = ("offset" in range ? range.offset : undefined) ?? 0
  const length = ("length" in range ? range.length : undefined) ?? size - start

  return { start, end: Math.min(size, start + length) - 1 }
}

/* Serves an R2 object with Range support, so video can seek. */
async function serveObject(
  c: Context<App>,
  key: string,
  extraHeaders: Record<string, string> = {}
) {
  const object = await c.env.BUCKET.get(key, {
    range: c.req.raw.headers,
    onlyIf: c.req.raw.headers,
  })

  if (!object) return c.text("Not found", 404)
  const headers = new Headers(extraHeaders)
  object.writeHttpMetadata(headers)
  headers.set("etag", object.httpEtag)
  headers.set("accept-ranges", "bytes")

  if (!headers.has("content-type")) headers.set("content-type", "video/mp4")

  if (!("body" in object)) return new Response(null, { status: 304, headers })

  if (object.range && c.req.header("range")) {
    const { start, end } = rangeBounds(object.range, object.size)

    headers.set("content-range", `bytes ${start}-${end}/${object.size}`)
    headers.set("content-length", String(end - start + 1))

    return new Response(object.body, { status: 206, headers })
  }

  headers.set("content-length", String(object.size))

  return new Response(object.body, { headers })
}

/* ---- Clips ---- */

export type Clip = {
  key: string
  folder: Folder
  size: number
  uploaded: string
  thumb?: { duration: number; width: number; height: number; v: string }
}

app.get("/api/clips", async (c) => {
  const [clipLists, thumbs] = await Promise.all([
    Promise.all(FOLDERS.map((f) => listAll(c.env.BUCKET, `${f}/`))),
    listAll(c.env.BUCKET, "thumbs/", true),
  ])

  const thumbByKey = new Map(thumbs.map((t) => [t.key.slice(7, -4), t]))

  const clips: Clip[] = clipLists
    .flat()
    .filter((o) => o.key.endsWith(".mp4"))
    .map((o) => {
      const t = thumbByKey.get(o.key)

      return {
        key: o.key,
        folder: folderOf(o.key) ?? "replays",
        size: o.size,
        uploaded: o.uploaded.toISOString(),
        thumb: t && {
          duration: Number(t.customMetadata?.duration ?? 0),
          width: Number(t.customMetadata?.width ?? 0),
          height: Number(t.customMetadata?.height ?? 0),
          v: t.etag.slice(0, 8),
        },
      }
    })

  return c.json({ clips }, 200, { "cache-control": "no-store" })
})

app.get("/api/media/*", async (c) => {
  const clip = pathClip(c, "/api/media/")

  if (!clip) return c.text("Bad key", 400)
  const name = clip.key.split("/").pop()!

  return serveObject(c, clip.key, {
    "cache-control": "private, max-age=3600",
    ...(c.req.query("download") !== undefined && {
      "content-disposition": `attachment; filename="${name}"`,
    }),
  })
})

app.get("/api/thumb/*", async (c) => {
  const clip = pathClip(c, "/api/thumb/")

  if (!clip) return c.text("Bad key", 400)

  const res = await serveObject(c, `thumbs/${clip.key}.jpg`, {
    "cache-control": "private, max-age=31536000, immutable",
    "content-type": "image/jpeg",
  })

  return res
})

app.put("/api/thumb/*", async (c) => {
  const clip = pathClip(c, "/api/thumb/")

  if (!clip) return c.text("Bad key", 400)
  const body = await c.req.arrayBuffer()

  if (body.byteLength > 2_000_000) return c.text("Too large", 413)
  await c.env.BUCKET.put(`thumbs/${clip.key}.jpg`, body, {
    httpMetadata: { contentType: "image/jpeg" },
    customMetadata: {
      duration: c.req.header("x-duration") ?? "0",
      width: c.req.header("x-width") ?? "0",
      height: c.req.header("x-height") ?? "0",
    },
  })

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

  if (name !== undefined) {
    const time = file.match(/^\d{2}-\d{2}-\d{2}/)?.[0]
    const label = slug(name)
    file = [time, label].filter(Boolean).join("_") + ".mp4"
  }

  parts[0] = folder
  const target = await move(c.env.BUCKET, clip.key, [...parts, file].join("/"))

  return c.json({ key: target })
})

app.delete("/api/clips/*", async (c) => {
  const clip = pathClip(c, "/api/clips/")

  if (!clip || clip.folder !== "trash")
    return c.json({ error: "Only clips in the trash can be deleted" }, 400)
  await c.env.BUCKET.delete([clip.key, `thumbs/${clip.key}.jpg`])

  return c.json({ ok: true })
})

/* ---- Sharing ---- */

type ShareRecord = { key: string; expires: number | null }

app.post("/api/share", async (c) => {
  const { key, days } = await c.req.json<{ key: string; days: number | null }>()
  let clip = clipKey(key)

  if (!clip) return c.json({ error: "Bad key" }, 400)

  /* Shared clips are kept, so the link doesn't die with the 30-day cleanup. */
  if (clip.folder !== "saved") {
    const target = await move(
      c.env.BUCKET,
      clip.key,
      clip.key.replace(/^[^/]+/, "saved")
    )

    clip = { key: target, folder: "saved" }
  }

  const id = randomId(10)

  const record: ShareRecord = {
    key: clip.key,
    expires: days ? Date.now() + days * 86_400_000 : null,
  }

  await c.env.BUCKET.put(`shares/${id}.json`, JSON.stringify(record))
  const url = new URL(`/s/${id}`, c.req.url).toString()

  return c.json({ url, key: clip.key })
})

function randomId(length: number) {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const bytes = crypto.getRandomValues(new Uint8Array(length))

  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")
}

async function getShare(env: Env, id: string) {
  if (!/^[A-Za-z0-9]{6,20}$/.test(id)) return null
  const obj = await env.BUCKET.get(`shares/${id}.json`)

  if (!obj) return null
  const record = await obj.json<ShareRecord>()

  if (!clipKey(record.key) || (record.expires && record.expires < Date.now()))
    return null

  return record
}

app.get("/s/:id/clip.mp4", async (c) => {
  const share = await getShare(c.env, c.req.param("id"))

  if (!share) return c.text("This link has expired.", 404)

  return serveObject(c, share.key, { "cache-control": shareCache(share, 300) })
})

app.get("/s/:id", async (c) => {
  const id = c.req.param("id")
  const share = await getShare(c.env, id)

  if (!share) return c.html(sharePage(null, ""), 404)
  const thumb = await c.env.BUCKET.head(`thumbs/${share.key}.jpg`)

  return c.html(
    sharePage(share.key, new URL(`/s/${id}`, c.req.url).toString(), thumb)
  )
})

app.get("/s/:id/thumb.jpg", async (c) => {
  const share = await getShare(c.env, c.req.param("id"))

  if (!share) return c.text("Not found", 404)

  return serveObject(c, `thumbs/${share.key}.jpg`, {
    "content-type": "image/jpeg",
    "cache-control": shareCache(share, 3600),
  })
})

/* Caches for up to maxAge seconds, but not past the link's expiry. */
function shareCache(share: ShareRecord, maxAge: number) {
  const left = share.expires
    ? Math.floor((share.expires - Date.now()) / 1000)
    : maxAge

  return `public, max-age=${Math.max(0, Math.min(maxAge, left))}`
}

/* A pixel size from thumbnail metadata, as a plain number. */
function dimension(value: string | undefined, fallback: number) {
  const n = Math.round(Number(value))

  return n > 0 && n <= 16_384 ? n : fallback
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}

/* A bare page with Open Graph video tags, so Discord and others embed it. */
function sharePage(key: string | null, url: string, thumb?: R2Object | null) {
  if (!key) {
    return `<!doctype html><meta name=viewport content="width=device-width"><title>Link expired</title>
<body style="margin:0;display:grid;place-items:center;height:100vh;background:#0b0b0b;color:#888;font:13px ui-monospace,monospace">This link has expired.</body>`
  }

  const file = key
    .split("/")
    .pop()!
    .replace(/\.mp4$/, "")

  const label = file.match(/^\d{2}-\d{2}-\d{2}_?(.*)$/)?.[1] ?? file

  const clean = label
    .replace(/-trim(-\d+)?$/, "")
    .replace(/_[a-z2-9]{6,8}$/, "") /* the plugin's old random link code */
    .replace(/[-_]+/g, " ")
    .trim()

  const title = escapeHtml(clean || "Clip")
  const width = dimension(thumb?.customMetadata?.width, 1280)
  const height = dimension(thumb?.customMetadata?.height, 720)
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

function uploadTarget(c: Context<App>) {
  const clip = clipKey(c.req.query("key") ?? "")
  const uploadId = c.req.query("uploadId")

  const allowed =
    clip?.folder === "replays" ||
    (clip?.folder === "saved" && c.get("uploader") === "owner")

  if (!clip || !allowed || !uploadId) return null

  return c.env.BUCKET.resumeMultipartUpload(clip.key, uploadId)
}

/* Where an upload goes: OBS names a new replay; the trim editor saves next
 * to its source, e.g. ..._Valorant-trim.mp4 */
function uploadKey(c: Context<App>) {
  const name = c.req.query("name") ?? ""
  const from = clipKey(c.req.query("from") ?? "")

  if (from && c.get("uploader") === "owner") {
    const folder = from.folder === "trash" ? "replays" : from.folder

    return `${from.key.replace(/^[^/]+/, folder).replace(/\.mp4$/, "")}-trim.mp4`
  }

  return UPLOAD_NAME.test(name) ? `replays/${name}` : null
}

app.get("/api/upload/check", (c) => c.json({ ok: true }))

app.post("/api/upload/start", async (c) => {
  const wanted = uploadKey(c)

  if (!wanted) return c.json({ error: "Bad clip name" }, 400)
  const key = await uniqueKey(c.env.BUCKET, wanted)

  const upload = await c.env.BUCKET.createMultipartUpload(key, {
    httpMetadata: { contentType: "video/mp4" },
  })

  return c.json({ key, uploadId: upload.uploadId })
})

app.put("/api/upload/part", async (c) => {
  const upload = uploadTarget(c)
  const part = Number(c.req.query("part"))
  const body = c.req.raw.body

  if (!upload || !body || !Number.isInteger(part) || part < 1 || part > 10_000)
    return c.json({ error: "Bad upload" }, 400)

  const uploaded = await upload.uploadPart(part, body)

  return c.json({ etag: uploaded.etag })
})

app.post("/api/upload/complete", async (c) => {
  const upload = uploadTarget(c)

  const body = await c.req
    .json<{ parts?: R2UploadedPart[] }>()
    .catch(() => null)

  if (!upload || !body?.parts?.length)
    return c.json({ error: "Bad upload" }, 400)
  const object = await upload.complete(body.parts)

  return c.json({ key: object.key })
})

/* Throws away the parts of an upload that failed. */
app.post("/api/upload/abort", async (c) => {
  const upload = uploadTarget(c)

  if (!upload) return c.json({ error: "Bad upload" }, 400)
  await upload.abort()

  return c.json({ ok: true })
})

/* ---- OBS setup code ---- */

app.get("/api/setup", async (c) => {
  const token = await uploadToken(c.env)

  if (!token)
    return c.json(
      {
        error: `Set an APP_PASSWORD secret with ${MIN_PASSWORD} or more characters first. OBS's upload token is made from it.`,
      },
      500
    )
  const config = { a: new URL(c.req.url).origin, t: token }

  return c.json({ code: "r2obs2:" + btoa(JSON.stringify(config)) })
})

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404))

/* JSON errors, so OBS and the app can show what went wrong. */
app.onError((err, c) => c.json({ error: err.message }, 500))

/* ---- Daily cleanup ----
 * New clips are cleared after 30 days and the trash after 7, so the bucket
 * needs no lifecycle rules. Kept clips stay. */

const MAX_AGE_DAYS = { replays: 30, trash: 7 }

async function cleanup(bucket: R2Bucket) {
  const now = Date.now()

  const old = await Promise.all(
    Object.entries(MAX_AGE_DAYS).map(async ([folder, days]) =>
      (await listAll(bucket, `${folder}/`)).flatMap((object) =>
        now - object.uploaded.getTime() > days * 86_400_000
          ? [object.key, `thumbs/${object.key}.jpg`]
          : []
      )
    )
  )

  const keys = old.flat()
  const batches = []

  for (let i = 0; i < keys.length; i += 1000)
    batches.push(keys.slice(i, i + 1000))
  await Promise.all(batches.map((batch) => bucket.delete(batch)))
}

export default {
  fetch: app.fetch,
  scheduled: (_event, env, ctx) => ctx.waitUntil(cleanup(env.BUCKET)),
} satisfies ExportedHandler<Env>
