import * as React from "react"
import { useIsMutating } from "@tanstack/react-query"

import type { Clip } from "@/lib/api"
import { isEditableTarget } from "@/lib/keys"

/* "All" holds everything not in the trash, so keeping a clip doesn't move it
 * out from under you. */
export type View = "all" | "saved" | "trash"

export const VIEWS: View[] = ["all", "saved", "trash"]

export const inView = (c: Clip, v: View) =>
  v === "all" ? c.folder !== "trash" : c.folder === v

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

/* The clips in the current tab, newest first, filtered by the search box. */
export function useVisibleClips(
  clips: Clip[] | undefined,
  view: View,
  query: string
) {
  return React.useMemo(() => {
    const q = query.trim().toLowerCase()

    const matches = (c: Clip) =>
      inView(c, view) && (!q || `${c.title} ${c.day}`.toLowerCase().includes(q))

    return (clips ?? [])
      .filter(matches)
      .sort((a, b) => (b.day + b.time).localeCompare(a.day + a.time))
  }, [clips, view, query])
}

export function useViewCounts(clips: Clip[] | undefined) {
  return React.useMemo(() => {
    const counts = { all: 0, saved: 0, trash: 0 }

    for (const c of clips ?? []) {
      if (c.folder !== "trash") counts.all++

      if (c.folder === "saved") counts.saved++

      if (c.folder === "trash") counts.trash++
    }

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

    if (!inView(clip, view)) setView(clip.folder === "trash" ? "trash" : "all")
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

/* "/" focuses search; 1, 2 and 3 switch tabs. Off while a clip is open. */
export function useGlobalKeys(
  enabled: boolean,
  search: React.RefObject<HTMLInputElement | null>,
  setView: (view: View) => void
) {
  React.useEffect(() => {
    if (!enabled) return

    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || e.metaKey || e.ctrlKey) return

      const tab = VIEWS[Number(e.key) - 1]

      if (e.key === "/") {
        e.preventDefault()
        search.current?.focus()
      } else if (tab) {
        setView(tab)
      }
    }

    window.addEventListener("keydown", onKey)

    return () => window.removeEventListener("keydown", onKey)
  }, [enabled, search, setView])
}
