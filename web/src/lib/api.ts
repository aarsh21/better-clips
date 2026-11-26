export type Privacy = "private" | "unlisted" | "public"

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
  /** Google's classification, never the uploader's declaration. */
  madeForKids: boolean | null
  pendingTitle: string | null
  recordedAt: string
  uploaded: string
  durationSeconds: number | null
  thumbnail: string | null
  status: "uploading" | "processing" | "ready" | "failed" | "missing"
  /** https://youtu.be/<videoId> */
  url: string
}

export type YouTubeClip = Omit<ApiYouTubeClip, "privacy"> & {
  /** Null until a read confirms the visibility; never use the requested value as a badge. */
  privacy: Privacy | null
  key: string
  /** The day and time it was recorded, in this browser's time zone. */
  day: string
  time: string
}

export type Clip = YouTubeClip

export function parseYouTubeClip(raw: ApiYouTubeClip): YouTubeClip {
  const recorded = new Date(raw.recordedAt)

  return {
    ...raw,
    privacy: raw.pendingPrivacy === null ? raw.privacy : null,
    key: `youtube/${raw.id}`,
    category: raw.category.replace(/[-_]+/g, " ").trim(),
    day: localDay(recorded),
    time: recorded.toTimeString().slice(0, 8),
  }
}

export const durationOf = (clip: Clip) => clip.durationSeconds ?? 0

export const displayTitle = (c: Clip) =>
  c.pendingTitle ? `Pending: ${c.pendingTitle}` : c.title

/* "Clip 3 · Counter Strike 2", for toasts and confirmations outside the
 * grid, where the category isn't shown next to the title. */
export const longTitle = (c: Clip) =>
  c.category && !c.title.includes(c.category)
    ? `${displayTitle(c)} · ${c.category}`
    : displayTitle(c)

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

export function formatDuration(seconds: number) {
  if (!seconds) return ""
  const s = Math.round(seconds)

  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

export class SignInError extends Error {}

/* Where Google sign-in starts: signing in to clips, or connecting YouTube to
 * an account. Either asks for every permission clips uses, once. */
export const youtubeConnectUrl = (purpose: "login" | "connect") =>
  `/api/youtube/connect?purpose=${purpose}`

export const youtubeStudioUrl = (videoId: string) =>
  `https://studio.youtube.com/video/${encodeURIComponent(videoId)}/edit`

export type Me = {
  email: string
  youtube: {
    channelId: string
    channelTitle: string
    defaultMadeForKids: boolean
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

/* Another tab signed in or out: start over now. */
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

    if (data.auth === "google")
      throw new SignInError("Sign in to see your clips")

    if (data.account === "changed") {
      location.reload()
      throw new Error(data.error)
    }

    throw new Error(data.error ?? `Request failed (${res.status})`)
  }

  // SAFETY: every route is served by worker/index.ts, which returns T on success.
  return (await res.json()) as T
}

const youtubeClip = (id: string) =>
  `/api/youtube/clips/${encodeURIComponent(id)}`

export const api = {
  clips: () =>
    request<{
      youtube: ApiYouTubeClip[]
      returning: boolean
      errors?: { youtube: string }
    }>("/api/clips").then((d) => ({
      clips: d.youtube.map(parseYouTubeClip),
      returning: d.returning,
      warnings: Object.values(d.errors ?? {}),
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
  deleteYouTube: (id: string) =>
    request<{ ok?: boolean }>(youtubeClip(id), { method: "DELETE" }),
  setYouTubeAudience: (madeForKids: boolean) =>
    request<{ ok: true }>("/api/youtube/audience", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ madeForKids }),
    }),
  disconnectYouTube: () =>
    request<{ ok?: boolean }>("/api/youtube/disconnect", { method: "POST" }),
  removeDevice: (id: string) =>
    request<{ unpaired: true }>(
      `/api/youtube/devices/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    ),
  me: () => request<Me>("/api/me"),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
}
