# Deployment

The cadaster is a two-container Docker Compose stack:

| Service | Image / build | Purpose |
|---|---|---|
| `db`  | `postgis/postgis:16-3.4` | PostgreSQL + PostGIS; data in the `pgdata` volume |
| `api` | built from `server/Dockerfile` | Node/TypeScript (Express, run via `tsx` — no build step), serves the API **and** the static frontend on port `8080` |

TypeScript runs directly with `tsx`; there is no compiled `dist/`. The image
bakes in `server/src`, `db/`, and `web/`, so **every code or asset change needs
an image rebuild** (`--build`) — a plain restart will not pick it up.

---

## 1. Prerequisites

- Docker Engine with the Compose plugin (`docker compose version` ≥ v2).
- Port `8080` free on the host (or change the mapping — see §3).

---

## 2. Quick start (local / first deploy)

```bash
cd /path/to/cadaster
cp .env.example .env          # then edit .env (see §3) — optional for local trials
docker compose up --build -d  # build images and start detached
docker compose logs -f api    # watch startup
```

Healthy startup logs look like:

```
[db] schema ensured
[db] maps ensured
[db] demo content seeded for map "island"
[db] demo content seeded for map "river"
[cadaster] listening on http://localhost:8080
```

Open <http://localhost:8080>.

**Bootstrap admin:** the **first account you register becomes admin**
automatically. Additional admins: the Admin → Users panel, or pre-seed via
`ADMIN_EMAILS` in `.env` (those emails are granted admin on signup).

Stop / start / tear down:

```bash
docker compose stop                  # stop, keep data
docker compose up -d                 # start again (no rebuild)
docker compose down                  # remove containers, KEEP the pgdata volume
docker compose down -v               # remove containers AND delete all data
```

---

## 3. Configuration (`.env`)

`docker compose` reads `.env` automatically. All variables have safe defaults;
override for production.

| Variable | Default | Notes |
|---|---|---|
| `SESSION_SECRET` | dev placeholder | **Set a long random string in production.** `openssl rand -hex 32` |
| `COOKIE_SECURE` | `false` | Set `true` only when served over HTTPS (marks the session cookie `Secure`). |
| `ADMIN_EMAILS` | empty | Comma-separated emails auto-granted admin on signup. |
| `TERRITORY_NAME` | `Libertaria` | Display name of the **primary** map. |
| `TERRITORY_MIN_X/MIN_Y/MAX_X/MAX_Y` | `-1000 … 1000` | Extent (abstract units) of the **primary** map. |
| `TERRITORY_GRID` | `100` | Reference-grid spacing of the **primary** map. |

DB credentials (`cadaster`/`cadaster`) and `DATABASE_URL` are set in
`docker-compose.yml`. To change them, edit the `db` env and the `api`
`DATABASE_URL` together.

To expose a different host port, change the `api` mapping in
`docker-compose.yml` (e.g. `"3000:8080"`); the container always listens on
`8080`.

### Maps & the `TERRITORY_*` variables — important

There are three maps, **seeded idempotently at boot**:

- `libertaria` (primary) — name/extent/grid come from the `TERRITORY_*` vars.
- `island` (Verdant Isle) and `river` (Riverlands) — fixed mock places.

Seeding uses `INSERT … ON CONFLICT (slug) DO NOTHING`, so **`TERRITORY_*`
applies only on the very first boot against an empty database**. Changing those
vars later does **not** mutate the already-seeded primary map (bounds are
intentionally immutable per the independent-maps design). To re-apply changed
territory settings you must reset the DB (§6) or update the `maps` row directly
in SQL.

Optional demo content (a few approved parcels + presentation icons per map) is
seeded **only for maps that are empty** and **only if an admin user already
exists**; on a brand-new DB it is skipped silently until after an admin
registers and the next boot. It never duplicates and never overwrites real data.

---

## 4. Updating / redeploying

Because the image bakes the source and `tsx` does not watch in production:

```bash
git pull            # or otherwise update the working tree
docker compose up --build -d
docker compose logs -f api
```

Schema migrations are automatic and idempotent: on every boot the API re-runs
`db/init.sql` wholesale (`ensureSchema`) and then `ensureMaps()` (seed maps +
backfill `parcels.map_id`). New `CREATE … IF NOT EXISTS` / `ADD COLUMN IF NOT
EXISTS` statements apply safely against the existing `pgdata`. No manual
migration step.

---

## 5. Data persistence & backup

All state lives in the named volume `pgdata`. It survives `docker compose down`
and image rebuilds; it is deleted only by `docker compose down -v`.

**Back up** (logical dump):

```bash
docker compose exec -T db pg_dump -U cadaster cadaster > cadaster-$(date +%F).sql
```

**Restore** into a fresh stack:

```bash
docker compose down -v
docker compose up -d db
docker compose exec -T db sh -c 'until pg_isready -U cadaster; do sleep 1; done'
docker compose exec -T db psql -U cadaster -d cadaster < cadaster-YYYY-MM-DD.sql
docker compose up --build -d            # bring up the api
```

(Volume-level snapshot/backup of `pgdata` is also fine if you prefer.)

---

## 6. Reset the database

Wipes **all** users, parcels, markers, and re-seeds maps from current `.env`:

```bash
docker compose down -v
docker compose up --build -d
```

---

## 7. Production hardening

- **Secrets:** set a strong `SESSION_SECRET`; change the Postgres
  user/password from `cadaster`/`cadaster` (update both `db` env and the `api`
  `DATABASE_URL`).
- **HTTPS:** terminate TLS at a reverse proxy (nginx/Caddy/Traefik) in front of
  the `api` container; set `COOKIE_SECURE=true`. Do not expose `8080` directly.
- **Reverse proxy:** forward to `api:8080`; add **rate limiting on the auth
  routes** (`/api/auth/*`) — there is none in-app.
- **Network:** keep the `db` service internal (it already publishes no host
  port). Only the proxy should reach the `api`.
- **Backups:** schedule the §5 `pg_dump` (the `pgdata` volume holds everything).
- **Resources/restart:** add `restart: unless-stopped` to both services in
  `docker-compose.yml` for unattended hosts.

Minimal example reverse-proxy block (Caddy):

```
cadaster.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

…with the `api` port published only to localhost (`"127.0.0.1:8080:8080"`).

---

## 8. Operations & troubleshooting

```bash
docker compose ps                       # service status / health
docker compose logs -f api              # API logs (startup, errors)
docker compose logs db                  # Postgres logs
docker compose exec db psql -U cadaster -d cadaster   # SQL shell
docker compose restart api              # restart API only (no rebuild)
```

| Symptom | Cause / fix |
|---|---|
| Code/UI change not showing | You restarted instead of rebuilding. Run `docker compose up --build -d`. |
| `api` exits, logs `gave up waiting for database` | DB not healthy in time. `docker compose up -d db`, wait for healthy, then bring up `api`. |
| Changed `TERRITORY_*` had no effect | Maps already seeded; vars apply only on first boot. Reset DB (§6) or edit the `maps` row in SQL. |
| No demo content on island/river | No admin existed at boot, or the map already has data. Register the admin, then `docker compose restart api`. |
| Port 8080 in use | Change the `api` port mapping in `docker-compose.yml`. |
| Need to wipe everything | `docker compose down -v && docker compose up --build -d`. |
