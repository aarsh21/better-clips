import * as React from "react"

export function togglePlay(video: HTMLVideoElement | null) {
  if (!video) return

  if (video.paused) void video.play()
  else video.pause()
}

export function seekTo(video: HTMLVideoElement | null, time: number) {
  if (video) video.currentTime = Math.max(0, time)
}

/* Whether the video is playing, kept in sync with its play and pause events. */
export function usePlaying(video: React.RefObject<HTMLVideoElement | null>) {
  const subscribe = React.useCallback(
    (notify: () => void) => {
      const element = video.current

      element?.addEventListener("play", notify)
      element?.addEventListener("pause", notify)

      return () => {
        element?.removeEventListener("play", notify)
        element?.removeEventListener("pause", notify)
      }
    },
    [video]
  )

  return React.useSyncExternalStore(
    subscribe,
    () => !(video.current?.paused ?? true)
  )
}
