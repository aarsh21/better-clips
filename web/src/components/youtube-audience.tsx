import { useMutation, useQueryClient } from "@tanstack/react-query"

import { api } from "@/lib/api"
import { useAccount } from "@/lib/settings"

export function YouTubeAudience({ prompt = false }: { prompt?: boolean }) {
  const channel = useAccount()?.youtube
  const qc = useQueryClient()

  const save = useMutation({
    mutationFn: api.setYouTubeAudience,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  })

  if (!channel || (prompt && channel.defaultMadeForKids !== null)) return null

  return (
    <fieldset
      disabled={save.isPending}
      className={prompt ? "mb-5 max-w-xl border px-4 py-3 text-xs" : "text-xs"}
    >
      <legend className="font-medium">Made for kids?</legend>
      <p className="mt-1 leading-relaxed text-muted-foreground">
        Choose Yes if your clips are directed at children.{" "}
        <a
          className="underline"
          href="https://support.google.com/youtube/answer/9528076"
          target="_blank"
          rel="noreferrer"
        >
          How to choose
        </a>
      </p>
      <p className="mb-2 text-muted-foreground">
        Used when OBS doesn’t send an audience choice.
      </p>
      <div className="flex gap-4">
        {([true, false] as const).map((value) => (
          <label key={String(value)} className="flex items-center gap-1.5">
            <input
              type="radio"
              name={prompt ? "library-audience" : "settings-audience"}
              checked={channel.defaultMadeForKids === value}
              onChange={() => save.mutate(value)}
            />
            {value ? "Yes" : "No"}
          </label>
        ))}
      </div>
      {save.error && (
        <p role="alert" className="text-destructive">
          {save.error.message}
        </p>
      )}
    </fieldset>
  )
}
