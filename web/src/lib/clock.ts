import * as React from "react"

/* 12- or 24-hour times, chosen in Settings > Appearance and remembered in
 * this browser. Until you choose, it follows your computer's locale. */
export type Clock = "12h" | "24h"

const KEY = "clips:clock"
const listeners = new Set<() => void>()

const LOCALE_CYCLE = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
}).resolvedOptions().hourCycle

const LOCALE_CLOCK: Clock =
  LOCALE_CYCLE === "h11" || LOCALE_CYCLE === "h12" ? "12h" : "24h"

function read(): Clock {
  const saved = localStorage.getItem(KEY)

  return saved === "12h" || saved === "24h" ? saved : LOCALE_CLOCK
}

function subscribe(onChange: () => void) {
  listeners.add(onChange)
  window.addEventListener("storage", onChange)

  return () => {
    listeners.delete(onChange)
    window.removeEventListener("storage", onChange)
  }
}

export function setClock(clock: Clock) {
  localStorage.setItem(KEY, clock)
  listeners.forEach((l) => l())
}

export function useClock() {
  return React.useSyncExternalStore(subscribe, read)
}

/* "15:22:07" is "15:22" or "3:22 PM"; with seconds, "15:22:07" or
 * "3:22:07 PM". */
export function formatClock(time: string, clock: Clock, seconds = false) {
  const [h, m, s] = time.split(":")
  const tail = seconds && s ? `:${m}:${s}` : `:${m}`

  if (clock === "24h") return `${h}${tail}`
  const hour = Number(h)

  return `${hour % 12 || 12}${tail} ${hour < 12 ? "AM" : "PM"}`
}

/* The clip's time in the chosen format. */
export function useClipTime() {
  const clock = useClock()

  return React.useCallback(
    (time: string, seconds = false) => formatClock(time, clock, seconds),
    [clock]
  )
}
