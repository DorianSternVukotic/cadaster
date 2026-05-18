"use strict";

/* ---------- tiny helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const el = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer = null;
function toast(msg, kind = "") {
  const t = el("toast");
  t.textContent = msg;
  t.className = kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 4200);
}

const fmt = (n) => Math.round(n).toLocaleString();

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

/* ---------- state ---------- */
let me = null; // current user or null
let maps = []; // [{id,slug,name,description,bounds,grid,basemap}, ...]
let currentMap = null; // the active map object
let iconKinds = []; // palette kinds from the server
let territory = null; // {minX,minY,maxX,maxY,grid,name} of the current map
let scale = 1; // degrees of lng/lat per map unit
let cx = 0;
let cy = 0;
let mode = "view"; // "view" | "draw" | "placeIcon"
let drawPts = []; // [[lng,lat], ...]
let pendingKind = null; // chosen palette kind while placing an icon
let placePt = null; // {lng,lat} where the icon will go
let selectedId = null; // parcel id (number) or "m"+markerId (string)
let suppressHash = false; // guard against onhashchange feedback

/* ---------- coordinate transform (abstract units <-> map lng/lat) ----------
   There is no real-world basemap; MapLibre still needs lng/lat, so the active
   map's extent is mapped into a tiny box around (0,0) where Mercator distortion
   is negligible and uniform (squares stay square). The API only ever sees
   abstract units, always scoped to one map. */
function configureTransform(terr) {
  territory = terr;
  cx = (terr.minX + terr.maxX) / 2;
  cy = (terr.minY + terr.maxY) / 2;
  const span = Math.max(terr.maxX - terr.minX, terr.maxY - terr.minY) || 1;
  scale = 0.2 / span;
}
const u2ll = ([x, y]) => [(x - cx) * scale, (y - cy) * scale];
const ll2u = ([lng, lat]) => [
  Math.round((lng / scale + cx) * 100) / 100,
  Math.round((lat / scale + cy) * 100) / 100,
];

function transformGeometry(geom, fn) {
  // Polygon only (what parcels produce/store).
  return {
    type: "Polygon",
    coordinates: geom.coordinates.map((ring) => ring.map(fn)),
  };
}
function geomBounds(geomLL) {
  const b = new maplibregl.LngLatBounds();
  geomLL.coordinates.forEach((ring) => ring.forEach((c) => b.extend(c)));
  return b;
}

/* ---------- map / layers ---------- */
let map;

const ALL_SOURCES = [
  "basemap",
  "grid",
  "border",
  "parcels",
  "sel",
  "markers",
  "draw",
  "draw-pts",
];
// bottom -> top draw order; reversed for teardown.
const ALL_LAYERS = [
  "bm-ocean",
  "bm-land",
  "bm-forest",
  "bm-river-fill",
  "bm-river-line",
  "bm-contours",
  "grid",
  "border",
  "parcels-fill",
  "parcels-line",
  "parcels-own",
  "sel",
  "sel-pt",
  "markers-circles",
  "markers-own",
  "markers-icons",
  "draw-fill",
  "draw-line",
  "draw-pts",
];

// Layers panel checkbox group -> MapLibre layer ids.
const LAYER_GROUPS = {
  satellite: [
    "bm-ocean",
    "bm-land",
    "bm-forest",
    "bm-river-fill",
    "bm-river-line",
  ],
  elevation: ["bm-contours"],
  plots: ["parcels-fill", "parcels-line", "parcels-own"],
  presentation: ["markers-circles", "markers-own", "markers-icons"],
  grid: ["grid", "border"],
};
function setGroupVisible(group, visible) {
  for (const id of LAYER_GROUPS[group] || [])
    if (map.getLayer(id))
      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
}
function reapplyLayerToggles() {
  document.querySelectorAll("#layers input[type=checkbox]").forEach((cb) => {
    setGroupVisible(cb.dataset.group, cb.checked);
  });
}

function buildGrid() {
  const lines = [];
  const { minX, maxX, minY, maxY, grid } = territory;
  for (let x = minX; x <= maxX + 1e-9; x += grid)
    lines.push([u2ll([x, minY]), u2ll([x, maxY])]);
  for (let y = minY; y <= maxY + 1e-9; y += grid)
    lines.push([u2ll([minX, y]), u2ll([maxX, y])]);
  return {
    type: "FeatureCollection",
    features: lines.map((c) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: c },
    })),
  };
}

function statusColor() {
  return [
    "match",
    ["get", "status"],
    "approved",
    "#2e9e5b",
    "pending",
    "#e0a526",
    "rejected",
    "#d2503f",
    "#8899aa",
  ];
}

