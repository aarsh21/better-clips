import * as React from "react"
import {
  ArrowCounterClockwiseIcon,
  BookmarkSimpleIcon,
  DownloadSimpleIcon,
  LinkIcon,
  ScissorsIcon,
  TrashIcon,
} from "@phosphor-icons/react"

import { ShareMenu } from "@/components/share-menu"
import { TrimBar } from "@/components/trim-bar"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { buttonVariants } from "@/components/ui/button-variants"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Action, ViewerHeader } from "@/components/viewer-parts"
import { YouTubeViewer } from "@/components/youtube-viewer"
import {
  dayLabel,
  daysLeft,
  type Settings,
  downloadUrl,
  formatBytes,
  formatDuration,
  longTitle,
  mediaUrl,
  thumbUrl,
  type BucketClip,
  type Clip,
} from "@/lib/api"
import {
  useClipActions,
  type ClipActions,
  type ClipNav,
} from "@/lib/clip-actions"
import { useClipTime } from "@/lib/clock"
import { isEditableTarget } from "@/lib/keys"
import { useSettings } from "@/lib/settings"
import { seekTo, togglePlay } from "@/lib/video"

type Props = ClipNav & {
  clip: Clip | null
  onOpen: (key: string) => void
}

type Mode = "view" | "trim" | "rename"

export function ClipViewer(props: Props) {
  /* Keep the last clip while the dialog animates out. */
  const [last, setLast] = React.useState(props.clip)

  if (props.clip && props.clip !== last) setLast(props.clip)

  const clip = props.clip ?? last

  return (
    <Dialog
      open={!!props.clip}
      onOpenChange={(open) => !open && props.onClose()}
    >
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[100dvh] w-full max-w-[min(100vw,1280px)] flex-col gap-0 bg-background p-0 sm:max-w-[min(94vw,1280px)]"
      >
        <TooltipProvider delay={300}>
          {clip?.source === "youtube" ? (
            <YouTubeViewer clip={clip} nav={props} key={clip.key} />
          ) : (
            clip && <Viewer {...props} clip={clip} key={clip.key} />
          )}
        </TooltipProvider>
      </DialogContent>
    </Dialog>
  )
}

function Viewer({ clip, onOpen, ...nav }: Props & { clip: BucketClip }) {
  const video = React.useRef<HTMLVideoElement>(null)
  const { data: settings } = useSettings()
  const clipTime = useClipTime()
  const [mode, setMode] = React.useState<Mode>("view")
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [duration, setDuration] = React.useState(clip.thumb?.duration ?? 0)
  const actions = useClipActions(clip, nav, () => setConfirmDelete(true))

  /* Play with sound; if the browser blocks that, play muted. */
  React.useEffect(() => {
    const element = video.current

    if (!element) return

    element
      .play()
      .catch(() => {
        element.muted = true

        return element.play()
      })
      .catch(() => undefined)
  }, [])

  React.useEffect(() => {
    if (mode !== "view" || confirmDelete) return

    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey)
        return

      /* An open menu, such as Share, keeps its own arrow keys. */
      if (e.target instanceof Element && e.target.closest("[role=menu]")) return

      const run = keyAction(e, {
        clip,
        nav,
        actions,
        video: video.current,
        setMode,
      })

      if (!run) return

      e.preventDefault()
      run()
    }

    /* Capture: the dialog stops arrow keys before they reach the window. */
    window.addEventListener("keydown", onKey, true)

    return () => window.removeEventListener("keydown", onKey, true)
  })

  return (
    <>
      <ViewerHeader
        clip={clip}
        meta={clipMeta(clip, clipTime(clip.time, true), duration, settings)}
        name={clip.name}
        maxLength={40}
        nav={nav}
        renaming={mode === "rename"}
        onStartRename={() => setMode("rename")}
        onRenamed={(name) => {
          setMode("view")

          if (name !== null) actions.rename(name)
        }}
      />

      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
        <video
          ref={video}
          src={mediaUrl(clip.key)}
          poster={clip.thumb ? thumbUrl(clip) : undefined}
          playsInline
          controls={mode !== "trim"}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onClick={(e) => mode === "trim" && togglePlay(e.currentTarget)}
          className="aspect-video max-h-[calc(100dvh-9.5rem)] w-full bg-black object-contain outline-none"
        />
      </div>

      {mode === "trim" ? (
        <TrimBar
          clip={clip}
          video={video}
          duration={duration}
          onCancel={() => setMode("view")}
          onSaved={(key) => {
            setMode("view")
            onOpen(key)
          }}
        />
      ) : (
        <ActionBar
          clip={clip}
          actions={actions}
          onTrim={() => setMode("trim")}
          onAskDelete={() => setConfirmDelete(true)}
        />
      )}

      <DeleteDialog
        clip={clip}
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        onConfirm={() => {
          setConfirmDelete(false)
          void actions.destroy()
        }}
      />
    </>
  )
}

