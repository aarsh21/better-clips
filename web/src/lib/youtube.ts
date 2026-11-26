import type * as React from "react"
import { ClockIcon, GlobeIcon, LinkIcon, LockIcon } from "@phosphor-icons/react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Privacy, type YouTubeClip } from "@/lib/api"
import { copyLink } from "@/lib/clip-actions"
import { updateClips } from "@/lib/clips"

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

export const privacyOption = (privacy: Privacy | null) =>
  PRIVACY_OPTIONS.find((p) => p.value === privacy) ?? {
    label: "Visibility pending",
    icon: ClockIcon,
  }

/* One change to a clip on YouTube. */
export type YouTubeChange =
  | { kind: "title"; title: string }
  | { kind: "privacy"; privacy: Privacy }
  | { kind: "delete" }

function send(clip: YouTubeClip, change: YouTubeChange) {
  switch (change.kind) {
    case "title":
      return api.updateYouTube(clip.id, { title: change.title })
    case "privacy":
      return api.updateYouTube(clip.id, { privacy: change.privacy })
    case "delete":
      return api.deleteYouTube(clip.id)
  }
}

/* The clip after the change, or null once it's deleted. */
function changed(clip: YouTubeClip, change: YouTubeChange) {
  switch (change.kind) {
    case "title":
      return { ...clip, title: change.title, pendingTitle: change.title }
    case "privacy":
      return { ...clip, privacy: null, pendingPrivacy: change.privacy }
    case "delete":
      return null
  }
}

function doneText(change: YouTubeChange) {
  switch (change.kind) {
    case "title":
      return "Title change submitted"
    case "privacy":
      return "Visibility change submitted"
    case "delete":
      return "Deleted from YouTube"
  }
}

/* Renames, changes visibility or deletes a YouTube clip, updating the
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
      const next = changed(clip, change)

      updateClips(qc, (list) =>
        next
          ? list?.map((c) => (c.key === clip.key ? next : c))
          : list?.filter((c) => c.key !== clip.key)
      )
    },
    onError: (err, { clip, change }) => {
      updateClips(qc, (list) =>
        change.kind === "delete" && !list.some((c) => c.key === clip.key)
          ? [...list, clip]
          : list.map((c) => (c.key === clip.key ? clip : c))
      )
      toast.error(err.message)
    },
    onSuccess: (_data, { change }) => toast.success(doneText(change)),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function copyYouTubeLink(clip: YouTubeClip) {
  const notes = []

  if (clip.privacy === "private")
    notes.push("It's private: only you can watch it.")
  else if (clip.privacy === null)
    notes.push("YouTube visibility isn't confirmed yet.")

  return copyLink(clip.url, notes.join(" ") || undefined)
}
