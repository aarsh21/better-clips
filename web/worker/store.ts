/* Where clips live. A self-hosted app uses its R2 binding; the hosted app
 * reaches each user's own bucket over R2's S3 API with a key that only works
 * for that bucket. Both look the same to the routes in index.ts. */

import { AwsClient } from "aws4fetch"

export type Obj = {
  key: string
  size: number
  uploaded: Date
  etag: string
  uploadReceipt?: string
}

export type PutOptions = {
  contentType?: string
  /* Fails (returns false) instead of overwriting an existing object. */
  createOnly?: boolean
  meta?: Record<string, string>
}

export interface Store {
  /* Objects under prefix in key order, at most limit of them. */
  list(prefix: string, limit?: number): Promise<Obj[]>
  head(key: string): Promise<Obj | null>
  /* Streams an object, honouring Range, for fetch() calls from the app.
   * With etag, a 404 unless the object still has that ETag. */
  serve(
    key: string,
    req: Request,
    headers: Record<string, string>,
    etag?: string
  ): Promise<Response>
  /* A URL the browser can load straight from the bucket for at most
   * `seconds`, or null when the object must be streamed through the app
   * (the R2 binding can't sign). */
  signedUrl(
    key: string,
    opts: { seconds: number; download?: string; version?: string }
  ): Promise<string | null>
  getText(key: string): Promise<string | null>
  put(
    key: string,
    body: ReadableStream | ArrayBuffer | string,
    opts?: PutOptions
  ): Promise<boolean>
  /* Copies inside the bucket and returns the copy's ETag. With createOnly,
   * returns null when to exists. With sourceEtag, throws ClipChanged unless
   * from still has that ETag. */
  copy(
    from: string,
    to: string,
    createOnly: boolean,
    sourceEtag?: string
  ): Promise<string | null>
  /* Deletes keys and returns the ones that couldn't be deleted. */
  delete(keys: string[]): Promise<string[]>
  createUpload(key: string, receipt: string): Promise<string>
  uploadPart(
    key: string,
    uploadId: string,
    part: number,
    body: ReadableStream,
    length: number
  ): Promise<string>
  /* False when something else was written to key meanwhile. */
  completeUpload(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[]
  ): Promise<boolean>
  abortUpload(key: string, uploadId: string): Promise<void>
}

/* The file changed while the app was working on it, e.g. it was replaced
 * from outside the app. */
export class ClipChanged extends Error {
  constructor() {
    super("The clip changed meanwhile. Reload and try again.")
  }
}

function batchesOf<T>(items: T[], size: number) {
  const batches: T[][] = []

  for (let i = 0; i < items.length; i += size)
    batches.push(items.slice(i, i + size))

  return batches
}

/* ---- R2 binding (self-hosted) ---- */

/* R2 fills in every field of the range, setting the unused ones to
 * undefined, so check values rather than which keys exist. */
function rangeBounds(range: R2Range, size: number) {
  if ("suffix" in range && range.suffix !== undefined)
    return { start: Math.max(0, size - range.suffix), end: size - 1 }

  const start = ("offset" in range ? range.offset : undefined) ?? 0
  const length = ("length" in range ? range.length : undefined) ?? size - start

  return { start, end: Math.min(size, start + length) - 1 }
}

const toObj = (o: R2Object): Obj => ({
  key: o.key,
  size: o.size,
  uploaded: o.uploaded,
  etag: o.etag,
  uploadReceipt: o.customMetadata?.receipt,
})

