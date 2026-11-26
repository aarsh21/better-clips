import type { Context, Hono } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"

export type HostedEnv = {
  DB?: D1Database
  CREDS_KEY?: string
  /* Replacing CREDS_KEY: move the old one to CREDS_KEY_PREVIOUS and add one
   * to CREDS_KEY_VERSION (1 when unset). Stored secrets are re-encrypted
   * with the new key the next time they're used. */
  CREDS_KEY_VERSION?: string
  CREDS_KEY_PREVIOUS?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  GOOGLE_OAUTH?: string
  YOUTUBE_API?: string
}

export type SignedIn = {
  userId: string
  email: string
}

export const local = (url: string | undefined) =>
  url && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url)
    ? url
    : null

const encoder = new TextEncoder()

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

const unb64url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0)
  )

export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export async function sha256(text: string) {
  return b64url(await crypto.subtle.digest("SHA-256", encoder.encode(text)))
}

const keyCache = new Map<string, Promise<CryptoKey>>()

export const currentVersion = (env: HostedEnv) =>
  Number(env.CREDS_KEY_VERSION) || 1

async function deriveKey(base64: string) {
  const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))

  if (raw.length !== 32) throw new Error("CREDS_KEY must be 32 bytes, base64")

  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, [
    "deriveKey",
  ])

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: encoder.encode("clips encrypt"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}

function keys(env: HostedEnv, version = currentVersion(env)) {
  const base64 =
    version === currentVersion(env)
      ? env.CREDS_KEY
      : version === currentVersion(env) - 1
        ? env.CREDS_KEY_PREVIOUS
        : undefined

  if (!base64) throw new Error(`No CREDS_KEY for version ${version}`)
  let hit = keyCache.get(base64)

  if (!hit) {
    hit = deriveKey(base64)
    keyCache.set(base64, hit)
  }

  return hit
}

export async function encrypt(env: HostedEnv, text: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))

  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await keys(env),
    encoder.encode(text)
  )

  return `${b64url(iv)}.${b64url(sealed)}`
}

export async function decrypt(env: HostedEnv, sealed: string, version: number) {
  const [iv, data] = sealed.split(".")

  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64url(iv) },
    await keys(env, version),
    unb64url(data)
  )

  return new TextDecoder().decode(plain)
}

const SESSION_COOKIE = "clips_sid"
const SESSION_DAYS = 30

export async function signedIn(c: Context) {
  const env: HostedEnv = c.env
  const sid = getCookie(c, SESSION_COOKIE)

  if (!sid) return null
  const hash = await sha256(sid)

  const row = await env
    .DB!.prepare(
      `SELECT u.id AS user_id, u.email
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ? AND s.expires > ?`
    )
    .bind(hash, Date.now())
    .first<{ user_id: string; email: string }>()

  return row ? { userId: row.user_id, email: row.email } : null
}

export async function startSession(c: Context, userId: string) {
  const env: HostedEnv = c.env
  const sid = randomToken()
  const expires = Date.now() + SESSION_DAYS * 86_400_000

  await env.DB!.batch([
    env
      .DB!.prepare("DELETE FROM sessions WHERE user_id = ? AND expires < ?")
      .bind(userId, Date.now()),
    env
      .DB!.prepare(
        "INSERT INTO sessions (id_hash, user_id, expires) VALUES (?, ?, ?)"
      )
      .bind(await sha256(sid), userId, expires),
  ])

  setCookie(c, SESSION_COOKIE, sid, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: SESSION_DAYS * 86_400,
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- registered on index.ts’s app
export function hostedRoutes(app: Hono<any>) {
  app.post("/api/auth/logout", async (c) => {
    const env: HostedEnv = c.env
    const sid = getCookie(c, SESSION_COOKIE)

    if (sid) {
      const hash = await sha256(sid)

      await env
        .DB!.prepare("DELETE FROM sessions WHERE id_hash = ?")
        .bind(hash)
        .run()
    }

    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true })

    return c.json({ ok: true })
  })
}
