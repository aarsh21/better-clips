import * as React from "react"
import { CloudIcon } from "@phosphor-icons/react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { buttonVariants } from "@/components/ui/button-variants"
import { Input } from "@/components/ui/input"
import { Wordmark } from "@/components/brand"
import { YouTubeConsent } from "@/components/youtube-consent"
import { api, type SignInKind } from "@/lib/api"

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
export function SignIn({ kind }: { kind: SignInKind }) {
  if (kind === "cloudflare") return <CloudflareSignIn />

  return (
    <AuthShell>
      <AuthTitle>
        {kind === "password" ? "Sign in" : "Set a password"}
      </AuthTitle>
      {kind === "password" ? <PasswordForm /> : <SetPassword />}
    </AuthShell>
  )
}

function CloudflareSignIn() {
  return (
    <AuthShell>
      <AuthTitle>Sign in</AuthTitle>
      <div className="flex flex-col gap-3">
        <a
          href="/api/auth/login"
          className={buttonVariants({ size: "lg", className: "w-full" })}
        >
          <CloudIcon weight="fill" />
          Sign in with Cloudflare
        </a>
        <YouTubeConsent purpose="login" google>
          Sign in with Google
        </YouTubeConsent>
      </div>
      <p className="mt-5 text-sm text-muted-foreground">
        Cloudflare for your own bucket, Google for YouTube.{" "}
        <a
          href="/faq"
          className="text-foreground underline-offset-4 hover:underline"
        >
          Which one?
        </a>
      </p>
    </AuthShell>
  )
}

function PasswordForm() {
  const qc = useQueryClient()
  const [password, setPassword] = React.useState("")

  const login = useMutation({
    mutationFn: api.login,
    onSuccess: () => qc.invalidateQueries(),
  })

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        login.mutate(password)
      }}
    >
      <Input
        type="password"
        name="password"
        aria-label="Password"
        autoComplete="current-password"
        placeholder="Password"
        className="h-11"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        aria-invalid={login.isError || undefined}
        autoFocus
      />
      <Button type="submit" size="lg" disabled={!password || login.isPending}>
        {login.isPending ? "Signing in…" : "Sign in"}
      </Button>
      <p role="alert" className="min-h-5 text-sm text-destructive">
        {login.error?.message}
      </p>
    </form>
  )
}

function SetPassword() {
  return (
    <div className="text-sm leading-relaxed text-muted-foreground">
      <p>
        In the Cloudflare dashboard, open this Worker, go to{" "}
        <b className="text-foreground">Settings → Variables and Secrets</b> and
        add a secret named <code className="text-foreground">APP_PASSWORD</code>{" "}
        with 12 or more characters. Then reload this page.
      </p>
    </div>
  )
}
