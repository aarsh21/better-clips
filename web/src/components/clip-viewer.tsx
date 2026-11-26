import * as React from "react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { YouTubeViewer } from "@/components/youtube-viewer"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { Clip } from "@/lib/api"
import type { ClipNav } from "@/lib/clip-actions"

type Props = ClipNav & {
  clip: Clip | null
}

export function ClipViewer(props: Props) {
  /* Keep the last clip while the dialog animates out. */
  const [last, setLast] = React.useState(props.clip)

  if (props.clip && props.clip !== last) setLast(props.clip)

  const clip = props.clip ?? last

  return (
    <Dialog
      open={!!props.clip}
      onOpenChange={(open) => !open && props.onClose()}
    >
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[100dvh] w-full max-w-[min(100vw,1280px)] flex-col gap-0 bg-background p-0 sm:max-w-[min(94vw,1280px)]"
      >
        <TooltipProvider delay={300}>
          {clip && <YouTubeViewer clip={clip} nav={props} key={clip.key} />}
        </TooltipProvider>
      </DialogContent>
    </Dialog>
  )
}
