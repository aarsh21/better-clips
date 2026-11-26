import type * as React from "react"
import { cn } from "cn"

import { Wordmark } from "@/components/brand"
import { buttonVariants } from "@/components/ui/button-variants"
import { APP_PATH } from "@/lib/view"

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
  current: "/faq" | "/privacy" | "/terms"
  title: string
  intro: React.ReactNode
  children: React.ReactNode
}) {
  const pages = [
    { href: "/faq", label: "FAQ" },
    { href: "/privacy", label: "Privacy" },
    { href: "/terms", label: "Terms" },
  ]

  return (
    <div className="min-h-svh">
      <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1320px] items-center gap-6 px-5 sm:px-8">
          <a href="/" aria-label="Better Clips home">
            <Wordmark />
          </a>
          <nav
            aria-label="Pages"
            className="flex items-center gap-4 text-sm sm:gap-5"
          >
            {pages.map(({ href, label }) => (
              <a
                key={href}
                href={href}
                aria-current={href === current ? "page" : undefined}
                className={cn(
                  "text-muted-foreground transition-colors hover:text-foreground",
                  href === current && "text-foreground"
                )}
              >
                {label}
              </a>
            ))}
          </nav>
          <a
            href={APP_PATH}
            className={cn(
              buttonVariants(),
              "ml-auto hidden h-9 px-4 text-sm sm:inline-flex"
            )}
          >
            Open the app
          </a>
        </div>
      </header>
      <main className="mx-auto max-w-[1320px] px-5 pt-16 pb-28 sm:px-8 lg:pt-24">
        <div className="grid gap-x-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,42rem)]">
          <div>
            <h1 className="font-display text-[clamp(3rem,9vw,5.5rem)] lg:sticky lg:top-28">
              {title}
            </h1>
          </div>
          <div>
            <div className="mt-8 mb-14 text-lg leading-relaxed text-muted-foreground lg:mt-0 [&_p+p]:mt-2 [&_p+p]:text-sm">
              {intro}
            </div>
            <div className="flex flex-col gap-16">{children}</div>
          </div>
        </div>
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
    <section className="flex flex-col gap-8">
      <h2 className="border-b pb-3 font-mono text-[11px] tracking-wider text-primary uppercase">
        {title}
      </h2>
      {children}
    </section>
  )
}

/* One question and its answer. */
function Q({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-xl font-bold tracking-[-0.01em] [font-stretch:85%]">
        {q}
      </h3>
      <div className="flex flex-col gap-3 leading-relaxed text-muted-foreground [&_b]:font-medium [&_b]:text-foreground [&_li]:pl-1 [&_ul]:flex [&_ul]:list-disc [&_ul]:flex-col [&_ul]:gap-1.5 [&_ul]:pl-4">
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
            OBS keeps an MP4 in your recording folder and uploads it to your
            channel. In <b>Tools → Better Clips Settings</b>, choose how to
            connect:
          </p>
          <ul>
            <li>
              <b>YouTube, through the Better Clips app</b>: clips go to your
              YouTube channel. The app starts each upload, and OBS sends the
              video straight to YouTube, so the file never passes through the
              app. The app keeps a library entry for each clip, so you can
              watch, rename, share and delete it here.
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
            When connecting YouTube through the app, Google asks for all
            permissions together:
          </p>
          <ul>
            <li>
              <b>Your email address and Google account ID</b>, to sign you in.
            </li>
            <li>
              <b>See, edit and permanently delete your YouTube videos</b>, to
              find your channel, upload your replays and show them in your
              library. Only videos uploaded by Better Clips can be renamed, have
              their visibility changed or be deleted through the app.
            </li>
          </ul>
          <p>
            Google&apos;s page lets you untick boxes, but Better Clips needs all
            of them. If one is unticked, signing in fails: sign in again and
            tick every box.
          </p>
          <p>
            In direct mode, OBS asks only to upload videos and to view your
            YouTube account so it can show the channel and check processing. It
            doesn&apos;t ask for your email or Google account ID. (Version 0.4.0
            also asked for those, but never used them.)
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
              <b>Directly: yes.</b> OBS saves the token in your operating
              system&apos;s secure storage and sends it only to Google. If
              secure storage is unavailable, the token stays in memory and you
              need to sign in again after restarting OBS.
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
            Removing a hosted channel removes its library entries. Unpairing one
            device does not. Revoking the Google grant can disconnect both
            routes for the same account. Your videos stay on YouTube. For full
            account deletion, see the{" "}
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
        <Q q="Can I download or edit a clip?">
          <p>
            Download opens your video in YouTube Studio, where you can download
            your own upload. OBS also keeps the original MP4. Clip editing in
            Better Clips is coming soon.
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
              Your email address and the ID of the Google account you sign in
              with.
            </li>
            <li>
              With YouTube: your channel&apos;s ID and name, and Google&apos;s
              refresh token, encrypted at rest when you upload through this app.
              In direct mode, OBS uses your operating system&apos;s secure
              storage, or keeps the token only in memory for this session.
            </li>
          </ul>
        </Q>
        <Q q="Your clips on YouTube">
          <p>
            For each clip OBS uploads through Better Clips: its YouTube video
            ID, title, description, visibility, game or scene, when it was
            recorded, its length, audience, thumbnail and processing status.
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
            on your computer and sends it only to Google. It never reaches
            Better Clips&apos; servers.
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
            Direct OBS keeps the channel details in the plugin settings and the
            Google token in your system&apos;s secure storage (or in memory for
            one session) until you disconnect or it detects loss of access.
          </p>
        </Q>
        <Q q="Removing access">
          <p>
            Click <b>Disconnect YouTube</b> in <b>Settings → YouTube</b>, or
            remove Better Clips in{" "}
            <Link href={GOOGLE_PERMISSIONS}>your Google Account</Link>. A
            successful hosted disconnect removes its YouTube token, paired
            devices and library entries. If you revoke at Google, the app
            removes these records when it detects the revoked grant. Google
            revocation affects both routes for the same Google account.
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
            videos on YouTube or local recordings. Use the same address for
            privacy questions. Do not send passwords or tokens.
          </p>
        </Q>
      </Section>
    </InfoShell>
  )
}

