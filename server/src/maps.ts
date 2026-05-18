// Maps registry. Each map is an independent place with its own bounds, grid
// and mock basemap. Parcels and markers belong to exactly one map. The two
// mock maps (island, river) plus a "primary" map (inheriting the env-driven
// TERRITORY_* extent) are seeded idempotently at boot by ensureMaps().

import { config } from "./config.js";
import { query } from "./db.js";

export const PRIMARY_SLUG = "libertaria";

export interface MapRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
  grid: number;
  basemap: string;
  sort_order: number;
}

interface SeedDef {
  slug: string;
  name: string;
  description: string;
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
  grid: number;
  basemap: "plain" | "island" | "river";
  sort_order: number;
}

// The primary map inherits the env TERRITORY_* extent (so existing config and
// any backfilled legacy parcels stay coherent); island/river are fixed mock
// places. Bounds are immutable once seeded (ON CONFLICT DO NOTHING).
function seedDefs(): SeedDef[] {
  const t = config.territory;
  return [
    {
      slug: PRIMARY_SLUG,
      name: t.name,
      description: "The primary territory.",
      min_x: t.minX,
      min_y: t.minY,
      max_x: t.maxX,
      max_y: t.maxY,
      grid: t.grid,
      basemap: "plain",
      sort_order: 0,
    },
    {
      slug: "island",
      name: "Verdant Isle",
      description: "A forested volcanic island ringed by open water.",
      min_x: -800,
      min_y: -800,
      max_x: 800,
      max_y: 800,
      grid: 100,
      basemap: "island",
      sort_order: 1,
    },
    {
      slug: "river",
      name: "Riverlands",
      description: "A settlement plain straddling the Silt River.",
      min_x: 0,
      min_y: 0,
      max_x: 2000,
      max_y: 1200,
      grid: 100,
      basemap: "river",
      sort_order: 2,
    },
  ];
}

/**
 * Idempotently seed the maps and attach any pre-existing (legacy) parcels to
 * the primary map. Safe to run on every boot: ON CONFLICT DO NOTHING never
 * mutates an existing map, and the backfill UPDATE is a no-op once all rows
 * already have a map_id.
 */
export async function ensureMaps(): Promise<void> {
  for (const m of seedDefs()) {
    await query(
      `INSERT INTO maps
         (slug, name, description, min_x, min_y, max_x, max_y, grid, basemap, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (slug) DO NOTHING`,
      [
        m.slug,
        m.name,
        m.description,
        m.min_x,
        m.min_y,
        m.max_x,
        m.max_y,
        m.grid,
        m.basemap,
        m.sort_order,
      ],
    );
  }
  await query(
    `UPDATE parcels
        SET map_id = (SELECT id FROM maps WHERE slug = $1)
      WHERE map_id IS NULL`,
    [PRIMARY_SLUG],
  );
  console.log("[db] maps ensured");
}

function coerce(r: MapRow): MapRow {
  return {
    ...r,
    min_x: Number(r.min_x),
    min_y: Number(r.min_y),
    max_x: Number(r.max_x),
    max_y: Number(r.max_y),
    grid: Number(r.grid),
    sort_order: Number(r.sort_order),
  };
}

export async function getMaps(): Promise<MapRow[]> {
  const { rows } = await query<MapRow>(
    `SELECT id, slug, name, description,
            min_x, min_y, max_x, max_y, grid, basemap, sort_order
       FROM maps ORDER BY sort_order, id`,
  );
  return rows.map(coerce);
}

/**
 * Resolve a `?map=` / body `map` value (slug or numeric id) to a MapRow.
 * Missing/empty falls back to the primary map (or the first map).
 */
export async function resolveMap(param: unknown): Promise<MapRow | null> {
  const maps = await getMaps();
  if (param == null || param === "")
    return maps.find((m) => m.slug === PRIMARY_SLUG) ?? maps[0] ?? null;
  const s = String(param);
  return maps.find((m) => m.slug === s || String(m.id) === s) ?? null;
}
