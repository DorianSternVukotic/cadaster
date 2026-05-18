import { type Request, type Response, Router } from "express";
import { currentUser, requireAdmin } from "./auth.js";
import { query } from "./db.js";
import { getOverlaps } from "./parcels.js";

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const STATUSES = ["pending", "approved", "rejected", "all"] as const;

// GET /api/admin/parcels?status=pending  — review queue with overlap reports.
adminRouter.get("/parcels", async (req: Request, res: Response) => {
  const status = String(req.query.status ?? "pending");
  if (!STATUSES.includes(status as (typeof STATUSES)[number]))
    return res.status(400).json({ error: "Bad status filter." });

  const where = status === "all" ? "TRUE" : "p.status = $1";
  const params = status === "all" ? [] : [status];
  const { rows } = await query(
    `SELECT p.id, p.name, p.description, p.status, p.owner_id, p.map_id,
            u.display_name AS owner_name, u.email AS owner_email,
            mp.name AS map_name,
            p.created_at, p.decided_at, p.decision_note,
            ST_Area(p.geom) AS area, ST_AsGeoJSON(p.geom) AS geojson
       FROM parcels p
       JOIN users u ON u.id = p.owner_id
       JOIN maps  mp ON mp.id = p.map_id
      WHERE ${where}
      ORDER BY p.created_at DESC`,
    params,
  );

  const parcels = [];
  for (const r of rows) {
    parcels.push({
      id: r.id,
      name: r.name,
      description: r.description,
      status: r.status,
      owner_name: r.owner_name,
      owner_email: r.owner_email,
      map_name: r.map_name,
      created_at: r.created_at,
      decided_at: r.decided_at,
      decision_note: r.decision_note,
      area: Number(r.area),
      geometry: JSON.parse(r.geojson),
      overlaps: await getOverlaps(r.id, r.map_id),
    });
  }
  res.json({ parcels });
});

// GET /api/admin/markers?status=pending  — presentation-icon review queue.
adminRouter.get("/markers", async (req: Request, res: Response) => {
  const status = String(req.query.status ?? "pending");
  if (!STATUSES.includes(status as (typeof STATUSES)[number]))
    return res.status(400).json({ error: "Bad status filter." });

  const where = status === "all" ? "TRUE" : "m.status = $1";
  const params = status === "all" ? [] : [status];
  const { rows } = await query(
    `SELECT m.id, m.name, m.description, m.kind, m.status, m.owner_id,
            u.display_name AS owner_name, u.email AS owner_email,
            mp.name AS map_name,
            m.created_at, m.decided_at, m.decision_note,
            ST_AsGeoJSON(m.geom) AS geojson
       FROM markers m
       JOIN users u ON u.id = m.owner_id
       JOIN maps  mp ON mp.id = m.map_id
      WHERE ${where}
      ORDER BY m.created_at DESC`,
    params,
  );

  res.json({
    markers: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      kind: r.kind,
      status: r.status,
      owner_name: r.owner_name,
      owner_email: r.owner_email,
      map_name: r.map_name,
      created_at: r.created_at,
      decided_at: r.decided_at,
      decision_note: r.decision_note,
      geometry: JSON.parse(r.geojson),
    })),
  });
});

// POST /api/admin/markers/:id/decision  — approve or reject an icon.
adminRouter.post(
  "/markers/:id/decision",
  async (req: Request, res: Response) => {
    const me = currentUser(res)!;
    const id = Number(req.params.id);
    const decision = String(req.body?.decision ?? "");
    const note = String(req.body?.note ?? "").trim().slice(0, 2000);

    if (!Number.isInteger(id))
      return res.status(400).json({ error: "Bad id." });
    if (decision !== "approved" && decision !== "rejected")
      return res
        .status(400)
        .json({ error: "decision must be 'approved' or 'rejected'." });

    const { rowCount } = await query(
      `UPDATE markers
          SET status = $1, decided_at = now(), decided_by = $2,
              decision_note = $3
        WHERE id = $4`,
      [decision, me.id, note, id],
    );
    if (!rowCount)
      return res.status(404).json({ error: "Marker not found." });
    res.json({ ok: true, status: decision });
  },
);

// POST /api/admin/parcels/:id/decision  — approve or reject a claim.
adminRouter.post(
  "/parcels/:id/decision",
  async (req: Request, res: Response) => {
    const me = currentUser(res)!;
    const id = Number(req.params.id);
    const decision = String(req.body?.decision ?? "");
    const note = String(req.body?.note ?? "").trim().slice(0, 2000);

    if (!Number.isInteger(id))
      return res.status(400).json({ error: "Bad id." });
    if (decision !== "approved" && decision !== "rejected")
      return res
        .status(400)
        .json({ error: "decision must be 'approved' or 'rejected'." });

    const { rowCount } = await query(
      `UPDATE parcels
          SET status = $1, decided_at = now(), decided_by = $2,
              decision_note = $3
        WHERE id = $4`,
      [decision, me.id, note, id],
    );
    if (!rowCount)
      return res.status(404).json({ error: "Parcel not found." });
    res.json({ ok: true, status: decision });
  },
);

// GET /api/admin/users  — account list for role management.
adminRouter.get("/users", async (_req: Request, res: Response) => {
  const { rows } = await query(
    `SELECT id, email, display_name, is_admin, created_at
       FROM users ORDER BY created_at`,
  );
  res.json({ users: rows });
});

// POST /api/admin/users/promote  — grant or revoke admin by email.
adminRouter.post("/users/promote", async (req: Request, res: Response) => {
  const me = currentUser(res)!;
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const isAdmin = Boolean(req.body?.isAdmin);

  if (!email) return res.status(400).json({ error: "Email is required." });
  if (email === me.email && !isAdmin)
    return res
      .status(400)
      .json({ error: "You cannot remove your own admin access." });

  const { rowCount } = await query(
    "UPDATE users SET is_admin = $1 WHERE email = $2",
    [isAdmin, email],
  );
  if (!rowCount)
    return res.status(404).json({ error: "No user with that email." });
  res.json({ ok: true });
});
