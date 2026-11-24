import type { ElementType } from "react"
import { cn } from "cn"

/* A row of buttons, one of them chosen, read out as a radio group. */
export function Segmented<T extends string | number | null>({
  labelledBy,
  options,
  value,
  onChange,
}: {
  labelledBy: string
  options: {
    value: T
    label: string
    title?: string
    icon?: ElementType
  }[]
  value: T | undefined
  onChange: (value: T) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      className="flex w-full border bg-muted/30"
    >
      {options.map((option) => {
        const checked = option.value === value
        const Icon = option.icon

        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={checked}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex h-8 flex-1 items-center justify-center gap-1.5 border-r text-xs text-muted-foreground tabular-nums transition-colors last:border-r-0 hover:text-foreground focus-visible:relative focus-visible:z-10 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
              checked &&
                "bg-background font-medium text-foreground shadow-[inset_0_-2px_0_var(--primary)]"
            )}
          >
            {Icon && <Icon className="size-3.5" />}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
