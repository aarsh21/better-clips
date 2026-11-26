/* What the app knows about clips besides the files: settings, thumbnail
 * sizes, share links and uploads in progress. A self-hosted app keeps it in
 * its bucket; the hosted app keeps it in D1, per user. */

export type Settings = { replaysDays: number | null; trashDays: number }

/* Clean-up is paused in a bucket you connected yourself until you confirm
 * the lengths, since it may hold clips the app never saw. */
export type StoredSettings = Settings & { paused: boolean }

export const DEFAULT_SETTINGS: Settings = { replaysDays: 30, trashDays: 7 }

export const REPLAY_DAYS = [7, 14, 30, 60, 90, null]
export const TRASH_DAYS = [1, 3, 7, 14, 30]

/* Settings from JSON, or null unless both lengths are ones the app offers. */
export function parseSettings(text: string | null): Settings | null {
  try {
    const s: { replaysDays?: unknown; trashDays?: unknown } = JSON.parse(
      text ?? ""
    )

    const replaysDays = REPLAY_DAYS.find((d) => d === s.replaysDays)
    const trashDays = TRASH_DAYS.find((d) => d === s.trashDays)

    return replaysDays !== undefined && trashDays !== undefined
      ? { replaysDays, trashDays }
      : null
  } catch {
    return null
  }
}

export type ThumbMeta = {
  duration: number
  width: number
  height: number
  v: string
}

/* etag pins a link to the recording that was shared, and thumbEtag to its
 * thumbnail: if either file is replaced, the link stops showing it instead
 * of showing the new file. */
export type Share = {
  key: string
  expires: number | null
  etag?: string
  thumbEtag?: string
}

/* A move: the clip's ETag before and after, and its thumbnail's, if any. */
export type Moved = {
  from: string
  to: string
  etag: [string, string]
  thumb: [string, string] | null
}

export interface Meta {
  settings(): Promise<StoredSettings>
  /* Saving also confirms the lengths, which starts a paused clean-up. */
  saveSettings(settings: Settings): Promise<void>
  obsSeen(): Promise<string | null>
  markObsSeen(): Promise<void>
  thumbs(): Promise<Map<string, ThumbMeta>>
  thumb(key: string): Promise<ThumbMeta | null>
  putThumb(key: string, meta: Omit<ThumbMeta, "v">): Promise<void>
  /* A clip moved: its thumbnail and the share links of that recording
   * follow it, except into the trash, which turns its links off. */
  moved(move: Moved): Promise<void>
  claimMove(move: Moved): Promise<boolean>
  pendingMoves(): Promise<Moved[]>
  endMove(from: string): Promise<void>
  /* Clips that were deleted for good. */
  forget(keys: string[]): Promise<void>
  createShare(id: string, share: Share): Promise<void>
  /* Reserves a new upload's key. False if another upload already has it. */
  startUpload(uploadId: string, key: string): Promise<boolean>
  /* Whether this user started the upload with this key. */
  uploadState(
    uploadId: string,
    key: string
  ): Promise<"open" | "complete" | null>
  finishUpload(uploadId: string, key: string): Promise<void>
  endUpload(uploadId: string): Promise<void>
}

const live = (share: Share | null) =>
  share && (!share.expires || share.expires > Date.now()) ? share : null

/* ---- Self-hosted: everything in the bucket ---- */

async function listAll(bucket: R2Bucket, prefix: string) {
  const objects: R2Object[] = []
  let cursor: string | undefined

  do {
    const page = await bucket.list({
      prefix,
      cursor,
      limit: 1000,
      include: ["customMetadata"],
    })

    objects.push(...page.objects)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)

  return objects
}

