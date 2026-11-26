import { APP_PATH } from "@/lib/view"
import * as React from "react"
import { DesktopIcon, MoonIcon, SunIcon } from "@phosphor-icons/react"
import { useMutation } from "@tanstack/react-query"

import { InfoLinks } from "@/components/sign-in"
import { YouTubeObsSteps } from "@/components/youtube"
import { YouTubeSettings } from "@/components/youtube-settings"
import { Segmented } from "@/components/segmented"
import { Button } from "@/components/ui/button"
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
import { announceAccountChange, api } from "@/lib/api"
import { useMe } from "@/lib/settings"

export type SettingsTab = "obs" | "youtube" | "appearance"

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
  const { data: account } = useMe()

  const signOut = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      announceAccountChange()
      location.assign(APP_PATH)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Pinned near the top, so switching tabs or connecting OBS changes the
          height downwards instead of making the dialog jump. */}
      <DialogContent className="top-[10vh] max-h-[85vh] translate-y-0 gap-0 overflow-y-auto p-0 sm:max-w-lg">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="font-display text-4xl">Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Connect OBS, manage your YouTube channel, and pick a theme.
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={tab}
          onValueChange={(value: SettingsTab) => onTab(value)}
          className="min-w-0"
        >
          <TabsList
            variant="line"
            className="w-full justify-start border-b px-4"
          >
            <TabsTrigger value="obs">OBS</TabsTrigger>
            <TabsTrigger value="youtube">YouTube</TabsTrigger>
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
          </TabsList>
          <div className="px-6 py-6">
            <TabsContent value="obs">
              <YouTubeObsSteps />
            </TabsContent>
            <TabsContent value="youtube">
              <YouTubeSettings />
            </TabsContent>
            <TabsContent value="appearance">
              <AppearanceSettings />
            </TabsContent>
          </div>
        </Tabs>
        <div className="flex items-center justify-between gap-2 border-t px-6 py-3 text-sm">
          <span>{account?.email}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => signOut.mutate()}
            disabled={signOut.isPending}
          >
            Sign out
          </Button>
        </div>
        <InfoLinks newTab className="border-t px-6 py-4" />
      </DialogContent>
    </Dialog>
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
          <span id={id} className="text-sm font-medium">
            Theme
          </span>
          <span className="text-xs text-muted-foreground">
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
          <span id={clockId} className="text-sm font-medium">
            Time format
          </span>
          <span className="text-xs text-muted-foreground">
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
