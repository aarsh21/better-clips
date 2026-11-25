import * as React from "react"
import { useIsMutating } from "@tanstack/react-query"

import { durationOf, sizeOf, type Clip } from "@/lib/api"
import { isEditableTarget } from "@/lib/keys"

/* "All" holds everything not in the trash, so keeping a clip doesn't move it
 * out from under you. YouTube clips are only in "All": they're never cleaned
 * up, and deleting one is for good. */
export type View = "all" | "saved" | "trash"

export const VIEWS: View[] = ["all", "saved", "trash"]

/* Without a bucket, there's nothing to keep or trash. */
export const viewsFor = (hasBucket: boolean): View[] =>
  hasBucket ? VIEWS : ["all"]

export const inView = (c: Clip, v: View) => {
  if (c.source === "youtube") return v === "all"

  return v === "all" ? c.folder !== "trash" : c.folder === v
}

const inTrash = (c: Clip) => c.source === "bucket" && c.folder === "trash"

function readHash() {
  if (!location.hash.startsWith("#/clip/")) return null

  try {
    return decodeURIComponent(location.hash.slice(7))
  } catch {
    return null /* a hand-edited link with a broken escape */
  }
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

export type Sort = "newest" | "oldest" | "longest" | "largest" | "name"

export const SORTS: { value: Sort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "longest", label: "Longest first" },
  { value: "largest", label: "Largest first" },
  { value: "name", label: "Name" },
]

const COMPARE: Record<Sort, (a: Clip, b: Clip) => number> = {
  newest: byNewest,
  oldest: (a, b) => byNewest(b, a),
  longest: (a, b) => durationOf(b) - durationOf(a) || byNewest(a, b),
  largest: (a, b) => sizeOf(b) - sizeOf(a) || byNewest(a, b),
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
  view: View,
  sort: Sort,
  category: string | null
) {
  return React.useMemo(
    () =>
      (clips ?? [])
        .filter(
          (c) =>
            inView(c, view) && (category === null || c.category === category)
        )
        .sort(COMPARE[sort]),
    [clips, view, sort, category]
  )
}

/* The categories in the current tab with their clip counts, most clips
 * first. */
export function useCategories(clips: Clip[] | undefined, view: View) {
  return React.useMemo(() => {
    const counts = new Map<string, number>()

    for (const c of clips ?? [])
      if (inView(c, view))
        counts.set(c.category, (counts.get(c.category) ?? 0) + 1)

    return [...counts]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }, [clips, view])
}

export function useViewCounts(clips: Clip[] | undefined) {
  return React.useMemo(() => {
    const counts = { all: 0, saved: 0, trash: 0 }

    for (const c of clips ?? [])
      for (const v of VIEWS) if (inView(c, v)) counts[v]++

    return counts
  }, [clips])
}

/* Ties the open clip to the list: closes it when it disappears, switches to
 * the tab it lives in, and follows it when a move gives it a new key. */
export function useOpenClipSync(
  clips: Clip[] | undefined,
  view: View,
  setView: (view: View) => void
) {
  const [openKey, openClip] = useOpenClip()
  const moving = useIsMutating() > 0
  const clip = clips?.find((c) => c.key === openKey) ?? null
  const [shownKey, setShownKey] = React.useState<string | null>(null)

  if (clip && openKey !== shownKey) {
    setShownKey(openKey)

    if (!inView(clip, view)) setView(inTrash(clip) ? "trash" : "all")
  }

  React.useEffect(() => {
    if (openKey && clips && !clip && !moving) openClip(null, true)
  }, [openKey, clips, clip, openClip, moving])

  const openKeyRef = React.useRef(openKey)

  React.useEffect(() => {
    openKeyRef.current = openKey
  }, [openKey])

  const follow = React.useCallback(
    (from: string, to: string) => {
      if (openKeyRef.current === from) openClip(to)
    },
    [openClip]
  )

  return { clip, openClip, follow }
}

/* "/" and ⌘K open search; 1, 2 and 3 switch between the tabs shown. Off
 * while a clip or a dialog is open. */
export function useGlobalKeys(
  enabled: boolean,
  views: View[],
  onSearch: () => void,
  setView: (view: View) => void
) {
  React.useEffect(() => {
    if (!enabled) return

    const onKey = (e: KeyboardEvent) => {
      const commandK = e.key === "k" && (e.metaKey || e.ctrlKey)

      if (commandK || (e.key === "/" && !isEditableTarget(e.target))) {
        e.preventDefault()
        onSearch()

        return
      }

      if (isEditableTarget(e.target) || e.metaKey || e.ctrlKey) return
      const tab = views[Number(e.key) - 1]

      if (tab) setView(tab)
    }

    window.addEventListener("keydown", onKey)

    return () => window.removeEventListener("keydown", onKey)
  }, [enabled, views, onSearch, setView])
}