type KeyContext = {
  clip: BucketClip
  nav: ClipNav
  actions: ClipActions
  video: HTMLVideoElement | null
  setMode: (mode: Mode) => void
}

/* The viewer's keyboard shortcuts. Returns nothing for keys it doesn't use.
 * Up and down (or H and L) change clips; left and right seek, as they do in
 * the browser's own player, which handles them itself when it has focus. */
function keyAction(e: KeyboardEvent, ctx: KeyContext) {
  const { clip, nav, actions, video } = ctx
  const live = clip.folder !== "trash"
  const step = (by: number) => () => nav.onNavigate(clip, by)

  const skip = (by: number) => () =>
    seekTo(video, (video?.currentTime ?? 0) + by)

  const prev = nav.hasPrev ? step(-1) : undefined
  const next = nav.hasNext ? step(1) : undefined

  const toggleMute = () => {
    if (video) video.muted = !video.muted
  }

  const bindings = new Map<string, (() => void) | undefined>([
    [" ", () => togglePlay(video)],
    ["ArrowUp", prev],
    ["ArrowDown", next],
    ["h", prev],
    ["l", next],
    ["ArrowLeft", e.target === video ? undefined : skip(-5)],
    ["ArrowRight", e.target === video ? undefined : skip(5)],
    ["k", live ? actions.keep : undefined],
    ["t", live ? () => ctx.setMode("trim") : undefined],
    ["e", () => ctx.setMode("rename")],
    ["m", toggleMute],
    ["f", () => void video?.requestFullscreen?.()],
    ["Delete", actions.trash],
    ["Backspace", actions.trash],
  ])

  return bindings.get(e.key)
}

function clipMeta(
  clip: BucketClip,
  time: string,
  duration: number,
  settings?: Settings
) {
  const parts = [dayLabel(clip.day), time, formatBytes(clip.size)]

  if (clip.category) parts.unshift(clip.category)
  const left = daysLeft(clip, settings)

  if (duration) parts.push(formatDuration(duration))

  if (clip.folder === "saved") parts.push("kept")
  else if (left !== null)
    parts.push(`${clip.folder === "trash" ? "deleted" : "cleared"} in ${left}d`)

  return parts.join(" · ")
}

function ActionBar({
  clip,
  actions,
  onTrim,
  onAskDelete,
}: {
  clip: BucketClip
  actions: ClipActions
  onTrim: () => void
  onAskDelete: () => void
}) {
  if (clip.folder === "trash") {
    return (
      <div className="flex flex-wrap items-center gap-1 border-t px-3 py-2.5">
        <Action
          icon={ArrowCounterClockwiseIcon}
          label="Restore"
          onClick={actions.restore}
        />
        <Action
          icon={TrashIcon}
          label="Delete forever"
          kbd="Del"
          destructive
          onClick={onAskDelete}
        />
      </div>
    )
  }

  const kept = clip.folder === "saved"

  return (
    <div className="flex flex-wrap items-center gap-1 border-t px-3 py-2.5">
      <Action
        icon={BookmarkSimpleIcon}
        label={kept ? "Kept" : "Keep"}
        kbd="K"
        active={kept}
        onClick={actions.keep}
      />
      <Action icon={ScissorsIcon} label="Trim" kbd="T" onClick={onTrim} />
      <ShareMenu onShare={(days) => void actions.share(days)}>
        <Button variant="ghost" size="sm">
          <LinkIcon />
          Share
        </Button>
      </ShareMenu>
      <a
        href={downloadUrl(clip.key)}
        download
        className={buttonVariants({ variant: "ghost", size: "sm" })}
      >
        <DownloadSimpleIcon />
        <span className="hidden sm:inline">Download</span>
      </a>
      <div className="ml-auto" />
      <Action
        icon={TrashIcon}
        label="Delete"
        kbd="Del"
        destructive
        onClick={actions.trash}
      />
    </div>
  )
}

function DeleteDialog({
  clip,
  open,
  onOpenChange,
  onConfirm,
}: {
  clip: BucketClip
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this clip forever?</AlertDialogTitle>
          <AlertDialogDescription>
            {longTitle(clip)} will be removed from your bucket. This can't be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Delete forever
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
