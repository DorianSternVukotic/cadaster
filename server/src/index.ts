import "express-async-errors"; // forwards async route errors to the handler
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { adminRouter } from "./admin.js";
import { attachUser, authRouter } from "./auth.js";
import { config } from "./config.js";
import { initDb } from "./db.js";
import { ICON_KINDS } from "./icons.js";
import { ensureMaps, getMaps } from "./maps.js";
import { markersRouter } from "./markers.js";
import { parcelsRouter } from "./parcels.js";
import { seedDemo } from "./seed.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(attachUser);

// Map + API agree on the available maps (and their extents), the icon
// palette, and the legacy single-territory shape via this endpoint.
app.get("/api/config", async (_req, res) => {
  const maps = await getMaps();
  res.json({
    territory: config.territory, // legacy / compatibility
    iconKinds: ICON_KINDS,
    maps: maps.map((m) => ({
      id: m.id,
      slug: m.slug,
      name: m.name,
      description: m.description,
      bounds: { minX: m.min_x, minY: m.min_y, maxX: m.max_x, maxY: m.max_y },
      grid: m.grid,
      basemap: m.basemap,
    })),
  });
});

app.use("/api/auth", authRouter);
app.use("/api/parcels", parcelsRouter);
app.use("/api/markers", markersRouter);
app.use("/api/admin", adminRouter);

// maplibre-gl is vendored from node_modules so the app works fully offline.
app.use(
  "/vendor/maplibre",
  express.static(join(repoRoot, "server", "node_modules", "maplibre-gl", "dist")),
);
app.use(express.static(join(repoRoot, "web")));

app.use((_req, res) => res.status(404).json({ error: "Not found." }));

// Final error handler: async route rejections land here.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[error]", err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error." });
});

initDb()
  .then(ensureMaps)
  .then(seedDemo)
  .then(() => {
    app.listen(config.port, () => {
      console.log(`[cadaster] listening on http://localhost:${config.port}`);
      console.log(
        `[cadaster] territory "${config.territory.name}" ` +
          `[${config.territory.minX},${config.territory.minY}] .. ` +
          `[${config.territory.maxX},${config.territory.maxY}]`,
      );
    });
  })
  .catch((err) => {
    console.error("[cadaster] failed to start:", err);
    process.exit(1);
  });