/* ---------- mock vector basemaps (built client-side, offline) ---------- */
function rectFeature(x0, y0, x1, y1, bm) {
  return {
    type: "Feature",
    properties: { bm },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          u2ll([x0, y0]),
          u2ll([x1, y0]),
          u2ll([x1, y1]),
          u2ll([x0, y1]),
          u2ll([x0, y0]),
        ],
      ],
    },
  };
}
// Deterministic perturbed radius (periodic in the angle, so the ring closes).
function perturbed(cxu, cyu, r, amp, n) {
  const c = [];
  for (let i = 0; i <= n; i++) {
    const a = (2 * Math.PI * i) / n;
    const rr = r * (1 + amp * Math.sin(3 * a + 0.7) + amp * 0.5 * Math.cos(5 * a - 0.3));
    c.push(u2ll([cxu + rr * Math.cos(a), cyu + rr * Math.sin(a)]));
  }
  return c;
}
function blobFeature(cxu, cyu, r, bm, amp = 0.07) {
  return {
    type: "Feature",
    properties: { bm },
    geometry: { type: "Polygon", coordinates: [perturbed(cxu, cyu, r, amp, 80)] },
  };
}
function ringLine(cxu, cyu, r, bm, amp = 0.05) {
  return {
    type: "Feature",
    properties: { bm },
    geometry: { type: "LineString", coordinates: perturbed(cxu, cyu, r, amp, 80) },
  };
}
function unitNormals(pts) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    dx /= L;
    dy /= L;
    return [-dy, dx]; // left normal
  });
}
function ribbonFeature(pts, hw, bm) {
  const nrm = unitNormals(pts);
  const left = pts.map((p, i) => [p[0] + nrm[i][0] * hw, p[1] + nrm[i][1] * hw]);
  const right = pts.map((p, i) => [p[0] - nrm[i][0] * hw, p[1] - nrm[i][1] * hw]);
  const ring = [...left, ...right.reverse(), left[0]].map(u2ll);
  return {
    type: "Feature",
    properties: { bm },
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}
function lineFeature(pts, bm) {
  return {
    type: "Feature",
    properties: { bm },
    geometry: { type: "LineString", coordinates: pts.map(u2ll) },
  };
}

function buildBasemap(kind) {
  const f = [];
  const { minX, minY, maxX, maxY } = territory;
  const W = maxX - minX;
  const H = maxY - minY;
  const S = Math.min(W, H);

  if (kind === "island") {
    const ux = (minX + maxX) / 2;
    const uy = (minY + maxY) / 2;
    const R = S * 0.34;
    f.push(rectFeature(minX, minY, maxX, maxY, "ocean"));
    f.push(blobFeature(ux, uy, R * 1.18, "land", 0.06));
    f.push(blobFeature(ux - W * 0.04, uy + H * 0.05, R * 0.66, "forest", 0.1));
    [0.92, 0.74, 0.56, 0.36].forEach((k) =>
      f.push(ringLine(ux, uy, R * 1.18 * k, "contour", 0.05)),
    );
  } else if (kind === "river") {
    f.push(rectFeature(minX, minY, maxX, maxY, "land"));
    const cl = [
      [minX + 0.04 * W, minY + 0.12 * H],
      [minX + 0.24 * W, minY + 0.4 * H],
      [minX + 0.47 * W, minY + 0.36 * H],
      [minX + 0.7 * W, minY + 0.66 * H],
      [minX + 0.97 * W, minY + 0.82 * H],
    ];
    const hw = S * 0.05;
    f.push(ribbonFeature(cl, hw, "river-fill"));
    f.push(lineFeature(cl, "river-line"));
    f.push(blobFeature(minX + 0.3 * W, minY + 0.78 * H, S * 0.1, "forest", 0.1));
    f.push(blobFeature(minX + 0.8 * W, minY + 0.3 * H, S * 0.08, "forest", 0.1));
    const nrm = unitNormals(cl);
    [1.8, 2.8, 3.8].forEach((mlt) => {
      const off = cl.map((p, i) => [
        p[0] - nrm[i][0] * hw * mlt,
        p[1] - nrm[i][1] * hw * mlt,
      ]);
      f.push(lineFeature(off, "contour"));
    });
  } else {
    const mx = W * 0.06;
    const my = H * 0.06;
    f.push(rectFeature(minX + mx, minY + my, maxX - mx, maxY - my, "land"));
  }
  return { type: "FeatureCollection", features: f };
}

/* ---------- presentation icons (inline SVG -> map images) ---------- */
const ICON_SVG = {
  house:
    '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><path d="M15 4 L26 14 H23 V25 H7 V14 H4 Z" fill="#fff" stroke="#04101f" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  garden:
    '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><path d="M15 26 V14" stroke="#04101f" stroke-width="1.6"/><circle cx="15" cy="9" r="5" fill="#fff" stroke="#04101f" stroke-width="1.6"/><circle cx="9" cy="15" r="4" fill="#fff" stroke="#04101f" stroke-width="1.6"/><circle cx="21" cy="15" r="4" fill="#fff" stroke="#04101f" stroke-width="1.6"/></svg>',
  tower:
    '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><path d="M10 26 V8 H12 V5 H14 V8 H16 V5 H18 V8 H20 V26 Z" fill="#fff" stroke="#04101f" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  market:
    '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><path d="M6 12 L10 6 H20 L24 12 Z" fill="#fff" stroke="#04101f" stroke-width="1.6" stroke-linejoin="round"/><rect x="8" y="12" width="14" height="13" fill="#fff" stroke="#04101f" stroke-width="1.6"/></svg>',
  school:
    '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><rect x="6" y="12" width="18" height="13" fill="#fff" stroke="#04101f" stroke-width="1.6"/><path d="M15 4 V12 M15 4 L22 7 L15 9" fill="#fff" stroke="#04101f" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  dock:
    '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><path d="M4 16 H26 M9 16 V25 M21 16 V25" stroke="#04101f" stroke-width="1.6" fill="none"/><path d="M11 11 H22 L19 16 H11 Z" fill="#fff" stroke="#04101f" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  farm:
    '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><path d="M6 25 V12 L15 5 L24 12 V25 Z" fill="#fff" stroke="#04101f" stroke-width="1.6" stroke-linejoin="round"/><path d="M15 25 V16 H20 V25" fill="none" stroke="#04101f" stroke-width="1.4"/></svg>',
  park:
    '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><path d="M15 26 V18" stroke="#04101f" stroke-width="1.6"/><path d="M15 4 L22 17 H8 Z" fill="#fff" stroke="#04101f" stroke-width="1.6" stroke-linejoin="round"/></svg>',
};
async function loadIconImages() {
  await Promise.all(
    iconKinds.map(
      (kind) =>
        new Promise((resolve) => {
          const svg = ICON_SVG[kind];
          if (!svg) return resolve();
          const img = new Image(30, 30);
          img.onload = () => {
            if (!map.hasImage(kind)) map.addImage(kind, img);
            resolve();
          };
          img.onerror = resolve;
          img.src = "data:image/svg+xml;utf8," + encodeURIComponent(svg);
        }),
    ),
  );
}

/* ---------- build / teardown / switch ---------- */
function buildAllLayers() {
  const empty = { type: "FeatureCollection", features: [] };
  const sw = u2ll([territory.minX, territory.minY]);
  const ne = u2ll([territory.maxX, territory.maxY]);

  map.addSource("basemap", {
    type: "geojson",
    data: buildBasemap(currentMap.basemap),
  });
  map.addLayer({
    id: "bm-ocean",
    type: "fill",
    source: "basemap",
    filter: ["==", ["get", "bm"], "ocean"],
    paint: { "fill-color": "#13314a" },
  });
  map.addLayer({
    id: "bm-land",
    type: "fill",
    source: "basemap",
    filter: ["==", ["get", "bm"], "land"],
    paint: { "fill-color": "#33623f" },
  });
  map.addLayer({
    id: "bm-forest",
    type: "fill",
    source: "basemap",
    filter: ["==", ["get", "bm"], "forest"],
    paint: { "fill-color": "#26512f", "fill-opacity": 0.9 },
  });
  map.addLayer({
    id: "bm-river-fill",
    type: "fill",
    source: "basemap",
    filter: ["==", ["get", "bm"], "river-fill"],
    paint: { "fill-color": "#1f6f9c" },
  });
  map.addLayer({
    id: "bm-river-line",
    type: "line",
    source: "basemap",
    filter: ["==", ["get", "bm"], "river-line"],
    paint: { "line-color": "#2a90c8", "line-width": 2 },
  });
  map.addLayer({
    id: "bm-contours",
    type: "line",
    source: "basemap",
    filter: ["==", ["get", "bm"], "contour"],
    paint: {
      "line-color": "#d8c48a",
      "line-width": 1,
      "line-dasharray": [3, 2],
      "line-opacity": 0.55,
    },
  });

  map.addSource("grid", { type: "geojson", data: buildGrid() });
  map.addLayer({
    id: "grid",
    type: "line",
    source: "grid",
    paint: { "line-color": "#22324a", "line-width": 1, "line-opacity": 0.6 },
  });
  map.addSource("border", {
    type: "geojson",
    data: {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [sw, [ne[0], sw[1]], ne, [sw[0], ne[1]], sw],
      },
    },
  });
  map.addLayer({
    id: "border",
    type: "line",
    source: "border",
    paint: { "line-color": "#3d5377", "line-width": 2 },
  });

  map.addSource("parcels", { type: "geojson", data: empty });
  map.addLayer({
    id: "parcels-fill",
    type: "fill",
    source: "parcels",
    paint: { "fill-color": statusColor(), "fill-opacity": 0.35 },
  });
  map.addLayer({
    id: "parcels-line",
    type: "line",
    source: "parcels",
    paint: { "line-color": statusColor(), "line-width": 1.5 },
  });
  map.addLayer({
    id: "parcels-own",
    type: "line",
    source: "parcels",
    filter: ["==", ["get", "is_own"], true],
    paint: { "line-color": "#ffffff", "line-width": 2, "line-dasharray": [2, 2] },
  });

  map.addSource("sel", { type: "geojson", data: empty });
  map.addLayer({
    id: "sel",
    type: "line",
    source: "sel",
    paint: { "line-color": "#4ea1ff", "line-width": 3 },
  });
  map.addLayer({
    id: "sel-pt",
    type: "circle",
    source: "sel",
    paint: {
      "circle-radius": 16,
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": "#4ea1ff",
      "circle-stroke-width": 3,
    },
  });

  map.addSource("markers", { type: "geojson", data: empty });
  map.addLayer({
    id: "markers-circles",
    type: "circle",
    source: "markers",
    paint: {
      "circle-radius": 11,
      "circle-color": statusColor(),
      "circle-opacity": 0.9,
      "circle-stroke-color": "#04101f",
      "circle-stroke-width": 1.5,
    },
  });
  map.addLayer({
    id: "markers-own",
    type: "circle",
    source: "markers",
    filter: ["==", ["get", "is_own"], true],
    paint: {
      "circle-radius": 13,
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
    },
  });
  map.addLayer({
    id: "markers-icons",
    type: "symbol",
    source: "markers",
    layout: {
      "icon-image": ["get", "kind"],
      "icon-size": 0.85,
      "icon-allow-overlap": true,
    },
  });

  map.addSource("draw", { type: "geojson", data: empty });
  map.addLayer({
    id: "draw-fill",
    type: "fill",
    source: "draw",
    paint: { "fill-color": "#4ea1ff", "fill-opacity": 0.2 },
    filter: ["==", "$type", "Polygon"],
  });
  map.addLayer({
    id: "draw-line",
    type: "line",
    source: "draw",
    paint: { "line-color": "#4ea1ff", "line-width": 2 },
  });
  map.addSource("draw-pts", { type: "geojson", data: empty });
  map.addLayer({
    id: "draw-pts",
    type: "circle",
    source: "draw-pts",
    paint: {
      "circle-radius": 4,
      "circle-color": "#ffffff",
      "circle-stroke-color": "#4ea1ff",
      "circle-stroke-width": 2,
    },
  });
}

