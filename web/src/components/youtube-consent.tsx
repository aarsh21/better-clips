import * as React from "react"
import { cn } from "cn"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { buttonVariants } from "@/components/ui/button-variants"
import { youtubeConnectUrl } from "@/lib/api"

const YOUTUBE_TERMS = "https://www.youtube.com/t/terms"

/* Google's "G" mark, unaltered, as its sign-in branding guidelines ask. */
function GoogleG({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden className={className}>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  )
}

/* "Sign in with Google" in Google's own style: Roboto Medium, the full-colour
 * G, and its light or dark neutral button. */
export const googleButtonClass =
  "inline-flex h-10 w-full items-center justify-center gap-2.5 border border-[#747775] bg-white px-3 font-['Roboto',sans-serif] text-sm font-medium text-[#1f1f1f] transition-colors hover:bg-[#f2f2f2] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none dark:border-[#8e918f] dark:bg-[#131314] dark:text-[#e3e3e3] dark:hover:bg-[#1f1f20]"

/* Before Better Clips first uses YouTube, says what it will do on the
 * channel and what continuing agrees to. Continue goes on to Google. */
export function YouTubeConsent({
  purpose,
  google = false,
  className,
  children,
}: {
  purpose: "login" | "connect"
  /* Draw the trigger as Google's sign-in button. */
  google?: boolean
  className?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(google && googleButtonClass, className)}
      >
        {google && <GoogleG className="size-[18px]" />}
        {children}
      </button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader className="place-items-start text-left">
            <AlertDialogTitle>Before you connect YouTube</AlertDialogTitle>
            <AlertDialogDescription render={<div />} className="text-left">
              <p>On your channel, Better Clips will:</p>
              <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-foreground">
                <li>Upload the clips you save in OBS</li>
                <li>Read their status, title and visibility</li>
                <li>Rename them, or change who can watch them</li>
                <li>Delete them when you ask</li>
              </ul>
              <p className="mt-3">
                It only changes videos uploaded through Better Clips. By
                continuing you agree to the <a href="/terms">Terms</a>, the{" "}
                <a href="/privacy">Privacy policy</a> and the{" "}
                <a href={YOUTUBE_TERMS} target="_blank" rel="noreferrer">
                  YouTube Terms of Service
                </a>
                .
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <a href={youtubeConnectUrl(purpose)} className={buttonVariants()}>
              Continue
            </a>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
