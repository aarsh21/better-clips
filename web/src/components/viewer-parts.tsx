import * as React from "react"
import { CaretLeftIcon, CaretRightIcon, XIcon } from "@phosphor-icons/react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { DialogTitle } from "@/components/ui/dialog"
import { Kbd } from "@/components/ui/kbd"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { displayTitle, type Clip } from "@/lib/api"
import type { ClipNav } from "@/lib/clip-actions"

/* The pieces both viewers share: bucket clips (clip-viewer.tsx) and YouTube
 * clips (youtube-viewer.tsx). */

/* The title, which you click (or press E) to rename, a line about the clip,
 * and the previous, next and close buttons. */
export function ViewerHeader({
  clip,
  meta,
  name,
  maxLength,
  nav,
  renaming,
  onStartRename,
  onRenamed,
}: {
  clip: Clip
  meta: string
  /** What renaming starts from. */
  name: string
  maxLength: number
  nav: ClipNav
  renaming: boolean
  onStartRename: () => void
  onRenamed: (name: string | null) => void
}) {
  return (
    <div className="flex items-center gap-2 border-b px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col">
        {renaming ? (
          <RenameInput
            initial={name}
            maxLength={maxLength}
            onDone={onRenamed}
          />
        ) : (
          <DialogTitle
            render={<button type="button" />}
            onClick={onStartRename}
            className="w-fit max-w-full truncate text-left text-lg font-bold tracking-[-0.01em] [font-stretch:85%] outline-none hover:text-primary focus-visible:text-primary focus-visible:underline"
            title="Rename (E)"
          >
            {displayTitle(clip)}
          </DialogTitle>
        )}
        <span className="truncate font-mono text-[11px] text-muted-foreground tabular-nums">
          {meta}
        </span>
      </div>
      <div className="flex items-center">
        <IconButton
          label="Previous"
          kbd="↑"
          disabled={!nav.hasPrev}
          onClick={() => nav.onNavigate(clip, -1)}
        >
          <CaretLeftIcon />
        </IconButton>
        <IconButton
          label="Next"
          kbd="↓"
          disabled={!nav.hasNext}
          onClick={() => nav.onNavigate(clip, 1)}
        >
          <CaretRightIcon />
        </IconButton>
        <IconButton label="Close" kbd="Esc" onClick={nav.onClose}>
          <XIcon />
        </IconButton>
      </div>
    </div>
  )
}

function RenameInput({
  initial,
  maxLength,
  onDone,
}: {
  initial: string
  maxLength: number
  onDone: (name: string | null) => void
}) {
  const [value, setValue] = React.useState(initial)
  const input = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  return (
    <input
      ref={input}
      aria-label="Clip name"
      value={value}
      maxLength={maxLength}
      placeholder="Name this clip"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(value)

        if (e.key === "Escape") {
          e.stopPropagation()
          onDone(null)
        }
      }}
      className="h-7 w-full max-w-sm border-b border-primary bg-transparent text-lg font-bold [font-stretch:85%] outline-none"
    />
  )
}

export function Action({
  icon: Icon,
  label,
  kbd,
  active,
  destructive,
  disabled,
  onClick,
}: {
  icon: React.ElementType
  label: string
  kbd?: string
  active?: boolean
  destructive?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            onClick={onClick}
            disabled={disabled}
            className={cn(
              active && "text-primary",
              destructive &&
                "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            )}
          />
        }
      >
        <Icon weight={active ? "fill" : "regular"} />
        <span className={cn(destructive && "hidden sm:inline")}>{label}</span>
      </TooltipTrigger>
      {kbd && (
        <TooltipContent>
          {label} <Kbd>{kbd}</Kbd>
        </TooltipContent>
      )}
    </Tooltip>
  )
}

export function IconButton({
  label,
  kbd,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string; kbd: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            {...props}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label} <Kbd>{kbd}</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}
