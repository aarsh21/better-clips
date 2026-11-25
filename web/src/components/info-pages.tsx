import type * as React from "react"
import { ArrowLeftIcon } from "@phosphor-icons/react"
import { cn } from "cn"

const REPO = "https://github.com/aarsh21/obs-replay-r2"
const ISSUES = `${REPO}/issues`
const GOOGLE_PERMISSIONS = "https://myaccount.google.com/permissions"
const YOUTUBE_TERMS = "https://www.youtube.com/t/terms"
const GOOGLE_PRIVACY = "https://policies.google.com/privacy"

const USER_DATA_POLICY =
  "https://developers.google.com/terms/api-services-user-data-policy"

/* A link out of the page, or to another of its pages. */
function Link({ href, children }: { href: string; children: React.ReactNode }) {
  const external = href.startsWith("http")

  return (
    <a
      href={href}
      {...(external && { target: "_blank", rel: "noreferrer" })}
      className="text-foreground underline underline-offset-4 hover:text-primary"
    >
      {children}
    </a>
  )
}

/* The FAQ and the privacy policy: readable signed out, with the way back
 * to the library. */
function InfoShell({
  current,
  title,
  intro,
  children,
}: {
  current: "/faq" | "/privacy"
  title: string
  intro: React.ReactNode
  children: React.ReactNode
}) {
  const pages = [
    { href: "/faq", label: "FAQ" },
    { href: "/privacy", label: "Privacy" },
  ]

  return (
    <div className="min-h-svh">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-4 px-4 sm:px-6">
          <a href="/" className="flex items-center gap-2">
            <span className="size-2.5 bg-primary" />
            <span className="text-sm font-semibold tracking-tight">clips</span>
          </a>
          <nav className="flex items-center gap-3 text-xs">
            {pages.map(({ href, label }) => (
              <a
                key={href}
                href={href}
                aria-current={href === current ? "page" : undefined}
                className={cn(
                  "text-muted-foreground hover:text-foreground",
                  href === current && "text-foreground"
                )}
              >
                {label}
              </a>
            ))}
          </nav>
          <a
            href="/"
            className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeftIcon className="size-3.5" />
            Your clips
          </a>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 pt-10 pb-24 sm:px-6">
        <h1 className="mb-2 text-base font-semibold">{title}</h1>
        <div className="mb-10 text-xs leading-relaxed text-muted-foreground">
          {intro}
        </div>
        <div className="flex flex-col gap-10">{children}</div>
      </main>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-6">
      <h2 className="border-b pb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      {children}
    </section>
  )
}

/* One question and its answer. */
function Q({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{q}</h3>
      <div className="flex flex-col gap-2 text-xs leading-relaxed text-muted-foreground [&_b]:font-medium [&_b]:text-foreground [&_li]:pl-1 [&_ul]:flex [&_ul]:list-disc [&_ul]:flex-col [&_ul]:gap-1.5 [&_ul]:pl-4">
        {children}
      </div>
    </div>
  )
}

