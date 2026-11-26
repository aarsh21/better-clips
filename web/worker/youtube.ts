import type { Context, Hono } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { HTTPException } from "hono/http-exception"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import {
  currentVersion,
  decrypt,
  encrypt,
  local,
  randomToken,
  sha256,
  signedIn,
  startSession,
  type HostedEnv,
} from "./hosted"

const requiredScopes = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/youtube.force-ssl",
]

function hasAllScopes(scopes: string | undefined) {
  const granted = new Set(scopes?.split(" "))

  if (granted.has("https://www.googleapis.com/auth/userinfo.email"))
    granted.add("email")

  return requiredScopes.every((s) => granted.has(s))
}

const api = (env: HostedEnv) =>
  local(env.YOUTUBE_API) ?? "https://www.googleapis.com"

const oauth = (env: HostedEnv) =>
  local(env.GOOGLE_OAUTH) ?? "https://oauth2.googleapis.com"

const callback = (c: Context) =>
  new URL("/api/youtube/callback", c.req.url).href

const cookie = "clips_youtube_oauth"
const path = "/api/youtube"
const day = 86400000
const readyInterval = 15 * 60000
const editGrace = 30000

type Account = {
  user_id: string
  grant_id: string
  sync_failed: number
  had_clips: number
  default_made_for_kids: number | null
  subject: string
  channel_id: string
  channel_title: string
  scopes: string
  refresh_enc: string
  key_version: number
}

type Token = {
  access_token: string
  refresh_token?: string
  scope: string
  error?: string
}

type Flow = {
  state: string
  verifier: string
  purpose: string
  user: string
  port: number
  obsState: string
  challenge: string
  expires: number
}

type Video = {
  id: string
  etag: string
  snippet: {
    channelId: string
    title: string
    description: string
    categoryId: string
    tags?: string[]
    defaultLanguage?: string
    thumbnails?: Record<string, { url: string }>
  }
  status: {
    privacyStatus: string
    uploadStatus: string
    license?: string
    embeddable?: boolean
    publicStatsViewable?: boolean
    madeForKids?: boolean
    selfDeclaredMadeForKids?: boolean
    containsSyntheticMedia?: boolean
    publishAt?: string
  }
  contentDetails: { duration: string }
}

async function account(env: HostedEnv, user: string) {
  return env
    .DB!.prepare("SELECT * FROM youtube_accounts WHERE user_id=?")
    .bind(user)
    .first<Account>()
}

export async function youtubeInfo(env: HostedEnv, user: string) {
  const a = await account(env, user)

  return (
    a && {
      channelId: a.channel_id,
      channelTitle: a.channel_title,
      defaultMadeForKids: accountAudience(a),
      devices: (
        await env
          .DB!.prepare(
            "SELECT id,last_seen AS lastSeen FROM youtube_devices WHERE user_id=? ORDER BY last_seen DESC,id"
          )
          .bind(user)
          .all()
      ).results,
      ...(await env
        .DB!.prepare(
          `SELECT count(*) AS clipCount, count(start) + count(end) AS cutPointCount
           FROM youtube_clips WHERE user_id=? AND videoId IS NOT NULL`
        )
        .bind(user)
        .first<{ clipCount: number; cutPointCount: number }>()),
    }
  )
}

async function obs(c: Context) {
  const env: HostedEnv = c.env
  const token = /^Bearer (\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1]

  const user =
    token &&
    (await env
      .DB!.prepare(
        "UPDATE youtube_devices SET last_seen=? WHERE token_hash=? RETURNING user_id"
      )
      .bind(Date.now(), await sha256(token))
      .first<string>("user_id"))

  return user ? account(env, user) : null
}

const reconnect = "YouTube access stopped working. Sign in with YouTube again."

async function tokenRequest(env: HostedEnv, fields: Record<string, string>) {
  const res = await fetch(`${oauth(env)}/token`, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    body: new URLSearchParams({
      ...fields,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
    }),
  })

  // Google returns invalid_grant in a 400 response when access was revoked.
  if (!res.ok) {
    if (res.status === 400) return res.json<Token>()
    throw new Error("Google sign-in is unavailable. Try again.")
  }

  return res.json<Token>()
}

