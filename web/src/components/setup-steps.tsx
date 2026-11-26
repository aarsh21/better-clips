import * as React from "react"
import {
  CheckIcon,
  CopyIcon,
  TerminalIcon,
  WindowsLogoIcon,
} from "@phosphor-icons/react"
import { useQuery } from "@tanstack/react-query"
import { cn } from "cn"

import { Segmented } from "@/components/segmented"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import { useSettings } from "@/lib/settings"

const RELEASES = "https://github.com/aarsh21/better-clips/releases/latest"

/* Whether OBS is connected, then the steps to connect it. The status updates
 * by itself when OBS checks in, e.g. after Test Upload. */
export function ObsConnect() {
  const { data: settings, dataUpdatedAt, isRefetchError } = useSettings(true)
  const connected = !isRefetchError && Boolean(settings?.obsSeen && dataUpdatedAt - Date.parse(settings.obsSeen) < 5 * 60_000)
  const [showSteps, setShowSteps] = React.useState(false)

  return (
    <div className="flex flex-col gap-5">
      <ObsStatus seen={settings?.obsSeen} connected={connected} loading={!settings} />
      {connected && !showSteps ? (
        <button
          type="button"
          onClick={() => setShowSteps(true)}
          className="self-start text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Set up OBS on another PC
        </button>
      ) : (
        <SetupSteps />
      )}
    </div>
  )
}

function ObsStatus({
  seen,
  connected,
  loading,
}: {
  seen: string | null | undefined
  connected: boolean
  loading: boolean
}) {
  if (loading) return <Skeleton className="h-12 w-full" />

  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-3 border px-3 py-2.5",
        connected ? "border-emerald-500/30 bg-emerald-500/5" : "bg-muted/40"
      )}
    >
      <span className="relative flex size-2">
        {!seen && (
          <span className="absolute inline-flex size-full animate-ping bg-primary/70 [animation-duration:1.8s]" />
        )}
        <span
          className={cn(
            "relative inline-flex size-2",
            connected ? "bg-emerald-500" : "bg-primary"
          )}
        />
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="text-xs font-medium">
          {connected ? "OBS checked in recently" : seen ? "No recent OBS check" : "Waiting for OBS"}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {seen
            ? `Last seen ${timeAgo(seen)}. Use Test Upload in OBS to check again.`
            : "Run Test Upload or upload a clip from OBS to verify this bucket."}
        </span>
      </div>
    </div>
  )
}

function timeAgo(iso: string) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)

  if (minutes < 1) return "just now"

  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)

  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)

  return `${days} ${days === 1 ? "day" : "days"} ago`
}

const SCRIPTS = "https://raw.githubusercontent.com/aarsh21/better-clips/main"

type Platform = "unix" | "windows"

const PLATFORMS = [
  { value: "unix", label: "macOS / Linux", icon: TerminalIcon },
  { value: "windows", label: "Windows", icon: WindowsLogoIcon },
] as const

/* The one-line installer for each platform, with the setup code inside, so
 * pasting it installs the plugin and connects OBS in one go. */
function installCommand(platform: Platform, code: string) {
  return platform === "windows"
    ? `$env:CLIPS_SETUP_CODE='${code}'; irm ${SCRIPTS}/install.ps1 | iex`
    : `curl -fsSL ${SCRIPTS}/install.sh | sh -s -- '${code}'`
}

function hidden(code: string) {
  return code.slice(0, 14) + "••••••••"
}

