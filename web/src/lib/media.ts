/* Video work done in the browser with Mediabunny (WebCodecs). This module is
 * loaded on demand, so it costs nothing until a clip needs a thumbnail or an
 * edit. Every read is a ranged request, so only the bytes needed are fetched. */

import {
  ALL_FORMATS,
  BufferTarget,
  CanvasSink,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  UrlSource,
} from "mediabunny"

function open(url: string) {
  return new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
}

async function toJpeg(canvas: HTMLCanvasElement | OffscreenCanvas) {
  if ("convertToBlob" in canvas)
    return canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 })

  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/jpeg",
      0.82
    )
  )
}

export async function makeThumbnail(url: string) {
  const input = open(url)

  try {
    const track = await input.getPrimaryVideoTrack()

    if (!track) throw new Error("No video track")
    const duration = await input.computeDuration()

    const sink = new CanvasSink(track, {
      width: 640,
      height: 360,
      fit: "cover",
    })

    /* A third of the way in, at most 3 s: past fades, still near the action. */
    const frame = await sink.getCanvas(Math.min(duration * 0.33, 3))

    if (!frame) throw new Error("No frame")

    return {
      blob: await toJpeg(frame.canvas),
      duration,
      width: track.displayWidth,
      height: track.displayHeight,
    }
  } finally {
    input.dispose()
  }
}

/* Calls onFrame with each filmstrip frame (an object URL, or null for a gap)
 * as soon as it is decoded. Stops quietly when the signal aborts. */
export function loadFilmstrip(
  url: string,
  count: number,
  signal: AbortSignal,
  onFrame: (url: string | null) => void
) {
  void (async () => {
    try {
      for await (const frame of filmstrip(url, count, signal)) {
        if (signal.aborted) {
          if (frame) URL.revokeObjectURL(frame)

          return
        }

        onFrame(frame)
      }
    } catch (err) {
      console.warn("Filmstrip failed", err)
    }
  })()
}

/* Small frames spread across the clip, for the trim timeline. Yields each as
 * an object URL as soon as it is decoded. */
async function* filmstrip(url: string, count: number, signal: AbortSignal) {
  const input = open(url)

  try {
    const track = await input.getPrimaryVideoTrack()

    if (!track) return
    const duration = await input.computeDuration()

    const sink = new CanvasSink(track, {
      width: 192,
      height: 108,
      fit: "cover",
    })

    const times = Array.from(
      { length: count },
      (_, i) => ((i + 0.5) / count) * duration
    )

    for await (const frame of sink.canvasesAtTimestamps(times)) {
      if (signal.aborted) return
      yield frame ? URL.createObjectURL(await toJpeg(frame.canvas)) : null
    }
  } finally {
    input.dispose()
  }
}

/* Cuts [start, end] into a new MP4 without re-encoding: MP4 edit lists keep
 * the cut exact even when it doesn't land on a keyframe. */
export async function trimClip(
  url: string,
  start: number,
  end: number,
  onProgress: (p: number) => void
) {
  const input = open(url)

  try {
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new BufferTarget(),
    })

    const conversion = await Conversion.init({
      input,
      output,
      trim: { start, end },
    })

    if (!conversion.isValid)
      throw new Error("This clip can't be trimmed in the browser")
    conversion.onProgress = onProgress
    await conversion.execute()

    return output.target.buffer!
  } finally {
    input.dispose()
  }
}
