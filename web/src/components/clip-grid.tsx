import * as React from "react"
import {
  ArrowCounterClockwiseIcon,
  BookmarkSimpleIcon,
  ScissorsIcon,
  TrashIcon,
} from "@phosphor-icons/react"
import { cn } from "cn"

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

import {
  dayLabel,
  daysLeft,
  formatBytes,
  formatDuration,
  mediaUrl,
  thumbUrl,
  type Clip,
  type Settings,
} from "@/lib/api"
import { useClipMoves, type ClipMoves } from "@/lib/clip-actions"
import { useSettings } from "@/lib/settings"

export function ClipGrid({
  clips,
  onOpen,
}: {
  clips: Clip[]
  onOpen: (clip: Clip) => void
}) {
  const days = React.useMemo(() => {
    const groups = new Map<string, Clip[]>()

    for (const clip of clips) {
      const list = groups.get(clip.day) ?? []
      list.push(clip)
      groups.set(clip.day, list)
    }

    return [...groups]
  }, [clips])

  const { data: settings } = useSettings()
  const moves = useClipMoves()

  return (
    <TooltipProvider delay={400}>
      <div className="flex flex-col gap-10">
        {days.map(([day, list]) => (
          <section key={day}>
            <div className="sticky top-14 z-20 -mx-1 mb-3 flex items-baseline gap-3 bg-background/80 px-1 py-2 backdrop-blur-md">
              <h2 className="text-xs font-semibold">{dayLabel(day)}</h2>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {list.length} {list.length === 1 ? "clip" : "clips"} ·{" "}
                {formatBytes(list.reduce((n, c) => n + c.size, 0))}
              </span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-x-4 gap-y-6">
              {list.map((clip) => (
                <ClipCard
                  key={clip.key}
                  clip={clip}
                  settings={settings}
                  moves={moves}
                  onOpen={() => onOpen(clip)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </TooltipProvider>
  )
}

/* Hovering for a moment plays a muted preview from the start. Keep and
 * delete sit on the thumbnail, so they work without opening the clip. */
function ClipCard({
  clip,
  settings,
  moves,
  onOpen,
}: {
  clip: Clip
  settings: Settings | undefined
  moves: ClipMoves
  onOpen: () => void
}) {
  const [loaded, setLoaded] = React.useState(false)
  const [preview, setPreview] = React.useState(false)
  const timer = React.useRef<number>(undefined)
  const left = daysLeft(clip, settings)

  const startPreview = () => {
    timer.current = window.setTimeout(() => setPreview(true), 350)
  }

  const stopPreview = () => {
    window.clearTimeout(timer.current)
    setPreview(false)
  }

  const kept = clip.folder === "saved"

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
          {clip.thumb ? (
            <img
              src={thumbUrl(clip)}
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
          {preview && (
            <video
              src={mediaUrl(clip.key)}
              autoPlay
              muted
              loop
              playsInline
              className="absolute inset-0 size-full animate-in object-cover duration-200 fade-in-0"
            />
          )}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between p-1.5">
            <div className="flex gap-1">
              {clip.trimmed && (
                <Chip>
                  <ScissorsIcon className="size-3" />
                </Chip>
              )}
            </div>
            {clip.thumb?.duration ? (
              <Chip>{formatDuration(clip.thumb.duration)}</Chip>
            ) : null}
          </div>
        </div>
        <div className="flex items-baseline justify-between gap-3 px-0.5">
          <span className="truncate text-xs font-medium">{clip.title}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {left !== null && left <= 5 ? (
              <span className={cn(left <= 2 && "text-destructive")}>
                {left}d left ·{" "}
              </span>
            ) : null}
            {clip.time.slice(0, 5)}
          </span>
        </div>
      </button>
      <div className="absolute top-1.5 right-1.5 flex gap-1">
        {clip.folder === "trash" ? (
          <CardAction
            label="Restore"
            icon={ArrowCounterClockwiseIcon}
            onClick={() => moves.restore(clip)}
          />
        ) : (
          <>
            <CardAction
              label={kept ? "Kept forever · click to undo" : "Keep forever"}
              icon={BookmarkSimpleIcon}
              active={kept}
              onClick={() => moves.keep(clip)}
            />
            <CardAction
              label="Move to trash"
              icon={TrashIcon}
              destructive
              onClick={() => moves.trash(clip)}
            />
          </>
        )}
      </div>
    </div>
  )
}

/* A button on the thumbnail. It shows on hover or focus; a kept clip's
 * bookmark always shows, and touch screens always show them all. */
function CardAction({
  label,
  icon: Icon,
  active,
  destructive,
  onClick,
}: {
  label: string
  icon: React.ElementType
  active?: boolean
  destructive?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={active}
            onClick={onClick}
            className={cn(
              "flex size-7 items-center justify-center bg-black/70 text-white backdrop-blur-sm transition-[opacity,color,background-color] outline-none group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-black/90 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary [@media(hover:none)]:opacity-100",
              active ? "text-primary" : "opacity-0",
              destructive && "hover:text-red-400"
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