export function SetupSteps() {
  const setup = useQuery({
    queryKey: ["setup"],
    queryFn: api.setup,
    staleTime: Infinity,
  })

  const [platform, setPlatform] = React.useState<Platform>(() =>
    navigator.userAgent.includes("Windows") ? "windows" : "unix"
  )

  const [manual, setManual] = React.useState(false)
  const platformId = React.useId()
  const code = setup.data?.code

  return (
    <div className="flex flex-col gap-4 text-xs">
      <div className="flex flex-col gap-2">
        <span id={platformId} className="font-medium">
          Run this in a terminal
        </span>
        <Segmented
          labelledBy={platformId}
          options={[...PLATFORMS]}
          value={platform}
          onChange={setPlatform}
        />
        <CopyField
          text={code && installCommand(platform, code)}
          shown={code && installCommand(platform, hidden(code))}
          error={setup.error?.message}
          fresh={async () => {
            const latest = (await setup.refetch()).data?.code

            return latest && installCommand(platform, latest)
          }}
        />
        <p className="leading-relaxed text-muted-foreground">
          {platform === "windows"
            ? "Paste it into PowerShell. Windows asks once for permission to add the plugin."
            : "Paste it into Terminal. A Linux upgrade may need sudo to remove an old system plugin."}{" "}
          It waits for OBS to close, installs the plugin, then opens OBS with
          the Replay Buffer running. Press{" "}
          <kbd className="border bg-muted px-1 font-mono text-[10px] text-foreground">
            Ctrl+Alt+R
          </kbd>{" "}
          to save a clip. The command holds your setup code, so keep it private.
        </p>
      </div>
      {manual ? (
        <ManualSteps
          code={code}
          error={setup.error?.message}
          fresh={async () => (await setup.refetch()).data?.code}
        />
      ) : (
        <button
          type="button"
          onClick={() => setManual(true)}
          className="self-start text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Set it up by hand instead
        </button>
      )}
    </div>
  )
}

function ManualSteps({
  code,
  error,
  fresh,
}: {
  code: string | undefined
  error: string | undefined
  fresh: () => Promise<string | undefined>
}) {
  return (
    <ol className="flex flex-col gap-5 border-t pt-4">
      <Step n={1} title="Install the plugin">
        Download version 0.1.1 or newer for your system from{" "}
        <a
          href={RELEASES}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline-offset-4 hover:underline"
        >
          the latest release
        </a>{" "}
        and restart OBS.
      </Step>
      <Step n={2} title="Copy your setup code">
        <CopyField
          text={code}
          shown={code && hidden(code)}
          error={error}
          fresh={fresh}
        />
      </Step>
      <Step n={3} title="Paste it in OBS">
        Open <b>Tools → Better Clips Settings</b>, click <b>Paste setup code</b>
        , then <b>Test Upload</b> and <b>Save</b>.
      </Step>
      <Step n={4} title="Pick a hotkey">
        In <b>Settings → Hotkeys</b>, bind <b>Save Replay and Upload</b>. Start
        the Replay Buffer and press it.
      </Step>
    </ol>
  )
}

/* A secret shown cut short, with a button that copies all of it. */
/* Copying asks the app for the current code first, so a code reset in
 * another tab (or account switch) is never copied stale. */
function CopyField({
  text,
  shown,
  error,
  fresh,
}: {
  text: string | undefined
  shown: string | undefined
  error: string | undefined
  fresh: () => Promise<string | undefined>
}) {
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)

    return () => clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    if (!text) return
    const latest = await fresh()

    if (!latest) return
    await navigator.clipboard.writeText(latest)
    setCopied(true)
  }

  return (
    <div className="mt-1 flex items-stretch">
      <div className="flex h-8 min-w-0 flex-1 items-center border bg-muted/40 px-2 font-mono text-[11px] text-muted-foreground">
        {shown ? (
          <span className="truncate">{shown}</span>
        ) : error ? (
          <span className="text-destructive">{error}</span>
        ) : (
          <Skeleton className="h-3 w-40" />
        )}
      </div>
      <Button onClick={copy} disabled={!text} className="h-8">
        {copied ? <CheckIcon weight="bold" /> : <CopyIcon />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  )
}

function Step({
  n,
  title,
  children,
}: {
  n: number
  title: string
  children: React.ReactNode
}) {
  return (
    <li className="flex gap-3">
      <span className="flex size-5 shrink-0 items-center justify-center bg-primary/15 text-[10px] font-semibold text-primary">
        {n}
      </span>
      <div className="min-w-0 flex-1 leading-relaxed">
        <p className="font-medium">{title}</p>
        <div className="text-muted-foreground [&_b]:font-medium [&_b]:text-foreground">
          {children}
        </div>
      </div>
    </li>
  )
}
