import { cn } from "cn"

/* The Better Clips wordmark: the amber tally square and the name. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <span className="size-2.5 bg-primary" aria-hidden />
      <span className="text-[17px] leading-none font-extrabold tracking-[-0.01em] [font-stretch:78%]">
        Better Clips
      </span>
    </span>
  )
}
