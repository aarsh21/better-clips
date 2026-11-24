/* Clips API. Runs next to the R2 bucket, so the browser never sees bucket keys.
 *
 * Bucket layout:
 *   replays/<day>/<time>_<label>.mp4   uploaded by OBS, deleted after 30 days
 *   saved/<day>/<time>_<label>.mp4     kept clips, never deleted
 *   trash/<day>/<time>_<label>.mp4     deleted clips, purged after 7 days
 *   thumbs/<clip key>.jpg             thumbnail, metadata holds duration and size
 *   shares/<id>.json                  share link -> clip key and expiry
 */

import { Hono, type Context } from "hono"
import { createRemoteJWKSet, jwtVerify } from "jose"

type Env = {
  BUCKET: R2Bucket
  ASSETS: Fetcher
  OWNER_EMAIL: string
  ACCESS_TEAM: string
  ACCESS_AUD: string
  R2_S3_URL: string
  OBS_ACCESS_KEY_ID?: string
  OBS_SECRET_ACCESS_KEY?: string
  DEV_NO_AUTH?: string
}

const FOLDERS = ["replays", "saved", "trash"] as const

type Folder = (typeof FOLDERS)[number]

const app = new Hono<{ Bindings: Env }>()

/* ---- Auth: Cloudflare Access sits in front of the app; check its token too,
 * so the API stays closed even if the Access app is misconfigured. ---- */

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined

app.use("/api/*", async (c, next) => {
  if (c.env.DEV_NO_AUTH === "1") return next()

  const token =
    c.req.header("cf-access-jwt-assertion") ??
    getCookie(c.req.header("cookie"), "CF_Authorization")

  if (!token) return c.json({ error: "Not signed in" }, 401)
  const issuer = `https://${c.env.ACCESS_TEAM}.cloudflareaccess.com`
  jwks ??= createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: c.env.ACCESS_AUD,
    })

    const email = String(payload.email ?? "").toLowerCase()

    if (email !== c.env.OWNER_EMAIL.toLowerCase())
      return c.json({ error: "Not allowed" }, 403)
  } catch {
    return c.json({ error: "Invalid session" }, 401)
  }

  return next()
})

function getCookie(header: string | undefined, name: string) {
  for (const part of header?.split(";") ?? []) {
    const [k, ...v] = part.trim().split("=")

    if (k === name) return v.join("=")
  }
}

/* ---- Helpers ---- */

function folderOf(key: string): Folder | undefined {
  return FOLDERS.find((f) => key.startsWith(`${f}/`))
}

function clipKey(raw: string): { key: string; folder: Folder } | null {
  const key = decodeURIComponent(raw)
  const folder = folderOf(key)

  if (!folder || key.includes("..") || !key.endsWith(".mp4")) return null

  return { key, folder }
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
 * Its thumbnail and any share links follow it. */
async function move(bucket: R2Bucket, from: string, to: string) {
  if (from === to) return
  const src = await bucket.get(from)

  if (!src) throw new Error("Clip not found")
  const { readable, writable } = new FixedLengthStream(src.size)
  const write = src.body.pipeTo(writable)
  await Promise.all([
    write,
    bucket.put(to, readable, {
      httpMetadata: src.httpMetadata,
      customMetadata: src.customMetadata,
    }),
  ])
  const thumb = await bucket.get(`thumbs/${from}.jpg`)

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

      if (data?.key === from)
        await bucket.put(share.key, JSON.stringify({ ...data, key: to }))
    })
  )

  await bucket.delete([from, `thumbs/${from}.jpg`])
}

async function uniqueKey(bucket: R2Bucket, key: string) {
  const base = key.replace(/\.mp4$/, "")

  for (let i = 0; ; i++) {
    const candidate = i === 0 ? key : `${base}-${i + 1}.mp4`

    if (!(await bucket.head(candidate))) return candidate
  }
}

