import * as React from "react"
import { CheckIcon, CopyIcon } from "@phosphor-icons/react"
import { useQuery } from "@tanstack/react-query"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import { useSettings } from "@/lib/settings"

const RELEASES = "https://github.com/aarsh21/obs-replay-r2/releases/latest"

/* Whether OBS is connected, then the steps to connect it. The status updates
 * by itself when OBS checks in, e.g. after Test Upload. */
export function ObsConnect() {
  const { data: settings } = useSettings(true)
  const connected = Boolean(settings?.obsSeen)
  const [showSteps, setShowSteps] = React.useState(false)

  return (
    <div className="flex flex-col gap-5">
      <ObsStatus seen={settings?.obsSeen} loading={!settings} />
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
  loading,
}: {
  seen: string | null | undefined
  loading: boolean
}) {
  if (loading) return <Skeleton className="h-12 w-full" />

  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-3 border px-3 py-2.5",
        seen ? "border-emerald-500/30 bg-emerald-500/5" : "bg-muted/40"
      )}
    >
      <span className="relative flex size-2">
        {!seen && (
          <span className="absolute inline-flex size-full animate-ping bg-primary/70 [animation-duration:1.8s]" />
        )}
        <span
          className={cn(
            "relative inline-flex size-2",
            seen ? "bg-emerald-500" : "bg-primary"
          )}
        />
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="text-xs font-medium">
          {seen ? "OBS is connected" : "Waiting for OBS"}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {seen
            ? `Last checked in ${timeAgo(seen)}.`
            : "Follow the steps below. This turns green when you click Test Upload in OBS."}
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

export function SetupSteps() {
  const setup = useQuery({
    queryKey: ["setup"],
    queryFn: api.setup,
    staleTime: Infinity,
  })

  const [copied, setCopied] = React.useState(false)

  const copy = async () => {
    if (!setup.data) return
    await navigator.clipboard.writeText(setup.data.code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <ol className="flex flex-col gap-5 text-xs">
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
        <div className="mt-2 flex items-stretch gap-0">
          <div className="flex h-8 min-w-0 flex-1 items-center border bg-muted/40 px-2 font-mono text-[11px] text-muted-foreground">
            {setup.data ? (
              <span className="truncate">
                {setup.data.code.slice(0, 28)}••••••••
              </span>
            ) : setup.error ? (
              <span className="text-destructive">{setup.error.message}</span>
            ) : (
              <Skeleton className="h-3 w-40" />
            )}
          </div>
          <Button onClick={copy} disabled={!setup.data} className="h-8">
            {copied ? <CheckIcon weight="bold" /> : <CopyIcon />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          It lets OBS upload to this app. Keep it private.
        </p>
      </Step>
      <Step n={3} title="Paste it in OBS">
        Open <b>Tools → Replay to R2 Settings</b>, click <b>Paste setup code</b>
        , then <b>Test Upload</b> and <b>Save</b>.
      </Step>
      <Step n={4} title="Pick a hotkey">
        In <b>Settings → Hotkeys</b>, bind <b>Save Replay to Cloudflare R2</b>.
        Start the Replay Buffer and press it.
      </Step>
    </ol>
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
