// Optional demo content so the layer toggles visibly do something on a fresh
// install. Idempotent: per map, content is only inserted when that map has
// zero parcels AND zero markers, so it never duplicates and never fights real
// user data. Needs an admin to own/attribute the content; if none exists yet
// (truly fresh DB) it is skipped silently — the mock basemap layers render
// regardless of data, and real claims exercise the rest.

import { query } from "./db.js";
import { type MapRow, getMaps } from "./maps.js";

interface DemoParcel {
  name: string;
  description: string;
  cx: number;
  cy: number;
  half: number;
}
interface DemoMarker {
  name: string;
  kind: string;
  x: number;
  y: number;
}

// Land anchors chosen to sit clear of water for each mock basemap. `plain`
// derives positions from the (env-driven) bounds; island is centred on its
// landmass; river keeps well off the diagonal river ribbon.
function demoFor(m: MapRow): { parcels: DemoParcel[]; markers: DemoMarker[] } {
  if (m.basemap === "island") {
    return {
      parcels: [
        { name: "Harbour Quarter", description: "Seeded demo parcel.", cx: -160, cy: -140, half: 90 },
        { name: "Hillside Grove", description: "Seeded demo parcel.", cx: 170, cy: 130, half: 80 },
      ],
      markers: [
        { name: "Town Hall", kind: "tower", x: 0, y: 0 },
        { name: "Old Market", kind: "market", x: -240, y: 190 },
        { name: "Botanic Garden", kind: "garden", x: 210, y: -170 },
      ],
    };
  }
  if (m.basemap === "river") {
    return {
      parcels: [
        { name: "North Commons", description: "Seeded demo parcel.", cx: 320, cy: 980, half: 110 },
        { name: "South Fields", description: "Seeded demo parcel.", cx: 1650, cy: 260, half: 110 },
      ],
      markers: [
        { name: "Riverside School", kind: "school", x: 260, y: 1060 },
        { name: "Mill Farm", kind: "farm", x: 470, y: 880 },
        { name: "Ferry Dock", kind: "dock", x: 1740, y: 210 },
      ],
    };
  }
  // plain / primary: cluster around the centre, sized from the bounds.
  const cx = (m.min_x + m.max_x) / 2;
  const cy = (m.min_y + m.max_y) / 2;
  const span = Math.min(m.max_x - m.min_x, m.max_y - m.min_y);
  const d = span * 0.18;
  const half = span * 0.08;
  return {
    parcels: [
      { name: "Central Plot", description: "Seeded demo parcel.", cx: cx - d, cy: cy - d, half },
      { name: "East Plot", description: "Seeded demo parcel.", cx: cx + d, cy: cy + d * 0.6, half },
    ],
    markers: [
      { name: "Civic House", kind: "house", x: cx, y: cy },
      { name: "Commons Park", kind: "park", x: cx - d * 1.4, y: cy + d },
      { name: "Trade House", kind: "house", x: cx + d * 1.4, y: cy - d },
    ],
  };
}

const squareGeoJSON = (cx: number, cy: number, h: number) =>
  JSON.stringify({
    type: "Polygon",
    coordinates: [
      [
        [cx - h, cy - h],
        [cx + h, cy - h],
        [cx + h, cy + h],
        [cx - h, cy + h],
        [cx - h, cy - h],
      ],
    ],
  });

export async function seedDemo(): Promise<void> {
  const { rows: admins } = await query<{ id: number }>(
    "SELECT id FROM users WHERE is_admin = TRUE ORDER BY id LIMIT 1",
  );
  const owner = admins[0]?.id;
  if (!owner) return; // nothing to attribute demo content to yet

  for (const m of await getMaps()) {
    const { rows: pc } = await query<{ n: string }>(
      "SELECT count(*)::int AS n FROM parcels WHERE map_id = $1",
      [m.id],
    );
    const { rows: mc } = await query<{ n: string }>(
      "SELECT count(*)::int AS n FROM markers WHERE map_id = $1",
      [m.id],
    );
    if (Number(pc[0]!.n) > 0 || Number(mc[0]!.n) > 0) continue;

    const demo = demoFor(m);
    for (const p of demo.parcels) {
      await query(
        `INSERT INTO parcels
           (owner_id, name, description, status, geom, map_id,
            decided_at, decided_by, decision_note)
         VALUES ($1, $2, $3, 'approved',
                 ST_SetSRID(ST_GeomFromGeoJSON($4)::geometry, 0), $5,
                 now(), $1, 'Seeded demo content.')`,
        [owner, p.name, p.description, squareGeoJSON(p.cx, p.cy, p.half), m.id],
      );
    }
    for (const k of demo.markers) {
      await query(
        `INSERT INTO markers
           (map_id, owner_id, name, description, kind, status, geom,
            decided_at, decided_by, decision_note)
         VALUES ($1, $2, $3, '', $4, 'approved',
                 ST_SetSRID(ST_GeomFromGeoJSON($5)::geometry, 0),
                 now(), $2, 'Seeded demo content.')`,
        [
          m.id,
          owner,
          k.name,
          k.kind,
          JSON.stringify({ type: "Point", coordinates: [k.x, k.y] }),
        ],
      );
    }
    console.log(`[db] demo content seeded for map "${m.slug}"`);
  }
}
