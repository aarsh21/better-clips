import * as React from "react"
import {
  CaretDownIcon,
  CheckIcon,
  CircleNotchIcon,
  WarningIcon,
  YoutubeLogoIcon,
} from "@phosphor-icons/react"
import { cn } from "cn"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { buttonVariants } from "@/components/ui/button-variants"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  formatDuration,
  youtubeStudioUrl,
  type Privacy,
  type YouTubeClip,
} from "@/lib/api"
import { useAccount } from "@/lib/settings"
import {
  copyYouTubeLink,
  PRIVACY_OPTIONS,
  privacyOption,
  useManageRequest,
  type YouTubeChange,
} from "@/lib/youtube"

/* YouTube's red, for its logo. */
export const YOUTUBE_RED = "text-[#ff0033]"

/* Marks a clip on YouTube, with who can watch it. */
export function YouTubeChip({ privacy }: { privacy: Privacy }) {
  return (
    <span className="flex h-5 items-center gap-1 bg-black/70 pr-1.5 pl-1 text-[10px] font-medium text-white backdrop-blur-sm">
      <YoutubeLogoIcon weight="fill" className={cn("size-3.5", YOUTUBE_RED)} />
      {privacyOption(privacy).label}
    </span>
  )
}

const STATUS_TEXT = {
  uploading: "Uploading from OBS…",
  processing: "Processing on YouTube…",
  failed: "YouTube couldn't process it",
} satisfies Record<Exclude<YouTubeClip["status"], "ready">, string>

/* Over a thumbnail or the player while YouTube isn't ready to play it. */
export function YouTubeStatus({
  clip,
  large = false,
}: {
  clip: YouTubeClip
  large?: boolean
}) {
  if (clip.status === "ready") return null
  const failed = clip.status === "failed"
  const Icon = failed ? WarningIcon : CircleNotchIcon

  return (
    <div
      role="status"
      className={cn(
        "absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/60 text-center text-white",
        large ? "gap-2 px-6" : "px-3 text-[11px]"
      )}
    >
      <Icon
        className={cn(
          large ? "size-6" : "size-4",
          failed ? "text-red-400" : "animate-spin"
        )}
      />
      <span className={cn("font-medium", large && "text-sm")}>
        {STATUS_TEXT[clip.status]}
      </span>
      {large && (
        <span className="max-w-sm text-xs text-white/70">
          {failed ? (
            <>
              Open it in{" "}
              <a
                href={youtubeStudioUrl(clip.videoId)}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-4"
              >
                YouTube Studio
              </a>{" "}
              to see why.
            </>
          ) : (
            "It plays here as soon as YouTube is done, usually within a few minutes."
          )}
        </span>
      )}
    </div>
  )
}