function teardownLayers() {
  for (const id of [...ALL_LAYERS].reverse())
    if (map.getLayer(id)) map.removeLayer(id);
  for (const s of ALL_SOURCES) if (map.getSource(s)) map.removeSource(s);
}

function fitToMap() {
  const sw = u2ll([territory.minX, territory.minY]);
  const ne = u2ll([territory.maxX, territory.maxY]);
  map.fitBounds([sw, ne], { padding: 70, duration: 0 });
  const margin = 0.25;
  map.setMaxBounds([
    [
      sw[0] - Math.abs(sw[0]) * margin - 0.05,
      sw[1] - Math.abs(sw[1]) * margin - 0.05,
    ],
    [
      ne[0] + Math.abs(ne[0]) * margin + 0.05,
      ne[1] + Math.abs(ne[1]) * margin + 0.05,
    ],
  ]);
}

const parseHash = () => {
  const m = /map=([\w-]+)/.exec(location.hash);
  return m ? m[1] : null;
};

async function switchMap(slug) {
  const m = maps.find((x) => x.slug === slug);
  if (!m || (currentMap && m.slug === currentMap.slug)) return;
  if (mode === "draw") exitDrawing();
  else if (mode === "placeIcon") exitPlacing();
  currentMap = m;
  localStorage.setItem("cad_map", slug);
  if (parseHash() !== slug) {
    suppressHash = true;
    location.hash = "map=" + slug;
  }
  el("map-switcher").value = slug;
  configureTransform({ ...m.bounds, grid: m.grid, name: m.name });
  el("title").textContent = m.name;
  selectedId = null;
  el("detail").classList.add("hidden");
  teardownLayers();
  buildAllLayers();
  fitToMap();
  await loadParcels();
  await loadMarkers();
  reapplyLayerToggles();
}

