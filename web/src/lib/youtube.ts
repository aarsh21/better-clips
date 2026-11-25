import type * as React from "react"
import { GlobeIcon, LinkIcon, LockIcon } from "@phosphor-icons/react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  formatDuration,
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

/* Renames, changes visibility, cuts or deletes a YouTube clip, updating the
 * list right away. */
export function useYouTubeChange() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: ({
      clip,
      change,
    }: {
      clip: YouTubeClip
      change: YouTubeChange
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
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(KEY, ctx.previous)
      toast.error(err.message)
    },
    onSuccess: (_data, { change }) => toast.success(doneText(change)),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  })
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
