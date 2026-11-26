import { clipTitle } from "../../worker/clip-title"

export type Folder = "replays" | "saved" | "trash"

/* What GET /api/clips returns (worker/index.ts). */
type ApiClip = {
  key: string
  folder: Folder
  size: number
  etag: string
  uploaded: string
  thumb?: { duration: number; width: number; height: number; v: string }
}

export type BucketClip = ApiClip & {
  source: "bucket"
  /** YYYY-MM-DD the clip was recorded, from its folder (the PC's local day). */
  day: string
  /** HH:MM:SS, the PC's local time. */
  time: string
  /** The window or scene OBS saved from, such as "Counter Strike 2". */
  category: string
  /** The name you gave it, or "". */
  name: string
  /** "Trim 2" for a trim, else null. */
  trim: string | null
  /** The name, or "Clip 3" for the third recording in its category that day,
   * with " · Trim 2" for a trim. Set by withTitles. */
  title: string
  trimmed: boolean
}

export type Privacy = "private" | "unlisted" | "public"

/* A whole-second cut, applied by YouTube's player. */
export type Cut = { start: number; end: number }

/* What GET /api/clips returns for a clip on YouTube (hosted app). */
type ApiYouTubeClip = {
  /** Our row's ID. */
  id: string
  videoId: string
  title: string
  description: string
  /** The game or scene. */
  category: string
  privacy: Privacy
  pendingPrivacy: Privacy | null
  pendingTitle: string | null
  recordedAt: string
  uploaded: string
  durationSeconds: number | null
  thumbnail: string | null
  status: "uploading" | "processing" | "ready" | "failed" | "missing"
  cut: Cut | null
  /** https://youtu.be/<videoId> */
  url: string
}

export type YouTubeClip = Omit<ApiYouTubeClip, "privacy"> & {
  /** Null until a read confirms the visibility; never use the requested value as a badge. */
  privacy: Privacy | null
  source: "youtube"
  /** "youtube/<id>", which can't clash with a bucket key. */
  key: string
  /** The day and time it was recorded, in this browser's time zone. */
  day: string
  time: string
}

/* Every clip in the library: a file in your bucket, or a video on YouTube. */
export type Clip = BucketClip | YouTubeClip

/* replays/2026-11-24/14-35-07_Valorant-Ranked_k3f9x2.mp4 */
export function parseClip(raw: ApiClip): BucketClip {
  const parts = raw.key.split("/")
  const file = parts[parts.length - 1].replace(/\.mp4$/, "")
  const uploaded = new Date(raw.uploaded)

  const day = /^\d{4}-\d{2}-\d{2}$/.test(parts[1] ?? "")
    ? parts[1]
    : localDay(uploaded)

  const m = file.match(/^(\d{2})-(\d{2})-(\d{2})_?(.*)$/)
  let time: string
  let label: string

  if (m) {
    time = `${m[1]}:${m[2]}:${m[3]}`
    label = m[4]
  } else {
    time = uploaded.toTimeString().slice(0, 8)
    label = file
  }

  const { category, name, trim } = clipTitle(label)

  return {
    ...raw,
    source: "bucket",
    day,
    time,
    category,
    name,
    trim,
    title: name,
    trimmed: trim !== null,
  }
}

export function parseYouTubeClip(raw: ApiYouTubeClip): YouTubeClip {
  const recorded = new Date(raw.recordedAt)

  return {
    ...raw,
    privacy: raw.pendingPrivacy === null ? raw.privacy : null,
    source: "youtube",
    key: `youtube/${raw.id}`,
    /* Written like bucket clips' categories, which come from file names, so
     * one game is one category. */
    category: raw.category.replace(/[-_]+/g, " ").trim(),
    day: localDay(recorded),
    time: recorded.toTimeString().slice(0, 8),
  }
}

/* The clip's thumbnail, or null while there's none yet. */
export function thumbnailOf(clip: Clip) {
  if (clip.source === "youtube") return clip.thumbnail

  return clip.thumb ? thumbUrl(clip) : null
}

