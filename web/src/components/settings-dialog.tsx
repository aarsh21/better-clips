import * as React from "react"
import { DesktopIcon, MoonIcon, SunIcon } from "@phosphor-icons/react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { cn } from "cn"

import { useSignOut } from "@/components/connect-storage"
import { YouTubeObsSteps } from "@/components/youtube"
import { YouTubeSettings } from "@/components/youtube-settings"
import { Segmented } from "@/components/segmented"
import { Button } from "@/components/ui/button"
import { buttonVariants } from "@/components/ui/button-variants"
import { ObsConnect } from "@/components/setup-steps"
import { useTheme } from "@/components/theme-provider"
import { setClock, useClock } from "@/lib/clock"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { announceAccountChange, api, formatBytes, type Clip } from "@/lib/api"
import { useClips } from "@/lib/clips"
import {
  retentionText,
  useAccount,
  useHasBucket,
  useMe,
  useSaveSettings,
  useSettings,
} from "@/lib/settings"

export type SettingsTab = "obs" | "storage" | "youtube" | "appearance"

const FREE_BYTES = 10 * 1024 ** 3

export function SettingsDialog({
  open,
  tab,
  onOpenChange,
  onTab,
}: {
  open: boolean
  tab: SettingsTab
  onOpenChange: (open: boolean) => void
  onTab: (tab: SettingsTab) => void
}) {
  /* YouTube is only on the hosted app. */
  const hosted = useAccount() !== null
  const hasBucket = useHasBucket()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Pinned near the top, so switching tabs or connecting OBS changes the
          height downwards instead of making the dialog jump. */}
      <DialogContent className="top-[10vh] max-h-[85vh] translate-y-0 gap-0 overflow-y-auto p-0 sm:max-w-lg">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Connect OBS, choose how long clips are kept, connect YouTube, and
            pick a theme.
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={tab}
          onValueChange={(value: SettingsTab) => onTab(value)}
          className="min-w-0"
        >
          <TabsList
            variant="line"
            className="w-full justify-start border-b px-3"
          >
            <TabsTrigger value="obs">OBS</TabsTrigger>
            <TabsTrigger value="storage">Storage</TabsTrigger>
            {hosted && <TabsTrigger value="youtube">YouTube</TabsTrigger>}
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
          </TabsList>
          <div className="px-5 py-5">
            <TabsContent value="obs">
              {hasBucket ? <ObsConnect /> : <YouTubeObsSteps />}
            </TabsContent>
            <TabsContent value="storage">
              <StorageSettings />
            </TabsContent>
            {hosted && (
              <TabsContent value="youtube">
                <YouTubeSettings />
              </TabsContent>
            )}
            <TabsContent value="appearance">
              <AppearanceSettings />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

const REPLAY_OPTIONS = [7, 14, 30, 60, 90, null]
const TRASH_OPTIONS = [1, 3, 7, 14, 30]

function StorageSettings() {
  const { data: settings } = useSettings()
  const { data: clips } = useClips()
  const save = useSaveSettings()
  const hasBucket = useHasBucket()

  if (!hasBucket)
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Your clips are on YouTube, so they take no storage here. Want clips
            you can download, trim losslessly and share with expiring links? Add
            an R2 bucket in your own Cloudflare account, free up to 10 GB.
          </p>
          <a
            href="/api/auth/setup"
            className={buttonVariants({
              variant: "outline",
              size: "sm",
              className: "self-start",
            })}
          >
            Set up a bucket
          </a>
        </div>
        <AccountSettings />
      </div>
    )

  return (
    <div className="flex flex-col gap-6">
      <Usage clips={clips ?? []} />
      <OptionRow
        label="Delete new clips after"
        hint={
          settings?.replaysDays === null
            ? "New clips stay until you delete them."
            : "Clips you keep are never deleted."
        }
        options={REPLAY_OPTIONS.map((days) => ({
          value: days,
          label: days === null ? "Never" : `${days}d`,
          title: retentionText(days),
        }))}
        value={settings?.replaysDays}
        onChange={(replaysDays) => save.mutate({ replaysDays })}
      />
      <OptionRow
        label="Empty the trash after"
        hint="Deleted clips can be restored until then."
        options={TRASH_OPTIONS.map((days) => ({
          value: days,
          label: `${days}d`,
          title: retentionText(days),
        }))}
        value={settings?.trashDays}
        onChange={(trashDays) => save.mutate({ trashDays })}
      />
      {settings?.paused ? (
        <div className="flex flex-col gap-2 border border-primary/30 bg-primary/5 p-3">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Cleanup is off for this bucket, since it may hold files this app
            didn&apos;t make. Once it&apos;s on, only <b>.mp4</b> clips in{" "}
            <b>replays/</b> and <b>trash/</b> are ever deleted.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            disabled={save.isPending}
            onClick={() =>
              save.mutate({
                replaysDays: settings.replaysDays,
                trashDays: settings.trashDays,
              })
            }
          >
            Turn on cleanup with these lengths
          </Button>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          Cleanup runs once a day.
        </p>
      )}
      <AccountSettings />
    </div>
  )
}

