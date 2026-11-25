import * as React from "react"
import {
  ArrowSquareOutIcon,
  CheckIcon,
  LinkIcon,
  PauseIcon,
  PlayIcon,
  ScissorsIcon,
  TrashIcon,
  YoutubeLogoIcon,
} from "@phosphor-icons/react"
import { cn } from "cn"

import { TrimHandle } from "@/components/trim-bar"
import { Button } from "@/components/ui/button"
import { buttonVariants } from "@/components/ui/button-variants"
import { Kbd } from "@/components/ui/kbd"
import { Action, ViewerHeader } from "@/components/viewer-parts"
import {
  CutLinkDialog,
  DeleteYouTubeDialog,
  PrivacyButton,
  useYouTubeShare,
  YouTubeStatus,
} from "@/components/youtube"
import {
  dayLabel,
  durationOf,
  formatDuration,
  youtubeStudioUrl,
  type Cut,
  type YouTubeClip,
} from "@/lib/api"
import type { ClipNav } from "@/lib/clip-actions"
import { useClipTime } from "@/lib/clock"
import { isEditableTarget } from "@/lib/keys"
import {
  privacyOption,
  useYouTubeChange,
  type YouTubeChange,
} from "@/lib/youtube"
import {
  embedUrl,
  togglePlayer,
  useCutEnd,
  useYouTubePlayer,
  type Player,
} from "@/lib/youtube-player"

type Mode = "view" | "cut" | "rename"

const seconds = (t: number) => formatDuration(t) || "0:00"

/* A clip on YouTube plays in YouTube's player. Its cut, rename, visibility
 * and delete change the video on YouTube; there's no download, since YouTube
 * doesn't give the file back. */
