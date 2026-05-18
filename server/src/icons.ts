// The presentation-icon palette. This is the single source of truth the API
// validates marker submissions against; the browser keeps its own parallel
// copy (web/app.js) holding the inline SVG artwork for each kind.

export const ICON_KINDS = [
  "house",
  "garden",
  "tower",
  "market",
  "school",
  "dock",
  "farm",
  "park",
] as const;

export type IconKind = (typeof ICON_KINDS)[number];

export function isIconKind(v: unknown): v is IconKind {
  return (
    typeof v === "string" && (ICON_KINDS as readonly string[]).includes(v)
  );
}
