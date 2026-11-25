import * as React from "react"
import {
  ArchiveIcon,
  BookmarkSimpleIcon,
  CloudIcon,
  FilmSlateIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  SunIcon,
  TrashIcon,
  YoutubeLogoIcon,
} from "@phosphor-icons/react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { cn } from "cn"
import { toast } from "sonner"

import { ClipGrid } from "@/components/clip-grid"
import { ClipToolbar } from "@/components/clip-toolbar"
import { ConnectStorage } from "@/components/connect-storage"
import type { SettingsTab } from "@/components/settings-dialog"
import { ObsConnect } from "@/components/setup-steps"
import { SignIn } from "@/components/sign-in"
import { useTheme } from "@/components/theme-provider"
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
import { Kbd } from "@/components/ui/kbd"
import { Skeleton } from "@/components/ui/skeleton"
import { YOUTUBE_RED, YouTubeObsSteps } from "@/components/youtube"
import {
  api,
  bucketBytes,
  formatBytes,
  NoStorageError,
  SignInError,
  youtubeConnectUrl,
  type BucketClip,
  type Clip,
  type Settings,
} from "@/lib/api"
import { useClips, useNewClipToasts, useThumbnailWorker } from "@/lib/clips"
import {
  retentionText,
  useHasBucket,
  useHasChannel,
  useSettings,
} from "@/lib/settings"
import {
  byNewest,
  sortsByDay,
  useCategories,
  useGlobalKeys,
  useOpenClipSync,
  usePage,
  useSort,
  useViewCounts,
  useVisibleClips,
  viewsFor,
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

const loadPages = () => import("@/components/info-pages")

const Faq = React.lazy(() => loadPages().then((m) => ({ default: m.Faq })))

const Privacy = React.lazy(() =>
  loadPages().then((m) => ({ default: m.Privacy }))
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

/* Google's consent page lets you untick a permission, and clips refuses a
 * sign-in without all of them. Says how to fix it, unless the message
 * already does. */
const uncheckedGoogleBox = (error: string) =>
  /permission/i.test(error) &&
  /youtube|google/i.test(error) &&
  !/tick|every/i.test(error)

/* The hosted app's sign-in and storage setup come back to /?auth_error=…
 * or /?connected=1. Show it once and tidy the address bar. */
function useAuthFlash() {
  React.useEffect(() => {
    const params = new URLSearchParams(location.search)
    const error = params.get("auth_error")
    const connected = params.has("connected")

    if (error)
      toast.error(error, {
        id: "auth",
        description: uncheckedGoogleBox(error)
          ? "Sign in again and tick every box on Google's page. Better Clips needs each one to upload, list, rename and delete your clips."
          : undefined,
      })

    if (params.get("connected") === "youtube")
      toast.success("YouTube connected", {
        id: "auth",
        description: "Clips you upload from OBS show up here.",
      })
    else if (connected)
      toast.success("Storage connected", {
        id: "auth",
        description: "Now connect OBS with the command below.",
      })

    if (error || connected)
      history.replaceState(null, "", location.pathname + location.hash)
  }, [])
}

/* The FAQ and the privacy policy open without signing in, and without
 * loading any clips. */
export default function App() {
  const page = usePage()

  if (page)
    return (
      <React.Suspense>{page === "faq" ? <Faq /> : <Privacy />}</React.Suspense>
    )

  return <Library />
}

function Library() {
  const { data: clips, isPending, error } = useClips()
  const hasBucket = useHasBucket()
  const views = viewsFor(hasBucket)
  const [chosenView, setView] = React.useState<View>("all")
  /* Without a bucket, "All" is the only tab. */
  const view = views.includes(chosenView) ? chosenView : "all"
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [settingsTab, setSettingsTab] = React.useState<SettingsTab>("obs")
  const [sort, setSort] = useSort()
  const [chosenCategory, setCategory] = React.useState<string | null>(null)
  const categories = useCategories(clips, view)

  /* A category with no clips left in this tab shows them all. */
  const category = categories.some((c) => c.name === chosenCategory)
    ? chosenCategory
    : null

  const visible = useVisibleClips(clips, view, sort, category)
  const { clip, openClip, follow } = useOpenClipSync(clips, view, setView)
  const openSearch = React.useCallback(() => setSearchOpen(true), [])

  const searchable = React.useMemo(
    () => [...(clips ?? [])].sort(byNewest),
    [clips]
  )

  useThumbnailWorker(clips)
  useNewClipToasts(clips, openClip)
  useGlobalKeys(!clip && !settingsOpen, views, openSearch, setView)
  usePreload()
  useAuthFlash()

  if (error instanceof SignInError) return <SignIn kind={error.kind} />

  if (error instanceof NoStorageError) return <ConnectStorage />

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
        views={views}
        hasBucket={hasBucket}
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
          hasBucket={hasBucket}
          onOpen={(c) => openClip(c.key)}
          onSettings={openSettings}
          toolbar={
            <ClipToolbar
              categories={categories}
              category={category}
              onCategory={setCategory}
              sort={sort}
              onSort={setSort}
            />
          }
          byDay={sortsByDay(sort)}
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
            views={views}
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
  views,
  hasBucket,
  view,
  onView,
  onSearch,
  onSettings,
}: {
  clips: Clip[] | undefined
  views: View[]
  hasBucket: boolean
  view: View
  onView: (view: View) => void
  onSearch: () => void
  onSettings: (tab: SettingsTab) => void
}) {
  const counts = useViewCounts(clips)
  const used = bucketBytes(clips ?? [])

  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur-md supports-backdrop-filter:bg-background/65">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-4 sm:px-6">
        <div className="flex items-center gap-2 pr-2">
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex size-full animate-ping bg-primary/60 [animation-duration:2.5s]" />
            <span className="relative inline-flex size-2.5 bg-primary" />
          </span>
          <span className="text-sm font-semibold tracking-tight">
            better clips
          </span>
        </div>

        <nav className="flex items-center">
          {views.map((tab) => (
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
          {hasBucket && (
            <StorageMeter used={used} onClick={() => onSettings("storage")} />
          )}
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
  toolbar,
  byDay,
  hasBucket,
  onSettings,
}: {
  clips: Clip[] | undefined
  visible: Clip[]
  view: View
  pending: boolean
  error: Error | null
  hasBucket: boolean
  onOpen: (clip: Clip) => void
  onSettings: (tab: SettingsTab) => void
  toolbar: React.ReactNode
  byDay: boolean
}) {
  const { data: settings } = useSettings()
  const hasChannel = useHasChannel()

  if (error)
    return (
      <Empty
        icon={ArchiveIcon}
        title="Couldn't load your clips"
        body={error.message}
      />
    )

  if (pending || !clips) return <GridSkeleton />

  if (!clips.length) {
    if (hasBucket) return <FirstRun />

    return hasChannel ? (
      <YouTubeFirstRun />
    ) : (
      <ChooseDestination onOwnKey={() => onSettings("storage")} />
    )
  }

  if (visible.length)
    return (
      <>
        {view === "trash" && (
          <TrashBar
            clips={visible.filter((c) => c.source === "bucket")}
            settings={settings}
          />
        )}
        {toolbar}
        <ClipGrid clips={visible} byDay={byDay} onOpen={onOpen} />
      </>
    )

  const tab = TABS[view]

  return <Empty icon={tab.icon} title={tab.empty} body={tab.hint(settings)} />
}

/* Above the trash: when it clears itself, and a way to clear it now. */
function TrashBar({
  clips,
  settings,
}: {
  clips: BucketClip[]
  settings: Settings | undefined
}) {
  const [selection, setSelection] = React.useState<BucketClip[] | null>(null)
  const qc = useQueryClient()

  const empty = useMutation({
    mutationFn: api.emptyTrash,
    onSuccess: ({ deleted, skipped, failed }) => {
      const message = `Deleted ${deleted} ${deleted === 1 ? "clip" : "clips"} forever`

      const description = [
        skipped && `${skipped} changed or no longer in Trash.`,
        failed && `${failed} couldn't be deleted. Try again.`,
      ]
        .filter(Boolean)
        .join(" ")

      if (failed) toast.error(message, { description })
      else toast.success(message, { description })
    },
    onError: (err) => toast.error(err.message),
    onSettled: () => qc.invalidateQueries({ queryKey: ["clips"] }),
  })

  const size = formatBytes(bucketBytes(clips))

  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border px-4 py-3">
      <p className="text-xs text-muted-foreground">
        {clips.length} {clips.length === 1 ? "clip" : "clips"} · {size}.
        They&apos;re deleted for good after{" "}
        {retentionText(settings?.trashDays ?? 7)}.
      </p>
      <Button
        variant="destructive"
        size="sm"
        disabled={empty.isPending}
        onClick={() => setSelection(clips)}
      >
        <TrashIcon />
        {empty.isPending ? "Emptying…" : "Empty trash"}
      </Button>
      <AlertDialog
        open={!!selection}
        onOpenChange={(open) => !open && setSelection(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the clips shown?</AlertDialogTitle>
            <AlertDialogDescription>
              {selection?.length} {selection?.length === 1 ? "clip" : "clips"} (
              {formatBytes(bucketBytes(selection ?? []))}) will be removed from
              your bucket. Other clips will stay in Trash. This can&apos;t be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!selection) return
                empty.mutate(selection)
                setSelection(null)
              }}
            >
              Delete forever
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
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

/* A YouTube-only account: OBS signs in to YouTube itself, so there's no
 * install command with a setup code. */
function YouTubeFirstRun() {
  return (
    <div className="mx-auto max-w-lg py-16">
      <h1 className="mb-1 text-base font-semibold">No clips yet</h1>
      <p className="mb-6 text-xs leading-relaxed text-muted-foreground">
        Clips you save in OBS go to your YouTube channel and show up here.
      </p>
      <YouTubeObsSteps />
    </div>
  )
}

/* A hosted account with neither a bucket nor a channel yet: pick where
 * clips go before OBS can send any. */
function ChooseDestination({ onOwnKey }: { onOwnKey: () => void }) {
  return (
    <div className="mx-auto max-w-2xl py-16">
      <h1 className="mb-1 text-base font-semibold">
        Choose where your clips go
      </h1>
      <p className="mb-6 text-xs leading-relaxed text-muted-foreground">
        Keep them in a bucket in your own Cloudflare account, or upload them to
        your YouTube channel. You can add the other one later.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-3 border bg-muted/30 p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <CloudIcon weight="fill" className="size-4 text-primary" />
            Your own R2 bucket
          </p>
          <p className="flex-1 text-[11px] leading-relaxed text-muted-foreground">
            Download clips, trim them losslessly and share them with expiring
            links. Free up to 10 GB.
          </p>
          <a href="/api/auth/setup" className={buttonVariants()}>
            Set up automatically
          </a>
          <button
            type="button"
            onClick={onOwnKey}
            className="self-start text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Use another bucket, with your own key
          </button>
        </div>
        <div className="flex flex-col gap-3 border bg-muted/30 p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <YoutubeLogoIcon
              weight="fill"
              className={cn("size-4", YOUTUBE_RED)}
            />
            Your YouTube channel
          </p>
          <p className="flex-1 text-[11px] leading-relaxed text-muted-foreground">
            OBS uploads each clip to your channel, and you watch, rename and cut
            them here. They take no storage.
          </p>
          <a
            href={youtubeConnectUrl("connect")}
            className={buttonVariants({ variant: "outline" })}
          >
            Connect YouTube
          </a>
        </div>
      </div>
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
