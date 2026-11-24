import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, errorMessage, type Clip } from "@/lib/api"
import { useMoveClip } from "@/lib/clips"

export type ClipNav = {
  onClose: () => void
  onNavigate: (clip: Clip, step: number) => void
  onMoved: (from: string, to: string) => void
  hasPrev: boolean
  hasNext: boolean
}

export type ClipActions = ReturnType<typeof useClipActions>

/* Everything you can do to the open clip. Actions that remove it from the
 * current view step to a neighbour first, so the viewer never follows a clip
 * into the trash. */
export function useClipActions(
  clip: Clip,
  nav: ClipNav,
  askDelete: () => void
) {
  const qc = useQueryClient()
  const move = useMoveClip(nav.onMoved)

  /* mutateAsync, unlike mutate's callbacks, still resolves after the viewer
   * has moved on to another clip. It resolves to null on failure, which the
   * mutation has already shown as an error toast. */
  const moved = (vars: Parameters<typeof move.mutateAsync>[0]) =>
    move.mutateAsync(vars).catch(() => null)

  const leave = () => {
    if (nav.hasNext) nav.onNavigate(clip, 1)
    else if (nav.hasPrev) nav.onNavigate(clip, -1)
    else nav.onClose()
  }

  const keep = () => {
    const kept = clip.folder === "saved"

    void moved({ clip, to: kept ? "replays" : "saved" }).then(
      (done) =>
        done &&
        toast(kept ? "No longer kept" : "Kept forever", {
          description: kept ? "It will be cleared in 30 days." : undefined,
        })
    )
  }

  const trash = () => {
    if (clip.folder === "trash") return askDelete()

    const from = clip.folder

    leave()
    void moved({ clip, to: "trash" }).then(
      (done) =>
        done &&
        toast("Moved to trash", {
          description: clip.title,
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

  const restore = () => {
    leave()
    void moved({ clip, to: "replays" }).then(
      (done) => done && toast("Restored")
    )
  }

  const rename = (name: string) => {
    if (name.trim() === clip.title) return

    void moved({ clip, name }).then((done) => done && toast("Renamed"))
  }

  const destroy = async () => {
    leave()

    try {
      await api.destroy(clip.key)
      qc.setQueryData<Clip[]>(["clips"], (list) =>
        list?.filter((c) => c.key !== clip.key)
      )
      toast("Deleted forever")
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  const share = async (days: number | null) => {
    const pending = toast.loading("Creating link…")

    try {
      const { url, key } = await api.share(clip.key, days)

      /* Sharing keeps the clip, which moves it: update the list before the
       * viewer follows, so it doesn't close on a clip it can't find. */
      if (key !== clip.key) {
        qc.setQueryData<Clip[]>(["clips"], (list) =>
          list?.map((c) =>
            c.key === clip.key ? { ...c, key, folder: "saved" } : c
          )
        )
        nav.onMoved(clip.key, key)
      }

      await qc.invalidateQueries({ queryKey: ["clips"] })
      await copyLink(url, days, pending)
    } catch (err) {
      toast.error(errorMessage(err), { id: pending })
    }
  }

  return { keep, trash, restore, rename, destroy, share }
}

async function copyLink(url: string, days: number | null, id: string | number) {
  const description = days
    ? `Works for ${days} ${days === 1 ? "day" : "days"}.`
    : "Never expires."

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
