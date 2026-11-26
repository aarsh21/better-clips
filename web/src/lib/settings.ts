import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"

/* Who is signed in, on the hosted app. */
export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: api.me })
}

/* The hosted app's account, or null when self-hosted or still loading. */
export function useAccount() {
  const { data: me } = useMe()

  return me ?? null
}
