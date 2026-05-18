// Central configuration. The `territory` block is also served to the browser
// (GET /api/config) so the map and the API agree on the world's extent.

const num = (v: string | undefined, fallback: number) =>
  v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : fallback;

export const config = {
  port: num(process.env.PORT, 8080),

  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://cadaster:cadaster@db:5432/cadaster",

  // Used to sign nothing currently, but reserved for cookie signing / future use.
  sessionSecret: process.env.SESSION_SECRET ?? "dev-insecure-secret-change-me",

  // Cookie is not marked Secure when false (needed for plain-http local dev).
  cookieSecure: process.env.COOKIE_SECURE === "true",

  sessionDays: num(process.env.SESSION_DAYS, 30),

  // Comma-separated emails that become admin on signup (in addition to the
  // very first registered account, which is always made admin).
  adminEmails: (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // The abstract territory. Coordinates are unit-less map units, not degrees;
  // there is intentionally no real-world basemap. minX/minY..maxX/maxY define
  // the claimable extent; `grid` is the spacing of the reference graticule.
  territory: {
    minX: num(process.env.TERRITORY_MIN_X, -1000),
    minY: num(process.env.TERRITORY_MIN_Y, -1000),
    maxX: num(process.env.TERRITORY_MAX_X, 1000),
    maxY: num(process.env.TERRITORY_MAX_Y, 1000),
    grid: num(process.env.TERRITORY_GRID, 100),
    name: process.env.TERRITORY_NAME ?? "Libertaria",
  },
};

export type Territory = typeof config.territory;
