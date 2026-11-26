import * as React from "react"
import { LinkIcon, TrashIcon } from "@phosphor-icons/react"
import { cn } from "cn"

import {
  DeleteYouTubeDialog,
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
  dayLabel,
  displayTitle,
  durationOf,
  formatDuration,
  type Clip,
  type YouTubeClip,
} from "@/lib/api"
import { useClipTime } from "@/lib/clock"
import { copyYouTubeLink, useYouTubeChange } from "@/lib/youtube"

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

  const youtube = useYouTubeChange()
  const [deleting, setDeleting] = React.useState<YouTubeClip | null>(null)

  const cardActions: CardActions = {
    shareYouTube: copyYouTubeLink,
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
                  actions={cardActions}
                  onOpen={() => onOpen(clip)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
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

function groupSummary(list: Clip[]) {
  return `${list.length} ${list.length === 1 ? "clip" : "clips"}`
}

/* What the buttons on a card do. */
type CardActions = {
  shareYouTube: (clip: YouTubeClip) => void
  deleteYouTube: (clip: YouTubeClip) => void
}

function ClipCard({
  clip,
  byDay,
  actions,
  onOpen,
}: {
  clip: Clip
  byDay: boolean
  actions: CardActions
  onOpen: () => void
}) {
  const [loaded, setLoaded] = React.useState(false)
  const clipTime = useClipTime()

  const thumbnail = clip.thumbnail

  return (
    <div className="group relative">
      <button
        onClick={onOpen}
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
          <ThumbnailBadges clip={clip} />
        </div>
        <div className="flex flex-col gap-0.5 px-0.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-sm font-semibold">
              {displayTitle(clip)}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
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
        <YouTubeCardActions clip={clip} actions={actions} />
      </div>
    </div>
  )
}

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

function ThumbnailBadges({ clip }: { clip: Clip }) {
  const duration = durationOf(clip)

  return (
    <>
      <YouTubeStatus clip={clip} />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between p-1.5">
        <div className="flex gap-1">
          <YouTubeChip privacy={clip.privacy} />
        </div>
        {duration ? <Chip>{formatDuration(duration)}</Chip> : null}
      </div>
    </>
  )
}

function CardAction({
  label,
  icon: Icon,
  destructive,
  className,
  ...props
}: React.ComponentProps<"button"> & {
  label: string
  icon: React.ElementType
  destructive?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            {...props}
            className={cn(
              "flex size-7 items-center justify-center bg-black/70 text-white opacity-0 backdrop-blur-sm transition-[opacity,color,background-color] outline-none group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-black/90 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary data-popup-open:opacity-100 [@media(hover:none)]:opacity-100",
              destructive && "hover:text-red-400",
              className
            )}
          />
        }
      >
        <Icon weight="bold" className="size-3.5" />
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
