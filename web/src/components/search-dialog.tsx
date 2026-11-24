import {
  BookmarkSimpleIcon,
  DesktopIcon,
  FilmSlateIcon,
  HardDrivesIcon,
  MoonIcon,
  PlugsConnectedIcon,
  ScissorsIcon,
  SunIcon,
  TrashIcon,
} from "@phosphor-icons/react"

import type { SettingsTab } from "@/components/settings-dialog"
import { useTheme } from "@/components/theme-provider"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import { dayLabel, formatDuration, thumbUrl, type Clip } from "@/lib/api"
import type { View } from "@/lib/view"

const VIEW_ITEMS = [
  { view: "all", label: "All clips", icon: FilmSlateIcon, key: "1" },
  { view: "saved", label: "Kept clips", icon: BookmarkSimpleIcon, key: "2" },
  { view: "trash", label: "Trash", icon: TrashIcon, key: "3" },
] satisfies {
  view: View
  label: string
  icon: React.ElementType
  key: string
}[]

const THEMES = [
  { theme: "light", label: "Light theme", icon: SunIcon },
  { theme: "dark", label: "Dark theme", icon: MoonIcon },
  { theme: "system", label: "Match system theme", icon: DesktopIcon },
] as const

/* Opened with / or ⌘K: finds a clip by name or day, and runs app actions. */
export function SearchDialog({
  open,
  onOpenChange,
  clips,
  onOpenClip,
  onView,
  onSettings,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clips: Clip[]
  onOpenClip: (key: string) => void
  onView: (view: View) => void
  onSettings: (tab: SettingsTab) => void
}) {
  const { theme, setTheme } = useTheme()

  const run = (action: () => void) => () => {
    onOpenChange(false)
    action()
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search"
      description="Find a clip or run a command"
      className="sm:max-w-xl"
    >
      <Command loop filter={matchWords}>
        <CommandInput placeholder="Search clips, days, commands…" />
        <CommandList className="max-h-[min(60vh,28rem)]">
          <CommandEmpty>Nothing matches.</CommandEmpty>
          {clips.length > 0 && (
            <CommandGroup heading="Clips">
              {clips.map((clip) => (
                <CommandItem
                  key={clip.key}
                  value={clip.key}
                  keywords={[clip.title, clip.day, dayLabel(clip.day)]}
                  onSelect={run(() => onOpenClip(clip.key))}
                >
                  <ClipRow clip={clip} />
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandGroup heading="Go to">
            {VIEW_ITEMS.map(({ view, label, icon: Icon, key }) => (
              <CommandItem key={view} onSelect={run(() => onView(view))}>
                <Icon />
                {label}
                <CommandShortcut>{key}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Settings">
            <CommandItem onSelect={run(() => onSettings("obs"))}>
              <PlugsConnectedIcon />
              Connect OBS
            </CommandItem>
            <CommandItem
              keywords={["retention", "keep", "delete", "days"]}
              onSelect={run(() => onSettings("storage"))}
            >
              <HardDrivesIcon />
              Storage and cleanup
            </CommandItem>
            {THEMES.map(({ theme: value, label, icon: Icon }) => (
              <CommandItem
                key={value}
                keywords={["theme", "appearance"]}
                data-checked={theme === value}
                onSelect={run(() => setTheme(value))}
              >
                <Icon />
                {label}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}

/* Every typed word must appear somewhere in the item. cmdk's default fuzzy
 * match finds letters scattered across a whole clip path, so "light" would
 * match "Just Chatting" before the Light theme command. */
function matchWords(value: string, search: string, keywords?: string[]) {
  const text = [value, ...(keywords ?? [])].join(" ").toLowerCase()

  return search
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word))
    ? 1
    : 0
}

function ClipRow({ clip }: { clip: Clip }) {
  return (
    <>
      <span className="relative aspect-video w-14 shrink-0 overflow-hidden bg-muted">
        {clip.thumb && (
          <img
            src={thumbUrl(clip)}
            alt=""
            loading="lazy"
            decoding="async"
            className="absolute inset-0 size-full object-cover"
          />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 truncate font-medium">
          {clip.title}
          {clip.trimmed && (
            <ScissorsIcon className="size-3 text-muted-foreground" />
          )}
          {clip.folder === "saved" && (
            <BookmarkSimpleIcon weight="fill" className="size-3 text-primary" />
          )}
          {clip.folder === "trash" && (
            <TrashIcon className="size-3 text-muted-foreground" />
          )}
        </span>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {dayLabel(clip.day)} · {clip.time.slice(0, 5)}
          {clip.thumb?.duration
            ? ` · ${formatDuration(clip.thumb.duration)}`
            : ""}
        </span>
      </span>
    </>
  )
}
