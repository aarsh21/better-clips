import * as React from "react"
import { CheckIcon, PauseIcon, PlayIcon } from "@phosphor-icons/react"
import { useQueryClient } from "@tanstack/react-query"
import { cn } from "cn"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import {
  api,
  errorMessage,
  formatTimecode,
  mediaUrl,
  type Clip,
} from "@/lib/api"
import { seekTo, togglePlay, usePlaying } from "@/lib/video"

const FRAMES = 12
const MIN_LENGTH = 0.5

type Handle = "start" | "end" | "playhead"

/* Pick in and out points on a filmstrip, preview the range on a loop, then
 * save it as a new clip. The original is left alone. */
export function TrimBar({
  clip,
  video,
  duration,
  onCancel,
  onSaved,
}: {
  clip: Clip
  video: React.RefObject<HTMLVideoElement | null>
  duration: number
  onCancel: () => void
  onSaved: (key: string) => void
}) {
  const qc = useQueryClient()
  const [picked, setRange] = React.useState<[number, number] | null>(null)
  const range: [number, number] = picked ?? [0, duration]
  const [time, setTime] = React.useState(0)
  const playing = usePlaying(video)
  const [frames, setFrames] = React.useState<(string | null)[]>([])
  const [progress, setProgress] = React.useState<number | null>(null)
  const track = React.useRef<HTMLDivElement>(null)
  const drag = React.useRef<Handle | null>(null)
  const rangeRef = React.useRef(range)
  React.useEffect(() => {
    rangeRef.current = range
  })

  /* Filmstrip frames, decoded in the browser as they arrive. */
  React.useEffect(() => {
    const ctrl = new AbortController()
    const urls: string[] = []

    const onFrame = (url: string | null) => {
      if (url) urls.push(url)

      setFrames((f) => [...f, url])
    }

    import("@/lib/media")
      .then(({ loadFilmstrip }) =>
        loadFilmstrip(mediaUrl(clip.key), FRAMES, ctrl.signal, onFrame)
      )
      .catch((err) => console.warn("Filmstrip failed", err))

    return () => {
      ctrl.abort()
      urls.forEach(URL.revokeObjectURL)
    }
  }, [clip.key])

  /* Follow the video smoothly, and loop inside the range. */
  React.useEffect(() => {
    const v = video.current

    if (!v) return
    let raf = 0

    const tick = () => {
      const [start, end] = rangeRef.current

      if (
        !v.paused &&
        drag.current !== "playhead" &&
        v.currentTime >= end - 0.02
      ) {
        v.currentTime = start
      }

      setTime(v.currentTime)
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)

    return () => cancelAnimationFrame(raf)
  }, [video])

  const seek = (t: number) => seekTo(video.current, t)

  const timeAt = (clientX: number) => {
    const rect = track.current!.getBoundingClientRect()
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width)

    return (x / rect.width) * duration
  }

  const update = (handle: Handle, t: number) => {
    const [start, end] = rangeRef.current

    if (handle === "start") {
      const s = Math.min(t, end - MIN_LENGTH)
      setRange([Math.max(0, s), end])
      seek(Math.max(0, s))
    } else if (handle === "end") {
      const e = Math.max(t, start + MIN_LENGTH)
      setRange([start, Math.min(duration, e)])
      seek(Math.min(duration, e))
    } else {
      seek(Math.min(Math.max(t, start), end))
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!duration || progress !== null) return

    const target =
      e.target instanceof Element ? e.target.closest("[data-handle]") : null

    const side = target?.getAttribute("data-handle")

    const handle: Handle =
      side === "start" || side === "end" ? side : "playhead"

    drag.current = handle

    if (handle !== "playhead") video.current?.pause()
    e.currentTarget.setPointerCapture(e.pointerId)
    update(handle, timeAt(e.clientX))
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (drag.current) update(drag.current, timeAt(e.clientX))
  }

  const onPointerUp = () => {
    if (drag.current && drag.current !== "playhead") seek(rangeRef.current[0])
    drag.current = null
  }

  const save = async () => {
    const [start, end] = range
    setProgress(0)

    try {
      const { trimClip } = await import("@/lib/media")

      const buffer = await trimClip(mediaUrl(clip.key), start, end, (p) =>
        setProgress(p * 0.7)
      )

      setProgress(0.75)
      const { key } = await api.saveEdit(clip.key, buffer)
      setProgress(1)
      await qc.invalidateQueries({ queryKey: ["clips"] })
      toast.success("Saved as a new clip", {
        description: `${formatTimecode(end - start)} · the original is untouched`,
      })
      onSaved(key)
    } catch (err) {
      toast.error(errorMessage(err))
      setProgress(null)
    }
  }

  /* I and O set the range at the playhead, Enter saves, Esc cancels. */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (progress !== null || e.metaKey || e.ctrlKey) return

      if (e.key === " " || e.key === "k") togglePlay(video.current)
      else if (e.key === "i") update("start", time)
      else if (e.key === "o") update("end", time)
      else if (e.key === "Enter") void save()
      else if (e.key === "Escape") onCancel()
      else if (e.key === "ArrowLeft")
        seek(Math.max(range[0], time - (e.shiftKey ? 1 : 1 / 30)))
      else if (e.key === "ArrowRight")
        seek(Math.min(range[1], time + (e.shiftKey ? 1 : 1 / 30)))
      else return
      e.preventDefault()
      e.stopPropagation()
    }

    window.addEventListener("keydown", onKey, true)

    return () => window.removeEventListener("keydown", onKey, true)
  })

  const pct = (t: number) => (duration ? (t / duration) * 100 : 0)
  const [start, end] = range
  const length = end - start
  const changed = start > 0.01 || end < duration - 0.01

  return (
    <div className="flex flex-col gap-3 border-t px-3 pt-3 pb-3">
      <div
        ref={track}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="relative h-14 cursor-pointer touch-none select-none"
      >
        <div className="absolute inset-0 flex overflow-hidden bg-muted">
          {Array.from({ length: FRAMES }, (_, i) => (
            <div
              key={i}
              className="relative h-full flex-1 border-r border-black/40 last:border-0"
            >
              {frames[i] && (
                <img
                  src={frames[i]!}
                  alt=""
                  draggable={false}
                  className="size-full animate-in object-cover duration-300 fade-in-0"
                />
              )}
            </div>
          ))}
        </div>
        <div
          className="absolute inset-y-0 left-0 bg-background/75"
          style={{ width: `${pct(start)}%` }}
        />
        <div
          className="absolute inset-y-0 right-0 bg-background/75"
          style={{ width: `${100 - pct(end)}%` }}
        />
        <div
          className="pointer-events-none absolute inset-y-0 border-y-2 border-primary"
          style={{ left: `${pct(start)}%`, right: `${100 - pct(end)}%` }}
        />
        <TrimHandle side="start" at={pct(start)} />
        <TrimHandle side="end" at={pct(end)} />
        <div
          className="pointer-events-none absolute -inset-y-1 w-px bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
          style={{ left: `${pct(time)}%` }}
        />
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => togglePlay(video.current)}
        >
          {playing ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
        </Button>
        <div className="flex items-baseline gap-2 text-[11px] tabular-nums">
          <span className="text-muted-foreground">
            {formatTimecode(start)} – {formatTimecode(end)}
          </span>
          <span className="font-medium text-foreground">
            {formatTimecode(length)}
          </span>
        </div>
        <div className="ml-auto hidden items-center gap-1.5 text-[11px] text-muted-foreground lg:flex">
          <Kbd>I</Kbd>
          <Kbd>O</Kbd> set in/out
          <span className="px-1">·</span>
          <Kbd>←</Kbd>
          <Kbd>→</Kbd> step
        </div>
        <div className="ml-auto flex items-center gap-1 lg:ml-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={progress !== null}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={!changed || progress !== null}
            className="relative min-w-28 overflow-hidden"
          >
            {progress !== null && (
              <span
                className="absolute inset-y-0 left-0 bg-primary-foreground/15 transition-[width]"
                style={{ width: `${progress * 100}%` }}
              />
            )}
            <CheckIcon weight="bold" />
            {progress === null
              ? "Save trim"
              : progress < 0.75
                ? "Cutting…"
                : "Uploading…"}
          </Button>
        </div>
      </div>
    </div>
  )
}

function TrimHandle({ side, at }: { side: "start" | "end"; at: number }) {
  return (
    <div
      data-handle={side}
      className={cn(
        "group absolute inset-y-0 z-10 flex w-3 cursor-ew-resize items-center justify-center bg-primary",
        side === "start" ? "-translate-x-full" : ""
      )}
      style={{ left: `${at}%` }}
    >
      <span className="h-5 w-0.5 bg-primary-foreground/70 transition-transform group-hover:scale-y-125" />
    </div>
  )
}
