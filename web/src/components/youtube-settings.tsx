import * as React from "react"
import { CheckIcon, YoutubeLogoIcon } from "@phosphor-icons/react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { buttonVariants } from "@/components/ui/button-variants"
import { Skeleton } from "@/components/ui/skeleton"
import { YOUTUBE_RED } from "@/components/youtube"
import { api, youtubeConnectUrl } from "@/lib/api"
import { useAccount, useMe } from "@/lib/settings"

const YOUTUBE_TERMS = "https://www.youtube.com/t/terms"
const GOOGLE_PERMISSIONS = "https://myaccount.google.com/permissions"
const GOOGLE_PRIVACY = "https://policies.google.com/privacy"

/* Settings > YouTube (hosted app): the connected channel, what clips may do
 * with it, and a way to disconnect. */
export function YouTubeSettings() {
  const { isPending } = useMe()
  const account = useAccount()
  const youtube = account?.youtube

  if (isPending) return <Skeleton className="h-16 w-full" />

  return (
    <div className="flex flex-col gap-5 text-xs">
      {youtube ? (
        <ConnectedChannel channel={youtube} />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="leading-relaxed text-muted-foreground">
            Connect your YouTube channel to see the clips OBS uploads there in
            this library, next to your other clips. To upload from OBS, pick{" "}
            <b className="font-medium text-foreground">YouTube</b> as the
            destination in{" "}
            <b className="font-medium text-foreground">
              Tools → Better Clips Settings
            </b>
            , upload{" "}
            <b className="font-medium text-foreground">
              Through the Better Clips app
            </b>
            , sign in, then click{" "}
            <b className="font-medium text-foreground">Save</b>.
          </p>
          <a
            href={youtubeConnectUrl("connect")}
            className={buttonVariants({ className: "self-start" })}
          >
            <YoutubeLogoIcon weight="fill" />
            Connect YouTube
          </a>
        </div>
      )}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Uploads follow{" "}
        <a
          href={YOUTUBE_TERMS}
          target="_blank"
          rel="noreferrer"
          className="text-foreground underline-offset-4 hover:underline"
        >
          YouTube&apos;s Terms of Service
        </a>{" "}
        and{" "}
        <a
          href={GOOGLE_PRIVACY}
          target="_blank"
          rel="noreferrer"
          className="text-foreground underline-offset-4 hover:underline"
        >
          Google&apos;s Privacy Policy
        </a>
        . You can remove Better Clips&apos; access any time in{" "}
        <a
          href={GOOGLE_PERMISSIONS}
          target="_blank"
          rel="noreferrer"
          className="text-foreground underline-offset-4 hover:underline"
        >
          your Google Account
        </a>
        .
      </p>
    </div>
  )
}

function ConnectedChannel({
  channel,
}: {
  channel: NonNullable<NonNullable<ReturnType<typeof useAccount>>["youtube"]>
}) {
  const qc = useQueryClient()
  const [confirming, setConfirming] = React.useState(false)

  const remove = useMutation({
    mutationFn: api.removeDevice,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  })

  const { channelTitle: title, devices, clipCount } = channel

  const disconnect = useMutation({
    mutationFn: api.disconnectYouTube,
    onSuccess: () => {
      setConfirming(false)

      return qc.invalidateQueries()
    },
  })

  return (
    <div className="flex flex-col gap-3">
      <div
        role="status"
        className="flex items-center gap-3 border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5"
      >
        <YoutubeLogoIcon
          weight="fill"
          className={cn("size-5 shrink-0", YOUTUBE_RED)}
        />
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{title}</span>
          <span className="text-[11px] text-muted-foreground">
            Better Clips can upload, list, rename, change visibility of and
            delete your clips&apos; videos.
          </span>
        </div>
        <CheckIcon className="ml-auto size-4 shrink-0 text-emerald-500" />
      </div>
      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Paired OBS devices</h3>
        {devices.length === 0 && (
          <p className="text-muted-foreground">No devices paired.</p>
        )}
        {devices.map(({ id, lastSeen }) => (
          <div
            key={id}
            className="flex items-center justify-between gap-3 border-b pb-2"
          >
            <div>
              OBS · {id.slice(0, 8)}
              <p className="text-[11px] text-muted-foreground">
                {lastSeen
                  ? `Last seen ${new Date(lastSeen).toLocaleString()}`
                  : "Last seen unknown"}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              aria-label={`Remove OBS ${id.slice(0, 8)}`}
              disabled={remove.isPending}
              onClick={() => remove.mutate(id)}
            >
              Remove
            </Button>
          </div>
        ))}
        {remove.error && (
          <p role="alert" className="text-destructive">
            {remove.error.message}
          </p>
        )}
      </section>
      {confirming ? (
        <div className="flex flex-col gap-2 border border-destructive/30 bg-destructive/5 p-3">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Better Clips loses access to {title} and all paired OBS devices stop
            uploading there. Better Clips removes your YouTube library entries
            ({clipCount}) and all their saved cut points. Your videos stay on
            YouTube.
          </p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
          <p role="alert" className="text-[11px] text-destructive">
            {disconnect.error?.message}
          </p>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="self-start text-[11px] text-muted-foreground underline-offset-4 hover:text-destructive hover:underline"
        >
          Disconnect YouTube
        </button>
      )}
    </div>
  )
}
