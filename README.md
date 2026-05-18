# Cadaster

A web cadaster: anyone can view the territory map, registered users draw and
submit land claims, and admins approve or reject them. Overlapping claims are
detected automatically and surfaced to admins (and the claimant) for
resolution — they are not auto-blocked.

## Why this was built (and not adopted off-the-shelf)

Existing open land-administration software was evaluated first:

- **FAO SOLA / Open Tenure** — conceptually the closest (crowdsourced claims +
  community adjudication) but a heavyweight Java enterprise stack with an
  Android-first capture flow; bending it into a clean web app is more work than
  a focused build.
- **Cadasta** — no longer a self-hostable platform, now a loose toolkit.
- **open-user-map** — only location *pins* with optional approval, WordPress-bound.
- **Accela / Cloudpermit / Oracle** — proprietary government SaaS; overkill.

None fit a lightweight "draw a polygon → admin approves → public map" app, so
this is a small, self-hostable custom build on mature components.

## Stack

| Layer    | Choice |
|----------|--------|
| Map      | MapLibre GL JS (MIT, no API key, fully offline — vendored from npm) |
| Frontend | Vanilla JS, no bundler |
| API      | Node + TypeScript (Express), run via `tsx` (no build step) |
| Data     | PostgreSQL + **PostGIS** — spatial index, area, overlap detection |
| Deploy   | Docker Compose (PostGIS + API) |

The map is an **abstract territory**: there is no real-world basemap. Parcel
geometry is stored in unit-less map units (PostGIS SRID 0); the browser maps
them into a tiny lng/lat window so MapLibre stays happy while squares stay
square. Areas are reported in `u²` (map units squared).

## Run it

```bash
cp .env.example .env        # optional; sensible defaults already work
docker compose up --build
```

Open <http://localhost:8080>.

**Bootstrap admin:** the **first account you register becomes admin**
automatically. Additional admins can be granted in the Admin → Users panel, or
pre-seeded via `ADMIN_EMAILS` in `.env`.

## Using it

- **Anyone** (no account): sees approved parcels, pans/zooms the grid.
- **Register / sign in** (top-left): then **+ Claim land** → click the map to
  drop corners (3+) → double-click or *Finish* → name it → *Submit*. The claim
  enters `pending` and you immediately see any overlap warnings.
- **Owners** see their own pending/rejected parcels and can withdraw a pending
  one.
- **Admins** get an **Admin** drawer: a review queue (with per-claim overlap
  reports) to Approve/Reject with a note, plus user role management. Approving
  a parcel makes it visible to everyone.

Colour key: green = approved, amber = pending, red = rejected, dashed white =
your own.

## API surface

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/config` | Territory extent (public) |
| `POST` | `/api/auth/signup` · `/login` · `/logout` | session cookie |
| `GET` | `/api/auth/me` | current user |
| `GET` | `/api/parcels` | GeoJSON, visibility by role |
| `POST` | `/api/parcels` | submit claim (auth) |
| `GET` | `/api/parcels/:id` | detail + overlaps |
| `DELETE` | `/api/parcels/:id` | owner withdraws / admin deletes |
| `GET` | `/api/admin/parcels?status=` | review queue (admin) |
| `POST` | `/api/admin/parcels/:id/decision` | approve/reject (admin) |
| `GET` | `/api/admin/users` · `POST /users/promote` | roles (admin) |

## Project layout

```
db/init.sql            PostGIS schema (also applied idempotently at boot)
server/src/
  config.ts            env + territory config (served to the browser)
  db.ts                pool, connect-retry, ensureSchema
  auth.ts              signup/login/sessions, role middleware
  parcels.ts           listing, claim creation, overlap detection
  admin.ts             review queue, decisions, role management
  index.ts             app wiring + static serving
web/                   index.html · style.css · app.js (MapLibre)
```

## Switching to a real-world basemap later

The abstract grid is deliberately swappable. To go geographic:

1. In `web/app.js`, replace the empty `style` with a real style URL (e.g. a
   MapLibre demo style or self-hosted tiles) and drop the unit↔lng/lat
   transform (`u2ll` / `ll2u`) so coordinates are real WGS84.
2. Change the `parcels.geom` column and inserts to `geometry(Polygon, 4326)`
   and report area with `ST_Area(geom::geography)` for square metres.
3. Remove the `TERRITORY_*` extent clamps (or repurpose them as a region of
   interest).

Everything else — auth, workflow, overlap detection — is unchanged.

## Production notes

- Set a strong `SESSION_SECRET`, `COOKIE_SECURE=true`, and serve behind HTTPS.
- Put the API behind a reverse proxy; add rate limiting on the auth routes.
- The `pgdata` volume holds all data — back it up.