export function bindingStore(bucket: R2Bucket): Store {
  return {
    async list(prefix, limit = Infinity) {
      const objects: Obj[] = []
      let cursor: string | undefined

      do {
        const page = await bucket.list({ prefix, cursor, limit: 1000 })

        objects.push(...page.objects.map(toObj))
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor && objects.length < limit)

      return objects.slice(0, limit)
    },

    async head(key) {
      const o = await bucket.head(key)

      return o && toObj(o)
    },

    async serve(key, req, extra, etag) {
      const object = await bucket.get(key, {
        range: req.headers,
        onlyIf: etag ? { etagMatches: etag } : req.headers,
      })

      if (!object || (etag && !("body" in object)))
        return new Response("Not found", { status: 404 })
      const headers = new Headers(extra)
      object.writeHttpMetadata(headers)
      headers.set("etag", object.httpEtag)
      headers.set("accept-ranges", "bytes")

      if (!headers.has("content-type")) headers.set("content-type", "video/mp4")

      if (!("body" in object))
        return new Response(null, { status: 304, headers })

      if (object.range && req.headers.get("range")) {
        const { start, end } = rangeBounds(object.range, object.size)

        headers.set("content-range", `bytes ${start}-${end}/${object.size}`)
        headers.set("content-length", String(end - start + 1))

        return new Response(object.body, { status: 206, headers })
      }

      headers.set("content-length", String(object.size))

      return new Response(object.body, { headers })
    },

    signedUrl: async () => null,

    async getText(key) {
      const o = await bucket.get(key)

      return o ? o.text() : null
    },

    async put(key, body, opts = {}) {
      const written = await bucket.put(key, body, {
        httpMetadata: opts.contentType
          ? { contentType: opts.contentType }
          : undefined,
        customMetadata: opts.meta,
        onlyIf: opts.createOnly ? { etagDoesNotMatch: "*" } : undefined,
      })

      return written !== null
    },

    /* The binding can't copy, so stream the object into its new key. */
    async copy(from, to, createOnly, sourceEtag) {
      const src = await bucket.get(
        from,
        sourceEtag ? { onlyIf: { etagMatches: sourceEtag } } : undefined
      )

      if (!src) throw new Error("Clip not found")

      if (!("body" in src)) throw new ClipChanged()
      const { readable, writable } = new FixedLengthStream(src.size)

      const [, written] = await Promise.all([
        src.body.pipeTo(writable),
        bucket.put(to, readable, {
          httpMetadata: src.httpMetadata,
          customMetadata: src.customMetadata,
          onlyIf: createOnly ? { etagDoesNotMatch: "*" } : undefined,
        }),
      ])

      return written?.etag ?? null
    },

    async delete(keys) {
      await Promise.all(batchesOf(keys, 1000).map((b) => bucket.delete(b)))

      return []
    },

    async createUpload(key, receipt) {
      const upload = await bucket.createMultipartUpload(key, {
        httpMetadata: { contentType: "video/mp4" },
        customMetadata: { receipt },
      })

      return upload.uploadId
    },

    async uploadPart(key, uploadId, part, body) {
      const upload = bucket.resumeMultipartUpload(key, uploadId)

      return (await upload.uploadPart(part, body)).etag
    },

    async completeUpload(key, uploadId, parts) {
      await bucket.resumeMultipartUpload(key, uploadId).complete(parts)

      return true
    },

    async abortUpload(key, uploadId) {
      await bucket.resumeMultipartUpload(key, uploadId).abort()
    },
  }
}

/* ---- R2 over S3 (hosted) ---- */

export type S3Bucket = {
  /* https://<account>.r2.cloudflarestorage.com, or with .eu. for the EU */
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

/* The endpoint and bucket from the S3 API URL the dashboard shows, e.g.
 * https://<account>.r2.cloudflarestorage.com/<bucket>. */
export function parseS3Url(url: string) {
  const m = url
    .trim()
    .match(
      /^https:\/\/([0-9a-f]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com)\/([a-z0-9][a-z0-9-]{1,61}[a-z0-9])\/?$/
    )

  return m ? { endpoint: `https://${m[1]}`, bucket: m[2] } : null
}

export class StorageError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const XML_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
])

function unxml(text: string) {
  return text.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (_, e: string) => XML_ENTITIES.get(e) ?? ""
  )
}

function xmlEscape(text: string) {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}

function tag(xml: string, name: string) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))

  return m ? unxml(m[1]) : null
}

/* Keys are slugs and slashes, but encode each segment anyway. */
const path = (key: string) => key.split("/").map(encodeURIComponent).join("/")

/* A signed link starts on a 30-minute boundary and ends a fixed time after
 * it, so the same object gets the same URL for half an hour and the browser
 * caches it. It never outlives `seconds` from now; a link that must end
 * sooner than a window allows is signed from now instead. */
const WINDOW = 1800

function signingTime(seconds: number, now = Date.now()) {
  const nowS = Math.floor(now / 1000)
  const start = seconds > WINDOW ? nowS - (nowS % WINDOW) : nowS

  return {
    datetime: new Date(start * 1000).toISOString().replace(/[:-]|\.\d{3}/g, ""),
    expires: seconds > WINDOW ? seconds : Math.max(1, seconds),
  }
}

/* R2 reports a failed copy or delete inside a 200 response. */
function failed(xml: string) {
  return /<Error>/.test(xml)
}

