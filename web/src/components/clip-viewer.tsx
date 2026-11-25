import * as React from "react"
import {
  ArrowCounterClockwiseIcon,
  BookmarkSimpleIcon,
  CaretLeftIcon,
  CaretRightIcon,
  DownloadSimpleIcon,
  LinkIcon,
  ScissorsIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react"
import { cn } from "cn"

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
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Kbd } from "@/components/ui/kbd"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  dayLabel,
  daysLeft,
  type Settings,
  downloadUrl,
  formatBytes,
  formatDuration,
  mediaUrl,
  thumbUrl,
  type Clip,
} from "@/lib/api"
import {
  useClipActions,
  type ClipActions,
  type ClipNav,
} from "@/lib/clip-actions"
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
          {clip && <Viewer {...props} clip={clip} key={clip.key} />}
        </TooltipProvider>
      </DialogContent>
    </Dialog>
  )
}

function Viewer({ clip, onOpen, ...nav }: Props & { clip: Clip }) {
  const video = React.useRef<HTMLVideoElement>(null)
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

    window.addEventListener("keydown", onKey)

    return () => window.removeEventListener("keydown", onKey)
  })

  return (
    <>
      <ViewerHeader
        clip={clip}
        duration={duration}
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
  clip: Clip
  nav: ClipNav
  actions: ClipActions
  video: HTMLVideoElement | null
  setMode: (mode: Mode) => void
}

/* The viewer's keyboard shortcuts. Returns nothing for keys it doesn't use. */
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
    ["ArrowLeft", e.shiftKey ? skip(-5) : prev],
    ["ArrowRight", e.shiftKey ? skip(5) : next],
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

function clipMeta(clip: Clip, duration: number, settings?: Settings) {
  const parts = [dayLabel(clip.day), clip.time, formatBytes(clip.size)]
  const left = daysLeft(clip, settings)

  if (duration) parts.push(formatDuration(duration))

  if (clip.folder === "saved") parts.push("kept")
  else if (left !== null)
    parts.push(`${clip.folder === "trash" ? "deleted" : "cleared"} in ${left}d`)

  return parts.join(" · ")
}

function ViewerHeader({
  clip,
  duration,
  nav,
  renaming,
  onStartRename,
  onRenamed,
}: {
  clip: Clip
  duration: number
  nav: ClipNav
  renaming: boolean
  onStartRename: () => void
  onRenamed: (name: string | null) => void
}) {
  const { data: settings } = useSettings()

  return (
    <div className="flex items-center gap-2 border-b px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        {renaming ? (
          <RenameInput
            initial={clip.title === "Untitled" ? "" : clip.title}
            onDone={onRenamed}
          />
        ) : (
          <DialogTitle
            render={<button type="button" />}
            onClick={onStartRename}
            className="w-fit max-w-full truncate text-left text-sm font-semibold outline-none hover:text-primary focus-visible:text-primary focus-visible:underline"
            title="Rename (E)"
          >
            {clip.title}
          </DialogTitle>
        )}
        <span className="truncate text-[11px] text-muted-foreground tabular-nums">
          {clipMeta(clip, duration, settings)}
        </span>
      </div>
      <div className="flex items-center">
        <IconButton
          label="Previous"
          kbd="←"
          disabled={!nav.hasPrev}
          onClick={() => nav.onNavigate(clip, -1)}
        >
          <CaretLeftIcon />
        </IconButton>
        <IconButton
          label="Next"
          kbd="→"
          disabled={!nav.hasNext}
          onClick={() => nav.onNavigate(clip, 1)}
        >
          <CaretRightIcon />
        </IconButton>
        <IconButton label="Close" kbd="Esc" onClick={nav.onClose}>
          <XIcon />
        </IconButton>
      </div>
    </div>
  )
}

function ActionBar({
  clip,
  actions,
  onTrim,
  onAskDelete,
}: {
  clip: Clip
  actions: ClipActions
  onTrim: () => void
  onAskDelete: () => void
}) {
  if (clip.folder === "trash") {
    return (
      <div className="flex flex-wrap items-center gap-1 border-t px-2 py-2">
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
    <div className="flex flex-wrap items-center gap-1 border-t px-2 py-2">
      <Action
        icon={BookmarkSimpleIcon}
        label={kept ? "Kept" : "Keep"}
        kbd="K"
        active={kept}
        onClick={actions.keep}
      />
      <Action icon={ScissorsIcon} label="Trim" kbd="T" onClick={onTrim} />
      <ShareMenu onShare={(days) => void actions.share(days)} />
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

const SHARE_OPTIONS = [
  { label: "1 day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "Forever", days: null },
]

function ShareMenu({ onShare }: { onShare: (days: number | null) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
        <LinkIcon />
        Share
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-44">
        {/* Base UI only allows a menu label inside a group. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Copy a link that works for</DropdownMenuLabel>
          {SHARE_OPTIONS.map(({ label, days }) => (
            <DropdownMenuItem key={label} onClick={() => onShare(days)}>
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function DeleteDialog({
  clip,
  open,
  onOpenChange,
  onConfirm,
}: {
  clip: Clip
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
            {clip.title} will be removed from your bucket. This can't be undone.
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

function RenameInput({
  initial,
  onDone,
}: {
  initial: string
  onDone: (name: string | null) => void
}) {
  const [value, setValue] = React.useState(initial)
  const input = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  return (
    <input
      ref={input}
      aria-label="Clip name"
      value={value}
      maxLength={40}
      placeholder="Name this clip"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(value)

        if (e.key === "Escape") {
          e.stopPropagation()
          onDone(null)
        }
      }}
      className="h-5 w-full max-w-sm border-b border-primary bg-transparent text-sm font-semibold outline-none"
    />
  )
}

function Action({
  icon: Icon,
  label,
  kbd,
  active,
  destructive,
  onClick,
}: {
  icon: React.ElementType
  label: string
  kbd?: string
  active?: boolean
  destructive?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            onClick={onClick}
            className={cn(
              active && "text-primary",
              destructive &&
                "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            )}
          />
        }
      >
        <Icon weight={active ? "fill" : "regular"} />
        <span className={cn(destructive && "hidden sm:inline")}>{label}</span>
      </TooltipTrigger>
      {kbd && (
        <TooltipContent>
          {label} <Kbd>{kbd}</Kbd>
        </TooltipContent>
      )}
    </Tooltip>
  )
}

function IconButton({
  label,
  kbd,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string; kbd: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            {...props}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label} <Kbd>{kbd}</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}
