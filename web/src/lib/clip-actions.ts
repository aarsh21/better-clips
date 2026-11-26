import { toast } from "sonner"

import type { Clip } from "@/lib/api"

export type ClipNav = {
  onClose: () => void
  onNavigate: (clip: Clip, step: number) => void
  hasPrev: boolean
  hasNext: boolean
}

/* Copies a link and says so; id replaces a loading toast. */
export async function copyLink(
  url: string,
  description?: string,
  id?: string | number
) {
  try {
    await navigator.clipboard.writeText(url)
    toast.success("Link copied", { id, description })
  } catch {
    /* The clipboard needs a recent click; offer a button instead. */
    toast.success("Link ready", {
      id,
      description: url,
      action: {
        label: "Copy",
        onClick: () => void navigator.clipboard.writeText(url),
      },
    })
  }
}