async function loadParcels() {
  if (!currentMap) return;
  const fc = await api(
    "/api/parcels?map=" + encodeURIComponent(currentMap.slug),
  );
  fc.features.forEach((f) => {
    f.geometry = transformGeometry(f.geometry, u2ll);
  });
  const src = map.getSource("parcels");
  if (src) src.setData(fc);
}

async function loadMarkers() {
  if (!currentMap) return;
  const fc = await api(
    "/api/markers?map=" + encodeURIComponent(currentMap.slug),
  );
  fc.features.forEach((f) => {
    f.geometry = { type: "Point", coordinates: u2ll(f.geometry.coordinates) };
  });
  const src = map.getSource("markers");
  if (src) src.setData(fc);
}

const reloadData = async () => {
  await loadParcels();
  await loadMarkers();
};

async function initMap() {
  const cfg = await api("/api/config");
  maps = cfg.maps || [];
  iconKinds = cfg.iconKinds || [];
  if (!maps.length) throw new Error("No maps configured");

  const want = parseHash() || localStorage.getItem("cad_map");
  currentMap = maps.find((m) => m.slug === want) || maps[0];

  const sw = el("map-switcher");
  sw.innerHTML = "";
  maps.forEach((m) => {
    const o = document.createElement("option");
    o.value = m.slug;
    o.textContent = m.name;
    sw.appendChild(o);
  });
  sw.value = currentMap.slug;

  configureTransform({
    ...currentMap.bounds,
    grid: currentMap.grid,
    name: currentMap.name,
  });
  el("title").textContent = currentMap.name;

  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {},
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#0d1b2a" } },
      ],
    },
    center: [0, 0],
    zoom: 9,
    renderWorldCopies: false,
    attributionControl: false,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }));

  await new Promise((r) => map.on("load", r));
  await loadIconImages();
  buildAllLayers();
  fitToMap();

  // Bound once; the generic click hit-tests via queryRenderedFeatures so it
  // keeps working across map-switch source/layer teardown + rebuild.
  map.on("click", onMapClick);
  map.on("dblclick", (e) => {
    if (mode === "draw") {
      e.preventDefault();
      finishDrawing();
    }
  });
  ["parcels-fill", "markers-circles"].forEach((L) => {
    map.on("mouseenter", L, () => {
      if (mode === "view") map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", L, () => {
      if (mode === "view") map.getCanvas().style.cursor = "";
    });
  });

  reapplyLayerToggles();
  await loadParcels();
  await loadMarkers();
}

/* ---------- detail (parcel) ---------- */
function statusPill(s) {
  return `<span class="pill ${s}">${s}</span>`;
}

