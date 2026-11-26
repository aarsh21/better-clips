import type * as React from "react"
import { ArrowLeftIcon } from "@phosphor-icons/react"
import { cn } from "cn"

const REPO = "https://github.com/aarsh21/better-clips"
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
            <span className="text-sm font-semibold tracking-tight">
              better clips
            </span>
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
          How the Better Clips app and its plugin for OBS handle your clips. See
          also the <Link href="/privacy">privacy policy</Link>.
        </>
      }
    >
      <Section title="Where clips go">
        <Q q="Where are my clips stored?">
          <p>
            It depends on the <b>Destination</b> in OBS, under{" "}
            <b>Tools → Better Clips Settings</b>:
          </p>
          <ul>
            <li>
              <b>Better Clips app (R2)</b>: OBS uploads each clip to your Better
              Clips app, which keeps it in an R2 bucket. On the hosted app
              that&apos;s a bucket in your own Cloudflare account; on a
              self-hosted app, it&apos;s your Worker&apos;s bucket.
            </li>
            <li>
              <b>S3 bucket</b>: OBS uploads each clip straight to your own
              S3-compatible bucket, such as Cloudflare R2, with the keys you
              entered in OBS.
            </li>
            <li>
              <b>YouTube, through the Better Clips app</b>: clips go to your
              YouTube channel. The app starts each upload, and OBS sends the
              video straight to YouTube, so the file never passes through the
              app. The app keeps a library entry for each clip, so you can
              watch, rename, cut and delete it here.
            </li>
            <li>
              <b>YouTube, directly</b>: OBS signs in to Google itself and
              uploads straight to your channel. The Better Clips app isn&apos;t
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
        <Q q="Which Google permissions does Better Clips ask for, and why?">
          <p>
            For bucket storage only, use Cloudflare sign-in. When connecting
            YouTube through the app, Google asks for all permissions together:
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
              Better Clips only changes videos it uploaded.
            </li>
          </ul>
          <p>
            Google&apos;s page lets you untick boxes, but Better Clips needs all
            of them. If one is unticked, signing in fails: sign in again and
            tick every box.
          </p>
          <p>
            Direct OBS uploads need permission to upload videos and view your
            channel and processing status. Version 0.4.0 also requests your
            Google account ID and email, but does not use them. Direct OBS does
            not ask to edit or delete your existing videos.
          </p>
        </Q>
        <Q q="Does OBS hold my Google token?">
          <ul>
            <li>
              <b>Through the Better Clips app: no.</b> Google&apos;s token stays
              in the app, encrypted. OBS gets its own upload token, which only
              works with the app.
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
              . Better Clips gives up its access at Google and forgets the
              token.
            </li>
            <li>
              <b>In OBS</b>: on the YouTube page of{" "}
              <b>Tools → Better Clips Settings</b>,<b> Unpair this OBS</b>{" "}
              disconnects only this device. Use
              <b> Remove channel from app…</b> to disconnect the hosted channel
              everywhere. In direct mode, <b>Disconnect</b> revokes the Google
              grant and clears the connection on this computer.
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
            Removing a hosted channel removes its library entries and cut
            points. Unpairing one device does not. Revoking the Google grant can
            disconnect both routes for the same account. Your videos stay on
            YouTube. For full account deletion, see the{" "}
            <Link href="/privacy">privacy policy</Link>.
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
            This covers the hosted Better Clips app at clips.zabimaru.me and the
            Better Clips plugin for OBS. If you self-host, the web app and its
            storage run in your own Cloudflare account. Questions? Read the{" "}
            <Link href="/faq">FAQ</Link>.
          </p>
          <p className="mt-2">Last updated 26 November 2026.</p>
        </>
      }
    >
      <Section title="What Better Clips stores">
        <Q q="Your account">
          <ul>
            <li>
              Your email address and the ID of the Cloudflare or Google account
              you sign in with.
            </li>
            <li>
              With YouTube: your channel&apos;s ID and name, and Google&apos;s
              refresh token, encrypted at rest when you upload through this app.
              In direct mode the token stays in the plugin&apos;s settings on
              your computer. Better Clips does not encrypt it there.
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
            For each clip OBS uploads through Better Clips: its YouTube video
            ID, title, description, visibility, game or scene, when it was
            recorded, its length, thumbnail and processing status, and its cut
            points.
          </p>
        </Q>
      </Section>

      <Section title="How Better Clips uses YouTube data">
        <Q q="What Better Clips does">
          <ul>
            <li>Uploads the clips you save in OBS to your channel.</li>
            <li>
              Lists, renames, changes the visibility of and deletes only the
              videos Better Clips uploaded, and changes them only when you ask.
            </li>
            <li>Nothing else on your YouTube account.</li>
          </ul>
        </Q>
        <Q q="Sharing">
          <p>
            Cloudflare runs the hosted app and stores its account and library
            records. Google receives the channel requests, video files and
            metadata needed for the YouTube features you choose. OBS sends the
            video file directly to YouTube on both YouTube routes. Better Clips
            does not sell Google data or use it for ads. Its use and transfer of
            information received from Google APIs adheres to the{" "}
            <Link href={USER_DATA_POLICY}>
              Google API Services User Data Policy
            </Link>
            , including the Limited Use requirements.
          </p>
        </Q>
        <Q q="YouTube API Services">
          <p>
            Better Clips uses YouTube API Services. Using its YouTube features
            means you agree to{" "}
            <Link href={YOUTUBE_TERMS}>YouTube&apos;s Terms of Service</Link>,
            and Google handles your data as described in the{" "}
            <Link href={GOOGLE_PRIVACY}>Google Privacy Policy</Link>.
          </p>
        </Q>
        <Q q="Direct mode in OBS">
          <p>
            When OBS uploads to YouTube directly, it keeps Google&apos;s token
            only on your computer, in OBS&apos;s settings, and sends it only to
            Google. It never reaches Better Clips&apos; servers.
          </p>
        </Q>
        <Q q="Cookies and playback">
          <p>
            We use cookies to complete sign-in and keep you signed in. Your
            browser remembers preferences such as your theme. When a YouTube
            thumbnail or player loads, Google receives information such as your
            IP address and site origin. Opening a clip can start playback.
            Google may use cookies, collect playback information and show ads
            under its own policy.
          </p>
        </Q>
      </Section>

      <Section title="Your choices">
        <Q q="How long is data kept?">
          <p>
            The hosted app keeps your sign-in ID and email for the life of the
            account. While your channel is connected it keeps its Google token,
            paired devices and clip records. It schedules a channel and video
            refresh after six days, with retries if Google is unavailable.
            Direct OBS keeps the channel details and Google token in the plugin
            settings until you disconnect or it detects loss of access.
          </p>
        </Q>
        <Q q="Removing access">
          <p>
            Click <b>Disconnect YouTube</b> in <b>Settings → YouTube</b>, or
            remove Better Clips in{" "}
            <Link href={GOOGLE_PERMISSIONS}>your Google Account</Link>. A
            successful hosted disconnect removes its YouTube token, paired
            devices, library entries and cut points. If you revoke at Google,
            the app removes these records when it detects the revoked grant.
            Google revocation affects both routes for the same Google account.
            Disconnect direct OBS to clear its local connection. The videos stay
            on YouTube; delete them in YouTube Studio if you want them removed
            there too.
          </p>
        </Q>
        <Q q="Delete your hosted account or ask a privacy question">
          <p>
            Disconnecting YouTube does not erase your hosted sign-in account. To
            delete it, email{" "}
            <Link href="mailto:aarshpersonal@proton.me">
              aarshpersonal@proton.me
            </Link>{" "}
            from your sign-in address with the subject “Delete my Better Clips
            account”. We verify your request before removing the remaining
            sign-in ID, email and hosted account records. This does not delete
            videos on YouTube or files in your own bucket. Use the same address
            for privacy questions. Do not send passwords or tokens.
          </p>
        </Q>
      </Section>
    </InfoShell>
  )
}
