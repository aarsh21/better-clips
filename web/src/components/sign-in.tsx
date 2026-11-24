import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/api"

/* Shown instead of the app until you sign in with APP_PASSWORD. */
export function SignIn({ setUp }: { setUp: boolean }) {
  const qc = useQueryClient()
  const [password, setPassword] = React.useState("")

  const login = useMutation({
    mutationFn: api.login,
    onSuccess: () => qc.invalidateQueries(),
  })

  return (
    <main className="flex min-h-svh items-center justify-center px-4">
      <div className="w-full max-w-xs">
        <div className="mb-6 flex items-center gap-2">
          <span className="size-2.5 bg-primary" />
          <h1 className="text-sm font-semibold tracking-tight">clips</h1>
        </div>
        {setUp ? (
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
        ) : (
          <div className="flex flex-col gap-2 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Set a password</p>
            <p>
              In the Cloudflare dashboard, open this Worker, go to{" "}
              <b className="text-foreground">
                Settings → Variables and Secrets
              </b>{" "}
              and add a secret named{" "}
              <code className="text-foreground">APP_PASSWORD</code> with 12 or
              more characters. Then reload this page.
            </p>
          </div>
        )}
      </div>
    </main>
  )
}