async function openDetail(id) {
  selectedId = id;
  const d = el("detail");
  d.classList.remove("hidden");
  d.innerHTML = "<p>Loading…</p>";
  let data;
  try {
    data = await api("/api/parcels/" + id);
  } catch (e) {
    d.innerHTML = `<p class="msg err">${e.message}</p>`;
    return;
  }
  const p = data.parcel;
  const geomLL = transformGeometry(p.geometry, u2ll);
  map.getSource("sel").setData({ type: "Feature", geometry: geomLL });

  const canDelete =
    me && ((p.is_own && p.status === "pending") || me.is_admin);
  const isAdmin = me && me.is_admin;

  let html = `
    <h3>${escapeHtml(p.name)} ${statusPill(p.status)}</h3>
    <div class="kv"><span>Owner</span><span>${escapeHtml(p.owner_name)}</span></div>
    <div class="kv"><span>Area</span><span>${fmt(p.area)} u²</span></div>
    <div class="kv"><span>Claimed</span><span>${new Date(
      p.created_at,
    ).toLocaleDateString()}</span></div>`;
  if (p.decided_at)
    html += `<div class="kv"><span>Decided</span><span>${new Date(
      p.decided_at,
    ).toLocaleDateString()} by ${escapeHtml(p.decided_by_name || "—")}</span></div>`;
  if (p.decision_note)
    html += `<div class="kv"><span>Note</span><span>${escapeHtml(
      p.decision_note,
    )}</span></div>`;
  if (p.description) html += `<hr/><p>${escapeHtml(p.description)}</p>`;

  if (data.overlaps && data.overlaps.length) {
    html += `<div class="overlaps"><div class="warn">⚠ Overlaps ${data.overlaps.length} parcel(s)</div>`;
    for (const o of data.overlaps)
      html += `<div class="olist">${escapeHtml(o.name)} ${statusPill(
        o.status,
      )}<br/><small>${escapeHtml(o.owner_name)} · ${fmt(
        o.overlap_area,
      )} u² shared</small></div>`;
    html += `</div>`;
  }

  html += `<hr/><div class="row"><button id="d-zoom" class="ghost">Zoom to</button>`;
  if (canDelete)
    html += `<button id="d-del" class="ghost">${
      p.is_own && !me.is_admin ? "Withdraw" : "Delete"
    }</button>`;
  html += `<button id="d-close" class="ghost">Close</button></div>`;

  if (isAdmin) {
    html += `<hr/><strong>Decision</strong>
      <textarea id="d-note" rows="2" placeholder="Note (optional)">${escapeHtml(
        p.decision_note || "",
      )}</textarea>
      <div class="row">
        <button id="d-approve">Approve</button>
        <button id="d-reject" class="ghost">Reject</button>
      </div>`;
  }
  d.innerHTML = html;

  el("d-zoom").onclick = () =>
    map.fitBounds(geomBounds(geomLL), { padding: 80, duration: 600 });
  el("d-close").onclick = () => {
    d.classList.add("hidden");
    map.getSource("sel").setData({ type: "FeatureCollection", features: [] });
    selectedId = null;
  };
  if (canDelete)
    el("d-del").onclick = async () => {
      if (!confirm("Remove this parcel?")) return;
      try {
        await api("/api/parcels/" + id, { method: "DELETE" });
        toast("Parcel removed", "ok");
        el("d-close").click();
        await loadParcels();
      } catch (e) {
        toast(e.message, "err");
      }
    };
  if (isAdmin) {
    const decide = async (decision) => {
      try {
        await api(`/api/admin/parcels/${id}/decision`, {
          method: "POST",
          body: JSON.stringify({ decision, note: el("d-note").value }),
        });
        toast(`Parcel ${decision}`, "ok");
        await loadParcels();
        await openDetail(id);
        if (!el("admin").classList.contains("hidden")) refreshAdminQueue();
      } catch (e) {
        toast(e.message, "err");
      }
    };
    el("d-approve").onclick = () => decide("approved");
    el("d-reject").onclick = () => decide("rejected");
  }
}

/* ---------- detail (marker) ---------- */
async function openMarkerDetail(id) {
  selectedId = "m" + id;
  const d = el("detail");
  d.classList.remove("hidden");
  d.innerHTML = "<p>Loading…</p>";
  let data;
  try {
    data = await api("/api/markers/" + id);
  } catch (e) {
    d.innerHTML = `<p class="msg err">${e.message}</p>`;
    return;
  }
  const mk = data.marker;
  const ll = u2ll(mk.geometry.coordinates);
  map.getSource("sel").setData({
    type: "Feature",
    geometry: { type: "Point", coordinates: ll },
  });

  const canDelete =
    me && ((mk.is_own && mk.status === "pending") || me.is_admin);
  const isAdmin = me && me.is_admin;

  let html = `
    <h3>${escapeHtml(mk.name)} ${statusPill(mk.status)}</h3>
    <div class="kv"><span>Type</span><span>${escapeHtml(mk.kind)}</span></div>
    <div class="kv"><span>Owner</span><span>${escapeHtml(mk.owner_name)}</span></div>
    <div class="kv"><span>Placed</span><span>${new Date(
      mk.created_at,
    ).toLocaleDateString()}</span></div>`;
  if (mk.decided_at)
    html += `<div class="kv"><span>Decided</span><span>${new Date(
      mk.decided_at,
    ).toLocaleDateString()} by ${escapeHtml(mk.decided_by_name || "—")}</span></div>`;
  if (mk.decision_note)
    html += `<div class="kv"><span>Note</span><span>${escapeHtml(
      mk.decision_note,
    )}</span></div>`;
  if (mk.description) html += `<hr/><p>${escapeHtml(mk.description)}</p>`;

  html += `<hr/><div class="row"><button id="d-zoom" class="ghost">Zoom to</button>`;
  if (canDelete)
    html += `<button id="d-del" class="ghost">${
      mk.is_own && !me.is_admin ? "Withdraw" : "Delete"
    }</button>`;
  html += `<button id="d-close" class="ghost">Close</button></div>`;

  if (isAdmin) {
    html += `<hr/><strong>Decision</strong>
      <textarea id="d-note" rows="2" placeholder="Note (optional)">${escapeHtml(
        mk.decision_note || "",
      )}</textarea>
      <div class="row">
        <button id="d-approve">Approve</button>
        <button id="d-reject" class="ghost">Reject</button>
      </div>`;
  }
  d.innerHTML = html;

  el("d-zoom").onclick = () =>
    map.flyTo({ center: ll, zoom: Math.max(map.getZoom(), 11), duration: 600 });
  el("d-close").onclick = () => {
    d.classList.add("hidden");
    map.getSource("sel").setData({ type: "FeatureCollection", features: [] });
    selectedId = null;
  };
  if (canDelete)
    el("d-del").onclick = async () => {
      if (!confirm("Remove this icon?")) return;
      try {
        await api("/api/markers/" + id, { method: "DELETE" });
        toast("Icon removed", "ok");
        el("d-close").click();
        await loadMarkers();
      } catch (e) {
        toast(e.message, "err");
      }
    };
  if (isAdmin) {
    const decide = async (decision) => {
      try {
        await api(`/api/admin/markers/${id}/decision`, {
          method: "POST",
          body: JSON.stringify({ decision, note: el("d-note").value }),
        });
        toast(`Icon ${decision}`, "ok");
        await loadMarkers();
        await openMarkerDetail(id);
        if (!el("admin").classList.contains("hidden")) refreshIconQueue();
      } catch (e) {
        toast(e.message, "err");
      }
    };
    el("d-approve").onclick = () => decide("approved");
    el("d-reject").onclick = () => decide("rejected");
  }
}

