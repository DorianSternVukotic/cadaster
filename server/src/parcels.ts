import { type Request, type Response, Router } from "express";
import { currentUser, requireAuth, type User } from "./auth.js";
import { query } from "./db.js";
import { type MapRow, resolveMap } from "./maps.js";

export const parcelsRouter = Router();

interface OverlapRow {
  id: number;
  name: string;
  status: string;
  owner_name: string;
  overlap_area: number;
}

/**
 * Parcels that materially overlap the given parcel (shared area > 0, so a
 * shared boundary between neighbours is NOT flagged). Rejected parcels and
 * the parcel itself are excluded. Used both to warn the claimant and to
 * inform admins during review.
 */
async function getOverlaps(
  parcelId: number,
  mapId: number,
): Promise<OverlapRow[]> {
  const { rows } = await query<OverlapRow>(
    `SELECT p.id, p.name, p.status, u.display_name AS owner_name,
            ST_Area(ST_Intersection(p.geom, t.geom)) AS overlap_area
       FROM parcels p
       JOIN users u ON u.id = p.owner_id,
            (SELECT geom FROM parcels WHERE id = $1) t
      WHERE p.id <> $1
        AND p.map_id = $2
        AND p.status IN ('pending', 'approved')
        AND ST_Intersects(p.geom, t.geom)
        AND ST_Area(ST_Intersection(p.geom, t.geom)) > 0
      ORDER BY overlap_area DESC`,
    [parcelId, mapId],
  );
  return rows.map((r) => ({ ...r, overlap_area: Number(r.overlap_area) }));
}

export { getOverlaps };

/** Validate a GeoJSON Polygon and return a clean, closed exterior ring. */
function cleanPolygon(
  geometry: unknown,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): { ring: [number, number][] } | { error: string } {
  if (
    !geometry ||
    typeof geometry !== "object" ||
    (geometry as { type?: unknown }).type !== "Polygon"
  )
    return { error: "Geometry must be a GeoJSON Polygon." };

  const coords = (geometry as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coords) || coords.length !== 1)
    return {
      error: "Polygon must have exactly one ring (holes are not supported).",
    };

  const raw = coords[0];
  if (!Array.isArray(raw) || raw.length < 4)
    return { error: "Polygon needs at least 3 corners." };

  const ring: [number, number][] = [];
  for (const pt of raw) {
    if (
      !Array.isArray(pt) ||
      pt.length < 2 ||
      typeof pt[0] !== "number" ||
      typeof pt[1] !== "number" ||
      !Number.isFinite(pt[0]) ||
      !Number.isFinite(pt[1])
    )
      return { error: "Every corner must be a numeric [x, y] pair." };

    const x = pt[0];
    const y = pt[1];
    if (
      x < bounds.minX ||
      x > bounds.maxX ||
      y < bounds.minY ||
      y > bounds.maxY
    )
      return {
        error: `Corner (${x}, ${y}) is outside the map bounds.`,
      };
    ring.push([x, y]);
  }

  // Ensure the ring is explicitly closed.
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
  if (ring.length < 4) return { error: "Polygon needs at least 3 corners." };

  return { ring };
}

const boundsOf = (m: MapRow) => ({
  minX: m.min_x,
  minY: m.min_y,
  maxX: m.max_x,
  maxY: m.max_y,
});

/** SQL fragment + params controlling which parcels a viewer may see. */
function visibility(user: User | null, startIdx: number): {
  sql: string;
  params: unknown[];
} {
  if (user?.is_admin) return { sql: "TRUE", params: [] };
  if (user)
    return { sql: `(p.status = 'approved' OR p.owner_id = $${startIdx})`, params: [user.id] };
  return { sql: "p.status = 'approved'", params: [] };
}

// GET /api/parcels?map=<slug|id>  — map data as a GeoJSON FeatureCollection.
parcelsRouter.get("/", async (req: Request, res: Response) => {
  const mp = await resolveMap(req.query.map);
  if (!mp) return res.status(400).json({ error: "Unknown map." });
  const me = currentUser(res);
  const vis = visibility(me, 2);
  const { rows } = await query(
    `SELECT p.id, p.name, p.description, p.status, p.owner_id,
            u.display_name AS owner_name, p.created_at,
            ST_Area(p.geom) AS area,
            ST_AsGeoJSON(p.geom) AS geojson
       FROM parcels p
       JOIN users u ON u.id = p.owner_id
      WHERE p.map_id = $1 AND ${vis.sql}
      ORDER BY p.id`,
    [mp.id, ...vis.params],
  );

  res.json({
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature",
      id: r.id,
      geometry: JSON.parse(r.geojson),
      properties: {
        id: r.id,
        name: r.name,
        description: r.description,
        status: r.status,
        owner_id: r.owner_id,
        owner_name: r.owner_name,
        area: Number(r.area),
        created_at: r.created_at,
        is_own: me ? r.owner_id === me.id : false,
      },
    })),
  });
});