/* Picks who can watch the clip on YouTube. children opens the menu. */
export function PrivacyMenu({
  privacy,
  onChange,
  align,
  children,
}: {
  privacy: Privacy
  onChange: (privacy: Privacy) => void
  align?: "start" | "end"
  children: React.ReactElement
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={children} />
      <DropdownMenuContent align={align} className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Who can watch it on YouTube</DropdownMenuLabel>
          {PRIVACY_OPTIONS.map(({ value, label, hint, icon: Icon }) => (
            <DropdownMenuItem
              key={value}
              onClick={() => value !== privacy && onChange(value)}
              className="items-start"
            >
              <Icon className="mt-0.5" />
              <span className="flex flex-1 flex-col">
                <span>{label}</span>
                <span className="text-[11px] text-muted-foreground">
                  {hint}
                </span>
              </span>
              {value === privacy && <CheckIcon className="mt-0.5" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/* The visibility button in the viewer's action bar. */
export function PrivacyButton({
  privacy,
  onChange,
}: {
  privacy: Privacy
  onChange: (privacy: Privacy) => void
}) {
  const { label, icon: Icon } = privacyOption(privacy)

  return (
    <PrivacyMenu privacy={privacy} onChange={onChange}>
      <Button variant="ghost" size="sm" title="Who can watch it on YouTube">
        <Icon />
        {label}
        <CaretDownIcon className="size-3 opacity-60" />
      </Button>
    </PrivacyMenu>
  )
}

/* Copies a YouTube clip's link. A cut clip asks first, since the video on
 * YouTube still has all of it. */
export function useYouTubeShare() {
  const [warning, setWarning] = React.useState<YouTubeClip | null>(null)

  const share = (clip: YouTubeClip) => {
    if (clip.cut) setWarning(clip)
    else void copyYouTubeLink(clip)
  }

  const dialog = {
    clip: warning,
    onOpenChange: (open: boolean) => !open && setWarning(null),
  }

  return { share, dialog }
}

export function CutLinkDialog({
  clip,
  onOpenChange,
}: {
  clip: YouTubeClip | null
  onOpenChange: (open: boolean) => void
}) {
  const [last, setLast] = React.useState(clip)

  if (clip && clip !== last) setLast(clip)
  const shown = clip ?? last
  const start = formatDuration(shown?.cut?.start ?? 0) || "0:00"

  return (
    <AlertDialog open={!!clip} onOpenChange={onOpenChange}>
      {/* Wider than other confirmations, for its three buttons. */}
      <AlertDialogContent className="sm:max-w-md!">
        <AlertDialogHeader>
          <AlertDialogTitle>This link has the whole clip</AlertDialogTitle>
          <AlertDialogDescription>
            Your cut only applies when the clip plays here. The video on YouTube
            still has all of it: the link starts at {start}, but plays on to the
            end, and anyone can go back. To cut the video itself, trim it in
            YouTube Studio.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {shown && (
            <a
              href={youtubeStudioUrl(shown.videoId)}
              target="_blank"
              rel="noreferrer"
              onClick={() => onOpenChange(false)}
              className={buttonVariants({ variant: "outline" })}
            >
              Edit in YouTube Studio
            </a>
          )}
          <AlertDialogAction
            onClick={() => {
              if (shown) void copyYouTubeLink(shown)
              onOpenChange(false)
            }}
          >
            Copy link anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/* Deleting from YouTube can't be undone, so it always asks. */
export function DeleteYouTubeDialog({
  clip,
  onOpenChange,
  onConfirm,
}: {
  clip: YouTubeClip | null
  onOpenChange: (open: boolean) => void
  onConfirm: (clip: YouTubeClip) => void
}) {
  const [last, setLast] = React.useState(clip)
  const channel = useAccount()?.youtube?.channelTitle

  if (clip && clip !== last) setLast(clip)
  const shown = clip ?? last

  return (
    <AlertDialog open={!!clip} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this video from YouTube?</AlertDialogTitle>
          <AlertDialogDescription>
            “{shown?.title}” will be permanently deleted from{" "}
            {channel ? `your channel ${channel}` : "your YouTube channel"}, and
            its link stops working. YouTube can&apos;t bring it back.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => shown && onConfirm(shown)}
          >
            Delete from YouTube
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

const MANAGE_REASON = {
  title: "rename it",
  privacy: "change who can watch it",
  cut: "cut it",
  delete: "delete it",
} satisfies Record<YouTubeChange["kind"], string>

/* Asks for permission to edit your videos the first time a change needs it,
 * then sends you to Google. The change is made when you're back. */
export function ManagePermissionDialog() {
  const { pending, allow, cancel } = useManageRequest()
  const [last, setLast] = React.useState(pending)

  if (pending && pending !== last) setLast(pending)
  const kind = (pending ?? last)?.change.kind ?? "title"

  return (
    <AlertDialog open={!!pending} onOpenChange={(open) => !open && cancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Let clips edit your YouTube videos?
          </AlertDialogTitle>
          <AlertDialogDescription>
            To {MANAGE_REASON[kind]}, clips needs one more permission. Google
            will ask you to allow clips to “see, edit, and permanently delete
            your YouTube videos”. clips only changes a video when you ask it to,
            and you&apos;ll come back here to finish.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Not now</AlertDialogCancel>
          <AlertDialogAction onClick={allow}>
            Continue to Google
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/* Connecting OBS without a bucket: there's no setup code, OBS signs in to
 * YouTube itself. */
export function YouTubeObsSteps() {
  return (
    <ol className="flex list-decimal flex-col gap-2 pl-4 text-xs leading-relaxed text-muted-foreground [&_b]:font-medium [&_b]:text-foreground">
      <li>
        Install the plugin from{" "}
        <a
          href="https://github.com/aarsh21/obs-replay-r2/releases/latest"
          target="_blank"
          rel="noreferrer"
          className="text-primary underline-offset-4 hover:underline"
        >
          the latest release
        </a>{" "}
        and restart OBS.
      </li>
      <li>
        In <b>Tools → Replay to R2 Settings</b>, set <b>Destination</b> to{" "}
        <b>YouTube</b> and click <b>Sign in with YouTube</b>. When it says
        you&apos;re connected, click <b>Save</b>: clips only go to YouTube once
        the destination is saved.
      </li>
      <li>
        Bind <b>Save Replay and Upload</b> in <b>Settings → Hotkeys</b>, start
        the Replay Buffer and press it.
      </li>
    </ol>
  )
}
