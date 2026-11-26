import * as React from "react"
import {
  ArrowRightIcon,
  CheckIcon,
  CloudArrowUpIcon,
  CloudIcon,
  CopyIcon,
  DatabaseIcon,
  KeyboardIcon,
  MoonIcon,
  ScissorsIcon,
  SunIcon,
  MonitorPlayIcon,
} from "@phosphor-icons/react"
import { cn } from "cn"
import { toast } from "sonner"

import { useTheme } from "@/components/theme-provider"
import { buttonVariants } from "@/components/ui/button-variants"
import { APP_PATH } from "@/lib/view"

const REPO = "https://github.com/aarsh21/better-clips"
const DEPLOY = `https://deploy.workers.cloudflare.com/?url=${REPO}/tree/main/web`

const INSTALL = {
  windows: {
    label: "Windows",
    shell: "PowerShell",
    command:
      "irm https://raw.githubusercontent.com/aarsh21/better-clips/main/install.ps1 | iex",
  },
  macos: {
    label: "macOS",
    shell: "Terminal",
    command:
      "curl -fsSL https://raw.githubusercontent.com/aarsh21/better-clips/main/install.sh | sh",
  },
  linux: {
    label: "Linux",
    shell: "Terminal",
    command:
      "curl -fsSL https://raw.githubusercontent.com/aarsh21/better-clips/main/install.sh | sh",
  },
} as const

type Os = keyof typeof INSTALL

const OSES: Os[] = ["windows", "macos", "linux"]

/* Sample clips for the dashboard mock: invented games, with frames made for
 * this page. */
const SAMPLE_CLIPS = [
  {
    id: "a",
    img: "arena",
    title: "Clutch 1v3",
    game: "Neon Bastion",
    time: "21:14",
    length: "0:30",
  },
  {
    id: "b",
    img: "race",
    title: "Last-lap pass",
    game: "Overdrive 99",
    time: "21:02",
    length: "0:20",
  },
  {
    id: "c",
    img: "boss",
    title: "Hollow Choir, no hit",
    game: "Ashen Vigil",
    time: "19:48",
    length: "0:45",
  },
  {
    id: "d",
    img: "alley",
    title: "Ace on B site",
    game: "Sandline",
    time: "18:30",
    length: "0:30",
  },
  {
    id: "e",
    img: "royale",
    title: "Final circle",
    game: "Dropzone",
    time: "17:05",
    length: "0:25",
  },
  {
    id: "f",
    img: "stream",
    title: "Drift line on stream",
    game: "Night Circuit",
    time: "16:41",
    length: "0:40",
  },
]

function guessOs(): Os {
  if (typeof navigator === "undefined") return "windows"
  const ua = navigator.userAgent

  if (/Mac/.test(ua)) return "macos"

  if (/Linux|X11/.test(ua) && !/Android/.test(ua)) return "linux"

  return "windows"
}

function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <span className="size-2.5 bg-primary" aria-hidden />
      <span className="text-[17px] leading-none font-extrabold tracking-[-0.01em] [font-stretch:78%]">
        Better Clips
      </span>
    </span>
  )
}

function ThemeToggle() {
  const { setTheme } = useTheme()

  return (
    <button
      type="button"
      aria-label="Switch between light and dark"
      title="Switch between light and dark"
      onClick={() =>
        setTheme(
          document.documentElement.classList.contains("dark") ? "light" : "dark"
        )
      }
      className="grid size-9 place-items-center text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
    >
      <SunIcon className="hidden size-4 dark:block" />
      <MoonIcon className="size-4 dark:hidden" />
    </button>
  )
}

function OpenApp({
  size = "lg",
  className,
}: {
  size?: "lg" | "xl"
  className?: string
}) {
  return (
    <a
      href={APP_PATH}
      className={cn(
        buttonVariants(),
        "group h-11 gap-2 px-5 text-sm font-semibold",
        size === "xl" && "h-14 px-7 text-base",
        className
      )}
    >
      Open the app
      <ArrowRightIcon
        weight="bold"
        className="transition-transform duration-300 ease-out group-hover:translate-x-0.5"
      />
    </a>
  )
}