// POST /api/parcels  — submit a land claim (status: pending).
parcelsRouter.post("/", requireAuth, async (req: Request, res: Response) => {
  const me = currentUser(res)!;
  const name = String(req.body?.name ?? "").trim();
  const description = String(req.body?.description ?? "").trim();

  if (name.length < 1 || name.length > 120)
    return res.status(400).json({ error: "Name is required (max 120 chars)." });
  if (description.length > 2000)
    return res.status(400).json({ error: "Description is too long." });

  const mp = await resolveMap(req.body?.map);
  if (!mp) return res.status(400).json({ error: "Unknown map." });

  const cleaned = cleanPolygon(req.body?.geometry, boundsOf(mp));
  if ("error" in cleaned) return res.status(400).json({ error: cleaned.error });

  const geojson = JSON.stringify({
    type: "Polygon",
    coordinates: [cleaned.ring],
  });

  // Reject self-intersecting / degenerate geometry before storing it.
  const check = await query<{ valid: boolean; reason: string; area: number }>(
    `SELECT ST_IsValid(g) AS valid, ST_IsValidReason(g) AS reason,
            ST_Area(g) AS area
       FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1)::geometry, 0) AS g) s`,
    [geojson],
  );
  const chk = check.rows[0]!;
  if (!chk.valid)
    return res
      .status(400)
      .json({ error: `Invalid polygon: ${chk.reason}` });
  if (Number(chk.area) <= 0)
    return res.status(400).json({ error: "Polygon has zero area." });

  const { rows } = await query<{
    id: number;
    status: string;
    area: number;
    created_at: string;
  }>(
    `INSERT INTO parcels (owner_id, name, description, geom, map_id)
     VALUES ($1, $2, $3, ST_SetSRID(ST_GeomFromGeoJSON($4)::geometry, 0), $5)
     RETURNING id, status, ST_Area(geom) AS area, created_at`,
    [me.id, name, description, geojson, mp.id],
  );
  const created = rows[0]!;
  const overlaps = await getOverlaps(created.id, mp.id);

  res.status(201).json({
    parcel: {
      id: created.id,
      name,
      description,
      status: created.status,
      area: Number(created.area),
      created_at: created.created_at,
    },
    overlaps,
  });
});

// GET /api/parcels/:id  — full detail incl. overlap report.
parcelsRouter.get("/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id))
    return res.status(400).json({ error: "Bad id." });

  const me = currentUser(res);
  const vis = visibility(me, 1);
  const { rows } = await query(
    `SELECT p.id, p.name, p.description, p.status, p.owner_id, p.map_id,
            u.display_name AS owner_name, p.created_at, p.decided_at,
            p.decision_note, d.display_name AS decided_by_name,
            ST_Area(p.geom) AS area, ST_AsGeoJSON(p.geom) AS geojson
       FROM parcels p
       JOIN users u ON u.id = p.owner_id
       LEFT JOIN users d ON d.id = p.decided_by
      WHERE p.id = $${vis.params.length + 1} AND ${vis.sql}`,
    [...vis.params, id],
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ error: "Parcel not found." });

  res.json({
    parcel: {
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      owner_id: row.owner_id,
      owner_name: row.owner_name,
      created_at: row.created_at,
      decided_at: row.decided_at,
      decided_by_name: row.decided_by_name,
      decision_note: row.decision_note,
      area: Number(row.area),
      geometry: JSON.parse(row.geojson),
      is_own: me ? row.owner_id === me.id : false,
    },
    overlaps: await getOverlaps(id, row.map_id),
  });
});

// DELETE /api/parcels/:id  — owner withdraws a pending claim; admin deletes any.
parcelsRouter.delete(
  "/:id",
  requireAuth,
  async (req: Request, res: Response) => {
    const me = currentUser(res)!;
    const id = Number(req.params.id);
    if (!Number.isInteger(id))
      return res.status(400).json({ error: "Bad id." });

    const { rows } = await query<{ owner_id: number; status: string }>(
      "SELECT owner_id, status FROM parcels WHERE id = $1",
      [id],
    );
    const p = rows[0];
    if (!p) return res.status(404).json({ error: "Parcel not found." });

    const ownPending = p.owner_id === me.id && p.status === "pending";
    if (!me.is_admin && !ownPending)
      return res.status(403).json({
        error: "You can only withdraw your own claims while pending.",
      });

    await query("DELETE FROM parcels WHERE id = $1", [id]);
    res.json({ ok: true });
  },
);
