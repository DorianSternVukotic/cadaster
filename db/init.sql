-- Cadaster schema (PostGIS).
-- Runs automatically on first container start via docker-entrypoint-initdb.d.
-- The API also applies this idempotently at boot (ensureSchema), so it works
-- even against a pre-existing database.

CREATE EXTENSION IF NOT EXISTS postgis;

-- Accounts. The first registered account (or any email in ADMIN_EMAILS)
-- is granted admin automatically; admins can promote others afterwards.
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Server-side sessions. Token lives in an httpOnly cookie.
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

-- Land parcels. Geometry uses SRID 0 (an abstract, unit-less Cartesian plane)
-- because this deployment is a conceptual territory, not real-world geography.
-- ST_Area / ST_Intersects work fine on SRID 0; areas are reported in map units.
CREATE TABLE IF NOT EXISTS parcels (
  id            BIGSERIAL PRIMARY KEY,
  owner_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected')),
  geom          geometry(Polygon, 0) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ,
  decided_by    BIGINT REFERENCES users(id),
  decision_note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS parcels_geom_gix   ON parcels USING GIST (geom);
CREATE INDEX IF NOT EXISTS parcels_status_idx ON parcels (status);
CREATE INDEX IF NOT EXISTS parcels_owner_idx  ON parcels (owner_id);

-- Maps. Each map is an independent "place": its own bounds, grid spacing and
-- (client-rendered) mock basemap. Parcels and markers belong to exactly one
-- map. Rows are seeded idempotently by the server at boot (ensureMaps) so the
-- primary map can inherit the env-driven TERRITORY_* extent.
CREATE TABLE IF NOT EXISTS maps (
  id          BIGSERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  min_x       DOUBLE PRECISION NOT NULL,
  min_y       DOUBLE PRECISION NOT NULL,
  max_x       DOUBLE PRECISION NOT NULL,
  max_y       DOUBLE PRECISION NOT NULL,
  grid        DOUBLE PRECISION NOT NULL DEFAULT 100,
  basemap     TEXT NOT NULL DEFAULT 'plain'
                CHECK (basemap IN ('plain', 'island', 'river')),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maps_sort_idx ON maps (sort_order, id);

-- Attach parcels to a map. Kept NULLable at the DB level on purpose: this file
-- runs (ensureSchema) before maps are seeded and legacy rows backfilled, so a
-- NOT NULL here would fail. The not-null invariant is enforced application-side
-- (every INSERT supplies map_id; every SELECT filters by it). PG <= 16 has no
-- ADD CONSTRAINT IF NOT EXISTS, hence the pg_constraint guard.
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS map_id BIGINT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parcels_map_fk') THEN
    ALTER TABLE parcels ADD CONSTRAINT parcels_map_fk
      FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS parcels_map_idx ON parcels (map_id);

-- Presentation icons: user-placed conceptual points (buildings, gardens, …),
-- same pending/approved/rejected workflow as parcels but a Point geometry and
-- no overlap detection. map_id is NOT NULL (new table, no legacy rows).
CREATE TABLE IF NOT EXISTS markers (
  id            BIGSERIAL PRIMARY KEY,
  map_id        BIGINT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  owner_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected')),
  geom          geometry(Point, 0) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ,
  decided_by    BIGINT REFERENCES users(id),
  decision_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS markers_geom_gix   ON markers USING GIST (geom);
CREATE INDEX IF NOT EXISTS markers_status_idx ON markers (status);
CREATE INDEX IF NOT EXISTS markers_owner_idx  ON markers (owner_id);
CREATE INDEX IF NOT EXISTS markers_map_idx    ON markers (map_id);
