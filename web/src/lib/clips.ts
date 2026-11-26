import * as React from "react"
import { useQuery, type QueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { api, longTitle, type Clip } from "@/lib/api"
import { useClipTime } from "@/lib/clock"

const KEY = ["clips"]

type Library = Awaited<ReturnType<typeof api.clips>>

export function updateClips(qc: QueryClient, edit: (clips: Clip[]) => Clip[]) {
  qc.setQueryData<Library>(
    KEY,
    (data) => data && { ...data, clips: edit(data.clips) }
  )
}

export function useClips() {
  const query = useQuery({
    queryKey: KEY,
    queryFn: api.clips,
    /* New clips from OBS show up on their own. */
    refetchInterval: (query) =>
      query.state.data?.clips.some(
        (c) => c.status === "processing" || c.pendingTitle || c.pendingPrivacy
      )
        ? 5_000
        : 30_000,
    refetchIntervalInBackground: false,
    staleTime: 5_000,
  })

  const warnings = query.data?.warnings.join(" ")

  const error =
    query.error ??
    (!query.data?.clips.length && warnings ? new Error(warnings) : null)

  const notice =
    query.data?.clips.length && (query.error || warnings)
      ? `${query.error ? "Could not refresh the library." : warnings} Showing the last available clips.`
      : null

  return {
    data: query.data?.clips,
    returning: query.data?.returning,
    notice,
    isPending: query.isPending,
    error,
  }
}

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
      const fresh = clips.filter((c) => !seen.current!.has(c.key))

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
