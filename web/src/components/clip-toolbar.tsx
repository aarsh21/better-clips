import * as React from "react"
import {
  CaretDownIcon,
  SortAscendingIcon,
  TagSimpleIcon,
} from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SORTS, type Sort } from "@/lib/view"

const ALL = "\u0000all"

const categoryLabel = (name: string) => name || "No category"

/* Above the grid: which category to show, and in what order. */
export function ClipToolbar({
  categories,
  category,
  onCategory,
  sort,
  onSort,
}: {
  categories: { name: string; count: number }[]
  category: string | null
  onCategory: (category: string | null) => void
  sort: Sort
  onSort: (sort: Sort) => void
}) {
  const total = categories.reduce((n, c) => n + c.count, 0)

  return (
    <div className="mb-4 flex items-center justify-between gap-2">
      <Menu
        label="Category"
        icon={TagSimpleIcon}
        current={category === null ? "All categories" : categoryLabel(category)}
        value={category ?? ALL}
        onValue={(v) => onCategory(v === ALL ? null : v)}
        options={[
          { value: ALL, label: "All categories", count: total },
          ...categories.map((c) => ({
            value: c.name,
            label: categoryLabel(c.name),
            count: c.count,
          })),
        ]}
      />
      <Menu
        label="Sort by"
        icon={SortAscendingIcon}
        align="end"
        current={SORTS.find((s) => s.value === sort)?.label ?? "Sort"}
        value={sort}
        onValue={onSort}
        options={SORTS}
      />
    </div>
  )
}

function Menu<T extends string>({
  label,
  icon: Icon,
  current,
  value,
  onValue,
  options,
  align,
}: {
  label: string
  icon: React.ElementType
  current: string
  value: T
  onValue: (value: T) => void
  options: { value: T; label: string; count?: number }[]
  align?: "start" | "end"
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={`${label}: ${current}`}
            className="min-w-0 text-muted-foreground hover:text-foreground data-popup-open:text-foreground"
          />
        }
      >
        <Icon />
        <span className="truncate">{current}</span>
        <CaretDownIcon data-icon="inline-end" className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-auto max-w-72 min-w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(v) => {
            const picked = options.find((o) => o.value === v)

            if (picked) onValue(picked.value)
          }}
        >
          {options.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value}>
              <span className="truncate">{o.label}</span>
              {o.count !== undefined && (
                <span className="ml-auto pl-3 text-muted-foreground tabular-nums">
                  {o.count}
                </span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
