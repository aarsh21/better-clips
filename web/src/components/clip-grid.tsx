import * as React from "react"
import { BookmarkSimpleIcon, ScissorsIcon } from "@phosphor-icons/react"
import { cn } from "cn"

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

  return (
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
                onOpen={() => onOpen(clip)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

/* Hovering for a moment plays a muted preview from the start. */
function ClipCard({
  clip,
  settings,
  onOpen,
}: {
  clip: Clip
  settings: Settings | undefined
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

  return (
    <button
      onClick={onOpen}
      onPointerEnter={(e) => e.pointerType === "mouse" && startPreview()}
      onPointerLeave={stopPreview}
      onFocus={startPreview}
      onBlur={stopPreview}
      className="group flex flex-col gap-2 text-left outline-none"
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
            {clip.folder === "saved" && (
              <Chip>
                <BookmarkSimpleIcon
                  weight="fill"
                  className="size-3 text-primary"
                />
              </Chip>
            )}
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
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex h-5 items-center bg-black/70 px-1.5 text-[10px] font-medium text-white tabular-nums backdrop-blur-sm">
      {children}
    </span>
  )
}