/* On the hosted app: who is signed in and which bucket is connected. */
function AccountSettings() {
  const { data: me } = useMe()
  const signOut = useSignOut()
  const [confirming, setConfirming] = React.useState(false)

  const disconnect = useMutation({
    mutationFn: api.disconnectStorage,
    onSuccess: () => {
      announceAccountChange()
      location.assign("/")
    },
  })

  const qc = useQueryClient()

  /* For an install command that got out: OBS needs the new one. */
  const resetObs = useMutation({
    mutationFn: api.resetObsToken,
    onSuccess: (setup) => {
      qc.setQueryData(["setup"], setup)

      return qc.invalidateQueries({ queryKey: ["settings"] })
    },
  })

  if (!me || !("email" in me)) return null

  return (
    <div className="flex flex-col gap-3 border-t pt-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs font-medium">
            {me.storage ? `Bucket ${me.storage.bucket}` : "No bucket"}
          </span>
          <span className="truncate text-[11px] text-muted-foreground">
            {me.email}
            {me.storage &&
              (me.storage.auto ? " · set up automatically" : " · your key")}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
        >
          Sign out
        </Button>
      </div>
      {me.storage && (
        <div className="flex items-start justify-between gap-3">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {resetObs.isSuccess
              ? "Done. The old command stops working; run the new one from the OBS tab."
              : "Shared your OBS install command by mistake? Make a new one and the old one stops working."}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={resetObs.isPending}
            onClick={() => resetObs.mutate()}
          >
            New OBS command
          </Button>
        </div>
      )}
      {!me.storage ? null : confirming ? (
        <div className="flex flex-col gap-2 border border-destructive/30 bg-destructive/5 p-3">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            clips stops using this bucket right away, and OBS stops uploading.
            Your clips stay in the bucket. To turn the key off for good, delete
            it in R2 → Manage API tokens.
          </p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              Disconnect
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="self-start text-[11px] text-muted-foreground underline-offset-4 hover:text-destructive hover:underline"
        >
          Disconnect storage
        </button>
      )}
    </div>
  )
}

function Usage({ clips }: { clips: Clip[] }) {
  const sizes = { replays: 0, saved: 0, trash: 0 }

  for (const clip of clips)
    if (clip.source === "bucket") sizes[clip.folder] += clip.size

  const parts = [
    { label: "New", bytes: sizes.replays, className: "bg-primary" },
    { label: "Kept", bytes: sizes.saved, className: "bg-foreground/70" },
    { label: "Trash", bytes: sizes.trash, className: "bg-muted-foreground/40" },
  ]

  const used = sizes.replays + sizes.saved + sizes.trash

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium tabular-nums">{formatBytes(used)}</span>
        <span className="text-[11px] text-muted-foreground">
          of 10 GB free each month
        </span>
      </div>
      <div className="flex h-1.5 bg-muted">
        {parts.map((p) => (
          <div
            key={p.label}
            className={cn("h-full transition-[width]", p.className)}
            style={{ width: `${Math.min(100, (p.bytes / FREE_BYTES) * 100)}%` }}
          />
        ))}
      </div>
      <div className="flex gap-4 text-[11px] text-muted-foreground tabular-nums">
        {parts.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5">
            <span className={cn("size-1.5", p.className)} />
            {p.label} {formatBytes(p.bytes)}
          </span>
        ))}
      </div>
    </div>
  )
}

function OptionRow<T extends number | null>({
  label,
  hint,
  options,
  value,
  onChange,
}: {
  label: string
  hint: string
  options: { value: T; label: string; title: string }[]
  value: T | undefined
  onChange: (value: T) => void
}) {
  const id = React.useId()

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span id={id} className="text-xs font-medium">
          {label}
        </span>
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      </div>
      <Segmented
        labelledBy={id}
        options={options}
        value={value}
        onChange={onChange}
      />
    </div>
  )
}

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: DesktopIcon },
] as const

function AppearanceSettings() {
  const { theme, setTheme } = useTheme()
  const id = React.useId()
  const clockId = React.useId()
  const clock = useClock()

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <span id={id} className="text-xs font-medium">
            Theme
          </span>
          <span className="text-[11px] text-muted-foreground">
            System follows your computer's light or dark mode.
          </span>
        </div>
        <Segmented
          labelledBy={id}
          options={[...THEME_OPTIONS]}
          value={theme}
          onChange={setTheme}
        />
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <span id={clockId} className="text-xs font-medium">
            Time format
          </span>
          <span className="text-[11px] text-muted-foreground">
            How clip times are shown, such as 15:22 or 3:22 PM.
          </span>
        </div>
        <Segmented
          labelledBy={clockId}
          options={[
            { value: "24h", label: "24-hour" },
            { value: "12h", label: "12-hour" },
          ]}
          value={clock}
          onChange={setClock}
        />
      </div>
    </div>
  )
}
