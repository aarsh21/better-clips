import { useMutation, useQueryClient } from "@tanstack/react-query"

import { api } from "@/lib/api"
import { useAccount } from "@/lib/settings"

export function YouTubeAudience() {
  const channel = useAccount()?.youtube
  const qc = useQueryClient()

  const save = useMutation({
    mutationFn: api.setYouTubeAudience,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  })

  if (!channel) return null

  return (
    <fieldset disabled={save.isPending} className="text-sm">
      <legend className="float-left w-full font-semibold">
        Made for kids?
      </legend>
      <p className="mt-1 leading-relaxed text-muted-foreground">
        Choose Yes if your clips are directed at children.{" "}
        <a
          className="text-foreground underline underline-offset-4 hover:text-primary"
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
      <div className="flex gap-6">
        {([true, false] as const).map((value) => (
          <label
            key={String(value)}
            className="flex items-center gap-2 font-medium"
          >
            <input
              type="radio"
              name="settings-audience"
              checked={channel.defaultMadeForKids === value}
              onChange={() => save.mutate(value)}
              className="size-4 accent-primary"
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
