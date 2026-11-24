import * as React from "react"
import { DesktopIcon, MoonIcon, SunIcon } from "@phosphor-icons/react"
import { cn } from "cn"

import { Segmented } from "@/components/segmented"
import { ObsConnect } from "@/components/setup-steps"
import { useTheme } from "@/components/theme-provider"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatBytes, type Clip } from "@/lib/api"
import { useClips } from "@/lib/clips"
import { retentionText, useSaveSettings, useSettings } from "@/lib/settings"

export type SettingsTab = "obs" | "storage" | "appearance"

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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Pinned near the top, so switching tabs or connecting OBS changes the
          height downwards instead of making the dialog jump. */}
      <DialogContent className="top-[10vh] max-h-[85vh] translate-y-0 gap-0 overflow-y-auto p-0 sm:max-w-lg">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Connect OBS, choose how long clips are kept, and pick a theme.
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
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
          </TabsList>
          <div className="px-5 py-5">
            <TabsContent value="obs">
              <ObsConnect />
            </TabsContent>
            <TabsContent value="storage">
              <StorageSettings />
            </TabsContent>
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
      <p className="text-[11px] text-muted-foreground">
        Cleanup runs once a day.
      </p>
    </div>
  )
}

function Usage({ clips }: { clips: Clip[] }) {
  const sizes = { replays: 0, saved: 0, trash: 0 }

  for (const clip of clips) sizes[clip.folder] += clip.size

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

  return (
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
  )
}
