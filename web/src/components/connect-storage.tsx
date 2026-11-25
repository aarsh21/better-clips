import * as React from "react"
import { CaretDownIcon, LightningIcon } from "@phosphor-icons/react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { cn } from "cn"

import { AuthShell } from "@/components/sign-in"
import { Button } from "@/components/ui/button"
import { buttonVariants } from "@/components/ui/button-variants"
import { Input } from "@/components/ui/input"
import { announceAccountChange, api } from "@/lib/api"

/* The hosted app's second step: pick where clips are stored. */
export function ConnectStorage() {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: api.me })
  const [own, setOwn] = React.useState(false)
  const email = me && "email" in me ? me.email : null

  return (
    <AuthShell wide>
      <p className="mb-1 text-sm font-medium">Connect your storage</p>
      <p className="mb-6 text-xs leading-relaxed text-muted-foreground">
        Your clips live in an R2 bucket in your own Cloudflare account. Better
        Clips only gets a key for that one bucket, never for the rest of your
        account.
      </p>

      <div className="flex flex-col gap-3 border bg-muted/30 p-4">
        <a
          href="/api/auth/setup"
          className={buttonVariants({ size: "lg", className: "w-full" })}
        >
          <LightningIcon weight="fill" />
          Set up automatically
        </a>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Uses the <b>clips</b> bucket in your account, with the clips already
          in it, or makes it if you don&apos;t have one. Cloudflare asks once to
          let Better Clips do that and make a key for just that bucket. Better
          Clips asks Cloudflare to cancel that permission as soon as it&apos;s
          done.
        </p>
      </div>

      <button
        type="button"
        aria-expanded={own}
        onClick={() => setOwn(!own)}
        className="mt-5 flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:text-foreground"
      >
        <CaretDownIcon
          className={cn("size-3 transition-transform", !own && "-rotate-90")}
        />
        Use another bucket, with your own key
      </button>
      {own && <OwnKeyForm />}

      <p className="mt-8 text-[11px] text-muted-foreground">
        R2 has to be turned on in your Cloudflare account once (Storage &amp;
        databases → R2). It&apos;s free up to 10 GB.
      </p>
      {email && <SignedInAs email={email} />}
    </AuthShell>
  )
}

export function OwnKeyForm() {
  const [s3Url, setS3Url] = React.useState("")
  const [accessKeyId, setAccessKeyId] = React.useState("")
  const [secretAccessKey, setSecretAccessKey] = React.useState("")

  const connect = useMutation({
    mutationFn: api.connectStorage,
    onSuccess: () => {
      announceAccountChange()
      location.assign("/?connected=1")
    },
  })

  return (
    <form
      className="mt-3 flex flex-col gap-3 border p-4"
      onSubmit={(e) => {
        e.preventDefault()
        connect.mutate({ s3Url, accessKeyId, secretAccessKey })
      }}
    >
      <ol className="flex list-decimal flex-col gap-1 pl-4 text-[11px] leading-relaxed text-muted-foreground">
        <li>
          In R2, create a new private bucket just for clips. Its settings show
          its <b className="text-foreground">S3 API</b> URL.
        </li>
        <li>
          In R2 → <b className="text-foreground">Manage API tokens</b>, create a
          token with <b className="text-foreground">Object Read &amp; Write</b>{" "}
          for only that bucket.
        </li>
      </ol>
      <Field label="S3 API URL">
        <Input
          required
          value={s3Url}
          onChange={(e) => setS3Url(e.target.value)}
          placeholder="https://<account id>.r2.cloudflarestorage.com/clips"
          spellCheck={false}
          autoComplete="off"
        />
      </Field>
      <Field label="Access Key ID">
        <Input
          required
          value={accessKeyId}
          onChange={(e) => setAccessKeyId(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
        />
      </Field>
      <Field label="Secret Access Key">
        <Input
          required
          type="password"
          value={secretAccessKey}
          onChange={(e) => setSecretAccessKey(e.target.value)}
          autoComplete="off"
          className="font-mono"
        />
      </Field>
      <Button
        type="submit"
        variant="outline"
        disabled={connect.isPending}
        aria-invalid={connect.isError || undefined}
      >
        {connect.isPending ? "Checking the key…" : "Connect bucket"}
      </Button>
      <p role="alert" className="min-h-4 text-[11px] text-destructive">
        {connect.error?.message}
      </p>
    </form>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1 text-[11px] font-medium">
      {label}
      {children}
    </label>
  )
}

export function SignedInAs({ email }: { email: string }) {
  const signOut = useSignOut()

  return (
    <p className="mt-3 flex items-center gap-1 text-[11px] text-muted-foreground">
      Signed in as <span className="text-foreground">{email}</span> ·
      <button
        type="button"
        onClick={() => signOut.mutate()}
        className="underline-offset-4 hover:text-foreground hover:underline"
      >
        Sign out
      </button>
    </p>
  )
}

/* Signs out and forgets everything cached for this account. */
export function useSignOut() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      qc.clear()
      announceAccountChange()
      location.assign("/")
    },
  })
}
