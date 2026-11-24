/* The title shown for a clip file's label, the part after its time:
 * "Valorant-Ranked" is "Valorant Ranked", and the trim editor's
 * "Valorant-Ranked-trim-2" is "Valorant Ranked · Trim 2". Shared by the
 * app and the share page. */
export function clipTitle(label: string) {
  /* -trim-N, or an older -trim, -trim-2 or -trim-trim. */
  const trim = label.match(/(?:-trim)+(?:-(\d+))?$/)

  const name = label
    .slice(0, trim?.index ?? label.length)
    .replace(/_[a-z2-9]{6,8}$/, "") /* the plugin's old random link code */
    .replace(/[-_]+/g, " ")
    .trim()

  if (!trim) return { title: name, trimmed: false }

  const suffix = trim[1] ? `Trim ${trim[1]}` : "Trim"

  return { title: name ? `${name} · ${suffix}` : suffix, trimmed: true }
}
