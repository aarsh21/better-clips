import { cn } from "cn"

import { Wordmark } from "@/components/brand"
import { YouTubeConsent } from "@/components/youtube-consent"

/* A narrow column with the wordmark, for screens shown before the app. */
export function AuthShell({
  children,
  wide = false,
}: {
  children: React.ReactNode
  wide?: boolean
}) {
  return (
    <div className="flex min-h-svh flex-col bg-stage">
      <header className="mx-auto flex h-16 w-full max-w-[1320px] items-center px-5 sm:px-8">
        <a href="/" aria-label="Better Clips home">
          <Wordmark />
        </a>
      </header>
      <main className="flex flex-1 items-center justify-center px-5 py-12">
        <div className={wide ? "w-full max-w-md" : "w-full max-w-sm"}>
          {children}
        </div>
      </main>
      <InfoLinks className="mx-auto w-full max-w-[1320px] px-5 pb-8 sm:px-8" />
    </div>
  )
}

/* The FAQ, the privacy policy and the terms, which open without signing in. */
export function InfoLinks({
  className,
  newTab = false,
}: {
  className?: string
  newTab?: boolean
}) {
  const link = newTab ? { target: "_blank", rel: "noreferrer" } : {}

  return (
    <p
      className={cn(
        "flex gap-5 text-sm text-muted-foreground [&_a]:transition-colors [&_a:hover]:text-foreground",
        className
      )}
    >
      <a href="/faq" {...link}>
        FAQ
      </a>
      <a href="/privacy" {...link}>
        Privacy policy
      </a>
      <a href="/terms" {...link}>
        Terms
      </a>
    </p>
  )
}

/* The big condensed heading these screens open with. */
export function AuthTitle({ children }: { children: React.ReactNode }) {
  return (
    <h1 className="mb-8 font-display text-[clamp(2.75rem,10vw,3.75rem)]">
      {children}
    </h1>
  )
}

/* Shown instead of the app until you sign in. */
export function SignIn() {
  return (
    <AuthShell>
      <AuthTitle>Sign in</AuthTitle>
      <div className="flex flex-col gap-3">
        <YouTubeConsent purpose="login" google>
          Sign in with Google
        </YouTubeConsent>
      </div>
    </AuthShell>
  )
}
