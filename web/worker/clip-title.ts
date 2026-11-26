/* A clip file's label is the part after its time:
 * <Category>[__<Name>][-trim-N]. The category is the window or scene OBS saved
 * from, such as "Counter-Strike-2"; the name is one you gave the clip. Neither
 * part contains "_", so "__" can't be confused with either. Shared by the
 * app, the share page and renames. */
export function labelParts(label: string) {
  /* -trim-N, or an older -trim, -trim-2 or -trim-trim. */
  const trim = label.match(/(?:-trim)+(?:-(\d+))?$/)
  const base = label.slice(0, trim?.index ?? label.length)
  const sep = base.indexOf("__")
  const categoryKey = sep < 0 ? base : base.slice(0, sep)

  return {
    categoryKey,
    category: categoryKey.replace(/_(?:[0-9a-f]{32}|[a-z2-9]{6,8})$/, ""),
    name: sep < 0 ? "" : base.slice(sep + 2),
    /* The raw suffix, such as "-trim-2", kept when a trim is renamed. */
    trimSuffix: trim?.[0] ?? "",
    trimNumber: trim?.[1],
  }
}

const words = (part: string) => part.replace(/[-_]+/g, " ").trim()

/* "Counter-Strike-2__Ace-round-trim-2" is category "Counter Strike 2", name
 * "Ace round" and trim "Trim 2". */
export function clipTitle(label: string) {
  const parts = labelParts(label)

  return {
    category: words(parts.category),
    name: words(parts.name),
    trim: parts.trimSuffix
      ? parts.trimNumber
        ? `Trim ${parts.trimNumber}`
        : "Trim"
      : null,
  }
}