/* ---------- map click router ---------- */
function onMapClick(e) {
  if (mode === "draw") {
    drawPts.push([e.lngLat.lng, e.lngLat.lat]);
    renderDraw();
    return;
  }
  if (mode === "placeIcon") {
    if (!pendingKind) {
      toast("Pick an icon kind first", "err");
      return;
    }
    placePt = e.lngLat;
    map.getSource("draw-pts").setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [e.lngLat.lng, e.lngLat.lat],
          },
        },
      ],
    });
    el("place-form").classList.remove("hidden");
    el("place-name").focus();
    return;
  }
  const feats = map.queryRenderedFeatures(e.point, {
    layers: ["markers-icons", "markers-own", "markers-circles", "parcels-fill"],
  });
  if (!feats.length) return;
  const f = feats[0];
  if (f.layer.id.indexOf("markers") === 0) openMarkerDetail(f.properties.id);
  else openDetail(f.properties.id);
}

/* ---------- drawing a claim ---------- */
function renderDraw() {
  const pts = drawPts;
  map.getSource("draw-pts").setData({
    type: "FeatureCollection",
    features: pts.map((c) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: c },
    })),
  });

  let geom = { type: "FeatureCollection", features: [] };
  if (pts.length >= 3)
    geom = {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[...pts, pts[0]]] },
    };
  else if (pts.length >= 2)
    geom = { type: "Feature", geometry: { type: "LineString", coordinates: pts } };
  map.getSource("draw").setData(geom);

  el("draw-finish").disabled = pts.length < 3;
}

function startDrawing() {
  if (!me) return;
  mode = "draw";
  drawPts = [];
  selectedId = null;
  map.doubleClickZoom.disable();
  map.getCanvas().style.cursor = "crosshair";
  setAccountOpen(false);
  el("account-wrap").classList.add("hidden");
  el("detail").classList.add("hidden");
  el("admin").classList.add("hidden");
  el("place-bar").classList.add("hidden");
  el("draw-bar").classList.remove("hidden");
  el("claim-form").classList.add("hidden");
  renderDraw();
}

function exitDrawing() {
  mode = "view";
  drawPts = [];
  map.doubleClickZoom.enable();
  map.getCanvas().style.cursor = "";
  const empty = { type: "FeatureCollection", features: [] };
  if (map.getSource("draw")) map.getSource("draw").setData(empty);
  if (map.getSource("draw-pts")) map.getSource("draw-pts").setData(empty);
  el("draw-bar").classList.add("hidden");
  el("account-wrap").classList.remove("hidden");
}

function finishDrawing() {
  if (drawPts.length < 3) {
    toast("Need at least 3 corners", "err");
    return;
  }
  el("claim-form").classList.remove("hidden");
  el("claim-name").focus();
}

async function submitClaim() {
  const name = el("claim-name").value.trim();
  if (!name) {
    toast("Give the parcel a name", "err");
    return;
  }
  const ring = drawPts.map(ll2u);
  ring.push([...ring[0]]);
  try {
    const r = await api("/api/parcels", {
      method: "POST",
      body: JSON.stringify({
        map: currentMap.slug,
        name,
        description: el("claim-desc").value.trim(),
        geometry: { type: "Polygon", coordinates: [ring] },
      }),
    });
    el("claim-name").value = "";
    el("claim-desc").value = "";
    exitDrawing();
    await loadParcels();
    if (r.overlaps && r.overlaps.length)
      toast(
        `Claim submitted — ⚠ overlaps ${r.overlaps.length} parcel(s); an admin will review.`,
        "ok",
      );
    else toast("Claim submitted for review", "ok");
    openDetail(r.parcel.id);
  } catch (e) {
    toast(e.message, "err");
  }
}

/* ---------- placing an icon ---------- */
function buildPalette() {
  const box = el("palette");
  box.innerHTML = "";
  iconKinds.forEach((k) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "palette-btn";
    b.title = k;
    b.innerHTML = ICON_SVG[k] || k;
    b.onclick = () => {
      pendingKind = k;
      document
        .querySelectorAll("#palette .palette-btn")
        .forEach((x) => x.classList.toggle("active", x === b));
    };
    box.appendChild(b);
  });
}

function startPlacing() {
  if (!me) return;
  mode = "placeIcon";
  pendingKind = null;
  placePt = null;
  selectedId = null;
  map.getCanvas().style.cursor = "crosshair";
  setAccountOpen(false);
  el("account-wrap").classList.add("hidden");
  el("detail").classList.add("hidden");
  el("admin").classList.add("hidden");
  el("draw-bar").classList.add("hidden");
  el("place-bar").classList.remove("hidden");
  el("place-form").classList.add("hidden");
  buildPalette();
}

function exitPlacing() {
  mode = "view";
  pendingKind = null;
  placePt = null;
  map.getCanvas().style.cursor = "";
  const empty = { type: "FeatureCollection", features: [] };
  if (map.getSource("draw-pts")) map.getSource("draw-pts").setData(empty);
  el("place-bar").classList.add("hidden");
  el("account-wrap").classList.remove("hidden");
}

async function submitIcon() {
  if (!pendingKind) {
    toast("Pick an icon kind", "err");
    return;
  }
  if (!placePt) {
    toast("Click the map to place it", "err");
    return;
  }
  const name = el("place-name").value.trim();
  if (!name) {
    toast("Give the icon a name", "err");
    return;
  }
  const [x, y] = ll2u([placePt.lng, placePt.lat]);
  try {
    const r = await api("/api/markers", {
      method: "POST",
      body: JSON.stringify({
        map: currentMap.slug,
        kind: pendingKind,
        name,
        description: el("place-desc").value.trim(),
        geometry: { type: "Point", coordinates: [x, y] },
      }),
    });
    el("place-name").value = "";
    el("place-desc").value = "";
    exitPlacing();
    await loadMarkers();
    toast("Icon submitted for review", "ok");
    openMarkerDetail(r.marker.id);
  } catch (e) {
    toast(e.message, "err");
  }
}

