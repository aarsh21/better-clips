import * as React from "react"
import {
  ArrowSquareOutIcon,
  LinkIcon,
  ScissorsIcon,
  TrashIcon,
  YoutubeLogoIcon,
} from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { buttonVariants } from "@/components/ui/button-variants"
import { Action, ViewerHeader } from "@/components/viewer-parts"
import {
  DeleteYouTubeDialog,
  PrivacyButton,
  YouTubeStatus,
} from "@/components/youtube"
import {
  dayLabel,
  durationOf,
  formatDuration,
  youtubeStudioUrl,
  type YouTubeClip,
} from "@/lib/api"
import type { ClipNav } from "@/lib/clip-actions"
import { useClipTime } from "@/lib/clock"
import { isEditableTarget } from "@/lib/keys"
import {
  privacyOption,
  copyYouTubeLink,
  useYouTubeChange,
  type YouTubeChange,
} from "@/lib/youtube"
import {
  embedUrl,
  togglePlayer,
  useYouTubePlayer,
  type Player,
} from "@/lib/youtube-player"

type Mode = "view" | "rename"

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
  const clipTime = useClipTime()
  const src = embedUrl(clip)
  const { player, playing } = useYouTubePlayer(iframe, src)

  const apply = (change: YouTubeChange) => mutate({ clip, change })

  const leave = () => {
    if (nav.hasNext) nav.onNavigate(clip, 1)
    else if (nav.hasPrev) nav.onNavigate(clip, -1)
    else nav.onClose()
  }

  React.useEffect(() => {
    if (mode !== "view" || confirmDelete) return

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
    clip.privacy
      ? `${privacyOption(clip.privacy).label} on YouTube`
      : "Waiting for YouTube to confirm visibility",
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
        {src ? (
          <iframe
            ref={iframe}
            key={src}
            src={src}
            title={clip.title}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            className="aspect-video max-h-[calc(100dvh-9.5rem)] w-full border-0 bg-black"
          />
        ) : (
          <PlayerFallback clip={clip} />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1 border-t px-2 py-2">
        <Action icon={ScissorsIcon} label="Edit — coming soon" disabled />
        <PrivacyButton
          privacy={clip.privacy}
          onChange={(privacy) => apply({ kind: "privacy", privacy })}
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={!clip.videoId}
          onClick={() => void copyYouTubeLink(clip)}
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
          title="Open YouTube Studio to download your upload"
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          <ArrowSquareOutIcon />
          Download
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

function PlayerFallback({ clip }: { clip: YouTubeClip }) {
  return (
    <div className="relative flex aspect-video max-h-[calc(100dvh-9.5rem)] w-full flex-col items-center justify-center gap-3 text-center">
      {clip.status === "ready" ? (
        <>
          <p className="text-sm text-white">
            {clip.madeForKids
              ? "This video is made for kids."
              : "YouTube hasn’t confirmed this video’s audience."}
          </p>
          <a
            href={clip.url}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "secondary" })}
          >
            <YoutubeLogoIcon /> Watch on YouTube
          </a>
        </>
      ) : (
        <>
          {clip.thumbnail && (
            <img
              src={clip.thumbnail}
              alt=""
              className="absolute inset-0 size-full object-contain"
            />
          )}
          <YouTubeStatus clip={clip} large />
        </>
      )}
    </div>
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
    ["e", () => ctx.setMode("rename")],
    ["m", toggleMute],
    ["f", () => void ctx.iframe?.requestFullscreen?.()],
    ["Delete", ctx.askDelete],
    ["Backspace", ctx.askDelete],
  ])

  return bindings.get(key)
}
