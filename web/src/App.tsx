import * as React from "react"
import {
  ArchiveIcon,
  BookmarkSimpleIcon,
  FilmSlateIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  SunIcon,
  TrashIcon,
} from "@phosphor-icons/react"
import { cn } from "cn"

import { ClipGrid } from "@/components/clip-grid"
import type { SettingsTab } from "@/components/settings-dialog"
import { ObsConnect } from "@/components/setup-steps"
import { SignIn } from "@/components/sign-in"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBytes, SignInError, type Clip, type Settings } from "@/lib/api"
import { useClips, useNewClipToasts, useThumbnailWorker } from "@/lib/clips"
import { retentionText, useSettings } from "@/lib/settings"
import {
  byNewest,
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
    hint: () => "Save a replay in OBS and it will show up here.",
  },
  saved: {
    label: "Kept",
    icon: BookmarkSimpleIcon,
    empty: "Nothing kept yet",
    hint: (s?: Settings) =>
      s?.replaysDays
        ? `Press K on a clip to keep it forever. Other clips are cleared after ${retentionText(s.replaysDays)}.`
        : "Press K on a clip to keep it.",
  },
  trash: {
    label: "Trash",
    icon: TrashIcon,
    empty: "Trash is empty",
    hint: (s?: Settings) =>
      `Deleted clips stay here for ${retentionText(s?.trashDays ?? 7)}.`,
  },
} satisfies Record<
  View,
  {
    label: string
    icon: React.ElementType
    empty: string
    hint: (settings?: Settings) => string
  }
>

const FREE_BYTES = 10 * 1024 ** 3

/* The viewer and dialogs load after first paint, then preload while the
 * browser is idle, so the grid shows fast and opening them stays instant. */
const loadViewer = () => import("@/components/clip-viewer")
const loadSettings = () => import("@/components/settings-dialog")
const loadSearch = () => import("@/components/search-dialog")

const ClipViewer = React.lazy(() =>
  loadViewer().then((m) => ({ default: m.ClipViewer }))
)

const SettingsDialog = React.lazy(() =>
  loadSettings().then((m) => ({ default: m.SettingsDialog }))
)

const SearchDialog = React.lazy(() =>
  loadSearch().then((m) => ({ default: m.SearchDialog }))
)

