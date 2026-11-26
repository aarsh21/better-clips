import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  errorMessage,
  longTitle,
  type BucketClip,
  type Clip,
} from "@/lib/api"
import { useMoveClip, updateClips } from "@/lib/clips"
import { retentionText, useSettings } from "@/lib/settings"

export type ClipNav = {
  onClose: () => void
  onNavigate: (clip: Clip, step: number) => void
  onMoved: (from: string, to: string) => void
  hasPrev: boolean
  hasNext: boolean
}

export type ClipActions = ReturnType<typeof useClipActions>

export type ClipMoves = ReturnType<typeof useClipMoves>

/* Keep, trash, restore and share for any clip, with a toast for each. Used
 * by the grid's card buttons and by the viewer. */
export function useClipMoves(onMoved?: (from: string, to: string) => void) {
  const qc = useQueryClient()
  const move = useMoveClip(onMoved)
  const { data: settings } = useSettings()

  /* mutateAsync, unlike mutate's callbacks, still resolves after the viewer
   * has moved on to another clip. It resolves to null on failure, which the
   * mutation has already shown as an error toast. */
  const moved = (vars: Parameters<typeof move.mutateAsync>[0]) =>
    move.mutateAsync(vars).catch(() => null)

  const keep = (clip: BucketClip) => {
    const kept = clip.folder === "saved"

    void moved({ clip, to: kept ? "replays" : "saved" }).then(
      (done) =>
        done &&
        toast(kept ? "No longer kept" : "Kept forever", {
          description:
            kept && settings?.replaysDays
              ? `It will be cleared after ${retentionText(settings.replaysDays)}.`
              : undefined,
        })
    )
  }

  const trash = (clip: BucketClip) => {
    const from = clip.folder

    void moved({ clip, to: "trash" }).then(
      (done) =>
        done &&
        toast("Moved to trash", {
          description: longTitle(clip),
          action: {
            label: "Undo",
            onClick: () =>
              void moved({
                clip: { ...clip, key: done.key, folder: "trash" },
                to: from,
              }),
          },
        })
    )
  }

  const restore = (clip: BucketClip) => {
    void moved({ clip, to: "replays" }).then(
      (done) => done && toast("Restored")
    )
  }

  const rename = (clip: BucketClip, name: string) => {
    void moved({ clip, name }).then((done) => done && toast("Renamed"))
  }

  const share = async (clip: BucketClip, days: number | null) => {
    const pending = toast.loading("Creating link…")

    try {
      const { url, key } = await api.share(clip.key, days)

      /* Sharing keeps the clip, which moves it: update the list before the
       * viewer follows, so it doesn't close on a clip it can't find. */
      if (key !== clip.key) {
        updateClips(qc, (list) =>
          list?.map((c) =>
            c.key === clip.key && c.source === "bucket"
              ? { ...c, key, folder: "saved" }
              : c
          )
        )
        onMoved?.(clip.key, key)
      }

      await qc.invalidateQueries({ queryKey: ["clips"] })
      await copyLink(
        url,
        days
          ? `Works for ${days} ${days === 1 ? "day" : "days"}.`
          : "Never expires.",
        pending
      )
    } catch (err) {
      void qc.invalidateQueries({queryKey:["clips"]})
      toast.error(errorMessage(err), { id: pending })
    }
  }

  return { keep, trash, restore, rename, share }
}

/* Everything you can do to the open clip. Actions that remove it from the
 * current view step to a neighbour first, so the viewer never follows a clip
 * into the trash. */
export function useClipActions(
  clip: BucketClip,
  nav: ClipNav,
  askDelete: () => void
) {
  const qc = useQueryClient()
  const moves = useClipMoves(nav.onMoved)

  const leave = () => {
    if (nav.hasNext) nav.onNavigate(clip, 1)
    else if (nav.hasPrev) nav.onNavigate(clip, -1)
    else nav.onClose()
  }

  const keep = () => moves.keep(clip)

  const trash = () => {
    if (clip.folder === "trash") return askDelete()

    leave()
    moves.trash(clip)
  }

  const restore = () => {
    leave()
    moves.restore(clip)
  }

  const rename = (name: string) => {
    if (name.trim() !== clip.name) moves.rename(clip, name)
  }

  const destroy = async () => {
    leave()

    try {
      await api.destroy(clip.key)
      updateClips(qc, (list) =>
        list?.filter((c) => c.key !== clip.key)
      )
      toast("Deleted forever")
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  const share = (days: number | null) => moves.share(clip, days)

  return { keep, trash, restore, rename, destroy, share }
}

/* Copies a link and says so; id replaces a loading toast. */
export async function copyLink(
  url: string,
  description?: string,
  id?: string | number
) {
  try {
    await navigator.clipboard.writeText(url)
    toast.success("Link copied", { id, description })
  } catch {
    /* The clipboard needs a recent click; offer a button instead. */
    toast.success("Link ready", {
      id,
      description: url,
      action: {
        label: "Copy",
        onClick: () => void navigator.clipboard.writeText(url),
      },
    })
  }
}
