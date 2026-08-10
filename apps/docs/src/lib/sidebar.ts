import type { SidebarTransform } from "@cloudflare/nimbus-docs/types";

// `scope: "section"` prepends a synthetic lead link — the section's own landing
// — pinned to the top of every scoped rail with `order: -Infinity` (nimbus
// scopeToGroup). Flue's sections land on their first content page (Guide →
// Getting Started, Ecosystem → Overview), so that lead duplicates the first
// child; the hand-rolled prod rail never showed it. Strip the pinned lead here.
// `landing` stays intact for breadcrumbs and the header tabs — both read the
// config tree, not this transformed one.
//
// Correctness rides on a nimbus internal: the lead is the leading item, is a
// `link`/`external` (the two shapes scopeToGroup emits), and is the sole
// `-Infinity`-ordered item pre-transform. If a future nimbus release pins the
// lead differently this becomes a silent no-op (the duplicate reappears) rather
// than a build error — re-verify the rail when bumping the nimbus dependency.
export const dropSectionLead: SidebarTransform = ({ tree }) => {
  const [head] = tree;
  return head &&
    (head.type === "link" || head.type === "external") &&
    head.order === Number.NEGATIVE_INFINITY
    ? tree.slice(1)
    : tree;
};
