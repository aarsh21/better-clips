import * as React from "react"
import {
  ArchiveIcon,
  BookmarkSimpleIcon,
  FilmSlateIcon,
  MagnifyingGlassIcon,
  PlugsConnectedIcon,
  TrashIcon,
} from "@phosphor-icons/react"
import { cn } from "cn"

import { ClipGrid } from "@/components/clip-grid"
import { SetupSteps } from "@/components/setup-steps"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBytes, type Clip } from "@/lib/api"
import { useClips, useNewClipToasts, useThumbnailWorker } from "@/lib/clips"
import {
  useGlobalKeys,
  useOpenClipSync,
  useViewCounts,
  useVisibleClips,
  VIEWS,
  type View,
} from "@/lib/view"

const TABS = {
  all: {
    label: "All",
    icon: FilmSlateIcon,
    empty: "No clips",
    hint: "Save a replay in OBS and it will show up here.",
  },
  saved: {
    label: "Kept",
    icon: BookmarkSimpleIcon,
    empty: "Nothing kept yet",
    hint: "Press K on a clip to keep it forever. Other clips are cleared after 30 days.",
  },
  trash: {
    label: "Trash",
    icon: TrashIcon,
    empty: "Trash is empty",
    hint: "Deleted clips stay here for 7 days.",
  },
} satisfies Record<
  View,
  { label: string; icon: React.ElementType; empty: string; hint: string }
>

const FREE_BYTES = 10 * 1024 ** 3

/* The viewer and setup dialog load after first paint, then preload while the
 * browser is idle, so the grid shows fast and opening a clip stays instant. */
const loadViewer = () => import("@/components/clip-viewer")
const loadSetup = () => import("@/components/setup-dialog")

const ClipViewer = React.lazy(() =>
  loadViewer().then((m) => ({ default: m.ClipViewer }))
)

const SetupDialog = React.lazy(() =>
  loadSetup().then((m) => ({ default: m.SetupDialog }))
)

function usePreload() {
  React.useEffect(() => {
    const preload = () => {
      void loadViewer()
      void loadSetup()
    }

    if (typeof requestIdleCallback === "undefined") {
      const timer = setTimeout(preload, 1500)

      return () => clearTimeout(timer)
    }

    const id = requestIdleCallback(preload, { timeout: 3000 })

    return () => cancelIdleCallback(id)
  }, [])
}

export default function App() {
  const { data: clips, isPending, error } = useClips()
  const [view, setView] = React.useState<View>("all")
  const [query, setQuery] = React.useState("")
  const [setupOpen, setSetupOpen] = React.useState(false)
  const search = React.useRef<HTMLInputElement>(null)
  const visible = useVisibleClips(clips, view, query)
  const { clip, openClip, follow } = useOpenClipSync(clips, view, setView)

  useThumbnailWorker(clips)
  useNewClipToasts(clips, openClip)
  useGlobalKeys(!clip, search, setView)
  usePreload()

  const index = clip ? visible.findIndex((c) => c.key === clip.key) : -1

  const navigate = (from: Clip, step: number) => {
    const next = visible[visible.findIndex((c) => c.key === from.key) + step]

    if (next) openClip(next.key)
  }

  return (
    <div className="min-h-svh">
      <AppHeader
        clips={clips}
        view={view}
        onView={setView}
        query={query}
        onQuery={setQuery}
        search={search}
        onSetup={() => setSetupOpen(true)}
      />

      <main className="mx-auto max-w-[1600px] px-4 pt-4 pb-24 sm:px-6">
        <div className="mb-4 md:hidden">
          <Input
            aria-label="Search clips"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search clips"
          />
        </div>
        <ClipsBody
          clips={clips}
          visible={visible}
          view={view}
          query={query}
          pending={isPending}
          error={error}
          onOpen={(c) => openClip(c.key)}
        />
      </main>

      <React.Suspense>
        <ClipViewer
          clip={clip}
          onClose={() => openClip(null)}
          onNavigate={navigate}
          onOpen={openClip}
          onMoved={follow}
          hasPrev={index > 0}
          hasNext={index >= 0 && index < visible.length - 1}
        />
        {setupOpen && (
          <SetupDialog open={setupOpen} onOpenChange={setSetupOpen} />
        )}
      </React.Suspense>
    </div>
  )
}

