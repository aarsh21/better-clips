import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { useClipTime } from "@/lib/clock"
import {
  api,
  longTitle,
  mediaUrl,
  withTitles,
  type BucketClip,
  type Clip,
  type Folder,
} from "@/lib/api"

const KEY = ["clips"]

export function useClips() {
  return useQuery({
    queryKey: KEY,
    queryFn: api.clips,
    /* New clips from OBS show up on their own. */
    refetchInterval: (query) =>
      query.state.data?.some(
        (c) =>
          c.source === "youtube" &&
          (c.status === "processing" || c.pendingTitle || c.pendingPrivacy)
      )
        ? 5_000
        : 30_000,
    refetchIntervalInBackground: false,
    staleTime: 5_000,
  })
}

/* Moves a clip (keep, delete, restore, rename) and updates the list right
 * away; the server's answer then fixes up the key. */
export function useMoveClip(onMoved?: (from: string, to: string) => void) {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: ({
      clip,
      to,
      name,
    }: {
      clip: BucketClip
      to?: Folder
      name?: string
    }) => api.move(clip.key, { to, name }),
    onMutate: async ({ clip, to, name }) => {
      await qc.cancelQueries({ queryKey: KEY })
      const previous = qc.getQueryData<Clip[]>(KEY)
      qc.setQueryData<Clip[]>(
        KEY,
        (clips) =>
          clips &&
          withTitles(
            clips.map((c) =>
              c.key === clip.key && c.source === "bucket"
                ? {
                    ...c,
                    folder: to ?? c.folder,
                    name: name === undefined ? c.name : name.trim(),
                  }
                : c
            )
          )
      )

      return { previous }
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(KEY, ctx.previous)
      toast.error(err.message)
    },
    onSuccess: ({ key }, { clip }) => {
      onMoved?.(clip.key, key)
      qc.setQueryData<Clip[]>(KEY, (clips) =>
        clips?.map((c) => (c.key === clip.key ? { ...c, key } : c))
      )
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

/* Clips from OBS arrive without a thumbnail. The first time the app sees one,
 * it decodes a frame in the browser and stores the thumbnail in the bucket, so
 * this happens once per clip. Two at a time, newest first. */
export function useThumbnailWorker(clips: Clip[] | undefined) {
  const qc = useQueryClient()
  const startedRef = React.useRef(new Set<string>())

  React.useEffect(() => {
    const started = startedRef.current

    const todo = (clips ?? []).filter(
      (c): c is BucketClip =>
        c.source === "bucket" && !c.thumb && !started.has(c.key)
    )

    if (!todo.length || typeof VideoDecoder === "undefined") return
    todo.forEach((c) => started.add(c.key))

    let cancelled = false
    const queue = [...todo]

    const work = async () => {
      const { makeThumbnail } = await import("@/lib/media")

      for (let clip = queue.shift(); clip && !cancelled; clip = queue.shift()) {
        try {
          const t = await makeThumbnail(mediaUrl(clip.key))
          await api.putThumb(clip.key, t.blob, t)

          const thumb = {
            duration: t.duration,
            width: t.width,
            height: t.height,
            v: Math.random().toString(36).slice(2, 8),
          }

          qc.setQueryData<Clip[]>(KEY, (list) =>
            list?.map((c) =>
              c.key === clip.key && c.source === "bucket" ? { ...c, thumb } : c
            )
          )
        } catch (err) {
          console.warn("Thumbnail failed for", clip.key, err)
        }
      }
    }

    void Promise.all([work(), work()])

    return () => {
      cancelled = true
      queue.forEach((c) => started.delete(c.key))
    }
  }, [clips, qc])
}

/* A clip OBS just saved: not one you trimmed or moved here. */
const fromObs = (c: Clip) =>
  c.source === "youtube" || (c.folder === "replays" && !c.trimmed)

/* Tells you when a new clip lands while the app is open. */
export function useNewClipToasts(
  clips: Clip[] | undefined,
  open: (key: string) => void
) {
  const seen = React.useRef<Set<string> | null>(null)
  const clipTime = useClipTime()

  React.useEffect(() => {
    if (!clips) return

    if (seen.current) {
      const fresh = clips.filter((c) => fromObs(c) && !seen.current!.has(c.key))

      for (const clip of fresh.slice(0, 3)) {
        toast(`New clip · ${longTitle(clip)}`, {
          description: clipTime(clip.time),
          action: { label: "Watch", onClick: () => open(clip.key) },
        })
      }
    }

    seen.current = new Set(clips.map((c) => c.key))
  }, [clips, open, clipTime])
}