/* Seconds, after a YouTube clip's cut; 0 while unknown. */
export function durationOf(clip: Clip) {
  if (clip.source === "bucket") return clip.thumb?.duration ?? 0

  if (clip.cut) return clip.cut.end - clip.cut.start

  return clip.durationSeconds ?? 0
}

/* Bytes in your bucket. YouTube clips take none. */
export const sizeOf = (clip: Clip) => (clip.source === "bucket" ? clip.size : 0)

export const bucketBytes = (clips: Clip[]) =>
  clips.reduce((n, c) => n + sizeOf(c), 0)

export const displayTitle = (c: Clip) =>
  c.source === "youtube" && c.pendingTitle
    ? `Pending: ${c.pendingTitle}`
    : c.title

/* "Clip 3 · Counter Strike 2", for toasts and confirmations outside the
 * grid, where the category isn't shown next to the title. */
export const longTitle = (c: Clip) =>
  c.category && !c.title.includes(c.category)
    ? `${displayTitle(c)} · ${c.category}`
    : displayTitle(c)

/* Gives each clip its title. An unnamed clip is numbered within its category
 * and day in recording order, counting every folder, so moving a clip to the
 * trash doesn't renumber the others; a trim shares its source's number. */
export function withTitles(clips: Clip[]) {
  const times = new Map<string, Set<string>>()

  for (const c of clips) {
    if (c.source === "youtube") continue
    const group = `${c.day}/${c.category}`
    times.set(group, (times.get(group) ?? new Set()).add(c.time))
  }

  const numbers = new Map<string, number>()

  for (const [group, set] of times)
    [...set].sort().forEach((t, i) => numbers.set(`${group}/${t}`, i + 1))

  return clips.map((c): Clip => {
    if (c.source === "youtube") return c

    const base =
      c.name || `Clip ${numbers.get(`${c.day}/${c.category}/${c.time}`)}`

    return { ...c, title: c.trim ? `${base} · ${c.trim}` : base }
  })
}

export function localDay(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0")

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function dayLabel(day: string) {
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86_400_000)

  if (day === localDay(today)) return "Today"

  if (day === localDay(yesterday)) return "Yesterday"
  const [y, mo, d] = day.split("-").map(Number)
  const date = new Date(y, mo - 1, d)

  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(y !== today.getFullYear() && { year: "numeric" }),
  })
}

/* How long clips are kept (Settings > Storage). null keeps them forever. */
export type Settings = {
  replaysDays: number | null
  trashDays: number
  /** When OBS last checked in, or null if it never has. */
  obsSeen: string | null
  /** Hosted, own bucket: cleanup waits until you confirm the lengths. */
  paused?: boolean
}

