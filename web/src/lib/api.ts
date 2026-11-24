import { clipTitle } from "../../worker/clip-title"

export type Folder = "replays" | "saved" | "trash"

/* What GET /api/clips returns (worker/index.ts). */
type ApiClip = {
  key: string
  folder: Folder
  size: number
  uploaded: string
  thumb?: { duration: number; width: number; height: number; v: string }
}

export type Clip = ApiClip & {
  /** YYYY-MM-DD the clip was recorded, from its folder (the PC's local day). */
  day: string
  /** HH:MM:SS, the PC's local time. */
  time: string
  /** Scene name or the name you gave it. */
  title: string
  trimmed: boolean
}

/* replays/2026-11-24/14-35-07_Valorant-Ranked_k3f9x2.mp4 */
export function parseClip(raw: ApiClip): Clip {
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

  const { title, trimmed } = clipTitle(label)

  return { ...raw, day, time, title: title || "Untitled", trimmed }
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
}

/* Days left before the daily cleanup removes a clip, or null if it stays. */
export function daysLeft(clip: Clip, settings: Settings | undefined) {
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

/* Thrown when the app needs a password ("password") or has none set ("none"). */
export class SignInError extends Error {
  readonly setUp: boolean

  constructor(setUp: boolean) {
    super("Sign in to see your clips")
    this.setUp = setUp
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)

  if (!res.ok) {
    const data = await res.json().catch(() => ({}))

    if (data.auth === "password" || data.auth === "none")
      throw new SignInError(data.auth === "password")

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

export const api = {
  clips: () =>
    request<{ clips: ApiClip[] }>("/api/clips").then((d) =>
      d.clips.map(parseClip)
    ),
  move: (key: string, body: { to?: Folder; name?: string }) =>
    request<{ key: string }>("/api/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, ...body }),
    }),
  destroy: (key: string) =>
    request<{ ok: true }>(`/api/clips/${enc(key)}`, { method: "DELETE" }),
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
  login: (password: string) =>
    request<{ ok: true }>("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }),
}