/* ---------- auth ---------- */
// The account panel is collapsed by default behind #account-toggle so it
// doesn't sit over the map (especially on mobile).
function setAccountOpen(open) {
  el("account").classList.toggle("hidden", !open);
  el("account-toggle").setAttribute("aria-expanded", open ? "true" : "false");
}

function renderAuth() {
  const anon = el("auth-anon");
  const user = el("auth-user");
  el("account-toggle").textContent = me ? me.display_name : "Sign in";
  el("account-toggle").classList.toggle("is-user", !!me);
  if (me) {
    anon.classList.add("hidden");
    user.classList.remove("hidden");
    el("who-name").textContent = me.display_name;
    el("who-badge").classList.toggle("hidden", !me.is_admin);
    el("btn-admin").classList.toggle("hidden", !me.is_admin);
  } else {
    anon.classList.remove("hidden");
    user.classList.add("hidden");
    if (mode === "draw") exitDrawing();
    else if (mode === "placeIcon") exitPlacing();
  }
}

async function refreshMe() {
  try {
    const { user } = await api("/api/auth/me");
    me = user;
  } catch {
    me = null;
  }
  renderAuth();
  await reloadData();
}

/* ---------- admin: claims ---------- */
async function refreshAdminQueue() {
  const status = el("admin-filter").value;
  const list = el("admin-list");
  list.innerHTML = "Loading…";
  try {
    const { parcels } = await api("/api/admin/parcels?status=" + status);
    if (!parcels.length) {
      list.innerHTML = "<p class='hint'>Nothing here.</p>";
      return;
    }
    list.innerHTML = "";
    for (const p of parcels) {
      const card = document.createElement("div");
      card.className = "qcard";
      const ov = p.overlaps.length
        ? `<div class="warn" style="color:var(--pending)">⚠ overlaps ${p.overlaps.length}: ${p.overlaps
            .map((o) => escapeHtml(o.name) + " (" + o.status + ")")
            .join(", ")}</div>`
        : "";
      card.innerHTML = `
        <h4><span>${escapeHtml(p.name)}</span>${statusPill(p.status)}</h4>
        <div class="meta">${escapeHtml(p.map_name || "")} · ${escapeHtml(
          p.owner_name,
        )} · ${escapeHtml(p.owner_email)} · ${fmt(p.area)} u²</div>
        ${p.description ? `<div>${escapeHtml(p.description)}</div>` : ""}
        ${ov}
        <textarea rows="2" placeholder="Note (optional)">${escapeHtml(
          p.decision_note || "",
        )}</textarea>
        <div class="row">
          <button class="approve">Approve</button>
          <button class="reject ghost">Reject</button>
          <button class="zoom ghost">Zoom</button>
        </div>`;
      const note = card.querySelector("textarea");
      const decide = async (decision) => {
        try {
          await api(`/api/admin/parcels/${p.id}/decision`, {
            method: "POST",
            body: JSON.stringify({ decision, note: note.value }),
          });
          toast(`${p.name} ${decision}`, "ok");
          await loadParcels();
          refreshAdminQueue();
          if (selectedId === p.id) openDetail(p.id);
        } catch (e) {
          toast(e.message, "err");
        }
      };
      card.querySelector(".approve").onclick = () => decide("approved");
      card.querySelector(".reject").onclick = () => decide("rejected");
      card.querySelector(".zoom").onclick = () =>
        map.fitBounds(geomBounds(transformGeometry(p.geometry, u2ll)), {
          padding: 80,
          duration: 600,
        });
      list.appendChild(card);
    }
  } catch (e) {
    list.innerHTML = `<p class="msg err">${e.message}</p>`;
  }
}

/* ---------- admin: icons ---------- */
async function refreshIconQueue() {
  const status = el("icons-filter").value;
  const list = el("icons-list");
  list.innerHTML = "Loading…";
  try {
    const { markers } = await api("/api/admin/markers?status=" + status);
    if (!markers.length) {
      list.innerHTML = "<p class='hint'>Nothing here.</p>";
      return;
    }
    list.innerHTML = "";
    for (const mk of markers) {
      const card = document.createElement("div");
      card.className = "qcard";
      card.innerHTML = `
        <h4><span>${escapeHtml(mk.name)}</span>${statusPill(mk.status)}</h4>
        <div class="meta">${escapeHtml(mk.kind)} · ${escapeHtml(
          mk.map_name || "",
        )} · ${escapeHtml(mk.owner_name)} · ${escapeHtml(mk.owner_email)}</div>
        ${mk.description ? `<div>${escapeHtml(mk.description)}</div>` : ""}
        <textarea rows="2" placeholder="Note (optional)">${escapeHtml(
          mk.decision_note || "",
        )}</textarea>
        <div class="row">
          <button class="approve">Approve</button>
          <button class="reject ghost">Reject</button>
          <button class="zoom ghost">Zoom</button>
        </div>`;
      const note = card.querySelector("textarea");
      const decide = async (decision) => {
        try {
          await api(`/api/admin/markers/${mk.id}/decision`, {
            method: "POST",
            body: JSON.stringify({ decision, note: note.value }),
          });
          toast(`${mk.name} ${decision}`, "ok");
          await loadMarkers();
          refreshIconQueue();
          if (selectedId === "m" + mk.id) openMarkerDetail(mk.id);
        } catch (e) {
          toast(e.message, "err");
        }
      };
      card.querySelector(".approve").onclick = () => decide("approved");
      card.querySelector(".reject").onclick = () => decide("rejected");
      card.querySelector(".zoom").onclick = () =>
        map.flyTo({
          center: u2ll(mk.geometry.coordinates),
          zoom: Math.max(map.getZoom(), 11),
          duration: 600,
        });
      list.appendChild(card);
    }
  } catch (e) {
    list.innerHTML = `<p class="msg err">${e.message}</p>`;
  }
}