async function access(env: HostedEnv, a: Account) {
  const plain = await decrypt(env, a.refresh_enc, a.key_version)

  const t = await tokenRequest(env, {
    grant_type: "refresh_token",
    refresh_token: plain,
  })

  if (!t.access_token) {
    if (t.error === "invalid_grant") {
      const deleted = await env
        .DB!.prepare(
          "DELETE FROM youtube_accounts WHERE user_id=? AND refresh_enc=? AND grant_id=?"
        )
        .bind(a.user_id, a.refresh_enc, a.grant_id)
        .run()

      if (!deleted.meta.changes)
        throw new HTTPException(409, {
          message: "The channel connection changed. Try again.",
        })
      throw new HTTPException(401, { message: reconnect })
    }

    throw new Error("Google could not renew access. Try again.")
  }

  if (a.key_version !== currentVersion(env) || t.refresh_token)
    await env
      .DB!.prepare(
        "UPDATE youtube_accounts SET refresh_enc=?,key_version=? WHERE user_id=? AND refresh_enc=?"
      )
      .bind(
        await encrypt(env, t.refresh_token ?? plain),
        currentVersion(env),
        a.user_id,
        a.refresh_enc
      )
      .run()

  return t.access_token
}

async function google(
  env: HostedEnv,
  token: string,
  route: string,
  init?: RequestInit
) {
  const res = await fetch(api(env) + route, {
    signal: AbortSignal.timeout(15000),
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init?.headers },
  })

  if (!res.ok) throw await googleError(res)

  return res
}

async function googleError(res: Response) {
  const err = await res
    .json<{ error: { errors?: { reason: string }[] } }>()
    .catch(() => null)

  const reason = err?.error?.errors?.[0]?.reason
  // SAFETY: only upstream error statuses (4xx/5xx) are forwarded.
  const status = res.status >= 400 ? (res.status as ContentfulStatusCode) : 502

  return new HTTPException(
    status === 401
      ? 502
      : status === 403 && /rateLimit/i.test(reason ?? "")
        ? 429
        : status,
    {
      message:
        reason &&
        ["quotaExceeded", "dailyLimitExceeded", "uploadLimitExceeded"].includes(
          reason
        )
          ? "The YouTube upload limit was reached. Try again tomorrow."
          : res.status === 401
            ? reconnect
            : `YouTube refused the request (${reason ?? res.status}).`,
    }
  )
}

async function videos(env: HostedEnv, token: string, ids: string[]) {
  const res = await google(
    env,
    token,
    `/youtube/v3/videos?part=snippet,status,contentDetails&id=${encodeURIComponent(ids.join(","))}`
  )

  return (await res.json<{ items: Video[] }>()).items
}

async function myChannel(env: HostedEnv, token: string) {
  const res = await google(
    env,
    token,
    "/youtube/v3/channels?part=snippet&mine=true"
  )

  const channels = await res.json<{
    items: { id: string; snippet: { title: string } }[]
  }>()

  return channels.items[0]
}

function duration(iso: string) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(iso)

  return m
    ? Number(m[1] ?? 0) * 86400 +
        Number(m[2] ?? 0) * 3600 +
        Number(m[3] ?? 0) * 60 +
        Number(m[4] ?? 0)
    : null
}

async function sync(
  env: HostedEnv,
  a: Account,
  ids?: string[],
  token?: string
) {
  const now = Date.now(),
    lease = now + 60000

  const { results: batch } = await env
    .DB!.prepare(
      `UPDATE youtube_clips SET nextSync=?1,editLease=0,madeForKids=NULL WHERE id IN (
    SELECT id FROM youtube_clips WHERE user_id=?2 AND videoId IS NOT NULL AND nextSync<=?3 AND editLease<=?3
    AND (?4 IS NULL OR videoId IN (SELECT value FROM json_each(?4)))
    ORDER BY status='processing' DESC,nextSync LIMIT 50) RETURNING videoId,editedAt`
    )
    .bind(lease, a.user_id, now, ids ? JSON.stringify(ids) : null)
    .all<{ videoId: string; editedAt: number }>()

  if (!batch.length) return

  const found = await videos(
    env,
    token ?? (await access(env, a)),
    batch.map((row) => row.videoId)
  )

  await env.DB!.batch(
    batch.flatMap(({ videoId: id, editedAt }) => {
      const v = found.find(
        (v) => v.id === id && v.snippet.channelId === a.channel_id
      )

      if (!v)
        return [
          env
            .DB!.prepare(
              `DELETE FROM youtube_clips WHERE videoId=? AND editedAt=? AND nextSync=? AND editLease=0 AND missing_since<=?`
            )
            .bind(id, editedAt, lease, now - 7 * day),
          env
            .DB!.prepare(
              `UPDATE youtube_clips SET misses=misses+1,missing_since=coalesce(missing_since,?),nextSync=? WHERE videoId=? AND editedAt=? AND nextSync=? AND editLease=0`
            )
            .bind(now, now + day, id, editedAt, lease),
        ]
      const thumbs = v.snippet.thumbnails
      const status = v.status.uploadStatus
      const inGrace = now < editedAt + editGrace

      return env
        .DB!.prepare(
          `UPDATE youtube_clips SET
                title=?2,pendingTitle=CASE WHEN ?11 THEN nullif(pendingTitle,?2) END,
                description=?3,pendingDescription=CASE WHEN ?11 THEN nullif(pendingDescription,?3) END,
                privacy=?4,pendingPrivacy=CASE WHEN ?11 THEN nullif(pendingPrivacy,?4) END,
                durationSeconds=?5,thumbnail=?6,status=?7,misses=0,missing_since=NULL,nextSync=?1,madeForKids=?12
                WHERE videoId=?8 AND editedAt=?9 AND nextSync=?10 AND editLease=0`
        )
        .bind(
          Math.min(
            Date.now() + (status === "uploaded" ? 3000 : readyInterval),
            inGrace ? editedAt + editGrace : Infinity
          ),
          v.snippet.title,
          v.snippet.description,
          v.status.privacyStatus,
          duration(v.contentDetails.duration),
          thumbs?.high?.url ??
            thumbs?.medium?.url ??
            thumbs?.default?.url ??
            null,
          status === "processed"
            ? "ready"
            : ["rejected", "failed", "deleted"].includes(status)
              ? "failed"
              : "processing",
          id,
          editedAt,
          lease,
          Number(inGrace),
          isAudience(v.status.madeForKids) ? Number(v.status.madeForKids) : null
        )
    })
  )

  return true
}

