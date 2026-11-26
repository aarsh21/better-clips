import assert from "node:assert/strict"
import { test } from "node:test"
import { clipTitle, labelParts } from "../clip-title.ts"

test("file identities survive renames but stay out of titles and filters", () => {
  const key = "Valorant_0123456789abcdef0123456789abcdef"
  assert.equal(clipTitle(key).category, "Valorant")
  const renamed = `${key}__Ace-round-trim-2`
  assert.deepEqual(clipTitle(renamed), {
    category: "Valorant",
    name: "Ace round",
    trim: "Trim 2",
  })
  assert.equal(labelParts(renamed).categoryKey, key)
  assert.equal(clipTitle("Valorant_k3f9x2").category, "Valorant")
  assert.equal(clipTitle("Practice_room").category, "Practice room")
})