export function s3Store(b: S3Bucket): Store {
  const options = {
    accessKeyId: b.accessKeyId,
    secretAccessKey: b.secretAccessKey,
    service: "s3",
    region: "auto",
  }

  /* Reads retry on 429 and 5xx. Writes don't: a streamed body can't be sent
   * twice, and a repeated create or complete isn't harmless. */
  const reader = new AwsClient({ ...options, retries: 2 })
  const writer = new AwsClient({ ...options, retries: 0 })
  const signer = reader

  const base = `${b.endpoint}/${b.bucket}`

  async function call(url: string, init: RequestInit = {}, ok = [200]) {
    const method = init.method ?? "GET"
    const client = method === "GET" || method === "HEAD" ? reader : writer

    const res = await client.fetch(url, {
      ...init,
      headers: {
        "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
        ...init.headers,
      },
    })

    if (!ok.includes(res.status)) {
      const body = await res.text().catch(() => "")
      const code = tag(body, "Code") ?? res.statusText

      throw new StorageError(res.status, `Storage error: ${code}`)
    }

    return res
  }

  /* DeleteObjects takes up to 1000 keys and needs a Content-MD5. */
  async function deleteBatch(batch: string[]): Promise<string[]> {
    const xml = `<Delete><Quiet>true</Quiet>${batch
      .map((k) => `<Object><Key>${xmlEscape(k)}</Key></Object>`)
      .join("")}</Delete>`

    const md5 = await crypto.subtle.digest("MD5", new TextEncoder().encode(xml))

    const res = await call(`${base}?delete`, {
      method: "POST",
      body: xml,
      headers: {
        "content-md5": btoa(String.fromCharCode(...new Uint8Array(md5))),
      },
    })

    /* Quiet mode lists only the keys that failed, e.g. under a bucket lock. */
    const text = await res.text()

    return [...text.matchAll(/<Error>([\s\S]*?)<\/Error>/g)].map(
      ([, error]) => tag(error, "Key") ?? ""
    )
  }

  const store: Store = {
    async list(prefix, limit = Infinity) {
      const objects: Obj[] = []
      let token: string | null = null

      do {
        const q = new URLSearchParams({ "list-type": "2", "max-keys": "1000" })

        if (prefix) q.set("prefix", prefix)

        if (token) q.set("continuation-token", token)
        const xml = await (await call(`${base}?${q}`)).text()

        for (const [, item] of xml.matchAll(
          /<Contents>([\s\S]*?)<\/Contents>/g
        )) {
          objects.push({
            key: tag(item, "Key")!,
            size: Number(tag(item, "Size")),
            uploaded: new Date(tag(item, "LastModified")!),
            etag: (tag(item, "ETag") ?? "").replace(/"/g, ""),
          })
        }

        token =
          tag(xml, "IsTruncated") === "true"
            ? tag(xml, "NextContinuationToken")
            : null
      } while (token && objects.length < limit)

      return objects.slice(0, limit)
    },

    async head(key) {
      const res = await call(
        `${base}/${path(key)}`,
        { method: "HEAD" },
        [200, 404]
      )

      if (res.status === 404) return null

      return {
        key,
        size: Number(res.headers.get("content-length")),
        uploaded: new Date(res.headers.get("last-modified") ?? 0),
        etag: (res.headers.get("etag") ?? "").replace(/"/g, ""),
        uploadReceipt: res.headers.get("x-amz-meta-receipt") ?? undefined,
      }
    },

    async serve(key, req, extra, etag) {
      const headers: Record<string, string> = {}

      for (const name of ["range", "if-none-match", "if-modified-since"]) {
        const value = req.headers.get(name)

        if (value) headers[name] = value
      }

      if (etag) headers["if-match"] = `"${etag}"`

      const res = await call(
        `${base}/${path(key)}`,
        { headers },
        [200, 206, 304, 404, 412, 416]
      )

      if (res.status === 404 || res.status === 412) {
        await res.body?.cancel()

        return new Response("Not found", { status: 404 })
      }

      const out = new Headers(extra)

      for (const name of [
        "content-type",
        "content-length",
        "content-range",
        "etag",
        "last-modified",
      ]) {
        const value = res.headers.get(name)

        if (value && !out.has(name)) out.set(name, value)
      }

      out.set("accept-ranges", "bytes")

      return new Response(res.body, { status: res.status, headers: out })
    },

    async signedUrl(key, { seconds, download, version }) {
      const { datetime, expires } = signingTime(seconds)

      /* The browser caches the bytes under this URL, which only this
       * bucket's key can produce, so one user never sees another's. */
      const q = new URLSearchParams({
        "X-Amz-Expires": String(expires),
        "response-cache-control": `private, max-age=${Math.min(expires, 3600)}`,
      })

      /* A version makes a regenerated thumbnail a new URL, so the browser
       * doesn't show the cached old one. */
      if (download || version)
        q.set(
          "response-content-disposition",
          download
            ? `attachment; filename="${download.replace(/["\\]/g, "")}"`
            : `inline; filename="${version!.replace(/[^\w-]/g, "")}.jpg"`
        )

      const signed = await signer.sign(`${base}/${path(key)}?${q}`, {
        method: "GET",
        aws: { signQuery: true, datetime },
      })

      return signed.url
    },

    async getText(key) {
      const res = await call(`${base}/${path(key)}`, {}, [200, 404])

      return res.status === 404 ? null : res.text()
    },

    async put(key, body, opts = {}) {
      const headers: Record<string, string> = {}

      if (opts.contentType) headers["content-type"] = opts.contentType

      if (opts.createOnly) headers["if-none-match"] = "*"

      for (const [k, v] of Object.entries(opts.meta ?? {}))
        headers[`x-amz-meta-${k}`] = v

      const res = await call(
        `${base}/${path(key)}`,
        { method: "PUT", body, headers },
        [200, 412]
      )

      return res.status === 200
    },

    async copy(from, to, createOnly, sourceEtag) {
      const res = await call(
        `${base}/${path(to)}`,
        {
          method: "PUT",
          headers: {
            "x-amz-copy-source": `/${b.bucket}/${path(from)}`,
            ...(createOnly && { "cf-copy-destination-if-none-match": "*" }),
            ...(sourceEtag && {
              "x-amz-copy-source-if-match": `"${sourceEtag}"`,
            }),
          },
        },
        [200, 404, 412]
      )

      const text = await res.text()

      if (res.status === 404) throw new Error("Clip not found")

      /* 412 means the name is taken, or the source changed: tell apart. */
      if (res.status === 412) {
        if (sourceEtag && (await store.head(from))?.etag !== sourceEtag)
          throw new ClipChanged()

        return null
      }

      if (failed(text) || !text.includes("<CopyObjectResult"))
        throw new StorageError(500, `Storage error: ${tag(text, "Code")}`)

      return (tag(text, "ETag") ?? "").replace(/"/g, "")
    },

    async delete(keys) {
      return (await Promise.all(batchesOf(keys, 1000).map(deleteBatch))).flat()
    },

    async createUpload(key, receipt) {
      const res = await call(`${base}/${path(key)}?uploads`, {
        method: "POST",
        headers: { "content-type": "video/mp4", "x-amz-meta-receipt": receipt },
      })

      return tag(await res.text(), "UploadId")!
    },

    /* Streams the part straight through; S3 needs its exact length. */
    async uploadPart(key, uploadId, part, body, length) {
      const { readable, writable } = new FixedLengthStream(length)
      const q = new URLSearchParams({ partNumber: String(part), uploadId })

      const [, res] = await Promise.all([
        body.pipeTo(writable),
        call(`${base}/${path(key)}?${q}`, { method: "PUT", body: readable }),
      ])

      return (res.headers.get("etag") ?? "").replace(/"/g, "")
    },

    async completeUpload(key, uploadId, parts) {
      const xml = `<CompleteMultipartUpload>${[...parts]
        .sort((x, y) => x.partNumber - y.partNumber)
        .map(
          (p) =>
            `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${xmlEscape(p.etag)}"</ETag></Part>`
        )
        .join("")}</CompleteMultipartUpload>`

      /* Only completes onto a free key, atomically: another upload, a move
       * or an outside write that took the name meanwhile wins. */
      const res = await call(
        `${base}/${path(key)}?${new URLSearchParams({ uploadId })}`,
        { method: "POST", body: xml, headers: { "if-none-match": "*" } },
        [200, 412]
      )

      /* S3 can report a failure inside a 200. */
      const text = await res.text()

      if (res.status === 412) return false

      if (failed(text))
        throw new StorageError(500, `Storage error: ${tag(text, "Code")}`)

      return true
    },

    async abortUpload(key, uploadId) {
      await call(
        `${base}/${path(key)}?${new URLSearchParams({ uploadId })}`,
        { method: "DELETE" },
        [204, 404]
      )
    },
  }

  return store
}
