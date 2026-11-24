import { SetupSteps } from "@/components/setup-steps"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export function SetupDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect OBS</DialogTitle>
          <DialogDescription>
            One paste. Your replays upload straight from memory and show up
            here.
          </DialogDescription>
        </DialogHeader>
        <SetupSteps />
      </DialogContent>
    </Dialog>
  )
}