/* ---------- admin: users ---------- */
async function refreshUsers() {
  const box = el("users-list");
  box.innerHTML = "Loading…";
  try {
    const { users } = await api("/api/admin/users");
    box.innerHTML = "";
    for (const u of users) {
      const row = document.createElement("div");
      row.className = "olist";
      row.innerHTML = `${escapeHtml(u.display_name)} — ${escapeHtml(
        u.email,
      )} ${u.is_admin ? '<span class="badge">admin</span>' : ""}`;
      box.appendChild(row);
    }
  } catch (e) {
    box.innerHTML = `<p class="msg err">${e.message}</p>`;
  }
}

async function promote(email, isAdmin) {
  if (!email) return toast("Enter an email", "err");
  try {
    await api("/api/admin/users/promote", {
      method: "POST",
      body: JSON.stringify({ email, isAdmin }),
    });
    toast("Updated", "ok");
    refreshUsers();
  } catch (e) {
    toast(e.message, "err");
  }
}

/* ---------- wire up UI ---------- */
function wireUI() {
  // map switcher
  el("map-switcher").onchange = () => switchMap(el("map-switcher").value);
  window.addEventListener("hashchange", () => {
    if (suppressHash) {
      suppressHash = false;
      return;
    }
    const s = parseHash();
    if (s && maps.find((m) => m.slug === s)) switchMap(s);
  });

  // layer toggles
  document.querySelectorAll("#layers input[type=checkbox]").forEach((cb) => {
    cb.onchange = () => setGroupVisible(cb.dataset.group, cb.checked);
  });

  // account panel: collapsed by default, expand on click
  el("account-toggle").onclick = () =>
    setAccountOpen(el("account").classList.contains("hidden"));

  // auth tabs
  document.querySelectorAll("#auth-anon .tab").forEach((b) => {
    b.onclick = () => {
      document
        .querySelectorAll("#auth-anon .tab")
        .forEach((x) => x.classList.toggle("active", x === b));
      el("login-form").classList.toggle("hidden", b.dataset.tab !== "login");
      el("signup-form").classList.toggle("hidden", b.dataset.tab !== "signup");
    };
  });

  el("login-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const { user } = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: f.email.value,
          password: f.password.value,
        }),
      });
      me = user;
      renderAuth();
      await reloadData();
      setAccountOpen(false);
      toast("Signed in", "ok");
    } catch (err) {
      el("auth-msg").className = "msg err";
      el("auth-msg").textContent = err.message;
    }
  };

  el("signup-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const { user } = await api("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          displayName: f.displayName.value,
          email: f.email.value,
          password: f.password.value,
        }),
      });
      me = user;
      renderAuth();
      await reloadData();
      setAccountOpen(false);
      toast(
        me.is_admin
          ? "Account created — you are the bootstrap admin."
          : "Account created",
        "ok",
      );
    } catch (err) {
      el("auth-msg").className = "msg err";
      el("auth-msg").textContent = err.message;
    }
  };

  el("btn-logout").onclick = async () => {
    await api("/api/auth/logout", { method: "POST" });
    me = null;
    renderAuth();
    await reloadData();
    setAccountOpen(false);
  };

  el("btn-claim").onclick = startDrawing;
  el("draw-undo").onclick = () => {
    drawPts.pop();
    renderDraw();
  };
  el("draw-finish").onclick = finishDrawing;
  el("draw-cancel").onclick = exitDrawing;
  el("claim-submit").onclick = submitClaim;
  el("claim-back").onclick = () => el("claim-form").classList.add("hidden");

  el("btn-place").onclick = startPlacing;
  el("place-submit").onclick = submitIcon;
  el("place-cancel").onclick = exitPlacing;

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (mode === "draw") exitDrawing();
    else if (mode === "placeIcon") exitPlacing();
  });

  el("btn-admin").onclick = () => {
    setAccountOpen(false);
    el("admin").classList.remove("hidden");
    refreshAdminQueue();
  };
  el("admin-close").onclick = () => el("admin").classList.add("hidden");
  el("admin-refresh").onclick = refreshAdminQueue;
  el("admin-filter").onchange = refreshAdminQueue;
  el("icons-refresh").onclick = refreshIconQueue;
  el("icons-filter").onchange = refreshIconQueue;
  document.querySelectorAll("#admin .tab").forEach((b) => {
    b.onclick = () => {
      document
        .querySelectorAll("#admin .tab")
        .forEach((x) => x.classList.toggle("active", x === b));
      const t = b.dataset.atab;
      el("admin-queue").classList.toggle("hidden", t !== "queue");
      el("admin-icons").classList.toggle("hidden", t !== "icons");
      el("admin-users").classList.toggle("hidden", t !== "users");
      if (t === "queue") refreshAdminQueue();
      else if (t === "icons") refreshIconQueue();
      else refreshUsers();
    };
  });
  el("promote-grant").onclick = () =>
    promote(el("promote-email").value.trim().toLowerCase(), true);
  el("promote-revoke").onclick = () =>
    promote(el("promote-email").value.trim().toLowerCase(), false);
}

/* ---------- boot ---------- */
(async () => {
  wireUI();
  await initMap();
  await refreshMe();
})().catch((e) => {
  console.error(e);
  toast("Failed to start: " + e.message, "err");
});