function usePreload() {
  React.useEffect(() => {
    const preload = () => {
      void loadViewer()
      void loadSettings()
      void loadSearch()
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
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [settingsTab, setSettingsTab] = React.useState<SettingsTab>("obs")
  const visible = useVisibleClips(clips, view)
  const { clip, openClip, follow } = useOpenClipSync(clips, view, setView)
  const openSearch = React.useCallback(() => setSearchOpen(true), [])

  const searchable = React.useMemo(
    () => [...(clips ?? [])].sort(byNewest),
    [clips]
  )

  useThumbnailWorker(clips)
  useNewClipToasts(clips, openClip)
  useGlobalKeys(!clip && !settingsOpen, openSearch, setView)
  usePreload()

  if (error instanceof SignInError) return <SignIn setUp={error.setUp} />

  const index = clip ? visible.findIndex((c) => c.key === clip.key) : -1

  const navigate = (from: Clip, step: number) => {
    const next = visible[visible.findIndex((c) => c.key === from.key) + step]

    if (next) openClip(next.key)
  }

  const openSettings = (tab: SettingsTab) => {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }

  return (
    <div className="min-h-svh">
      <AppHeader
        clips={clips}
        view={view}
        onView={setView}
        onSearch={openSearch}
        onSettings={openSettings}
      />

      <main className="mx-auto max-w-[1600px] px-4 pt-4 pb-24 sm:px-6">
        <ClipsBody
          clips={clips}
          visible={visible}
          view={view}
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
        {searchOpen && (
          <SearchDialog
            open={searchOpen}
            onOpenChange={setSearchOpen}
            clips={searchable}
            onOpenClip={openClip}
            onView={setView}
            onSettings={openSettings}
          />
        )}
        {settingsOpen && (
          <SettingsDialog
            open={settingsOpen}
            tab={settingsTab}
            onOpenChange={setSettingsOpen}
            onTab={setSettingsTab}
          />
        )}
      </React.Suspense>
    </div>
  )
}

function AppHeader({
  clips,
  view,
  onView,
  onSearch,
  onSettings,
}: {
  clips: Clip[] | undefined
  view: View
  onView: (view: View) => void
  onSearch: () => void
  onSettings: (tab: SettingsTab) => void
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
          <SearchButton onClick={onSearch} />
          <StorageMeter used={used} onClick={() => onSettings("storage")} />
          <ThemeButton />
          <ObsButton onClick={onSettings} />
        </div>
      </div>
    </header>
  )
}

/* Looks like a search box, but opens the search dialog. */
function SearchButton({ onClick }: { onClick: () => void }) {
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        className="hidden h-8 w-56 items-center gap-2 border border-input bg-transparent px-2.5 text-xs text-muted-foreground transition-colors outline-none hover:border-foreground/20 hover:text-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 md:flex dark:bg-input/30"
      >
        <MagnifyingGlassIcon className="size-3.5" />
        Search clips
        <Kbd className="ml-auto">/</Kbd>
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Search clips"
        onClick={onClick}
        className="md:hidden"
      >
        <MagnifyingGlassIcon />
      </Button>
    </>
  )
}

function ThemeButton() {
  const { setTheme } = useTheme()

  /* Flips whatever is showing now, including when the theme is "system". */
  const toggle = () =>
    setTheme(
      document.documentElement.classList.contains("dark") ? "light" : "dark"
    )

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Switch between light and dark"
      title="Switch between light and dark"
      onClick={toggle}
    >
      <SunIcon className="hidden dark:block" />
      <MoonIcon className="dark:hidden" />
    </Button>
  )
}

/* Asks you to connect OBS until it has checked in once; after that it is
 * just the way into Settings. */
function ObsButton({ onClick }: { onClick: (tab: SettingsTab) => void }) {
  const { data: settings } = useSettings()

  if (settings && !settings.obsSeen)
    return (
      <Button variant="outline" size="sm" onClick={() => onClick("obs")}>
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping bg-primary/70 [animation-duration:1.8s]" />
          <span className="relative inline-flex size-1.5 bg-primary" />
        </span>
        Connect OBS
      </Button>
    )

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Settings"
      title="Settings"
      onClick={() => onClick("obs")}
    >
      <GearSixIcon />
    </Button>
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
  pending,
  error,
  onOpen,
}: {
  clips: Clip[] | undefined
  visible: Clip[]
  view: View
  pending: boolean
  error: Error | null
  onOpen: (clip: Clip) => void
}) {
  const { data: settings } = useSettings()

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

  return <Empty icon={tab.icon} title={tab.empty} body={tab.hint(settings)} />
}

function FirstRun() {
  return (
    <div className="mx-auto max-w-lg py-16">
      <h1 className="mb-1 text-base font-semibold">No clips yet</h1>
      <p className="mb-6 text-xs text-muted-foreground">
        Connect OBS once, then every replay you save lands here a second later.
      </p>
      <ObsConnect />
    </div>
  )
}

function StorageMeter({
  used,
  onClick,
}: {
  used: number
  onClick: () => void
}) {
  const pct = Math.min(100, (used / FREE_BYTES) * 100)

  return (
    <button
      type="button"
      onClick={onClick}
      className="hidden w-28 flex-col gap-1 px-1 py-1 outline-none hover:opacity-80 focus-visible:ring-1 focus-visible:ring-ring lg:flex"
      title={`${formatBytes(used)} of the free 10 GB. Click for storage settings.`}
      aria-label={`Storage: ${formatBytes(used)} of 10 GB used`}
    >
      <div className="flex w-full justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>{formatBytes(used)}</span>
        <span>10 GB</span>
      </div>
      <div className="h-0.5 w-full bg-muted">
        <div
          className={cn(
            "h-full bg-primary transition-[width]",
            pct > 85 && "bg-destructive"
          )}
          style={{ width: `${Math.max(pct, 1)}%` }}
        />
      </div>
    </button>
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
