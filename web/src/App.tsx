import * as React from "react"
import {
  ArchiveIcon,
  FilmSlateIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  SunIcon,
} from "@phosphor-icons/react"
import { toast } from "sonner"

import { ClipGrid } from "@/components/clip-grid"
import { ClipToolbar } from "@/components/clip-toolbar"
import { Wordmark } from "@/components/brand"
import type { SettingsTab } from "@/components/settings-dialog"
import { SignIn } from "@/components/sign-in"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { buttonVariants } from "@/components/ui/button-variants"
import { Kbd } from "@/components/ui/kbd"
import { Skeleton } from "@/components/ui/skeleton"
import { YouTubeObsSteps } from "@/components/youtube"
import { YouTubeConsent } from "@/components/youtube-consent"
import { SignInError, type Clip } from "@/lib/api"
import { useClips, useNewClipToasts } from "@/lib/clips"
import { useMe } from "@/lib/settings"
import {
  byNewest,
  sortsByDay,
  useCategories,
  useGlobalKeys,
  useOpenClipSync,
  usePage,
  useSort,
  useVisibleClips,
} from "@/lib/view"

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

const Terms = React.lazy(() => loadPages().then((m) => ({ default: m.Terms })))

const Home = React.lazy(() =>
  import("@/components/home").then((m) => ({ default: m.Home }))
)

const PAGES = { home: Home, faq: Faq, privacy: Privacy, terms: Terms }

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

/* The hosted app's sign-in come back to /?auth_error=…
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

    if (error || connected)
      history.replaceState(null, "", location.pathname + location.hash)
  }, [])
}

/* The homepage, the FAQ, the privacy policy and the terms open without
 * signing in, and without loading any clips. */
export default function App() {
  const page = usePage()

  if (page) {
    const Page = PAGES[page]

    return (
      <React.Suspense>
        <Page />
      </React.Suspense>
    )
  }

  return <Library />
}

function Library() {
  const { data: clips, isPending, error, notice, returning } = useClips()
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [settingsTab, setSettingsTab] = React.useState<SettingsTab>("obs")
  const [sort, setSort] = useSort()
  const [chosenCategory, setCategory] = React.useState<string | null>(null)
  const categories = useCategories(clips)

  /* A category with no clips left in this tab shows them all. */
  const category = categories.some((c) => c.name === chosenCategory)
    ? chosenCategory
    : null

  const visible = useVisibleClips(clips, sort, category)
  const { clip, openClip } = useOpenClipSync(clips)
  const openSearch = React.useCallback(() => setSearchOpen(true), [])

  const searchable = React.useMemo(
    () => [...(clips ?? [])].sort(byNewest),
    [clips]
  )

  useNewClipToasts(clips, openClip)
  useGlobalKeys(!clip && !settingsOpen, openSearch)
  usePreload()
  useAuthFlash()

  if (error instanceof SignInError) return <SignIn />

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
        onSearch={openSearch}
        onSettings={openSettings}
      />

      <main className="mx-auto max-w-[1600px] px-4 pt-6 pb-24 sm:px-8">
        {notice && (
          <p role="status" className="mb-6 border bg-card px-4 py-3 text-sm">
            {notice}
          </p>
        )}
        <ClipsBody
          returning={Boolean(returning)}
          clips={clips}
          visible={visible}
          pending={isPending}
          error={error}
          onOpen={(c) => openClip(c.key)}
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
          hasPrev={index > 0}
          hasNext={index >= 0 && index < visible.length - 1}
        />
        {searchOpen && (
          <SearchDialog
            open={searchOpen}
            onOpenChange={setSearchOpen}
            clips={searchable}
            onOpenClip={openClip}
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
  onSearch,
  onSettings,
}: {
  clips: Clip[] | undefined
  onSearch: () => void
  onSettings: (tab: SettingsTab) => void
}) {
  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur-md supports-backdrop-filter:bg-background/65">
      <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-2 px-4 sm:gap-4 sm:px-8">
        <a href="/" aria-label="Better Clips home" className="pr-1 sm:pr-3">
          <Wordmark className="[&>span:last-child]:hidden sm:[&>span:last-child]:inline" />
        </a>

        <h1 className="flex items-center gap-2 text-sm font-semibold">
          <FilmSlateIcon />
          Library{" "}
          <span className="font-mono text-muted-foreground">
            {clips?.length}
          </span>
        </h1>

        <div className="ml-auto flex items-center gap-2">
          <SearchButton onClick={onSearch} />
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
        className="hidden h-9 w-60 items-center gap-2 border border-input bg-transparent px-3 text-sm text-muted-foreground transition-colors outline-none hover:border-foreground/20 hover:text-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 md:flex dark:bg-input/30"
      >
        <MagnifyingGlassIcon className="size-4" />
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

function ObsButton({ onClick }: { onClick: (tab: SettingsTab) => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Settings"
      title="Settings"
      onClick={() => onClick("youtube")}
    >
      <GearSixIcon />
    </Button>
  )
}

function ClipsBody({
  returning,
  clips,
  visible,
  pending,
  error,
  onOpen,
  toolbar,
  byDay,
}: {
  clips: Clip[] | undefined
  returning: boolean
  visible: Clip[]
  pending: boolean
  error: Error | null
  onOpen: (clip: Clip) => void
  toolbar: React.ReactNode
  byDay: boolean
}) {
  const { data: account } = useMe()

  if (error && !clips?.length)
    return (
      <Empty
        icon={ArchiveIcon}
        title="Couldn't load your clips"
        body={error.message}
      />
    )

  if (pending || !clips) return <GridSkeleton />

  if (!clips.length && !account) return <GridSkeleton />

  if (!clips.length && !account?.youtube)
    return (
      <FirstRunShell intro="Connect your channel to see the clips you upload from OBS.">
        <YouTubeConsent purpose="connect" className={buttonVariants()}>
          Connect YouTube
        </YouTubeConsent>
      </FirstRunShell>
    )

  if (!clips.length && !returning) return <YouTubeFirstRun />

  if (visible.length)
    return (
      <>
        {toolbar}
        <ClipGrid clips={visible} byDay={byDay} onOpen={onOpen} />
      </>
    )

  return (
    <Empty
      icon={FilmSlateIcon}
      title="No clips"
      body="Save a replay in OBS and it will show up here."
    />
  )
}

/* The empty library's heading: big and condensed, like the homepage. */
function FirstRunShell({
  intro,
  children,
}: {
  intro: string
  children: React.ReactNode
}) {
  return (
    <div className="mx-auto max-w-xl py-14 sm:py-20">
      <h1 className="font-display text-[clamp(2.75rem,9vw,4.5rem)]">
        No clips yet
      </h1>
      <p className="mt-4 mb-10 text-lg text-muted-foreground">{intro}</p>
      {children}
    </div>
  )
}

function YouTubeFirstRun() {
  return (
    <FirstRunShell intro="Save a replay in OBS. It goes to your channel and shows up here.">
      <YouTubeObsSteps />
    </FirstRunShell>
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
      <Icon weight="duotone" className="mb-5 size-9 text-primary" />
      <p className="font-display text-4xl">{title}</p>
      <p className="mt-3 max-w-sm text-muted-foreground">{body}</p>
    </div>
  )
}

const SKELETONS = ["a", "b", "c", "d", "e", "f", "g", "h"]

function GridSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-x-5 gap-y-8 pt-12">
      {SKELETONS.map((id) => (
        <div key={id} className="flex flex-col gap-2">
          <Skeleton className="aspect-video w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
    </div>
  )
}
