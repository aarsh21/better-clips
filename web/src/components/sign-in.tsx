import * as React from "react"
import { CloudIcon, GoogleLogoIcon } from "@phosphor-icons/react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { buttonVariants } from "@/components/ui/button-variants"
import { Input } from "@/components/ui/input"
import { api, youtubeConnectUrl, type SignInKind } from "@/lib/api"

/* The clips logo and a narrow column, for screens shown before the app. */
export function AuthShell({
  children,
  wide = false,
}: {
  children: React.ReactNode
  wide?: boolean
}) {
  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-12">
      <div className={wide ? "w-full max-w-md" : "w-full max-w-xs"}>
        <div className="mb-6 flex items-center gap-2">
          <span className="size-2.5 bg-primary" />
          <h1 className="text-sm font-semibold tracking-tight">clips</h1>
        </div>
        {children}
        <InfoLinks className="mt-8" />
      </div>
    </main>
  )
}

/* The FAQ and the privacy policy, which open without signing in. */
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
        "flex gap-3 text-[11px] text-muted-foreground [&_a]:underline-offset-4 [&_a]:hover:text-foreground [&_a]:hover:underline",
        className
      )}
    >
      <a href="/faq" {...link}>
        FAQ
      </a>
      <a href="/privacy" {...link}>
        Privacy
      </a>
    </p>
  )
}

/* Shown instead of the app until you sign in. */
export function SignIn({ kind }: { kind: SignInKind }) {
  if (kind === "cloudflare") return <CloudflareSignIn />

  return (
    <AuthShell>
      {kind === "password" ? <PasswordForm /> : <SetPassword />}
    </AuthShell>
  )
}

function CloudflareSignIn() {
  return (
    <AuthShell>
      <p className="mb-1 text-sm font-medium">
        Your replays, from OBS to the web
      </p>
      <p className="mb-6 text-xs leading-relaxed text-muted-foreground">
        Press a hotkey in a game and the clip is here a second later. Keep clips
        in your own Cloudflare account, free up to 10 GB, or upload them to your
        YouTube channel.
      </p>
      <div className="flex flex-col gap-2">
        <a
          href="/api/auth/login"
          className={buttonVariants({ size: "lg", className: "w-full" })}
        >
          <CloudIcon weight="fill" />
          Sign in with Cloudflare
        </a>
        <a
          href={youtubeConnectUrl("login")}
          className={buttonVariants({
            size: "lg",
            variant: "outline",
            className: "w-full",
          })}
        >
          <GoogleLogoIcon weight="bold" />
          Sign in with Google
        </a>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        Cloudflare keeps clips in your own R2 bucket and only lets clips read
        your name and email. Google asks once for every permission clips uses:
        to upload to your YouTube channel, list those videos, and rename them,
        change who can watch or delete them when you ask, under{" "}
        <a
          href="https://www.youtube.com/t/terms"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-4 hover:text-foreground"
        >
          YouTube&apos;s Terms of Service
        </a>
        .
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
      className="flex flex-col gap-2"
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
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        aria-invalid={login.isError || undefined}
        autoFocus
      />
      <Button type="submit" disabled={!password || login.isPending}>
        {login.isPending ? "Signing in…" : "Sign in"}
      </Button>
      <p role="alert" className="min-h-4 text-[11px] text-destructive">
        {login.error?.message}
      </p>
    </form>
  )
}

function SetPassword() {
  return (
    <div className="flex flex-col gap-2 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">Set a password</p>
      <p>
        In the Cloudflare dashboard, open this Worker, go to{" "}
        <b className="text-foreground">Settings → Variables and Secrets</b> and
        add a secret named <code className="text-foreground">APP_PASSWORD</code>{" "}
        with 12 or more characters. Then reload this page.
      </p>
    </div>
  )
}
