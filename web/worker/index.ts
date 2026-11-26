import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { hostedRoutes, signedIn, type HostedEnv, type SignedIn } from "./hosted"
import {
  youtubeClips,
  youtubeInfo,
  youtubeMaintenance,
  youtubeRoutes,
} from "./youtube"

const app = new Hono<{ Bindings: HostedEnv; Variables: { who: SignedIn } }>()

// These handlers authenticate their own OAuth flow or OBS credential.
const deviceRoutes = new Set([
  "/api/youtube/connect",
  "/api/youtube/callback",
  "/api/youtube/obs/exchange",
  "/api/youtube/obs/status",
  "/api/youtube/obs/unpair",
  "/api/youtube/upload/start",
  "/api/youtube/upload/complete",
  "/api/youtube/upload/status",
])

app.use("/api/*", async (c, next) => {
  if (
    deviceRoutes.has(c.req.path) ||
    (c.req.path === "/api/youtube/disconnect" && c.req.header("authorization"))
  )
    return next()
  const who = await signedIn(c)

  if (!who) return c.json({ error: "Not signed in", auth: "google" }, 401)
  c.set("who", who)
  c.header("cache-control", "no-store")
  c.header("x-clips-account", who.userId)
  const expected = c.req.header("x-clips-account")

  if (
    expected &&
    expected !== who.userId &&
    !["GET", "HEAD"].includes(c.req.method)
  )
    return c.json(
      {
        error: "You signed in as someone else in another tab.",
        account: "changed",
      },
      409
    )

  return next()
})

app.get("/api/me", async (c) => {
  const who = c.get("who")

  return c.json({
    email: who.email,
    youtube: await youtubeInfo(c.env, who.userId),
  })
})

app.get("/api/clips", async (c) => {
  const yt = await youtubeClips(c.env, c.get("who").userId, c.executionCtx)

  return c.json({
    youtube: yt.clips,
    returning: yt.returning,
    errors: yt.stale
      ? { youtube: "Could not refresh YouTube clips." }
      : undefined,
  })
})

hostedRoutes(app)

youtubeRoutes(app)

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404))

app.onError((err, c) => {
  if (err instanceof HTTPException)
    return c.json(
      {
        error: err.message,
        ...(err.status === 401 &&
          c.req.header("authorization") && { reason: "revoked" }),
      },
      err.status
    )
  console.error(err)

  return c.json({ error: "Could not complete the request." }, 500)
})

export default {
  fetch: app.fetch,
  scheduled: (_event, env, ctx) => ctx.waitUntil(youtubeMaintenance(env)),
} satisfies ExportedHandler<HostedEnv>
