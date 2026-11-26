import * as React from "react"
import { useIsMutating } from "@tanstack/react-query"

import { durationOf, type Clip } from "@/lib/api"
import { isEditableTarget } from "@/lib/keys"

function readHash() {
  if (!location.hash.startsWith("#/clip/")) return null

  try {
    return decodeURIComponent(location.hash.slice(7))
  } catch {
    return null /* a hand-edited link with a broken escape */
  }
}

/* The dashboard lives under /apps/. Everything else at the top level is a
 * page that opens without signing in: the homepage at /, the FAQ (also at
 * #/faq), the privacy policy and the terms. */
export const APP_PATH = "/apps/"

export type Page = "home" | "faq" | "privacy" | "terms"

function readPage(): Page | null {
  const path = location.pathname.replace(/\/+$/, "")

  if (path === "/faq" || location.hash === "#/faq") return "faq"

  if (path === "/privacy") return "privacy"

  if (path === "/terms") return "terms"

  if (path === "") return "home"

  return null
}

/* Before the move to /apps/, the dashboard was at /: clip links were
 * /#/clip/…, and sign-in came back to /?auth_error=… or /?connected=…
 * Sends those to the dashboard, keeping the rest of the address. */
export function redirectOldDashboardUrl() {
  if (location.pathname !== "/") return false
  const params = new URLSearchParams(location.search)

  const old =
    location.hash.startsWith("#/clip/") ||
    params.has("auth_error") ||
    params.has("connected")

  if (old) location.replace(APP_PATH + location.search + location.hash)

  return old
}

/* The page this address shows instead of the library, or null. */
export function usePage() {
  const [page, setPage] = React.useState(readPage)

  React.useEffect(() => {
    const onChange = () => setPage(readPage())

    window.addEventListener("hashchange", onChange)

    return () => window.removeEventListener("hashchange", onChange)
  }, [])

  return page
}

/* The open clip lives in the URL hash, so Back closes it and links work. */
export function useOpenClip() {
  const [key, setKey] = React.useState(readHash)
  /* Whether we added the history entry, so closing can go back instead. */
  const pushed = React.useRef(false)

  React.useEffect(() => {
    const onPop = () => {
      pushed.current = false
      setKey(readHash())
    }

    window.addEventListener("popstate", onPop)

    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const open = React.useCallback((next: string | null, replace = false) => {
    if (next) {
      const hash = `#/clip/${encodeURIComponent(next)}`

      if (location.hash.startsWith("#/clip/"))
        history.replaceState(null, "", hash)
      else {
        history.pushState(null, "", hash)
        pushed.current = true
      }
    } else if (pushed.current && !replace) {
      pushed.current = false
      history.back()
    } else {
      history.replaceState(null, "", location.pathname)
    }

    setKey(next)
  }, [])

  return [key, open] as const
}

/* Newest first. */
export const byNewest = (a: Clip, b: Clip) =>
  (b.day + b.time).localeCompare(a.day + a.time)

export type Sort = "newest" | "oldest" | "longest" | "name"

export const SORTS: { value: Sort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "longest", label: "Longest first" },
  { value: "name", label: "Name" },
]

const COMPARE: Record<Sort, (a: Clip, b: Clip) => number> = {
  newest: byNewest,
  oldest: (a, b) => byNewest(b, a),
  longest: (a, b) => durationOf(b) - durationOf(a) || byNewest(a, b),
  name: (a, b) =>
    a.title.localeCompare(b.title, undefined, { numeric: true }) ||
    a.category.localeCompare(b.category) ||
    byNewest(a, b),
}

/* Sorting by time keeps the grid's day headings; other orders are one list. */
export const sortsByDay = (sort: Sort) => sort === "newest" || sort === "oldest"

const SORT_KEY = "clips:sort"

const isSort = (v: string | null): v is Sort => SORTS.some((s) => s.value === v)

/* The chosen order, remembered in this browser. */
export function useSort() {
  const [sort, setSort] = React.useState<Sort>(() => {
    const saved = localStorage.getItem(SORT_KEY)

    return isSort(saved) ? saved : "newest"
  })

  const choose = React.useCallback((next: Sort) => {
    localStorage.setItem(SORT_KEY, next)
    setSort(next)
  }, [])

  return [sort, choose] as const
}

/* The clips in the current tab, in one category when category isn't null,
 * in the chosen order. */
export function useVisibleClips(
  clips: Clip[] | undefined,
  sort: Sort,
  category: string | null
) {
  return React.useMemo(
    () =>
      (clips ?? [])
        .filter((c) => category === null || c.category === category)
        .sort(COMPARE[sort]),
    [clips, sort, category]
  )
}

/* The categories in the current tab with their clip counts, most clips
 * first. */
export function useCategories(clips: Clip[] | undefined) {
  return React.useMemo(() => {
    const counts = new Map<string, number>()

    for (const c of clips ?? [])
      counts.set(c.category, (counts.get(c.category) ?? 0) + 1)

    return [...counts]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }, [clips])
}

export function useOpenClipSync(clips: Clip[] | undefined) {
  const [openKey, openClip] = useOpenClip()
  const moving = useIsMutating() > 0
  const clip = clips?.find((c) => c.key === openKey) ?? null
  React.useEffect(() => {
    if (openKey && clips && !clip && !moving) openClip(null, true)
  }, [openKey, clips, clip, openClip, moving])

  return { clip, openClip }
}

/* Search shortcuts are off while a clip or dialog is open. */
export function useGlobalKeys(enabled: boolean, onSearch: () => void) {
  React.useEffect(() => {
    if (!enabled) return

    const onKey = (e: KeyboardEvent) => {
      const commandK = e.key === "k" && (e.metaKey || e.ctrlKey)

      if (commandK || (e.key === "/" && !isEditableTarget(e.target))) {
        e.preventDefault()
        onSearch()

        return
      }
    }

    window.addEventListener("keydown", onKey)

    return () => window.removeEventListener("keydown", onKey)
  }, [enabled, onSearch])
}