export async function youtubeClips(
  env: HostedEnv,
  user: string,
  ctx: Pick<ExecutionContext, "waitUntil">
) {
  const db = env.DB!,
    a = await account(env, user)

  if (!a) return { clips: [], stale: false }

  ctx.waitUntil(
    sync(env, a)
      .then(
        (updated) => (updated ? 0 : null),
        () => 1
      )
      .then(async (failed) => {
        if (failed !== null && failed !== a.sync_failed)
          await db
            .prepare(
              "UPDATE youtube_accounts SET sync_failed=? WHERE user_id=? AND grant_id=?"
            )
            .bind(failed, user, a.grant_id)
            .run()
      })
  )

  const { results } = await db
    .prepare(
      `SELECT id,videoId,coalesce(pendingTitle,title) AS title,pendingTitle,
       coalesce(pendingDescription,description) AS description,pendingDescription,category,
       coalesce(pendingPrivacy,privacy) AS privacy,pendingPrivacy,recordedAt,uploaded,durationSeconds,thumbnail,CASE WHEN missing_since IS NULL THEN status ELSE 'missing' END AS status,start,end,madeForKids
       FROM youtube_clips WHERE user_id=? AND videoId IS NOT NULL ORDER BY recordedAt DESC`
    )
    .bind(user)
    .all()

  return {
    returning: Boolean(a.had_clips),
    stale: Boolean(a.sync_failed),
    clips: results.map(({ start, end, madeForKids, ...row }) => ({
      ...row,
      madeForKids: madeForKids === 0 ? false : madeForKids === 1 ? true : null,
      cut: start === null ? null : { start, end },
      url: `https://youtu.be/${row.videoId}`,
    })),
  }
}

export async function youtubeMaintenance(env: HostedEnv) {
  const db = env.DB!,
    now = Date.now()

  await db.batch([
    db.prepare("DELETE FROM youtube_codes WHERE expires<=?").bind(now),
    db
      .prepare("DELETE FROM youtube_clips WHERE videoId IS NULL AND uploaded<?")
      .bind(new Date(now - 7 * day).toISOString()),
  ])

  const { results } = await db
    .prepare(
      "SELECT * FROM youtube_accounts WHERE checked<? OR key_version<>? ORDER BY checked LIMIT 5"
    )
    .bind(now - 6 * day, currentVersion(env))
    .all<Account>()

  for (const a of results) {
    try {
      const token = await access(env, a)
      const channel = await myChannel(env, token)

      const ids = await db
        .prepare(
          "SELECT videoId FROM youtube_clips WHERE user_id=? AND videoId IS NOT NULL"
        )
        .bind(a.user_id)
        .all<{ videoId: string }>()

      const batches = []

      for (let i = 0; i < ids.results.length; i += 50)
        batches.push(
          sync(
            env,
            a,
            ids.results.slice(i, i + 50).map((row) => row.videoId),
            token
          )
        )
      await Promise.all(batches)
      await db
        .prepare(
          "UPDATE youtube_accounts SET checked=?, channel_title=? WHERE user_id=?"
        )
        .bind(
          now,
          channel?.id === a.channel_id ? channel.snippet.title : "",
          a.user_id
        )
        .run()
    } catch {
      // Try again tomorrow without blocking older, unvisited accounts.
      await db
        .prepare("UPDATE youtube_accounts SET checked=? WHERE user_id=?")
        .bind(now - 5 * day, a.user_id)
        .run()
      console.warn("YouTube account refresh did not finish")
    }
  }
}