export function Faq() {
  return (
    <InfoShell
      current="/faq"
      title="Questions"
      intro={
        <>
          How clips and the Replay to R2 plugin for OBS handle your clips. See
          also the <Link href="/privacy">privacy policy</Link>.
        </>
      }
    >
      <Section title="Where clips go">
        <Q q="Where are my clips stored?">
          <p>
            It depends on the <b>Destination</b> in OBS, under{" "}
            <b>Tools → Replay to R2 Settings</b>:
          </p>
          <ul>
            <li>
              <b>Clips app (R2)</b>: OBS uploads each clip to your Clips app,
              which keeps it in an R2 bucket. On the hosted app that&apos;s a
              bucket in your own Cloudflare account; on a self-hosted app,
              it&apos;s your Worker&apos;s bucket.
            </li>
            <li>
              <b>S3 bucket</b>: OBS uploads each clip straight to your own
              S3-compatible bucket, such as Cloudflare R2, with the keys you
              entered in OBS.
            </li>
            <li>
              <b>YouTube, through the Clips app</b>: clips go to your YouTube
              channel. The app starts each upload, and OBS sends the video
              straight to YouTube, so the file never passes through the app. The
              app keeps a library entry for each clip, so you can watch, rename,
              cut and delete it here.
            </li>
            <li>
              <b>YouTube, directly</b>: OBS signs in to Google itself and
              uploads straight to your channel. The Clips app isn&apos;t
              involved, so these clips aren&apos;t in its library. Find them in
              YouTube Studio.
            </li>
          </ul>
        </Q>
        <Q q="What happens if an upload fails?">
          <p>
            OBS tries again a few times over about two minutes. If it still
            can&apos;t upload, or the error won&apos;t go away by retrying, it
            saves the clip to OBS&apos;s recording folder (
            <b>Settings → Output → Recording Path</b>) and says where in
            OBS&apos;s status bar. A clip that&apos;s still uploading when OBS
            closes is saved there too.
          </p>
        </Q>
      </Section>

      <Section title="Google and YouTube">
        <Q q="Which Google permissions does clips ask for, and why?">
          <p>
            Google asks once, the first time you sign in with Google or connect
            YouTube, whether from this app or from OBS:
          </p>
          <ul>
            <li>
              <b>Your email address and Google account ID</b>, to sign you in.
            </li>
            <li>
              <b>Upload YouTube videos</b>, to send the clips you save in OBS to
              your channel.
            </li>
            <li>
              <b>View your YouTube account</b>, to find your channel and show
              each clip&apos;s title, visibility, length, thumbnail and whether
              YouTube has finished processing it.
            </li>
            <li>
              <b>See, edit and permanently delete your YouTube videos</b>, to
              rename a clip, change who can watch it and delete it when you ask.
              clips only changes videos it uploaded.
            </li>
          </ul>
          <p>
            Google&apos;s page lets you untick boxes, but clips needs all of
            them. If one is unticked, signing in fails: sign in again and tick
            every box.
          </p>
          <p>
            In direct mode, OBS asks only to upload videos and to view your
            YouTube account, since it never renames or deletes them.
          </p>
        </Q>
        <Q q="Does OBS hold my Google token?">
          <ul>
            <li>
              <b>Through the Clips app: no.</b> Google&apos;s token stays in the
              app, encrypted. OBS gets its own upload token, which only works
              with the app.
            </li>
            <li>
              <b>Directly: yes.</b> OBS keeps a Google token in its plugin
              settings on your PC, and sends it only to Google. Keep those
              settings private, and disconnect OBS when you stop using it.
            </li>
          </ul>
        </Q>
        <Q q="How do I disconnect or remove access?">
          <ul>
            <li>
              <b>In this app</b>: <b>Settings → YouTube → Disconnect YouTube</b>
              . clips gives up its access at Google and forgets the token.
            </li>
            <li>
              <b>In OBS</b>: <b>Disconnect</b> on the YouTube page of{" "}
              <b>Tools → Replay to R2 Settings</b>. Through the Clips app, this
              also removes the app&apos;s access. If OBS says your channel is
              still connected to the Clips app, disconnect it in the app. In
              direct mode, OBS gives up its own access.
            </li>
            <li>
              <b>Any time</b>: remove the app in{" "}
              <Link href={GOOGLE_PERMISSIONS}>
                myaccount.google.com/permissions
              </Link>
              .
            </li>
          </ul>
        </Q>
        <Q q="What happens to my clips when I disconnect?">
          <p>
            They leave the clips library, but the videos stay on your YouTube
            channel.
          </p>
        </Q>
      </Section>

      <Section title="Clips on YouTube">
        <Q q="What's the difference between Unlisted, Private and Public?">
          <ul>
            <li>
              <b>Unlisted</b>: anyone with the link can watch it, but it
              doesn&apos;t show on your channel or in search. OBS uses this
              unless you choose another.
            </li>
            <li>
              <b>Private</b>: only you can watch it.
            </li>
            <li>
              <b>Public</b>: anyone can find and watch it.
            </li>
          </ul>
        </Q>
        <Q q="Does a cut change the video on YouTube?">
          <p>
            No. A cut only changes how the clip plays here, in whole seconds.
            The video on YouTube keeps the whole clip, and its link plays all of
            it. To cut the video itself, trim it in YouTube Studio.
          </p>
        </Q>
        <Q q="Does deleting a clip here delete it from YouTube?">
          <p>
            Yes. Deleting a YouTube clip here deletes the video from your
            channel for good, and YouTube can&apos;t bring it back.
          </p>
        </Q>
        <Q q="Why doesn't a new clip play right away?">
          <p>
            YouTube processes each video after it&apos;s uploaded, usually for a
            few minutes. The clip shows <b>Processing on YouTube</b> until it
            can play.
          </p>
        </Q>
        <Q q="Which audio goes to YouTube?">
          <p>
            One audio track: the one chosen under <b>Audio track</b> on the
            YouTube page of the OBS settings, Track 1 unless you change it. Pick
            one without voice chat.
          </p>
        </Q>
      </Section>

      <Section title="Help">
        <Q q="Where do I report a problem?">
          <p>
            Open an issue on <Link href={ISSUES}>GitHub</Link>. Your OBS log (
            <b>Help → Log Files</b>) helps.
          </p>
        </Q>
      </Section>
    </InfoShell>
  )
}