export function YouTubeViewer({
  clip,
  nav,
}: {
  clip: YouTubeClip
  nav: ClipNav
}) {
  const iframe = React.useRef<HTMLIFrameElement>(null)
  const [mode, setMode] = React.useState<Mode>("view")
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const { mutate } = useYouTubeChange()
  const { share, dialog } = useYouTubeShare()
  const clipTime = useClipTime()
  const ready = clip.status === "ready"
  /* Cutting shows the whole video, so you can move the cut outwards. */
  const src = embedUrl(clip.videoId, mode === "cut" ? null : clip.cut)
  const { player, playing } = useYouTubePlayer(iframe, ready ? src : "")

  /* The cut bar loops inside the range it's editing instead. */
  useCutEnd(player, mode === "cut" ? null : clip.cut)
  const duration = clip.durationSeconds || player?.getDuration() || 0

  const apply = (change: YouTubeChange) => mutate({ clip, change })

  const leave = () => {
    if (nav.hasNext) nav.onNavigate(clip, 1)
    else if (nav.hasPrev) nav.onNavigate(clip, -1)
    else nav.onClose()
  }

  React.useEffect(() => {
    if (mode !== "view" || confirmDelete || dialog.clip) return

    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey)
        return

      if (e.target instanceof Element && e.target.closest("[role=menu]")) return

      const run = keyAction(e.key, {
        clip,
        nav,
        player,
        playing,
        iframe: iframe.current,
        setMode,
        askDelete: () => setConfirmDelete(true),
      })

      if (!run) return

      e.preventDefault()
      run()
    }

    window.addEventListener("keydown", onKey, true)

    return () => window.removeEventListener("keydown", onKey, true)
  })

  const meta = [
    clip.category,
    dayLabel(clip.day),
    clipTime(clip.time, true),
    formatDuration(durationOf(clip)),
    `${privacyOption(clip.privacy).label} on YouTube`,
    clip.cut && `cut ${seconds(clip.cut.start)}–${seconds(clip.cut.end)}`,
  ]

  return (
    <>
      <ViewerHeader
        clip={clip}
        meta={meta.filter(Boolean).join(" · ")}
        name={clip.title}
        maxLength={100}
        nav={nav}
        renaming={mode === "rename"}
        onStartRename={() => setMode("rename")}
        onRenamed={(name) => {
          setMode("view")
          const title = name?.replace(/[<>]/g, "").trim()

          if (title && title !== clip.title) apply({ kind: "title", title })
        }}
      />

      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
        {ready ? (
          <iframe
            ref={iframe}
            key={src}
            src={src}
            title={clip.title}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            className={cn(
              "aspect-video w-full border-0 bg-black",
              /* The cut bar is taller than the action bar. */
              mode === "cut"
                ? "max-h-[calc(100dvh-14rem)]"
                : "max-h-[calc(100dvh-9.5rem)]"
            )}
          />
        ) : (
          <div className="relative aspect-video max-h-[calc(100dvh-9.5rem)] w-full">
            {clip.thumbnail && (
              <img
                src={clip.thumbnail}
                alt=""
                className="absolute inset-0 size-full object-contain"
              />
            )}
            <YouTubeStatus clip={clip} large />
          </div>
        )}
      </div>

      {mode === "cut" ? (
        <CutBar
          clip={clip}
          player={player}
          playing={playing}
          duration={duration}
          onCancel={() => setMode("view")}
          onSave={(cut) => {
            setMode("view")
            apply({ kind: "cut", cut })
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-1 border-t px-2 py-2">
          <Action
            icon={ScissorsIcon}
            label={clip.cut ? "Edit cut" : "Cut"}
            kbd="T"
            active={!!clip.cut}
            disabled={!ready}
            onClick={() => setMode("cut")}
          />
          <PrivacyButton
            privacy={clip.privacy}
            onChange={(privacy) => apply({ kind: "privacy", privacy })}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={!clip.videoId}
            onClick={() => share(clip)}
          >
            <LinkIcon />
            Copy link
          </Button>
          <a
            href={clip.url}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            <YoutubeLogoIcon />
            <span className="hidden sm:inline">Open on YouTube</span>
          </a>
          <a
            href={youtubeStudioUrl(clip.videoId)}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            <ArrowSquareOutIcon />
            <span className="hidden md:inline">Edit in YouTube Studio</span>
          </a>
          <div className="ml-auto" />
          <Action
            icon={TrashIcon}
            label="Delete"
            kbd="Del"
            destructive
            onClick={() => setConfirmDelete(true)}
          />
        </div>
      )}

      <CutLinkDialog {...dialog} />
      <DeleteYouTubeDialog
        clip={confirmDelete ? clip : null}
        onOpenChange={setConfirmDelete}
        onConfirm={() => {
          setConfirmDelete(false)
          leave()
          apply({ kind: "delete" })
        }}
      />
    </>
  )
}

type KeyContext = {
  clip: YouTubeClip
  nav: ClipNav
  player: Player | null
  playing: boolean
  iframe: HTMLIFrameElement | null
  setMode: (mode: Mode) => void
  askDelete: () => void
}

/* The same keys as a bucket clip's viewer, where they make sense: there's
 * nothing to keep, and T cuts instead of trimming. Keys pressed inside
 * YouTube's player go to the player. */
function keyAction(key: string, ctx: KeyContext) {
  const { clip, nav, player } = ctx
  const step = (by: number) => () => nav.onNavigate(clip, by)

  const skip = (by: number) => () =>
    player?.seekTo(Math.max(0, player.getCurrentTime() + by), true)

  const prev = nav.hasPrev ? step(-1) : undefined
  const next = nav.hasNext ? step(1) : undefined

  const toggleMute = () => {
    if (player?.isMuted()) player.unMute()
    else player?.mute()
  }

  const bindings = new Map<string, (() => void) | undefined>([
    [" ", () => togglePlayer(player, ctx.playing)],
    ["ArrowUp", prev],
    ["ArrowDown", next],
    ["h", prev],
    ["l", next],
    ["ArrowLeft", skip(-5)],
    ["ArrowRight", skip(5)],
    ["t", clip.status === "ready" ? () => ctx.setMode("cut") : undefined],
    ["e", () => ctx.setMode("rename")],
    ["m", toggleMute],
    ["f", () => void ctx.iframe?.requestFullscreen?.()],
    ["Delete", ctx.askDelete],
    ["Backspace", ctx.askDelete],
  ])

  return bindings.get(key)
}

type Handle = "start" | "end" | "playhead"

/* Picks whole seconds to play, on a bar of the video's length. YouTube's
 * player applies them; the video on YouTube is unchanged. */
function CutBar({
  clip,
  player,
  playing,
  duration,
  onCancel,
  onSave,
}: {
  clip: YouTubeClip
  player: Player | null
  playing: boolean
  duration: number
  onCancel: () => void
  onSave: (cut: Cut | null) => void
}) {
  const length = Math.floor(duration)

  const [picked, setRange] = React.useState<[number, number] | null>(() =>
    clip.cut ? [clip.cut.start, clip.cut.end] : null
  )

  const range: [number, number] = picked ?? [0, length]
  const [time, setTime] = React.useState(range[0])
  const track = React.useRef<HTMLDivElement>(null)
  const drag = React.useRef<Handle | null>(null)
  const rangeRef = React.useRef(range)

  React.useEffect(() => {
    rangeRef.current = range
  })

  /* Follow the player, and loop inside the range. */
  React.useEffect(() => {
    if (!player) return
    let raf = 0

    const tick = () => {
      const t = player.getCurrentTime()
      const [start, end] = rangeRef.current

      if (drag.current !== "playhead" && t >= end && end > start)
        player.seekTo(start, true)

      setTime(t)
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)

    return () => cancelAnimationFrame(raf)
  }, [player])

  const seek = (t: number) => player?.seekTo(t, true)

  const secondAt = (clientX: number) => {
    const rect = track.current!.getBoundingClientRect()
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width)

    return Math.round((x / rect.width) * length)
  }

  const update = (handle: Handle, t: number) => {
    const [start, end] = rangeRef.current

    if (handle === "start") {
      const s = Math.max(0, Math.min(Math.round(t), end - 1))
      setRange([s, end])
      seek(s)
    } else if (handle === "end") {
      const e = Math.min(length, Math.max(Math.round(t), start + 1))
      setRange([start, e])
      seek(Math.max(start, e - 2))
    } else {
      seek(Math.min(Math.max(t, start), end))
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!length) return

    const side =
      e.target instanceof Element
        ? e.target.closest("[data-handle]")?.getAttribute("data-handle")
        : null

    const handle: Handle =
      side === "start" || side === "end" ? side : "playhead"

    drag.current = handle

    if (handle !== "playhead") player?.pauseVideo()
    e.currentTarget.setPointerCapture(e.pointerId)
    update(handle, secondAt(e.clientX))
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (drag.current) update(drag.current, secondAt(e.clientX))
  }

  const onPointerUp = () => {
    if (drag.current && drag.current !== "playhead") seek(rangeRef.current[0])
    drag.current = null
  }

  const [start, end] = range
  const whole = start === 0 && end === length

  const save = () => {
    if (length) onSave(whole ? null : { start, end })
  }

  /* I and O set the range at the playhead, Enter saves, Esc cancels. */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) return

      if (e.key === " " || e.key === "k") togglePlayer(player, playing)
      else if (e.key === "i") update("start", time)
      else if (e.key === "o") update("end", time)
      else if (e.key === "Enter") save()
      else if (e.key === "Escape") onCancel()
      else if (e.key === "ArrowLeft") seek(Math.max(start, time - 1))
      else if (e.key === "ArrowRight") seek(Math.min(end, time + 1))
      else return
      e.preventDefault()
      e.stopPropagation()
    }

    window.addEventListener("keydown", onKey, true)

    return () => window.removeEventListener("keydown", onKey, true)
  })

  const pct = (t: number) => (length ? (t / length) * 100 : 0)
  const ticks = Array.from({ length: Math.max(0, length - 1) }, (_, i) => i + 1)

  return (
    <div className="flex flex-col gap-3 border-t px-3 pt-3 pb-3">
      <div
        ref={track}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="relative h-10 cursor-pointer touch-none select-none"
      >
        <div className="absolute inset-0 overflow-hidden bg-muted">
          {clip.thumbnail && (
            <img
              src={clip.thumbnail}
              alt=""
              draggable={false}
              className="size-full object-cover opacity-40"
            />
          )}
          {length <= 120 &&
            ticks.map((s) => (
              <span
                key={s}
                className="absolute bottom-0 h-1.5 w-px bg-foreground/25"
                style={{ left: `${pct(s)}%` }}
              />
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
          style={{ left: `${Math.min(100, pct(time))}%` }}
        />
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        The cut plays here and in your library, in whole seconds, and can start
        up to 2 seconds early. The video on YouTube keeps the whole clip; to cut
        it for good,{" "}
        <a
          href={youtubeStudioUrl(clip.videoId)}
          target="_blank"
          rel="noreferrer"
          className="text-foreground underline underline-offset-4"
        >
          edit it in YouTube Studio
        </a>
        .
      </p>

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={playing ? "Pause" : "Play"}
          disabled={!player}
          onClick={() => togglePlayer(player, playing)}
        >
          {playing ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
        </Button>
        <div className="flex items-baseline gap-2 text-[11px] tabular-nums">
          {length ? (
            <>
              <span className="text-muted-foreground">
                {seconds(start)} – {seconds(end)}
              </span>
              <span className="font-medium text-foreground">
                {seconds(end - start)}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">Loading the player…</span>
          )}
        </div>
        <div className="ml-auto hidden items-center gap-1.5 text-[11px] text-muted-foreground lg:flex">
          <Kbd>I</Kbd>
          <Kbd>O</Kbd> set in/out
          <span className="px-1">·</span>
          <Kbd>←</Kbd>
          <Kbd>→</Kbd> 1 s
        </div>
        <div className="ml-auto flex items-center gap-1 lg:ml-3">
          {clip.cut && (
            <Button variant="ghost" size="sm" onClick={() => onSave(null)}>
              Remove cut
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={!length || (whole && !clip.cut)}
            className="min-w-24"
          >
            <CheckIcon weight="bold" />
            Save cut
          </Button>
        </div>
      </div>
    </div>
  )
}
