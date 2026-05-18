// Presentation markers: user-placed conceptual icons (buildings, gardens, …)
// on a map's "presentation" layer. Same pending/approved/rejected workflow and
// role-based visibility as parcels, but a Point geometry, a palette `kind`,
// and no overlap detection.

import { type Request, type Response, Router } from "express";
import { currentUser, requireAuth, type User } from "./auth.js";
import { query } from "./db.js";
import { isIconKind } from "./icons.js";
import { resolveMap } from "./maps.js";

export const markersRouter = Router();

/** SQL fragment + params controlling which markers a viewer may see. */
function visibility(user: User | null, startIdx: number): {
  sql: string;
  params: unknown[];
} {
  if (user?.is_admin) return { sql: "TRUE", params: [] };
  if (user)
    return {
      sql: `(m.status = 'approved' OR m.owner_id = $${startIdx})`,
      params: [user.id],
    };
  return { sql: "m.status = 'approved'", params: [] };
}

// GET /api/markers?map=<slug|id>  — Point GeoJSON FeatureCollection.
markersRouter.get("/", async (req: Request, res: Response) => {
  const mp = await resolveMap(req.query.map);
  if (!mp) return res.status(400).json({ error: "Unknown map." });
  const me = currentUser(res);
  const vis = visibility(me, 2);
  const { rows } = await query(
    `SELECT m.id, m.name, m.description, m.kind, m.status, m.owner_id,
            u.display_name AS owner_name, m.created_at,
            ST_AsGeoJSON(m.geom) AS geojson
       FROM markers m
       JOIN users u ON u.id = m.owner_id
      WHERE m.map_id = $1 AND ${vis.sql}
      ORDER BY m.id`,
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
        kind: r.kind,
        status: r.status,
        owner_id: r.owner_id,
        owner_name: r.owner_name,
        created_at: r.created_at,
        is_own: me ? r.owner_id === me.id : false,
      },
    })),
  });
});

// POST /api/markers  — place a presentation icon (status: pending).
markersRouter.post("/", requireAuth, async (req: Request, res: Response) => {
  const me = currentUser(res)!;
  const name = String(req.body?.name ?? "").trim();
  const description = String(req.body?.description ?? "").trim();
  const kind = String(req.body?.kind ?? "");

  if (name.length < 1 || name.length > 120)
    return res.status(400).json({ error: "Name is required (max 120 chars)." });
  if (description.length > 2000)
    return res.status(400).json({ error: "Description is too long." });
  if (!isIconKind(kind))
    return res.status(400).json({ error: "Unknown icon kind." });

  const mp = await resolveMap(req.body?.map);
  if (!mp) return res.status(400).json({ error: "Unknown map." });

  const g = req.body?.geometry;
  if (
    !g ||
    typeof g !== "object" ||
    g.type !== "Point" ||
    !Array.isArray(g.coordinates) ||
    g.coordinates.length < 2 ||
    typeof g.coordinates[0] !== "number" ||
    typeof g.coordinates[1] !== "number" ||
    !Number.isFinite(g.coordinates[0]) ||
    !Number.isFinite(g.coordinates[1])
  )
    return res.status(400).json({ error: "Geometry must be a GeoJSON Point." });

  const x = g.coordinates[0] as number;
  const y = g.coordinates[1] as number;
  if (x < mp.min_x || x > mp.max_x || y < mp.min_y || y > mp.max_y)
    return res
      .status(400)
      .json({ error: `Point (${x}, ${y}) is outside the map bounds.` });

  const geojson = JSON.stringify({ type: "Point", coordinates: [x, y] });
  const { rows } = await query<{
    id: number;
    status: string;
    created_at: string;
  }>(
    `INSERT INTO markers (map_id, owner_id, name, description, kind, geom)
     VALUES ($1, $2, $3, $4, $5, ST_SetSRID(ST_GeomFromGeoJSON($6)::geometry, 0))
     RETURNING id, status, created_at`,
    [mp.id, me.id, name, description, kind, geojson],
  );
  const created = rows[0]!;

  res.status(201).json({
    marker: {
      id: created.id,
      name,
      description,
      kind,
      status: created.status,
      created_at: created.created_at,
    },
  });
});

// GET /api/markers/:id  — full detail (visibility-scoped).
markersRouter.get("/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id))
    return res.status(400).json({ error: "Bad id." });

  const me = currentUser(res);
  const vis = visibility(me, 1);
  const { rows } = await query(
    `SELECT m.id, m.name, m.description, m.kind, m.status, m.owner_id,
            u.display_name AS owner_name, m.created_at, m.decided_at,
            m.decision_note, d.display_name AS decided_by_name,
            ST_AsGeoJSON(m.geom) AS geojson
       FROM markers m
       JOIN users u ON u.id = m.owner_id
       LEFT JOIN users d ON d.id = m.decided_by
      WHERE m.id = $${vis.params.length + 1} AND ${vis.sql}`,
    [...vis.params, id],
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ error: "Marker not found." });

  res.json({
    marker: {
      id: row.id,
      name: row.name,
      description: row.description,
      kind: row.kind,
      status: row.status,
      owner_id: row.owner_id,
      owner_name: row.owner_name,
      created_at: row.created_at,
      decided_at: row.decided_at,
      decided_by_name: row.decided_by_name,
      decision_note: row.decision_note,
      geometry: JSON.parse(row.geojson),
      is_own: me ? row.owner_id === me.id : false,
    },
  });
});

// DELETE /api/markers/:id  — owner withdraws a pending icon; admin deletes any.
markersRouter.delete(
  "/:id",
  requireAuth,
  async (req: Request, res: Response) => {
    const me = currentUser(res)!;
    const id = Number(req.params.id);
    if (!Number.isInteger(id))
      return res.status(400).json({ error: "Bad id." });

    const { rows } = await query<{ owner_id: number; status: string }>(
      "SELECT owner_id, status FROM markers WHERE id = $1",
      [id],
    );
    const m = rows[0];
    if (!m) return res.status(404).json({ error: "Marker not found." });

    const ownPending = m.owner_id === me.id && m.status === "pending";
    if (!me.is_admin && !ownPending)
      return res.status(403).json({
        error: "You can only withdraw your own icons while pending.",
      });

    await query("DELETE FROM markers WHERE id = $1", [id]);
    res.json({ ok: true });
  },
);