function rangeBounds(range: R2Range, size: number) {
  if ("suffix" in range) return { start: size - range.suffix, end: size - 1 }

  const start = range.offset ?? 0

  return { start, end: start + (range.length ?? size - start) - 1 }
}

/* Serves an R2 object with Range support, so video can seek. */
async function serveObject(
  c: Context<{ Bindings: Env }>,
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
  const clip = clipKey(c.req.path.slice("/api/media/".length))

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
  const clip = clipKey(c.req.path.slice("/api/thumb/".length))

  if (!clip) return c.text("Bad key", 400)

  const res = await serveObject(c, `thumbs/${clip.key}.jpg`, {
    "cache-control": "private, max-age=31536000, immutable",
    "content-type": "image/jpeg",
  })

  return res
})

app.put("/api/thumb/*", async (c) => {
  const clip = clipKey(c.req.path.slice("/api/thumb/".length))

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
  const target = await uniqueKey(c.env.BUCKET, [...parts, file].join("/"))
  await move(c.env.BUCKET, clip.key, target)

  return c.json({ key: target })
})

app.delete("/api/clips/*", async (c) => {
  const clip = clipKey(c.req.path.slice("/api/clips/".length))

  if (!clip || clip.folder !== "trash")
    return c.json({ error: "Only clips in the trash can be deleted" }, 400)
  await c.env.BUCKET.delete([clip.key, `thumbs/${clip.key}.jpg`])

  return c.json({ ok: true })
})

/* Saves an edited clip next to its source, e.g. ..._Valorant-trim.mp4 */
app.post("/api/clips", async (c) => {
  const from = clipKey(c.req.query("from") ?? "")

  if (!from) return c.json({ error: "Bad key" }, 400)
  const length = Number(c.req.header("content-length"))

  if (!c.req.raw.body || !length) return c.json({ error: "Empty body" }, 400)
  const folder = from.folder === "trash" ? "replays" : from.folder
  const base = from.key.replace(/^[^/]+/, folder).replace(/\.mp4$/, "")
  const key = await uniqueKey(c.env.BUCKET, `${base}-trim.mp4`)
  await c.env.BUCKET.put(key, c.req.raw.body, {
    httpMetadata: { contentType: "video/mp4" },
  })

  return c.json({ key })
})

/* ---- Sharing ---- */

type ShareRecord = { key: string; expires: number | null }

app.post("/api/share", async (c) => {
  const { key, days } = await c.req.json<{ key: string; days: number | null }>()
  let clip = clipKey(key)

  if (!clip) return c.json({ error: "Bad key" }, 400)

  /* Shared clips are kept, so the link doesn't die with the 30-day cleanup. */
  if (clip.folder !== "saved") {
    const target = await uniqueKey(
      c.env.BUCKET,
      clip.key.replace(/^[^/]+/, "saved")
    )

    await move(c.env.BUCKET, clip.key, target)
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

  if (record.expires && record.expires < Date.now()) return null

  return record
}

app.get("/s/:id/clip.mp4", async (c) => {
  const share = await getShare(c.env, c.req.param("id"))

  if (!share) return c.text("This link has expired.", 404)

  return serveObject(c, share.key, { "cache-control": "public, max-age=300" })
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
    "cache-control": "public, max-age=3600",
  })
})

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
  const width = thumb?.customMetadata?.width ?? "1280"
  const height = thumb?.customMetadata?.height ?? "720"
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

/* ---- OBS setup code ---- */

app.get("/api/setup", (c) => {
  if (!c.env.OBS_ACCESS_KEY_ID || !c.env.OBS_SECRET_ACCESS_KEY)
    return c.json({ error: "Upload keys are not configured" }, 500)

  const config = {
    u: c.env.R2_S3_URL,
    k: c.env.OBS_ACCESS_KEY_ID,
    s: c.env.OBS_SECRET_ACCESS_KEY,
    f: "replays",
  }

  return c.json({ code: "r2obs1:" + btoa(JSON.stringify(config)) })
})

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404))

export default app
