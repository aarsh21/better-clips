import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Settings } from "@/lib/api"

const KEY = ["settings"]

/* Polls while waiting for OBS, so the app notices Test Upload right away. */
export function useSettings(waitForObs = false) {
  return useQuery({
    queryKey: KEY,
    queryFn: api.settings,
    staleTime: 60_000,
    refetchInterval: (query) =>
      waitForObs && !query.state.data?.obsSeen ? 3000 : false,
  })
}

export function useSaveSettings() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: api.saveSettings,
    onMutate: async (change) => {
      await qc.cancelQueries({ queryKey: KEY })
      const previous = qc.getQueryData<Settings>(KEY)
      qc.setQueryData<Settings>(KEY, (s) => s && { ...s, ...change })

      return { previous }
    },
    onError: (err, _change, ctx) => {
      if (ctx?.previous) qc.setQueryData(KEY, ctx.previous)
      toast.error(err.message)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

/* "30 days", or "never" for null. */
export function retentionText(days: number | null) {
  if (days === null) return "never"

  return `${days} ${days === 1 ? "day" : "days"}`
}