export function bucketMeta(bucket: R2Bucket): Meta {
  return {
    async settings() {
      const stored = await bucket.get("config/settings.json")

      return {
        ...(parseSettings(stored ? await stored.text() : null) ??
          DEFAULT_SETTINGS),
        paused: false,
      }
    },

    async saveSettings(settings) {
      await bucket.put("config/settings.json", JSON.stringify(settings))
    },

    async obsSeen() {
      return (
        (await bucket.head("config/obs-seen"))?.uploaded.toISOString() ?? null
      )
    },

    async markObsSeen() {
      await bucket.put("config/obs-seen", "")
    },

    /* The sizes are stored on the thumbnail objects themselves. */
    async thumbs() {
      const thumbs = await listAll(bucket, "thumbs/")

      return new Map(
        thumbs.map((t) => [
          t.key.slice(7, -4),
          {
            duration: Number(t.customMetadata?.duration ?? 0),
            width: Number(t.customMetadata?.width ?? 0),
            height: Number(t.customMetadata?.height ?? 0),
            v: t.etag.slice(0, 8),
          },
        ])
      )
    },

    async thumb(key) {
      const t = await bucket.head(`thumbs/${key}.jpg`)

      return (
        t && {
          duration: Number(t.customMetadata?.duration ?? 0),
          width: Number(t.customMetadata?.width ?? 0),
          height: Number(t.customMetadata?.height ?? 0),
          v: t.etag.slice(0, 8),
        }
      )
    },

    putThumb: async () => {},

    async claimMove(move) {
      return Boolean(
        await bucket.put(
          `config/moves/${encodeURIComponent(move.from)}`,
          JSON.stringify(move),
          { onlyIf: { etagDoesNotMatch: "*" } }
        )
      )
    },
    async pendingMoves() {
      const rows = await listAll(bucket, "config/moves/")

      const moves = await Promise.all(
        rows
          .filter((r) => r.uploaded.getTime() < Date.now() - 60000)
          .slice(0, 20)
          .map(async (r) => (await bucket.get(r.key))?.json<Moved>())
      )

      return moves.filter((m) => !!m)
    },
    async endMove(from) {
      await bucket.delete(`config/moves/${encodeURIComponent(from)}`)
    },
    async moved({ from, to, etag }) {
      const shares = await listAll(bucket, "shares/")

      await Promise.all(
        shares.map(async (s) => {
          const obj = await bucket.get(s.key)
          const data = obj ? await obj.json<Share>() : null

          if (data?.key !== from) return

          if (to.startsWith("trash/")) await bucket.delete(s.key)
          else
            await bucket.put(
              s.key,
              JSON.stringify({
                ...data,
                key: to,
                ...(data.etag && { etag: etag[1] }),
              })
            )
        })
      )
    },

    forget: async () => {},

    async createShare(id, share) {
      await bucket.put(`shares/${id}.json`, JSON.stringify(share))
    },

    async startUpload(id, key) {
      return Boolean(
        await bucket.put(`config/uploads/${encodeURIComponent(id)}`, key, {
          onlyIf: { etagDoesNotMatch: "*" },
        })
      )
    },
    async uploadState(id, key) {
      const row = await bucket.get(`config/uploads/${encodeURIComponent(id)}`)

      if (!row || (await row.text()) !== key) return null

      return row.customMetadata?.completed ? "complete" : "open"
    },
    async finishUpload(id, key) {
      await bucket.put(`config/uploads/${encodeURIComponent(id)}`, key, {
        customMetadata: { completed: "1" },
      })
    },
    async endUpload(id) {
      await bucket.delete(`config/uploads/${encodeURIComponent(id)}`)
    },
  }
}

export async function bucketShare(bucket: R2Bucket, id: string) {
  const obj = await bucket.get(`shares/${id}.json`)

  return live(obj ? await obj.json<Share>() : null)
}

/* ---- Hosted: D1, one row set per user ---- */

