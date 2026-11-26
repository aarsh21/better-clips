import * as React from "react"
import {
  ArrowCounterClockwiseIcon,
  BookmarkSimpleIcon,
  LinkIcon,
  ScissorsIcon,
  TrashIcon,
} from "@phosphor-icons/react"
import { cn } from "cn"

import { ShareMenu } from "@/components/share-menu"
import {
  CutLinkDialog,
  DeleteYouTubeDialog,
  useYouTubeShare,
  YouTubeChip,
  YouTubeStatus,
} from "@/components/youtube"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

import {
  bucketBytes,
  dayLabel,
  daysLeft,
  displayTitle,
  durationOf,
  formatBytes,
  formatDuration,
  mediaUrl,
  thumbnailOf,
  type BucketClip,
  type Clip,
  type Settings,
  type YouTubeClip,
} from "@/lib/api"
import { useClipMoves, type ClipMoves } from "@/lib/clip-actions"
import { useClipTime } from "@/lib/clock"
import { useSettings } from "@/lib/settings"
import { useYouTubeChange } from "@/lib/youtube"

/* clips arrive in display order. Sorted by time, they're grouped under day
 * headings; in any other order, they're one list. */
export function ClipGrid({
  clips,
  byDay,
  onOpen,
}: {
  clips: Clip[]
  byDay: boolean
  onOpen: (clip: Clip) => void
}) {
  const days = React.useMemo(() => {
    if (!byDay) return [["", clips] as const]
    const groups = new Map<string, Clip[]>()

    for (const clip of clips) {
      const list = groups.get(clip.day) ?? []
      list.push(clip)
      groups.set(clip.day, list)
    }

    return [...groups]
  }, [clips, byDay])

  const { data: settings } = useSettings()
  const moves = useClipMoves()
  const youtube = useYouTubeChange()
  const { share, dialog } = useYouTubeShare()
  const [deleting, setDeleting] = React.useState<YouTubeClip | null>(null)

  const cardActions: CardActions = {
    moves,
    shareYouTube: share,
    deleteYouTube: setDeleting,
  }

  return (
    <TooltipProvider delay={400}>
      <div className="flex flex-col gap-12">
        {days.map(([day, list]) => (
          <section key={day || "all"}>
            <div className="sticky top-16 z-20 -mx-1 mb-4 flex items-baseline gap-3 bg-background/85 px-1 py-3 backdrop-blur-md">
              {day && (
                <h2 className="text-lg font-bold tracking-[-0.01em] [font-stretch:85%]">
                  {dayLabel(day)}
                </h2>
              )}
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {groupSummary(list)}
              </span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-x-5 gap-y-8">
              {list.map((clip) => (
                <ClipCard
                  key={clip.key}
                  clip={clip}
                  byDay={byDay}
                  settings={settings}
                  actions={cardActions}
                  onOpen={() => onOpen(clip)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
      <CutLinkDialog {...dialog} />
      <DeleteYouTubeDialog
        clip={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        onConfirm={(clip) => {
          setDeleting(null)
          youtube.mutate({ clip, change: { kind: "delete" } })
        }}
      />
    </TooltipProvider>
  )
}

/* "4 clips · 1.2 GB", leaving out the size when they're all on YouTube. */
function groupSummary(list: Clip[]) {
  const count = `${list.length} ${list.length === 1 ? "clip" : "clips"}`
  const bytes = bucketBytes(list)

  return bytes ? `${count} · ${formatBytes(bytes)}` : count
}

/* What the buttons on a card do. */
type CardActions = {
  moves: ClipMoves
  shareYouTube: (clip: YouTubeClip) => void
  deleteYouTube: (clip: YouTubeClip) => void
}

/* Hovering a bucket clip for a moment plays a muted preview from the start;
 * YouTube clips have no file to preview. Keep, share and delete sit on the
 * thumbnail, so they work without opening the clip. */
function ClipCard({
  clip,
  byDay,
  settings,
  actions,
  onOpen,
}: {
  clip: Clip
  byDay: boolean
  settings: Settings | undefined
  actions: CardActions
  onOpen: () => void
}) {
  const [loaded, setLoaded] = React.useState(false)
  const [preview, setPreview] = React.useState(false)
  const timer = React.useRef<number>(undefined)
  const left = daysLeft(clip, settings)
  const clipTime = useClipTime()

  const thumbnail = thumbnailOf(clip)

  const startPreview = () => {
    if (clip.source === "youtube") return
    timer.current = window.setTimeout(() => setPreview(true), 350)
  }

  const stopPreview = () => {
    window.clearTimeout(timer.current)
    setPreview(false)
  }

  return (
    <div
      onPointerEnter={(e) => e.pointerType === "mouse" && startPreview()}
      onPointerLeave={stopPreview}
      className="group relative"
    >
      <button
        onClick={onOpen}
        onFocus={startPreview}
        onBlur={stopPreview}
        className="flex w-full flex-col gap-2 text-left outline-none"
      >
        <div className="relative aspect-video w-full overflow-hidden bg-muted ring-1 ring-foreground/5 transition-shadow group-hover:ring-foreground/20 group-focus-visible:ring-2 group-focus-visible:ring-primary">
          {thumbnail ? (
            <img
              src={thumbnail}
              alt=""
              loading="lazy"
              decoding="async"
              onLoad={() => setLoaded(true)}
              className={cn(
                "absolute inset-0 size-full object-cover transition-[opacity,scale] duration-300 group-hover:scale-[1.02]",
                loaded ? "opacity-100" : "opacity-0"
              )}
            />
          ) : (
            <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-muted to-secondary" />
          )}
          {preview && clip.source === "bucket" && (
            <video
              src={mediaUrl(clip.key)}
              autoPlay
              muted
              loop
              playsInline
              className="absolute inset-0 size-full animate-in object-cover duration-200 fade-in-0"
            />
          )}
          <ThumbnailBadges clip={clip} />
        </div>
        <div className="flex flex-col gap-0.5 px-0.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-sm font-semibold">
              {displayTitle(clip)}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
              {left !== null && left <= 5 ? (
                <span className={cn(left <= 2 && "text-destructive")}>
                  {left}d left ·{" "}
                </span>
              ) : null}
              {byDay
                ? clipTime(clip.time)
                : `${dayLabel(clip.day)} ${clipTime(clip.time)}`}
            </span>
          </div>
          <span className="truncate text-xs text-muted-foreground">
            {clip.category || "No category"}
          </span>
        </div>
      </button>
      <div className="absolute top-1.5 right-1.5 flex gap-1">
        {clip.source === "youtube" ? (
          <YouTubeCardActions clip={clip} actions={actions} />
        ) : (
          <BucketCardActions clip={clip} moves={actions.moves} />
        )}
      </div>
    </div>
  )
}

function BucketCardActions({
  clip,
  moves,
}: {
  clip: BucketClip
  moves: ClipMoves
}) {
  if (clip.folder === "trash")
    return (
      <CardAction
        label="Restore"
        icon={ArrowCounterClockwiseIcon}
        onClick={() => moves.restore(clip)}
      />
    )

  const kept = clip.folder === "saved"

  return (
    <>
      <CardAction
        label={kept ? "Kept forever · click to undo" : "Keep forever"}
        icon={BookmarkSimpleIcon}
        active={kept}
        onClick={() => moves.keep(clip)}
      />
      <ShareMenu align="end" onShare={(days) => void moves.share(clip, days)}>
        <CardAction label="Share" icon={LinkIcon} />
      </ShareMenu>
      <CardAction
        label="Move to trash"
        icon={TrashIcon}
        destructive
        onClick={() => moves.trash(clip)}
      />
    </>
  )
}

/* A YouTube clip has nothing to keep or trash: copy its link, or delete it
 * from YouTube after asking. */
function YouTubeCardActions({
  clip,
  actions,
}: {
  clip: YouTubeClip
  actions: CardActions
}) {
  return (
    <>
      <CardAction
        label="Copy YouTube link"
        icon={LinkIcon}
        onClick={() => actions.shareYouTube(clip)}
      />
      <CardAction
        label="Delete from YouTube"
        icon={TrashIcon}
        destructive
        onClick={() => actions.deleteYouTube(clip)}
      />
    </>
  )
}

/* On the thumbnail: a YouTube clip YouTube hasn't finished, then where the
 * clip lives, whether it's cut, and its length, above that. */
function ThumbnailBadges({ clip }: { clip: Clip }) {
  const duration = durationOf(clip)

  return (
    <>
      {clip.source === "youtube" && <YouTubeStatus clip={clip} />}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between p-1.5">
        <div className="flex gap-1">
          {clip.source === "youtube" && <YouTubeChip privacy={clip.privacy} />}
          {(clip.source === "youtube" ? !!clip.cut : clip.trimmed) && (
            <Chip>
              <ScissorsIcon className="size-3" />
            </Chip>
          )}
        </div>
        {duration ? <Chip>{formatDuration(duration)}</Chip> : null}
      </div>
    </>
  )
}

/* A button on the thumbnail. It shows on hover or focus, and while its menu
 * is open; a kept clip's bookmark always shows, and touch screens always show
 * them all. Other props, such as a menu trigger's, go to the button. */
function CardAction({
  label,
  icon: Icon,
  active,
  destructive,
  className,
  ...props
}: React.ComponentProps<"button"> & {
  label: string
  icon: React.ElementType
  active?: boolean
  destructive?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={active}
            {...props}
            className={cn(
              "flex size-7 items-center justify-center bg-black/70 text-white backdrop-blur-sm transition-[opacity,color,background-color] outline-none group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-black/90 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary data-popup-open:opacity-100 [@media(hover:none)]:opacity-100",
              active ? "text-primary" : "opacity-0",
              destructive && "hover:text-red-400",
              className
            )}
          />
        }
      >
        <Icon weight={active ? "fill" : "bold"} className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex h-5 items-center bg-black/70 px-1.5 text-[10px] font-medium text-white tabular-nums backdrop-blur-sm">
      {children}
    </span>
  )
}
