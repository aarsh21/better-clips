import * as React from "react"

import type { YouTubeClip } from "@/lib/api"

/* The parts of YouTube's IFrame Player API this app uses:
 * https://developers.google.com/youtube/iframe_api_reference */
export type Player = {
  getCurrentTime(): number
  getDuration(): number
  seekTo(seconds: number, allowSeekAhead: boolean): void
  playVideo(): void
  pauseVideo(): void
  mute(): void
  unMute(): void
  isMuted(): boolean
}

type PlayerApi = {
  Player: new (
    iframe: HTMLIFrameElement,
    options: {
      events: {
        onReady?: () => void
        onStateChange?: (event: { data: number }) => void
      }
    }
  ) => Player
}

declare global {
  interface Window {
    YT?: PlayerApi
    onYouTubeIframeAPIReady?: () => void
  }
}

const PLAYING = 1

let loading: Promise<PlayerApi> | null = null

/* Loads YouTube's player script once. */
function loadPlayerApi() {
  loading ??= new Promise<PlayerApi>((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT)
    const previous = window.onYouTubeIframeAPIReady

    window.onYouTubeIframeAPIReady = () => {
      previous?.()

      if (window.YT) resolve(window.YT)
    }

    const script = document.createElement("script")

    script.src = "https://www.youtube.com/iframe_api"
    script.async = true

    script.onerror = () => {
      loading = null
      reject(new Error("YouTube's player script didn't load"))
    }

    document.head.append(script)
  })

  return loading
}

/* The embed URL. YouTube refuses to play an embed that can't tell which site
 * it's on (error 153), so it gets this page's origin, and the iframe sends
 * the referrer. */
export function embedUrl(clip: YouTubeClip) {
  if (clip.status !== "ready" || clip.madeForKids !== false) return ""

  const params = new URLSearchParams({
    autoplay: "1",
    playsinline: "1",
    rel: "0",
    enablejsapi: "1",
    origin: location.origin,
  })

  return `https://www.youtube.com/embed/${encodeURIComponent(clip.videoId)}?${params}`
}

/* Controls the player in iframe once YouTube's script has loaded; null
 * before that, or if it can't load, when the player's own controls still
 * work. src is the iframe's, so a new embed gets a new player. */
export function useYouTubePlayer(
  iframe: React.RefObject<HTMLIFrameElement | null>,
  src: string
) {
  const [player, setPlayer] = React.useState<Player | null>(null)
  const [playing, setPlaying] = React.useState(false)

  React.useEffect(() => {
    const element = iframe.current

    if (!element) return
    let cancelled = false

    loadPlayerApi()
      .then((api) => {
        if (cancelled) return

        const created = new api.Player(element, {
          events: {
            onReady: () => !cancelled && setPlayer(created),
            onStateChange: (e) => !cancelled && setPlaying(e.data === PLAYING),
          },
        })
      })
      .catch((err) => console.warn(err))

    return () => {
      cancelled = true
      setPlayer(null)
      setPlaying(false)
    }
  }, [iframe, src])

  return { player, playing }
}

export function togglePlayer(player: Player | null, playing: boolean) {
  if (playing) player?.pauseVideo()
  else player?.playVideo()
}
