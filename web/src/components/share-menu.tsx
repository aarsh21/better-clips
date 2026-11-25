import * as React from "react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const SHARE_OPTIONS = [
  { label: "1 day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "Forever", days: null },
]

/* Copies a link that works for the picked time. children is the button that
 * opens the menu. */
export function ShareMenu({
  onShare,
  align,
  children,
}: {
  onShare: (days: number | null) => void
  align?: "start" | "end"
  children: React.ReactElement
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={children} />
      <DropdownMenuContent align={align} className="w-44">
        {/* Base UI only allows a menu label inside a group. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Copy a link that works for</DropdownMenuLabel>
          {SHARE_OPTIONS.map(({ label, days }) => (
            <DropdownMenuItem key={label} onClick={() => onShare(days)}>
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