function AppHeader({
  clips,
  view,
  onView,
  query,
  onQuery,
  search,
  onSetup,
}: {
  clips: Clip[] | undefined
  view: View
  onView: (view: View) => void
  query: string
  onQuery: (query: string) => void
  search: React.RefObject<HTMLInputElement | null>
  onSetup: () => void
}) {
  const counts = useViewCounts(clips)
  const used = (clips ?? []).reduce((n, c) => n + c.size, 0)

  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur-md supports-backdrop-filter:bg-background/65">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-4 sm:px-6">
        <div className="flex items-center gap-2 pr-2">
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex size-full animate-ping bg-primary/60 [animation-duration:2.5s]" />
            <span className="relative inline-flex size-2.5 bg-primary" />
          </span>
          <span className="text-sm font-semibold tracking-tight">clips</span>
        </div>

        <nav className="flex items-center">
          {VIEWS.map((tab) => (
            <TabButton
              key={tab}
              tab={tab}
              active={view === tab}
              count={counts[tab]}
              onClick={() => onView(tab)}
            />
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <div className="relative hidden md:block">
            <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={search}
              aria-label="Search clips"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
              placeholder="Search clips"
              className="h-8 w-56 pr-8 pl-8"
            />
            <Kbd className="absolute top-1/2 right-1.5 -translate-y-1/2">/</Kbd>
          </div>
          <StorageMeter used={used} />
          <Button variant="outline" size="sm" onClick={onSetup}>
            <PlugsConnectedIcon />
            <span className="hidden sm:inline">Connect OBS</span>
          </Button>
        </div>
      </div>
    </header>
  )
}

function TabButton({
  tab,
  active,
  count,
  onClick,
}: {
  tab: View
  active: boolean
  count: number
  onClick: () => void
}) {
  const { label, icon: Icon } = TABS[tab]

  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex h-14 items-center gap-1.5 px-3 text-xs text-muted-foreground transition-colors hover:text-foreground",
        active && "text-foreground"
      )}
    >
      <Icon className="size-3.5" weight={active ? "fill" : "regular"} />
      <span className="hidden sm:inline">{label}</span>
      <span className="text-[10px] tabular-nums opacity-60">{count || ""}</span>
      {active && (
        <span className="absolute inset-x-3 -bottom-px h-px bg-primary" />
      )}
    </button>
  )
}

function ClipsBody({
  clips,
  visible,
  view,
  query,
  pending,
  error,
  onOpen,
}: {
  clips: Clip[] | undefined
  visible: Clip[]
  view: View
  query: string
  pending: boolean
  error: Error | null
  onOpen: (clip: Clip) => void
}) {
  if (error)
    return (
      <Empty
        icon={ArchiveIcon}
        title="Couldn't load your clips"
        body={error.message}
      />
    )

  if (pending || !clips) return <GridSkeleton />

  if (!clips.length) return <FirstRun />

  if (visible.length) return <ClipGrid clips={visible} onOpen={onOpen} />

  const tab = TABS[view]

  return query ? (
    <Empty
      icon={MagnifyingGlassIcon}
      title="Nothing matches"
      body={`No clips match "${query}".`}
    />
  ) : (
    <Empty icon={tab.icon} title={tab.empty} body={tab.hint} />
  )
}

function FirstRun() {
  return (
    <div className="mx-auto max-w-lg py-16">
      <h1 className="mb-1 text-base font-semibold">No clips yet</h1>
      <p className="mb-6 text-xs text-muted-foreground">
        Connect OBS once, then every replay you save lands here a second later.
      </p>
      <SetupSteps />
    </div>
  )
}

function StorageMeter({ used }: { used: number }) {
  const pct = Math.min(100, (used / FREE_BYTES) * 100)

  return (
    <div
      className="hidden w-28 flex-col gap-1 lg:flex"
      title={`${formatBytes(used)} of the free 10 GB`}
    >
      <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>{formatBytes(used)}</span>
        <span>10 GB</span>
      </div>
      <div className="h-0.5 bg-muted">
        <div
          className={cn(
            "h-full bg-primary transition-[width]",
            pct > 85 && "bg-destructive"
          )}
          style={{ width: `${Math.max(pct, 1)}%` }}
        />
      </div>
    </div>
  )
}

function Empty({
  icon: Icon,
  title,
  body,
}: {
  icon: React.ElementType
  title: string
  body: string
}) {
  return (
    <div className="flex flex-col items-center py-32 text-center">
      <Icon className="mb-4 size-6 text-muted-foreground/60" />
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-xs text-xs text-muted-foreground">{body}</p>
    </div>
  )
}

const SKELETONS = ["a", "b", "c", "d", "e", "f", "g", "h"]

function GridSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-x-4 gap-y-6 pt-10">
      {SKELETONS.map((id) => (
        <div key={id} className="flex flex-col gap-2">
          <Skeleton className="aspect-video w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
    </div>
  )
}
