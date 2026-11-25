import * as React from "react"
import { GlobeIcon, LinkIcon, LockIcon } from "@phosphor-icons/react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  formatDuration,
  NeedsManageError,
  youtubeConnectUrl,
  type Clip,
  type Cut,
  type Privacy,
  type YouTubeClip,
} from "@/lib/api"
import { copyLink } from "@/lib/clip-actions"

const KEY = ["clips"]

export const PRIVACY_OPTIONS = [
  {
    value: "private",
    label: "Private",
    hint: "Only you can watch it",
    icon: LockIcon,
  },
  {
    value: "unlisted",
    label: "Unlisted",
    hint: "Anyone with the link can watch it",
    icon: LinkIcon,
  },
  {
    value: "public",
    label: "Public",
    hint: "Anyone can find and watch it",
    icon: GlobeIcon,
  },
] satisfies {
  value: Privacy
  label: string
  hint: string
  icon: React.ElementType
}[]

export const privacyOption = (privacy: Privacy) =>
  PRIVACY_OPTIONS.find((p) => p.value === privacy) ?? PRIVACY_OPTIONS[1]

/* One change to a clip on YouTube. */
export type YouTubeChange =
  | { kind: "title"; title: string }
  | { kind: "privacy"; privacy: Privacy }
  | { kind: "cut"; cut: Cut | null }
  | { kind: "delete" }

function send(clip: YouTubeClip, change: YouTubeChange) {
  switch (change.kind) {
    case "title":
      return api.updateYouTube(clip.id, { title: change.title })
    case "privacy":
      return api.updateYouTube(clip.id, { privacy: change.privacy })
    case "cut":
      return api.cutYouTube(clip.id, change.cut)
    case "delete":
      return api.deleteYouTube(clip.id)
  }
}

/* The clip after the change, or null once it's deleted. */
function changed(clip: YouTubeClip, change: YouTubeChange) {
  switch (change.kind) {
    case "title":
      return { ...clip, title: change.title }
    case "privacy":
      return { ...clip, privacy: change.privacy }
    case "cut":
      return { ...clip, cut: change.cut }
    case "delete":
      return null
  }
}

function doneText(change: YouTubeChange) {
  switch (change.kind) {
    case "title":
      return "Renamed on YouTube"
    case "privacy":
      return `${privacyOption(change.privacy).label} on YouTube`
    case "cut":
      return change.cut ? "Cut saved" : "Cut removed"
    case "delete":
      return "Deleted from YouTube"
  }
}

/* A change that needs permission to edit your videos. It's kept in this tab
 * while Google asks, then made when you're back. */
type Pending = { id: string; key: string; change: YouTubeChange }

const PENDING_KEY = "clips:youtube-change"
let asking: Pending | null = null
const listeners = new Set<() => void>()

function setAsking(next: Pending | null) {
  asking = next
  listeners.forEach((l) => l())
}

function subscribe(onChange: () => void) {
  listeners.add(onChange)

  return () => listeners.delete(onChange)
}

/* The change waiting for you to allow editing, for the dialog that asks. */
export function useManageRequest() {
  const pending = React.useSyncExternalStore(subscribe, () => asking)

  const allow = () => {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(asking))
    location.assign(youtubeConnectUrl("manage"))
  }

  return { pending, allow, cancel: () => setAsking(null) }
}

/* Renames, changes visibility, cuts or deletes a YouTube clip, updating the
 * list right away. The first time, YouTube answers that clips needs more
 * permission: ask for it, unless this is already the retry. */
export function useYouTubeChange() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: ({
      clip,
      change,
    }: {
      clip: YouTubeClip
      change: YouTubeChange
      retry?: boolean
    }) => send(clip, change),
    onMutate: async ({ clip, change }) => {
      await qc.cancelQueries({ queryKey: KEY })
      const previous = qc.getQueryData<Clip[]>(KEY)
      const next = changed(clip, change)

      qc.setQueryData<Clip[]>(KEY, (list) =>
        next
          ? list?.map((c) => (c.key === clip.key ? next : c))
          : list?.filter((c) => c.key !== clip.key)
      )

      return { previous }
    },
    onError: (err, { clip, change, retry }, ctx) => {
      if (ctx?.previous) qc.setQueryData(KEY, ctx.previous)

      if (err instanceof NeedsManageError && !retry)
        setAsking({ id: clip.id, key: clip.key, change })
      else toast.error(err.message)
    },
    onSuccess: (_data, { change }) => toast.success(doneText(change)),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

/* The change saved before Google's permission page, unless you said no
 * there (the app comes back with ?auth_error=…). */
function takePending(): Pending | null {
  const saved = sessionStorage.getItem(PENDING_KEY)

  sessionStorage.removeItem(PENDING_KEY)

  if (!saved || new URLSearchParams(location.search).has("auth_error"))
    return null

  try {
    // SAFETY: this tab wrote it from a Pending just before the redirect.
    return JSON.parse(saved) as Pending
  } catch {
    return null
  }
}

/* Back from Google: reopens the clip the change was for, before the app
 * reads the address, */
const resuming = takePending()

if (resuming && resuming.change.kind !== "delete")
  history.replaceState(
    null,
    "",
    `${location.pathname}${location.search}#/clip/${encodeURIComponent(resuming.key)}`
  )

/* then makes the change once the clips have loaded. */
export function useResumeYouTubeChange(clips: Clip[] | undefined) {
  const done = React.useRef(false)
  const { mutate } = useYouTubeChange()

  React.useEffect(() => {
    if (!resuming || !clips || done.current) return
    done.current = true

    const clip = clips.find(
      (c): c is YouTubeClip => c.source === "youtube" && c.key === resuming.key
    )

    if (clip) mutate({ clip, change: resuming.change, retry: true })
  }, [clips, mutate])
}

/* The link a YouTube clip shares: from its cut's start, since a link can't
 * end early. */
export function youtubeLink(clip: YouTubeClip) {
  return clip.cut ? `${clip.url}?t=${clip.cut.start}` : clip.url
}

export function copyYouTubeLink(clip: YouTubeClip) {
  const notes = []

  if (clip.cut)
    notes.push(
      `Starts at ${formatDuration(clip.cut.start) || "0:00"}; YouTube plays the rest too.`
    )

  if (clip.privacy === "private")
    notes.push("It's private: only you can watch it.")

  return copyLink(youtubeLink(clip), notes.join(" ") || undefined)
}
