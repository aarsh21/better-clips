import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Settings } from "@/lib/api"

const KEY = ["settings"]

/* Who is signed in, on the hosted app. */
export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: api.me })
}

/* The hosted app's account, or null when self-hosted or still loading. */
export function useAccount() {
  const { data: me } = useMe()

  return me && "email" in me ? me : null
}

/* A self-hosted app always has its bucket; a hosted account may only use
 * YouTube. Assumes a bucket until the account loads. */
export function useHasBucket() {
  const account = useAccount()

  return account === null || account.storage !== null
}

/* Whether a YouTube channel is connected (hosted app). */
export function useHasChannel() {
  return Boolean(useAccount()?.youtube)
}

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