export function d1Meta(db: D1Database, tenant: string): Meta {
  return {
    async settings() {
      const row = await db
        .prepare("SELECT settings, cleanup_on FROM tenants WHERE id = ?")
        .bind(tenant)
        .first<{ settings: string | null; cleanup_on: number }>()

      return {
        ...(parseSettings(row?.settings ?? null) ?? DEFAULT_SETTINGS),
        paused: row?.cleanup_on === 0,
      }
    },

    async saveSettings(settings) {
      await db
        .prepare(
          "UPDATE tenants SET settings = ?, cleanup_on = 1, next_cleanup = 0 WHERE id = ?"
        )
        .bind(JSON.stringify(settings), tenant)
        .run()
    },

    async obsSeen() {
      const row = await db
        .prepare("SELECT obs_seen FROM tenants WHERE id = ?")
        .bind(tenant)
        .first<{ obs_seen: number | null }>()

      return row?.obs_seen ? new Date(row.obs_seen).toISOString() : null
    },

    async markObsSeen() {
      await db
        .prepare("UPDATE tenants SET obs_seen = ? WHERE id = ?")
        .bind(Date.now(), tenant)
        .run()
    },

    async thumbs() {
      const { results } = await db
        .prepare(
          "SELECT key, duration, width, height, v FROM thumbs WHERE tenant_id = ?"
        )
        .bind(tenant)
        .all<ThumbMeta & { key: string }>()

      return new Map(results.map(({ key, ...meta }) => [key, meta]))
    },

    async thumb(key) {
      return db
        .prepare(
          "SELECT duration, width, height, v FROM thumbs WHERE tenant_id = ? AND key = ?"
        )
        .bind(tenant, key)
        .first<ThumbMeta>()
    },

    async putThumb(key, meta) {
      await db
        .prepare(
          `INSERT INTO thumbs (tenant_id, key, duration, width, height, v)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (tenant_id, key) DO UPDATE SET
             duration = ?3, width = ?4, height = ?5, v = ?6`
        )
        .bind(
          tenant,
          key,
          meta.duration,
          meta.width,
          meta.height,
          crypto.randomUUID().slice(0, 8)
        )
        .run()
    },

    async claimMove(move) {
      return Boolean(
        (
          await db
            .prepare(
              "INSERT INTO bucket_moves(tenant_id,source,move,created) VALUES(?,?,?,?) ON CONFLICT DO NOTHING"
            )
            .bind(tenant, move.from, JSON.stringify(move), Date.now())
            .run()
        ).meta.changes
      )
    },
    async pendingMoves() {
      const rows = await db
        .prepare(
          "SELECT move FROM bucket_moves WHERE tenant_id=? AND created<? ORDER BY created LIMIT 20"
        )
        .bind(tenant, Date.now() - 60000)
        .all<{ move: string }>()

      return rows.results.map(({ move }): Moved => JSON.parse(move))
    },
    async endMove(from) {
      await db
        .prepare("DELETE FROM bucket_moves WHERE tenant_id=? AND source=?")
        .bind(tenant, from)
        .run()
    },
    async moved({ from, to, etag, thumb }) {
      /* Only links to the recording that was moved follow it. A link pinned
       * to an earlier recording at this name stays off. */
      await db.batch([
        db
          .prepare("UPDATE thumbs SET key = ? WHERE tenant_id = ? AND key = ?")
          .bind(to, tenant, from),
        to.startsWith("trash/")
          ? db
              .prepare("DELETE FROM shares WHERE tenant_id = ? AND key = ?")
              .bind(tenant, from)
          : db
              .prepare(
                `UPDATE shares SET key = ?1, etag = ?2,
                   thumb_etag = CASE WHEN thumb_etag = ?3 THEN ?4 ELSE NULL END
                 WHERE tenant_id = ?5 AND key = ?6 AND etag = ?7`
              )
              .bind(
                to,
                etag[1],
                thumb?.[0] ?? null,
                thumb?.[1] ?? null,
                tenant,
                from,
                etag[0]
              ),
      ])
    },

    async forget(keys) {
      const batches = []

      for (let i = 0; i < keys.length; i += 50)
        batches.push(keys.slice(i, i + 50))

      /* One round trip: D1 runs a batch as a single transaction. */
      await db.batch(
        batches.flatMap((batch) => {
          const marks = batch.map(() => "?").join(",")

          return [
            db
              .prepare(
                `DELETE FROM thumbs WHERE tenant_id = ? AND key IN (${marks})`
              )
              .bind(tenant, ...batch),
            db
              .prepare(
                `DELETE FROM shares WHERE tenant_id = ? AND key IN (${marks})`
              )
              .bind(tenant, ...batch),
          ]
        })
      )
    },

    async createShare(id, share) {
      await db
        .prepare(
          `INSERT INTO shares (id, tenant_id, key, expires, etag, thumb_etag)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          tenant,
          share.key,
          share.expires,
          share.etag ?? null,
          share.thumbEtag ?? null
        )
        .run()
    },

    async startUpload(uploadId, key) {
      /* Old reservations of uploads that never finished free their key. */
      await db
        .prepare(
          "DELETE FROM uploads WHERE tenant_id = ? AND completed=0 AND created < ?"
        )
        .bind(tenant, Date.now() - 86_400_000)
        .run()

      const { meta } = await db
        .prepare(
          `INSERT INTO uploads (upload_id, tenant_id, key, created)
           VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`
        )
        .bind(uploadId, tenant, key, Date.now())
        .run()

      return meta.changes === 1
    },

    async uploadState(uploadId, key) {
      const row = await db
        .prepare(
          "SELECT completed FROM uploads WHERE upload_id = ? AND tenant_id = ? AND key = ?"
        )
        .bind(uploadId, tenant, key)
        .first<{ completed: number }>()

      return row ? (row.completed ? "complete" : "open") : null
    },
    async finishUpload(id, key) {
      await db
        .prepare(
          "UPDATE uploads SET completed=1 WHERE upload_id=? AND tenant_id=? AND key=?"
        )
        .bind(id, tenant, key)
        .run()
    },

    async endUpload(uploadId) {
      await db
        .prepare(
          "DELETE FROM uploads WHERE upload_id = ? AND tenant_id = ? AND completed=0"
        )
        .bind(uploadId, tenant)
        .run()
    },
  }
}

export async function d1Share(db: D1Database, id: string) {
  const row = await db
    .prepare(
      "SELECT tenant_id, key, expires, etag, thumb_etag FROM shares WHERE id = ?"
    )
    .bind(id)
    .first<{
      tenant_id: string
      key: string
      expires: number | null
      etag: string | null
      thumb_etag: string | null
    }>()

  /* Every hosted link is pinned; one that isn't can't be served safely. */
  if (!row?.etag) return null

  return row && live({ key: row.key, expires: row.expires })
    ? {
        tenant: row.tenant_id,
        key: row.key,
        expires: row.expires,
        etag: row.etag,
        thumbEtag: row.thumb_etag ?? undefined,
      }
    : null
}