const privacyOk = (v: string) =>
  v === "private" || v === "unlisted" || v === "public"

// These predicates validate incoming JSON before it reaches D1 or Google.
// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof
const isText = (value: unknown): value is string => typeof value === "string"

const isAudience = (value: unknown): value is boolean =>
  value === true || value === false

const accountAudience = (a: Account) =>
  a.default_made_for_kids === null ? null : a.default_made_for_kids === 1

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- untrusted request field
const titleOk = (v: unknown) =>
  isText(v) && !!v.trim() && [...v].length <= 100 && !/[<>]/.test(v)

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- untrusted request field
const descriptionOk = (v: unknown) =>
  isText(v) && new TextEncoder().encode(v).length <= 5000 && !/[<>]/.test(v)

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- registered on index.ts's app
export function youtubeRoutes(app: Hono<any>) {
  app.get(path + "/connect", async (c) => {
    const env: HostedEnv = c.env,
      q = c.req.query(),
      purpose = q.purpose

    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
      return c.redirect("/apps/?auth_error=YouTube+sign-in+is+not+configured")

    if (!["pair", "login", "connect"].includes(purpose))
      return c.json({ error: "Invalid purpose" }, 400)
    const who = await signedIn(c)

    if (purpose !== "login" && purpose !== "pair" && !who)
      return c.json({ error: "Sign in first" }, 401)

    const port = Number(q.obs_port ?? 0),
      obsState = q.obs_state ?? ""

    if (
      (purpose === "pair" ||
        q.obs_port !== undefined ||
        q.obs_state !== undefined) &&
      (!Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        !/^[-\w]{1,256}$/.test(obsState) ||
        !/^[-\w]{43}$/.test(q.obs_challenge ?? ""))
    )
      return c.json({ error: "Invalid OBS return address" }, 400)

    const f: Flow = {
      state: randomToken(),
      verifier: randomToken(),
      purpose,
      user: purpose === "login" && !port ? "" : (who?.userId ?? ""),
      port,
      obsState,
      challenge: q.obs_challenge ?? "",
      expires: Date.now() + 600000,
    }

    setCookie(c, cookie, await encrypt(env, JSON.stringify(f)), {
      path,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 600,
    })

    const url = new URL(
      (local(env.GOOGLE_OAUTH) ?? "https://accounts.google.com") +
        "/o/oauth2/v2/auth"
    )

    const existing = who && (await account(env, who.userId))
    url.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: callback(c),
      response_type: "code",
      state: f.state,
      scope: requiredScopes.join(" "),
      access_type: "offline",
      code_challenge: await sha256(f.verifier),
      code_challenge_method: "S256",
    }).toString()

    if (!hasAllScopes(existing?.scopes))
      url.searchParams.set("prompt", "consent")

    return c.redirect(url.href)
  })
  app.get(path + "/callback", async (c) => {
    const env: HostedEnv = c.env,
      db = env.DB!,
      sealed = getCookie(c, cookie)

    deleteCookie(c, cookie, { path, secure: true })
    let validated: Flow | undefined
    let error = "server_error"

    try {
      const f: Flow = JSON.parse(
        await decrypt(env, sealed ?? "", currentVersion(env)).catch(
          () => "null"
        )
      )

      if (!f || f.state !== c.req.query("state") || Date.now() > f.expires)
        throw new Error("Sign-in expired. Try again.")
      validated = f

      if (f.user && (await signedIn(c))?.userId !== f.user)
        throw new Error("Your sign-in changed. Start again.")

      if (!c.req.query("code")) {
        error = "access_denied"
        throw new Error("YouTube sign-in was cancelled.")
      }

      const t = await tokenRequest(env, {
        code: c.req.query("code")!,
        grant_type: "authorization_code",
        code_verifier: f.verifier,
        redirect_uri: callback(c),
      })

      if (!t.access_token) throw new Error("Google sign-in failed. Try again.")

      if (!hasAllScopes(t.scope)) {
        error = "insufficient_scope"
        throw new Error(
          "YouTube needs all permissions together. Select every permission, or use Cloudflare sign-in for bucket storage only."
        )
      }

      const me = await (
        await google(env, t.access_token, "/oauth2/v3/userinfo")
      ).json<{ sub: string; email: string }>()

      const ch = await myChannel(env, t.access_token)

      if (!me.sub || !me.email || !ch)
        throw new Error("Create a YouTube channel first, then try again.")

      const linked = await db
        .prepare("SELECT user_id FROM youtube_accounts WHERE subject=?")
        .bind(me.sub)
        .first<{ user_id: string }>()

      const user = f.user || linked?.user_id || `google:${me.sub}`
      const old = await account(env, user)

      if (
        (linked && linked.user_id !== user) ||
        (old && (old.subject !== me.sub || old.channel_id !== ch.id))
      )
        throw new Error("Choose the originally connected YouTube channel.")

      if (!f.user && !linked)
        await db
          .prepare(
            "INSERT INTO users(id,email,created) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email"
          )
          .bind(user, me.email, Date.now())
          .run()

      const refresh =
        t.refresh_token ??
        (old && (await decrypt(env, old.refresh_enc, old.key_version)))

      if (!refresh)
        throw new Error(
          "Google did not grant offline access. Reconnect YouTube."
        )

      const saved = await db
        .prepare(
          `INSERT INTO youtube_accounts(user_id,subject,channel_id,channel_title,scopes,refresh_enc,key_version,checked,grant_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET channel_title=excluded.channel_title,scopes=excluded.scopes,refresh_enc=excluded.refresh_enc,key_version=excluded.key_version,grant_id=excluded.grant_id WHERE subject=excluded.subject AND channel_id=excluded.channel_id AND grant_id IS ?`
        )
        .bind(
          user,
          me.sub,
          ch.id,
          ch.snippet.title,
          t.scope,
          await encrypt(env, refresh),
          currentVersion(env),
          Date.now(),
          t.refresh_token || !old ? crypto.randomUUID() : old.grant_id,
          old?.grant_id ?? null
        )
        .run()

      if (!saved.meta.changes)
        throw new Error("The connected channel changed. Try again.")

      if (!f.user) await startSession(c, user)

      if (!f.port) return c.redirect("/apps/")
      const code = randomToken()
      await db
        .prepare(
          "INSERT INTO youtube_codes(hash,user_id,expires,challenge) VALUES(?,?,?,?)"
        )
        .bind(await sha256(code), user, Date.now() + 300000, f.challenge)
        .run()

      return c.redirect(
        `http://127.0.0.1:${f.port}/callback?` +
          new URLSearchParams({ state: f.obsState, code })
      )
    } catch (err) {
      const description =
        err instanceof Error && !err.message.includes("D1_")
          ? err.message
          : "YouTube sign-in failed. Try again."

      if (validated?.port)
        return c.redirect(
          `http://127.0.0.1:${validated.port}/callback?` +
            new URLSearchParams({
              state: validated.obsState,
              error,
              error_description: description,
            })
        )

      return c.redirect("/apps/?auth_error=" + encodeURIComponent(description))
    }
  })
  app.post(path + "/obs/exchange", async (c) => {
    const env: HostedEnv = c.env

    const db = env.DB!,
      { code, verifier } = await c.req.json(),
      uploadToken = randomToken()

    if (!isText(verifier) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
      return c.json({ error: "Invalid pairing verifier" }, 401)

    const a = await db
      .prepare(
        "DELETE FROM youtube_codes WHERE hash=? AND expires>? AND challenge=? RETURNING user_id"
      )
      .bind(await sha256(String(code)), Date.now(), await sha256(verifier))
      .first<{ user_id: string }>()

    if (!a)
      return c.json(
        { error: "The connection code expired or was already used." },
        401
      )

    const inserted = await db
      .prepare(
        "INSERT INTO youtube_devices(id,user_id,token_hash,last_seen) SELECT ?,user_id,?,? FROM youtube_accounts WHERE user_id=?"
      )
      .bind(
        crypto.randomUUID(),
        await sha256(uploadToken),
        Date.now(),
        a.user_id
      )
      .run()

    const info = inserted.meta.changes && (await account(env, a.user_id))

    if (!info) return c.json({ error: reconnect, reason: "revoked" }, 401)

    return c.json(
      {
        channelId: info.channel_id,
        channelTitle: info.channel_title,
        uploadToken,
      },
      200,
      {
        "cache-control": "no-store",
      }
    )
  })
  app.get(path + "/obs/status", async (c) => {
    const a = await obs(c)

    if (!a) return c.json({ error: reconnect, reason: "unpaired" }, 401)

    return c.json(
      { channelTitle: a.channel_title, channelId: a.channel_id },
      200,
      {
        "cache-control": "no-store",
      }
    )
  })
  app.post(path + "/obs/unpair", async (c) => {
    const env: HostedEnv = c.env

    const token = /^Bearer (\S+)$/i.exec(
      c.req.header("authorization") ?? ""
    )?.[1]

    const removed =
      token &&
      (await env
        .DB!.prepare("DELETE FROM youtube_devices WHERE token_hash=?")
        .bind(await sha256(token))
        .run())

    if (!removed || !removed.meta.changes)
      return c.json({ error: reconnect, reason: "unpaired" }, 401)

    return c.json({ unpaired: true })
  })
  app.delete(path + "/devices/:id", async (c) => {
    const env: HostedEnv = c.env

    const removed = await env
      .DB!.prepare("DELETE FROM youtube_devices WHERE user_id=? AND id=?")
      .bind(c.get("who").userId, c.req.param("id"))
      .run()

    return removed.meta.changes
      ? c.json({ unpaired: true })
      : c.json({ error: "Device is no longer paired." }, 404)
  })
  app.put(path + "/audience", async (c) => {
    const env: HostedEnv = c.env
    const { madeForKids } = await c.req.json()

    if (!isAudience(madeForKids))
      return c.json({ error: "Choose Yes or No." }, 400)

    const saved = await env
      .DB!.prepare(
        "UPDATE youtube_accounts SET default_made_for_kids=? WHERE user_id=?"
      )
      .bind(Number(madeForKids), c.get("who").userId)
      .run()

    return saved.meta.changes
      ? c.json({ ok: true })
      : c.json({ error: reconnect }, 404)
  })
  app.post(path + "/upload/start", async (c) => {
    const env: HostedEnv = c.env,
      a = await obs(c)

    if (!a) return c.json({ error: reconnect, reason: "unpaired" }, 401)

    const {
      title,
      description,
      privacy,
      // Clips are gameplay highlights; without a choice, they're not for kids.
      madeForKids = accountAudience(a) ?? false,
      size,
      category,
      recordedAt,
    } = await c.req.json()

    if (
      !titleOk(title) ||
      !descriptionOk(description) ||
      !privacyOk(privacy) ||
      !isAudience(madeForKids) ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      !isText(category) ||
      !isText(recordedAt) ||
      !Number.isFinite(Date.parse(recordedAt))
    )
      return c.json({ error: "Invalid clip details" }, 400)

    const res = await google(
      env,
      await access(env, a),
      "/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-upload-content-type": "video/mp4",
          "x-upload-content-length": String(size),
        },
        body: JSON.stringify({
          snippet: { title, description, categoryId: "20" },
          status: {
            privacyStatus: privacy,
            selfDeclaredMadeForKids: madeForKids,
          },
        }),
      }
    )

    const sessionUrl = res.headers.get("location"),
      clipId = crypto.randomUUID()

    if (!sessionUrl) throw new Error("YouTube did not open the upload.")
    await env
      .DB!.prepare(
        "INSERT INTO youtube_clips(id,user_id,title,description,privacy,category,recordedAt,uploaded,session_enc,session_key_version,size,pendingTitle,pendingDescription,pendingPrivacy) VALUES(?,?,?,?,?,?,?,?,?,?,?,?3,?4,?5)"
      )
      .bind(
        clipId,
        a.user_id,
        title,
        description,
        privacy,
        category,
        new Date(recordedAt).toISOString(),
        new Date().toISOString(),
        await encrypt(env, sessionUrl),
        currentVersion(env),
        size
      )
      .run()

    return c.json({ sessionUrl, clipId }, 200, { "cache-control": "no-store" })
  })
  app.post(path + "/upload/complete", async (c) => {
    const env: HostedEnv = c.env,
      a = await obs(c)

    if (!a) return c.json({ error: reconnect, reason: "unpaired" }, 401)
    const { clipId, videoId } = await c.req.json()

    if (!isText(videoId) || !/^[-\w]{11}$/.test(videoId))
      return c.json({ error: "Invalid video ID" }, 400)

    const clip = await env
      .DB!.prepare(
        "SELECT videoId,session_enc,session_key_version,size FROM youtube_clips WHERE id=? AND user_id=?"
      )
      .bind(clipId, a.user_id)
      .first<{
        videoId: string | null
        session_enc: string
        session_key_version: number
        size: number
      }>()

    if (!clip) return c.json({ error: "Upload not found" }, 404)

    if (!clip.videoId) {
      // Do not let an OBS token enroll arbitrary existing videos for management.
      const session = await decrypt(
        env,
        clip.session_enc,
        clip.session_key_version
      )

      const url = new URL(session)

      if (
        url.origin !== new URL(api(env)).origin &&
        !(url.protocol === "https:" && url.hostname.endsWith(".googleapis.com"))
      )
        throw new Error("Unexpected YouTube receipt address")

      const receipt = await fetch(session, {
        method: "PUT",
        headers: {
          "content-range": `bytes */${clip.size}`,
          authorization: `Bearer ${await access(env, a)}`,
          "content-length": "0",
        },
        redirect: "manual",
        body: "",
      })

      if (receipt.status >= 400) throw await googleError(receipt)

      if (!receipt.ok || (await receipt.json<{ id: string }>()).id !== videoId)
        return c.json(
          { error: "YouTube has not confirmed this video yet." },
          409
        )
    }

    const result = await env
      .DB!.prepare(
        "UPDATE youtube_clips SET videoId=?,uploaded=CASE WHEN videoId IS NULL THEN ? ELSE uploaded END,session_enc=NULL,session_key_version=NULL,status=CASE WHEN videoId IS NULL THEN 'processing' ELSE status END WHERE id=? AND user_id=? AND (videoId IS NULL OR videoId=?)"
      )
      .bind(videoId, new Date().toISOString(), clipId, a.user_id, videoId)
      .run()

    if (!result.meta.changes) return c.json({ error: "Upload not found" }, 404)

    return c.json({ url: `https://youtu.be/${videoId}` })
  })
  app.get(path + "/upload/status", async (c) => {
    const env: HostedEnv = c.env,
      a = await obs(c)

    if (!a) return c.json({ error: reconnect, reason: "unpaired" }, 401)
    const id = c.req.query("clipId") ?? ""

    const clip = await env
      .DB!.prepare(
        "SELECT videoId,status FROM youtube_clips WHERE user_id=? AND id=? AND videoId IS NOT NULL"
      )
      .bind(a.user_id, id)
      .first<{ videoId: string; status: string }>()

    if (!clip) return c.json({ error: "Clip not found" }, 404)
    let status = clip.status

    if (status === "processing") {
      await sync(env, a, [clip.videoId])
      status =
        (await env
          .DB!.prepare(
            "SELECT status FROM youtube_clips WHERE user_id=? AND id=?"
          )
          .bind(a.user_id, id)
          .first<string>("status")) ?? "failed"
    }

    return c.json({ status, url: `https://youtu.be/${clip.videoId}` }, 200, {
      "cache-control": "no-store",
    })
  })
  // D1 owns the lock, so edits from different Worker isolates also serialize.
  app.use(path + "/clips/:id", async (c, next) => {
    if (c.req.method !== "PATCH" && c.req.method !== "DELETE") return next()

    const env: HostedEnv = c.env,
      id = c.req.param("id"),
      user = c.get("who").userId

    const lease = Date.now() + 120000

    for (let attempt = 0; attempt < 20; attempt++) {
      const lock = await env
        .DB!.prepare(
          "UPDATE youtube_clips SET editLease=? WHERE id=? AND user_id=? AND editLease<=?"
        )
        .bind(lease, id, user, Date.now())
        .run()

      if (lock.meta.changes) {
        try {
          return await next()
        } finally {
          await env
            .DB!.prepare(
              "UPDATE youtube_clips SET editLease=0 WHERE id=? AND user_id=? AND editLease=?"
            )
            .bind(id, user, lease)
            .run()
        }
      }

      if (
        !(await env
          .DB!.prepare("SELECT 1 FROM youtube_clips WHERE id=? AND user_id=?")
          .bind(id, user)
          .first())
      )
        return c.json({ error: "Clip not found" }, 404)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    return c.json({ error: "Another edit is still saving. Try again." }, 409)
  })
  app.on(
    ["PATCH", "PUT", "DELETE"],
    [path + "/clips/:id", path + "/clips/:id/cut"],
    async (c) => {
      const env: HostedEnv = c.env,
        db = env.DB!,
        user = c.get("who").userId,
        a = await account(env, user),
        id = c.req.param("id")

      if (!a) return c.json({ error: reconnect }, 401)

      const clip = await db
        .prepare(
          "SELECT videoId,durationSeconds FROM youtube_clips WHERE id=? AND user_id=? AND videoId IS NOT NULL"
        )
        .bind(id, user)
        .first<{
          videoId: string
          durationSeconds: number | null
        }>()

      if (!clip) return c.json({ error: "Clip not found" }, 404)

      if (c.req.path.endsWith("/cut")) {
        if (c.req.method !== "PUT")
          return c.json({ error: "Use PUT for cuts" }, 405)
        const cut = await c.req.json()

        if (
          cut !== null &&
          (!Number.isSafeInteger(cut?.start) ||
            !Number.isSafeInteger(cut?.end) ||
            cut.start < 0 ||
            cut.end <= cut.start ||
            (clip.durationSeconds !== null &&
              cut.end > Math.ceil(clip.durationSeconds)))
        )
          return c.json({ error: "Invalid whole-second cut" }, 400)

        const saved = await db
          .prepare(
            "UPDATE youtube_clips SET start=?,end=? WHERE id=? AND user_id=?"
          )
          .bind(cut?.start ?? null, cut?.end ?? null, id, user)
          .run()

        if (!saved.meta.changes)
          return c.json({ error: "This clip is gone." }, 404)
      } else if (c.req.method === "DELETE") {
        await google(
          env,
          await access(env, a),
          `/youtube/v3/videos?id=${clip.videoId}`,
          { method: "DELETE" }
        )
        await db
          .prepare("DELETE FROM youtube_clips WHERE id=? AND user_id=?")
          .bind(id, user)
          .run()
      } else if (c.req.method === "PATCH") {
        const { title, description, privacy } = await c.req.json()

        if (
          (title !== undefined && !titleOk(title)) ||
          (description !== undefined && !descriptionOk(description)) ||
          (privacy !== undefined && !privacyOk(privacy)) ||
          [title, description, privacy].every((v) => v === undefined)
        )
          return c.json({ error: "Invalid clip details" }, 400)

        const token = await access(env, a)

        for (let attempt = 0; ; attempt++) {
          const [v] = await videos(env, token, [clip.videoId])

          if (!v || v.snippet.channelId !== a.channel_id)
            return c.json({ error: "Clip not found" }, 404)

          type UpdateParts = {
            snippet?: Omit<Video["snippet"], "channelId">
            status?: Omit<Video["status"], "uploadStatus">
          }

          const parts: UpdateParts = {}

          if (title !== undefined || description !== undefined)
            parts.snippet = {
              title: title ?? v.snippet.title,
              description: description ?? v.snippet.description,
              categoryId: v.snippet.categoryId,
              tags: v.snippet.tags,
              defaultLanguage: v.snippet.defaultLanguage,
            }

          if (privacy !== undefined) {
            const {
              license,
              embeddable,
              publicStatsViewable,
              selfDeclaredMadeForKids,
              containsSyntheticMedia,
              publishAt,
            } = v.status

            parts.status = {
              privacyStatus: privacy,
              license,
              embeddable,
              publicStatsViewable,
              selfDeclaredMadeForKids,
              containsSyntheticMedia,
              publishAt: privacy === "private" ? publishAt : undefined,
            }
          }

          // YouTube replaces whole parts. Re-read and rebuild on a stale ETag;
          // never fill an untouched field from our pending edit.
          if (!v.etag)
            throw new Error("YouTube didn't return a video version. Try again.")

          try {
            await google(
              env,
              token,
              "/youtube/v3/videos?part=" + Object.keys(parts).join(","),
              {
                method: "PUT",
                headers: {
                  "content-type": "application/json",
                  "if-match": v.etag.startsWith('"') ? v.etag : `"${v.etag}"`,
                },
                body: JSON.stringify({ id: v.id, ...parts }),
              }
            )
          } catch (err) {
            if (
              err instanceof HTTPException &&
              err.status === 412 &&
              attempt < 2
            )
              continue
            throw err
          }

          await db
            .prepare(
              `UPDATE youtube_clips SET title=?,description=?,privacy=?,pendingTitle=?,pendingDescription=?,pendingPrivacy=?,
             editedAt=max(editedAt+1,?),nextSync=0 WHERE id=? AND user_id=?`
            )
            .bind(
              v.snippet.title,
              v.snippet.description,
              v.status.privacyStatus,
              title ?? null,
              description ?? null,
              privacy ?? null,
              Date.now(),
              id,
              user
            )
            .run()
          break
        }
      } else return c.json({ error: "Use PATCH to edit clips" }, 405)

      return c.json({ ok: true })
    }
  )
  app.post(path + "/disconnect", async (c) => {
    if (
      !c.req.header("authorization") &&
      c.req.header("Origin") !== new URL(c.req.url).origin
    )
      return c.json({ error: "Untrusted origin" }, 403)

    const env: HostedEnv = c.env,
      a = c.req.header("authorization")
        ? await obs(c)
        : await account(env, c.get("who").userId)

    if (!a) return c.json({ error: reconnect, reason: "unpaired" }, 401)

    const res = await fetch(oauth(env) + "/revoke", {
      method: "POST",
      body: new URLSearchParams({
        token: await decrypt(env, a.refresh_enc, a.key_version),
      }),
    })

    const alreadyInvalid =
      res.status === 400 &&
      (await res.json<{ error?: string }>().catch(() => null))?.error ===
        "invalid_token"

    if (!res.ok && !alreadyInvalid)
      return c.json(
        { error: "Google could not confirm disconnection. Try again." },
        502
      )

    const deleted = await env
      .DB!.prepare(
        "DELETE FROM youtube_accounts WHERE user_id=? AND grant_id=? AND refresh_enc=?"
      )
      .bind(a.user_id, a.grant_id, a.refresh_enc)
      .run()

    if (!deleted.meta.changes)
      return c.json(
        {
          error:
            "The channel connection changed. Review it before disconnecting again.",
        },
        409
      )

    return c.json({ ok: true })
  })
}