/* Days left before the daily cleanup removes a clip, or null if it stays. */
export function daysLeft(clip: Clip, settings: Settings | undefined) {
  /* Cleanup never touches YouTube. */
  if (clip.source === "youtube") return null

  const ttl =
    clip.folder === "replays"
      ? settings?.replaysDays
      : clip.folder === "trash"
        ? settings?.trashDays
        : null

  if (ttl === null || ttl === undefined) return null
  const age = (Date.now() - new Date(clip.uploaded).getTime()) / 86_400_000

  return Math.max(0, Math.ceil(ttl - age))
}

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`

  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`

  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export function formatDuration(seconds: number) {
  if (!seconds) return ""
  const s = Math.round(seconds)

  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

export function formatTimecode(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60

  return `${m}:${s.toFixed(2).padStart(5, "0")}`
}

const enc = (key: string) => key.split("/").map(encodeURIComponent).join("/")

export const mediaUrl = (key: string) => `/api/media/${enc(key)}`
export const downloadUrl = (key: string) => `/api/media/${enc(key)}?download`

export const thumbUrl = (clip: ApiClip) =>
  `/api/thumb/${enc(clip.key)}?v=${clip.thumb?.v ?? ""}`

/* Thrown when you need to sign in: with the app's password ("password"),
 * with Cloudflare on the hosted app ("cloudflare"), or when a self-hosted
 * app has no password set yet ("none"). */
export type SignInKind = "password" | "cloudflare" | "none"

export class SignInError extends Error {
  readonly kind: SignInKind

  constructor(kind: SignInKind) {
    super("Sign in to see your clips")
    this.kind = kind
  }
}

/* Where Google sign-in starts: signing in to clips, or connecting YouTube to
 * an account. Either asks for every permission clips uses, once. */
export const youtubeConnectUrl = (purpose: "login" | "connect") =>
  `/api/youtube/connect?purpose=${purpose}`

export const youtubeStudioUrl = (videoId: string) =>
  `https://studio.youtube.com/video/${encodeURIComponent(videoId)}/editor`

/* Thrown on the hosted app until you connect a bucket. */
export class NoStorageError extends Error {
  constructor() {
    super("Connect your storage first")
  }
}

/* Who is signed in. A self-hosted app has no accounts. */
export type Me =
  | { hosted: false }
  | {
      hosted?: true
      email: string
      storage: { id: string; bucket: string; auto: boolean } | null
      /** The connected channel. clips may upload, list, rename, change
       * visibility, cut and delete its videos. */
      youtube?: {
        channelId: string
        channelTitle: string
        devices: { id: string; lastSeen: number | null }[]
        clipCount: number
      } | null
    }

/* The account this tab started with (hosted app). If a request answers for
 * another one, someone signed in or out in another tab: start over, so
 * nothing cached for the old account is shown or used. Every change this
 * tab makes names the account, and the server refuses it for another. */
let account: string | null = null

const tabs =
  typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel("clips-account")

/* Another tab signed in, out, or changed storage: start over now. */
if (tabs)
  tabs.onmessage = (e) => {
    if (e.origin !== location.origin) return

    if (account !== null && e.data !== account) location.reload()
  }

/* Tells the other tabs this one's account changed. */
export function announceAccountChange() {
  tabs?.postMessage(null)
}

function checkAccount(res: Response) {
  const now = res.headers.get("x-clips-account")

  if (!now) return

  if (account === null) {
    account = now
    tabs?.postMessage(now)
  }

  if (now !== account) {
    tabs?.postMessage(now)
    location.reload()
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? "GET"
  const headers = new Headers(init?.headers)

  if (account && method !== "GET") headers.set("x-clips-account", account)
  const res = await fetch(url, { ...init, headers })

  checkAccount(res)

  if (!res.ok) {
    const data = await res.json().catch(() => ({}))

    if (
      data.auth === "password" ||
      data.auth === "none" ||
      data.auth === "cloudflare"
    )
      throw new SignInError(data.auth)

    if (data.storage === "none") throw new NoStorageError()

    if (data.account === "changed") {
      location.reload()
      throw new Error(data.error)
    }

    /* The Cloudflare Access session expired: reload so Access signs you in
     * again, but only once, in case the app's Access settings are wrong. */
    if (data.auth === "access" && sessionStorage.getItem("reloaded") === null) {
      sessionStorage.setItem("reloaded", "1")
      location.reload()
    }

    throw new Error(data.error ?? `Request failed (${res.status})`)
  }

  sessionStorage.removeItem("reloaded")

  // SAFETY: every route is served by worker/index.ts, which returns T on success.
  return (await res.json()) as T
}

/* A Worker request body is capped at 100 MB, so edits go up in 50 MB parts,
 * like clips from OBS. The server saves it next to the source clip. */
const PART_SIZE = 50 * 1024 * 1024

async function saveEdit(from: string, body: ArrayBuffer) {
  const { key, uploadId } = await request<{ key: string; uploadId: string }>(
    `/api/upload/start?from=${encodeURIComponent(from)}`,
    { method: "POST" }
  )

  const query = `key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}`
  const offsets = []

  for (let at = 0; at < body.byteLength; at += PART_SIZE) offsets.push(at)

  try {
    const parts = await Promise.all(
      offsets.map(async (at, i) => {
        const { etag } = await request<{ etag: string }>(
          `/api/upload/part?${query}&part=${i + 1}`,
          { method: "PUT", body: body.slice(at, at + PART_SIZE) }
        )

        return { partNumber: i + 1, etag }
      })
    )

    return await request<{ key: string }>(`/api/upload/complete?${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts }),
    })
  } catch (err) {
    void fetch(`/api/upload/abort?${query}`, { method: "POST" })
    throw err
  }
}

export function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

const youtubeClip = (id: string) =>
  `/api/youtube/clips/${encodeURIComponent(id)}`

export const api = {
  /* Bucket clips and YouTube clips, in one list. An app without YouTube
   * leaves youtube out. */
  clips: (previous?: Clip[]) =>
    request<{ clips?: ApiClip[]; youtube?: ApiYouTubeClip[]; errors?:{r2?:string;youtube?:string} }>(
      "/api/clips"
    ).then((d) => ({
      warnings: Object.values(d.errors ?? {}),
      clips: withTitles([
        ...(d.clips?.map(parseClip) ?? (d.errors?.r2 && previous ? previous.filter(c=>c.source === "bucket") : [])),
        ...(d.youtube?.map(parseYouTubeClip) ?? (d.errors?.youtube && previous ? previous.filter(c=>c.source === "youtube") : [])),
      ])
    })),
  updateYouTube: (
    id: string,
    body: { title?: string; description?: string; privacy?: Privacy }
  ) =>
    request<{ ok?: boolean }>(youtubeClip(id), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  cutYouTube: (id: string, cut: Cut | null) =>
    request<{ ok?: boolean }>(`${youtubeClip(id)}/cut`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cut),
    }),
  deleteYouTube: (id: string) =>
    request<{ ok?: boolean }>(youtubeClip(id), { method: "DELETE" }),
  disconnectYouTube: () =>
    request<{ ok?: boolean }>("/api/youtube/disconnect", { method: "POST" }),
  removeDevice: (id: string) => request<{ unpaired: true }>(`/api/youtube/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
  move: (key: string, body: { to?: Folder; name?: string }) =>
    request<{ key: string }>("/api/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, ...body }),
    }),
  destroy: (key: string) =>
    request<{ ok: true }>(`/api/clips/${enc(key)}`, { method: "DELETE" }),
  emptyTrash: (clips: BucketClip[]) =>
    request<{ deleted: number; skipped: number; failed: number }>(
      "/api/trash",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(clips.map(({ key, etag }) => ({ key, etag }))),
      }
    ),
  share: (key: string, days: number | null) =>
    request<{ url: string; key: string }>("/api/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, days }),
    }),
  saveEdit,
  putThumb: (
    key: string,
    blob: Blob,
    meta: { duration: number; width: number; height: number }
  ) =>
    request<{ ok: true }>(`/api/thumb/${enc(key)}`, {
      method: "PUT",
      headers: {
        "content-type": "image/jpeg",
        "x-duration": meta.duration.toFixed(3),
        "x-width": String(meta.width),
        "x-height": String(meta.height),
      },
      body: blob,
    }),
  setup: () => request<{ code: string }>("/api/setup"),
  settings: () => request<Settings>("/api/settings"),
  saveSettings: (body: Partial<Omit<Settings, "obsSeen">>) =>
    request<Omit<Settings, "obsSeen">>("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  me: () => request<Me>("/api/me"),
  connectStorage: (body: {
    s3Url: string
    accessKeyId: string
    secretAccessKey: string
  }) =>
    request<{ ok: true }>("/api/storage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  disconnectStorage: () =>
    request<{ ok: true }>("/api/storage", { method: "DELETE" }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  resetObsToken: () =>
    request<{ code: string }>("/api/obs/token", { method: "POST" }),
  login: (password: string) =>
    request<{ ok: true }>("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }),
}