export function Privacy() {
  return (
    <InfoShell
      current="/privacy"
      title="Privacy policy"
      intro={
        <>
          <p>
            This covers the hosted Clips app at clips.zabimaru.me and the Replay
            to R2 plugin for OBS. A self-hosted Clips app runs in your own
            Cloudflare account, and its data stays there. Questions? Read the{" "}
            <Link href="/faq">FAQ</Link>.
          </p>
          <p className="mt-2">Last updated 25 November 2026.</p>
        </>
      }
    >
      <Section title="What clips stores">
        <Q q="Your account">
          <ul>
            <li>
              Your email address and the ID of the Cloudflare or Google account
              you sign in with.
            </li>
            <li>
              With YouTube: your channel&apos;s ID and name, and Google&apos;s
              refresh token, encrypted at rest.
            </li>
            <li>
              With a bucket: its name and access key, with the secret key
              encrypted at rest. The clips themselves are in that bucket, in
              your own Cloudflare account.
            </li>
          </ul>
        </Q>
        <Q q="Your clips on YouTube">
          <p>
            For each clip OBS uploads through clips: its YouTube video ID,
            title, description, visibility, game or scene, when it was recorded,
            its length, thumbnail and processing status, and its cut points.
          </p>
        </Q>
      </Section>

      <Section title="How clips uses YouTube data">
        <Q q="What clips does">
          <ul>
            <li>Uploads the clips you save in OBS to your channel.</li>
            <li>
              Lists, renames, changes the visibility of and deletes only the
              videos clips uploaded, and changes them only when you ask.
            </li>
            <li>Nothing else on your YouTube account.</li>
          </ul>
        </Q>
        <Q q="Sharing">
          <p>
            clips doesn&apos;t sell or share your data, and doesn&apos;t use it
            for ads. clips&apos; use and transfer of information received from
            Google APIs adheres to the{" "}
            <Link href={USER_DATA_POLICY}>
              Google API Services User Data Policy
            </Link>
            , including the Limited Use requirements.
          </p>
        </Q>
        <Q q="YouTube API Services">
          <p>
            clips uses YouTube API Services. Using its YouTube features means
            you agree to{" "}
            <Link href={YOUTUBE_TERMS}>YouTube&apos;s Terms of Service</Link>,
            and Google handles your data as described in the{" "}
            <Link href={GOOGLE_PRIVACY}>Google Privacy Policy</Link>.
          </p>
        </Q>
        <Q q="Direct mode in OBS">
          <p>
            When OBS uploads to YouTube directly, it keeps Google&apos;s token
            only on your computer, in OBS&apos;s settings, and sends it only to
            Google. It never reaches clips&apos; servers.
          </p>
        </Q>
      </Section>

      <Section title="Your choices">
        <Q q="Removing access">
          <p>
            Click <b>Disconnect YouTube</b> in <b>Settings → YouTube</b>, or
            remove clips in{" "}
            <Link href={GOOGLE_PERMISSIONS}>your Google Account</Link>.
            Disconnecting deletes the stored token and clips&apos; library
            entries for your YouTube clips. The videos stay on YouTube.
          </p>
        </Q>
        <Q q="Contact">
          <p>
            Open an issue on <Link href={ISSUES}>GitHub</Link>.
          </p>
        </Q>
      </Section>
    </InfoShell>
  )
}