export function Terms() {
  return (
    <InfoShell
      current="/terms"
      title="Terms of service"
      intro={
        <>
          <p>
            These terms cover the hosted Better Clips app at clips.zabimaru.me
            and the Better Clips plugin for OBS. By using Better Clips you agree
            to them. See also the <Link href="/privacy">privacy policy</Link>.
          </p>
          <p className="mt-2">Last updated 26 November 2026.</p>
        </>
      }
    >
      <Section title="The service">
        <Q q="What Better Clips is">
          <p>
            Better Clips is a plugin for OBS and a web app. When you press its
            hotkey, OBS keeps a local copy and uploads the replay to your
            YouTube channel. The app lets you watch, rename, share and delete
            clips uploaded through it.
          </p>
        </Q>
        <Q q="Provided as is">
          <p>
            Better Clips is free, open-source software, provided as is, without
            warranties of any kind. It may change, be unavailable or stop, and a
            clip can fail to upload. Keep copies of clips that matter to you. To
            the extent the law allows, we are not liable for lost clips, lost
            data, or indirect or consequential damages from using Better Clips.
          </p>
        </Q>
        <Q q="Fair use of the hosted app">
          <p>
            Don&apos;t use Better Clips to break the law, to infringe
            others&apos; rights, or to attack or overload the service. We may
            suspend an account that does.
          </p>
        </Q>
      </Section>

      <Section title="YouTube">
        <Q q="YouTube Terms of Service">
          <p>
            Better Clips uses YouTube API Services. By using the YouTube
            features of Better Clips, you agree to be bound by the{" "}
            <Link href={YOUTUBE_TERMS}>YouTube Terms of Service</Link>. Google
            handles your data as described in the{" "}
            <Link href={GOOGLE_PRIVACY}>Google Privacy Policy</Link>.
          </p>
        </Q>
        <Q q="What Better Clips does on your channel">
          <p>
            With your permission, Better Clips uploads the clips you save in
            OBS, reads their processing status, and renames, changes the
            visibility of, or deletes them when you ask. It only changes videos
            uploaded through Better Clips. You can remove its access at any time
            in <Link href={GOOGLE_PERMISSIONS}>your Google Account</Link>.
          </p>
        </Q>
      </Section>

      <Section title="Your content">
        <Q q="Your clips are yours">
          <p>
            You keep all rights to your clips. They are stored on your own
            channel. You let Better Clips handle them only as needed to upload,
            list, play, rename, share and delete them for you.
          </p>
        </Q>
        <Q q="What you're responsible for">
          <ul>
            <li>
              Having the right to record and share what you clip, and following
              the rules of the games and platforms you use.
            </li>
            <li>
              Video visibility: anyone with the link can watch an unlisted
              video. Choose Private to restrict access.
            </li>
          </ul>
        </Q>
      </Section>

      <Section title="Ending">
        <Q q="Disconnect or delete your account">
          <p>
            You can stop using Better Clips at any time. Disconnect YouTube in{" "}
            <b>Settings → YouTube</b>. To delete your hosted account, email{" "}
            <Link href="mailto:aarshpersonal@proton.me">
              aarshpersonal@proton.me
            </Link>{" "}
            from your sign-in address with the subject “Delete my Better Clips
            account”. This does not delete videos on YouTube or local
            recordings.
          </p>
        </Q>
        <Q q="Open source and self-hosting">
          <p>
            The plugin and the app are licensed under the{" "}
            <Link href={`${REPO}/blob/main/LICENSE`}>GPL-2.0</Link>. A copy you
            host yourself runs in your own Cloudflare account; these terms cover
            the hosted app.
          </p>
        </Q>
        <Q q="Changes and contact">
          <p>
            We may update these terms and will change the date above when we do.
            Questions? Email{" "}
            <Link href="mailto:aarshpersonal@proton.me">
              aarshpersonal@proton.me
            </Link>{" "}
            or open an issue on <Link href={ISSUES}>GitHub</Link>.
          </p>
        </Q>
      </Section>
    </InfoShell>
  )
}