const NAV = [
  { href: "#install", label: "Install" },
  { href: "/faq", label: "FAQ" },
  { href: "/privacy", label: "Privacy policy" },
]

function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1320px] items-center gap-6 px-5 sm:px-8">
        <a href="/" aria-label="Better Clips home">
          <Wordmark />
        </a>
        <nav
          aria-label="Main"
          className="hidden items-center gap-6 text-sm md:flex"
        >
          {NAV.map(({ href, label }) => (
            <a
              key={href}
              href={href}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <a
            href={APP_PATH}
            className={cn(buttonVariants(), "h-9 px-4 text-sm font-semibold")}
          >
            Open the app
          </a>
        </div>
      </div>
    </header>
  )
}

/* The dashboard at work: a replay saved in OBS uploads and lands in the
 * library. Sample data, drawn in the app's own style. */
function DashboardMock() {
  const [first, ...rest] = SAMPLE_CLIPS

  return (
    <figure className="motion-moment">
      <div className="relative">
        <div
          aria-hidden
          className="overflow-hidden border bg-card shadow-[0_30px_80px_-30px_oklch(0_0_0/45%)]"
        >
          <div className="flex h-11 items-center gap-4 border-b px-4">
            <span className="flex items-center gap-1.5">
              <span className="size-2 bg-primary" />
              <span className="text-[13px] font-bold [font-stretch:78%]">
                Better Clips
              </span>
            </span>
            <span className="relative flex h-11 items-center text-xs font-medium">
              All{" "}
              <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                6
              </span>
              <span className="absolute inset-x-0 -bottom-px h-0.5 bg-primary" />
            </span>
            <span className="text-xs text-muted-foreground">Kept</span>
            <span className="text-xs text-muted-foreground">Trash</span>
            <span className="ml-auto hidden h-7 w-40 items-center justify-between border px-2 text-[11px] text-muted-foreground sm:flex">
              Search clips <kbd className="font-mono text-[10px]">/</kbd>
            </span>
          </div>
          <div className="p-4">
            <p className="mb-3 flex items-baseline gap-2 text-xs">
              <span className="font-semibold">Today</span>
              <span className="font-mono text-[10px] text-muted-foreground">
                6 clips · 142.7 MB
              </span>
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <MockCard clip={first} landing />
              {rest.map((clip) => (
                <MockCard key={clip.id} clip={clip} />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <ObsDock />
        <figcaption className="font-mono text-[10px] text-muted-foreground">
          Sample library
        </figcaption>
      </div>
    </figure>
  )
}

function MockCard({
  clip,
  landing = false,
}: {
  clip: (typeof SAMPLE_CLIPS)[number]
  landing?: boolean
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1.5",
        landing &&
          "animate-[clip-land_0.9s_cubic-bezier(0.16,1,0.3,1)_2.6s_both]"
      )}
    >
      <div
        className={cn(
          "relative aspect-video overflow-hidden bg-muted",
          landing && "ring-2 ring-primary ring-offset-2 ring-offset-card"
        )}
      >
        <img
          src={`/home/${clip.img}.webp`}
          alt=""
          width={960}
          height={540}
          className="size-full object-cover"
        />
        <span className="absolute right-1.5 bottom-1.5 bg-black/75 px-1 font-mono text-[10px] text-white">
          {clip.length}
        </span>
        {landing && (
          <span className="absolute top-1.5 left-1.5 bg-primary px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-primary-foreground uppercase">
            New
          </span>
        )}
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[12px] font-semibold">{clip.title}</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {clip.time}
        </span>
      </div>
      <span className="-mt-1 truncate text-[10px] text-muted-foreground">
        {clip.game}
      </span>
    </div>
  )
}

/* The OBS dock, floating over the library: the save, then the upload. */
function ObsDock() {
  return (
    <div
      aria-hidden
      className="border bg-popover p-3.5 shadow-[0_18px_40px_-12px_oklch(0_0_0/50%)] sm:w-[300px] sm:shrink-0"
    >
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold">Better Clips · OBS</span>
        <span className="flex items-center gap-1.5 font-mono text-[9px] tracking-wider text-primary uppercase">
          <span className="size-1.5 animate-[tally_1.6s_ease-in-out_infinite] bg-primary" />
          Replay buffer
        </span>
      </div>
      <p className="mb-2 font-mono text-[10px] text-muted-foreground">
        Saved 21-14-07_Neon_Bastion.mp4
      </p>
      <div className="h-1 overflow-hidden bg-muted">
        <div className="h-full origin-left animate-[upload-fill_2.4s_cubic-bezier(0.65,0,0.35,1)_0.3s_both] bg-primary" />
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-[11px]">
        <CheckIcon weight="bold" className="size-3 text-primary" />
        Uploaded. Link copied.
      </p>
    </div>
  )
}

function Hero() {
  return (
    <section className="relative overflow-hidden bg-stage">
      <div className="mx-auto grid max-w-[1320px] items-center gap-14 px-5 pt-10 pb-16 sm:px-8 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16 lg:pt-16 lg:pb-20">
        <div>
          <h1 className="font-display text-[clamp(3.4rem,11vw,7rem)]">
            Press a hotkey.
            <span className="block text-primary">Keep the moment.</span>
          </h1>
          <p className="mt-8 max-w-[30rem] text-xl leading-snug text-muted-foreground">
            Save OBS replays to YouTube or your own R2 or S3 bucket, and manage
            them in one dashboard.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-3">
            <OpenApp />
            <a
              href="#install"
              className={cn(
                buttonVariants({ variant: "outline" }),
                "h-11 px-5 text-sm font-semibold"
              )}
            >
              Install the plugin
            </a>
          </div>
        </div>
        <DashboardMock />
      </div>
    </section>
  )
}

const STEPS = [
  { icon: KeyboardIcon, title: "Press the hotkey", note: "Mid-game, in OBS" },
  {
    icon: CloudArrowUpIcon,
    title: "It lands in your storage",
    note: "Link copied",
  },
  { icon: ScissorsIcon, title: "Trim and share", note: "In the dashboard" },
]

function Steps() {
  return (
    <section id="how" className="scroll-mt-16 border-t">
      <ol className="mx-auto grid max-w-[1320px] gap-px bg-border sm:grid-cols-3">
        {STEPS.map(({ icon: Icon, title, note }) => (
          <li
            key={title}
            className="flex items-center gap-5 bg-background px-5 py-10 sm:px-8 lg:py-16"
          >
            <Icon weight="duotone" className="size-9 shrink-0 text-primary" />
            <div>
              <h2 className="text-xl font-bold tracking-[-0.01em] [font-stretch:85%]">
                {title}
              </h2>
              <p className="mt-1 font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
                {note}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

const DESTINATIONS = [
  {
    icon: MonitorPlayIcon,
    name: "YouTube",
    line: "Your channel. Nothing to store.",
  },
  {
    icon: CloudIcon,
    name: "Cloudflare R2",
    line: "Your bucket. Free up to 10 GB.",
  },
  {
    icon: DatabaseIcon,
    name: "Any S3 bucket",
    line: "Straight from OBS. No app needed.",
  },
]

function Destinations() {
  return (
    <section className="border-t bg-stage">
      <div className="mx-auto max-w-[1320px] px-5 py-24 sm:px-8 lg:py-36">
        <h2 className="font-display text-[clamp(2.6rem,6.5vw,4.5rem)]">
          Your storage. Your clips.
        </h2>
        <div className="mt-14 grid gap-px border bg-border md:grid-cols-3">
          {DESTINATIONS.map(({ icon: Icon, name, line }) => (
            <article
              key={name}
              className="flex flex-col gap-10 bg-background p-7 lg:p-9"
            >
              <Icon weight="duotone" className="size-8 text-primary" />
              <div>
                <h3 className="text-2xl font-bold tracking-[-0.01em] [font-stretch:85%]">
                  {name}
                </h3>
                <p className="mt-2 text-muted-foreground">{line}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

function Install() {
  const [os, setOs] = React.useState<Os>(guessOs)
  const [copied, setCopied] = React.useState(false)
  const { command, shell } = INSTALL[os]

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      toast.error("Couldn't copy. Select the command and copy it instead.")
    }
  }

  return (
    <section id="install" className="scroll-mt-16 border-t">
      <div className="mx-auto grid max-w-[1320px] items-center gap-12 px-5 py-24 sm:px-8 lg:grid-cols-[0.8fr_1.2fr] lg:py-36">
        <h2 className="font-display text-[clamp(2.6rem,6.5vw,4.5rem)]">
          Install in one line
        </h2>
        <div>
          <div
            role="tablist"
            aria-label="Your system"
            className="flex border-b"
          >
            {OSES.map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={os === key}
                onClick={() => {
                  setOs(key)
                  setCopied(false)
                }}
                className={cn(
                  "relative px-5 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
                  os === key && "text-foreground"
                )}
              >
                {INSTALL[key].label}
                {os === key && (
                  <span className="absolute inset-x-0 -bottom-px h-0.5 bg-primary" />
                )}
              </button>
            ))}
          </div>
          <div role="tabpanel" className="border border-t-0 bg-card">
            <div className="flex items-center justify-between border-b px-4 py-2.5">
              <span className="font-mono text-[11px] text-muted-foreground">
                {shell}
              </span>
              <button
                type="button"
                onClick={() => void copy()}
                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {copied ? (
                  <CheckIcon weight="bold" className="size-3.5 text-primary" />
                ) : (
                  <CopyIcon className="size-3.5" />
                )}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed whitespace-pre">
              <span className="text-primary select-none">{"> "}</span>
              {command}
            </pre>
          </div>
        </div>
      </div>
    </section>
  )
}

const FACTS = [
  "No extra encoding",
  "Your keys stay private",
  "Free and open source",
  "Self-host in one click",
]

function Closing() {
  return (
    <section className="border-t bg-stage">
      <div className="mx-auto flex max-w-[1320px] flex-col items-start gap-10 px-5 py-28 sm:px-8 lg:flex-row lg:items-end lg:justify-between lg:py-40">
        <h2 className="font-display text-[clamp(3rem,9vw,6.5rem)]">
          Your next clip
          <span className="block text-primary">is one key away.</span>
        </h2>
        <OpenApp size="xl" />
      </div>
      <div className="mx-auto max-w-[1320px] px-5 pb-16 sm:px-8">
        <p className="flex flex-wrap gap-x-6 gap-y-2 border-t pt-6 font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
          {FACTS.map((fact) => (
            <span key={fact}>{fact}</span>
          ))}
          <a href="/faq" className="text-foreground hover:text-primary">
            How it works →
          </a>
        </p>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-[1320px] flex-col gap-6 px-5 py-10 sm:px-8 md:flex-row md:items-center md:justify-between">
        <Wordmark />
        <nav
          aria-label="Footer"
          className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground [&_a]:transition-colors [&_a:hover]:text-foreground"
        >
          <a href={APP_PATH}>Open the app</a>
          <a href="/faq">FAQ</a>
          <a href="/privacy">Privacy policy</a>
          <a href="/terms">Terms</a>
          <a href={DEPLOY}>Self-host</a>
          <a href={REPO}>GitHub</a>
        </nav>
      </div>
    </footer>
  )
}

/* The public homepage of the hosted app. A self-hosted app sends / straight
 * to the dashboard (worker/index.ts). */
export function Home() {
  React.useEffect(() => {
    document.title = "Better Clips: OBS replays to YouTube or your own bucket"
  }, [])

  return (
    <div className="min-h-svh">
      <Nav />
      <main>
        <Hero />
        <Steps />
        <Destinations />
        <Install />
        <Closing />
      </main>
      <Footer />
    </div>
  )
}
