import * as React from "react"
import { CheckIcon, CopyIcon } from "@phosphor-icons/react"
import { useQuery } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"

const RELEASES = "https://github.com/aarsh21/obs-replay-r2/releases/latest"

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
        Download the installer for your system from{" "}
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
          It holds an upload-only key for your clips bucket. Keep it private.
        </p>
      </Step>
      <Step n={3} title="Paste it in OBS">
        Open <b>Tools → Replay to R2 Settings</b>, click <b>Paste setup code</b>
        , then <b>Save</b>.
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
