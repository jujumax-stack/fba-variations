#!/usr/bin/env node
/**
 * fba-variations — web backend
 * ---------------------------------------------------------------------------
 * Standalone Express app that builds Amazon variation families via SP-API.
 * Reuses the exact, battle-tested logic from amazon-variation-builder.mjs,
 * parameterized so it works for ANY family (not just the Ram tail light).
 *
 * The whole UI + API is gated behind HTTP Basic Auth (APP_USER / APP_PASS).
 * All secrets come from the environment / .env — nothing is hardcoded.
 * ---------------------------------------------------------------------------
 */

import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

// ===========================================================================
// CONFIG + ENV
// ===========================================================================
const MARKETPLACE_ID = process.env.MARKETPLACE_ID || "ATVPDKIKX0DER";        // US
const REGION_HOST    = process.env.REGION_HOST || "https://sellingpartnerapi-na.amazon.com";
const PORT           = parseInt(process.env.PORT || "3008", 10);
const SELLER_ID      = process.env.SP_API_SELLER_ID || process.env.SELLER_ID;

const APP_USER = process.env.APP_USER || "";
const APP_PASS = process.env.APP_PASS || "";

const REQUIRED = ["LWA_CLIENT_ID", "LWA_CLIENT_SECRET", "LWA_REFRESH_TOKEN"];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) { console.error("Missing SP-API env vars: " + missing.join(", ")); process.exit(1); }
if (!SELLER_ID)     { console.error("Missing SELLER_ID (or SP_API_SELLER_ID)."); process.exit(1); }
if (!APP_USER || !APP_PASS) { console.error("Missing APP_USER / APP_PASS — refusing to start an ungated app."); process.exit(1); }

// ===========================================================================
// SP-API AUTH + HTTP (ported verbatim from the CLI tool)
// ===========================================================================
let _token = null;
let _tokenExpiry = 0;

async function getAccessToken() {
  if (_token && Date.now() < _tokenExpiry - 60_000) return _token;
  const res = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.LWA_REFRESH_TOKEN,
      client_id: process.env.LWA_CLIENT_ID,
      client_secret: process.env.LWA_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error("LWA token exchange failed: " + res.status + " " + (await res.text()));
  const data = await res.json();
  _token = data.access_token;
  _tokenExpiry = Date.now() + data.expires_in * 1000;
  return _token;
}

// SP-API call with exponential backoff on 429 / 5xx.
async function sp(method, path, { query = {}, body = null } = {}) {
  const url = new URL(REGION_HOST + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  const delays = [0, 2000, 4000, 8000];
  let lastErr;
  for (const wait of delays) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const token = await getAccessToken();
    const res = await fetch(url, {
      method,
      headers: {
        "x-amz-access-token": token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status >= 500) { lastErr = res.status + " " + (await res.text()); continue; }
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) throw new Error(method + " " + path + " -> " + res.status + " " + JSON.stringify(json));
    return json;
  }
  throw new Error("Retries exhausted for " + method + " " + path + " (last: " + lastErr + ")");
}

const v = (val) => [{ value: val, marketplace_id: MARKETPLACE_ID }];

// ===========================================================================
// DISCOVERY — product type + valid variation themes for an ASIN
// ===========================================================================
async function discover(asin) {
  const cat = await sp("GET", `/catalog/2022-04-01/items/${asin}`, {
    query: { marketplaceIds: MARKETPLACE_ID, includedData: "productTypes" },
  });
  const productType = cat?.productTypes?.[0]?.productType;
  if (!productType) throw new Error("Could not resolve product type for " + asin);

  const def = await sp("GET", `/definitions/2020-09-01/productTypes/${productType}`, {
    query: { marketplaceIds: MARKETPLACE_ID, requirements: "LISTING", locale: "en_US" },
  });

  let themes = [];
  const link = def?.schema?.link?.resource;
  if (link) {
    try {
      const schema = await (await fetch(link)).json();
      themes =
        schema?.properties?.variation_theme?.items?.properties?.name?.enum ||
        schema?.properties?.variation_theme?.properties?.name?.enum || [];
    } catch { /* schema not parseable; leave themes empty */ }
  }
  return { asin, productType, themes };
}

// ===========================================================================
// PRE-FLIGHT — the lesson from last time.
// For each SKU the user intends to use, check:
//   - does it exist? what's its status/ASIN/parentage?
//   - is there a near-twin SKU differing only by a trailing "." (the gremlin)?
//   - how many FBA units are sitting on each variant?
// so a duplicate/stub never gets built into the family by accident.
// ===========================================================================
async function getListing(sku) {
  try {
    const res = await sp("GET", `/listings/2021-08-01/items/${SELLER_ID}/${encodeURIComponent(sku)}`, {
      query: { marketplaceIds: MARKETPLACE_ID, includedData: "summaries,issues,relationships" },
    });
    const s = res.summaries?.[0] || {};
    const rels = res.relationships?.[0]?.relationships || [];
    return {
      sku, exists: true,
      asin: s.asin || null,
      productType: s.productType || null,
      status: (s.status || []).join(", ") || "(no status)",
      itemName: s.itemName || null,
      parentOf: rels.flatMap((r) => r.childSkus || []),
      childOf: rels.flatMap((r) => r.parentSkus || []),
      issues: (res.issues || []).map((i) => ({ severity: i.severity, code: i.code, message: i.message })),
    };
  } catch (e) {
    return { sku, exists: false, error: String(e.message || e) };
  }
}

async function fbaUnits(skus) {
  const out = {};
  if (!skus.length) return out;
  try {
    const res = await sp("GET", `/fba/inventory/v1/summaries`, {
      query: {
        granularityType: "Marketplace", granularityId: MARKETPLACE_ID,
        marketplaceIds: MARKETPLACE_ID, details: "true",
        sellerSkus: skus.join(","),
      },
    });
    for (const s of res?.payload?.inventorySummaries || res?.inventorySummaries || []) {
      out[s.sellerSku] = s.totalQuantity ?? s?.inventoryDetails?.fulfillableQuantity ?? null;
    }
  } catch { /* inventory is best-effort; absence is not fatal */ }
  return out;
}

// twin candidates: with/without a single trailing dot
function twins(sku) {
  const set = new Set();
  if (sku.endsWith(".")) set.add(sku.slice(0, -1)); else set.add(sku + ".");
  return [...set];
}

async function preflight(skus) {
  const clean = [...new Set(skus.map((s) => String(s).trim()).filter(Boolean))];
  const probe = [...new Set(clean.flatMap((s) => [s, ...twins(s)]))];

  const listings = {};
  for (const sku of probe) listings[sku] = await getListing(sku);  // sequential — gentle on rate limits
  const units = await fbaUnits(probe.filter((s) => listings[s].exists));

  return clean.map((sku) => {
    const self = listings[sku];
    const twinHits = twins(sku)
      .filter((t) => listings[t]?.exists)
      .map((t) => ({ sku: t, status: listings[t].status, asin: listings[t].asin, units: units[t] ?? null }));
    return {
      sku,
      exists: self.exists,
      status: self.status,
      asin: self.asin,
      units: units[sku] ?? null,
      childOf: self.childOf,
      parentOf: self.parentOf,
      issues: self.issues,
      error: self.error,
      twinWarning: twinHits.length
        ? `A near-duplicate SKU exists (differs only by a trailing "."): ${twinHits.map((t) => `${t.sku} [${t.status}, ${t.units ?? "?"} units]`).join("; ")}. Confirm which one is the real, stocked listing before building.`
        : null,
      twins: twinHits,
    };
  });
}

// ===========================================================================
// STATUS — read the family tree (parent + its children) live
// ===========================================================================
async function statusCheck(parentSku, extraSkus = []) {
  const skus = [...new Set([parentSku, ...extraSkus].filter(Boolean))];
  const rows = [];
  for (const sku of skus) {
    const l = await getListing(sku);
    rows.push(l);
    // auto-expand: if the parent reports children we weren't given, include them
    if (l.exists && l.parentOf?.length) {
      for (const c of l.parentOf) {
        if (!skus.includes(c) && !rows.find((r) => r.sku === c)) rows.push(await getListing(c));
      }
    }
  }
  return rows;
}

// ===========================================================================
// BUILD — clone parent from a donor child, attach children. Dry-run by default.
// ===========================================================================
const STRIP_FROM_PARENT = [
  "purchasable_offer", "fulfillment_availability", "list_price",
  "merchant_suggested_asin", "externally_assigned_product_identifier", "size",
];

async function getDonorAttributes(donorSku) {
  const donor = await sp("GET", `/listings/2021-08-01/items/${SELLER_ID}/${encodeURIComponent(donorSku)}`, {
    query: { marketplaceIds: MARKETPLACE_ID, includedData: "attributes" },
  });
  return donor.attributes || {};
}

function buildParentAttributes(donorAttrs, { theme, parentTitle, countryOfOrigin }) {
  const attrs = structuredClone(donorAttrs);
  for (const key of STRIP_FROM_PARENT) delete attrs[key];
  if (parentTitle) attrs.item_name = v(parentTitle);
  attrs.parentage_level = v("parent");
  attrs.variation_theme = [{ name: theme, marketplace_id: MARKETPLACE_ID }];
  if (countryOfOrigin && !attrs.country_of_origin) attrs.country_of_origin = v(countryOfOrigin);
  return attrs;
}

function childOfferPatches(child, donorFulfillment, { parentSku, theme, conditionType, themeAttr }) {
  return [
    { op: "add", path: "/attributes/merchant_suggested_asin", value: v(child.asin) },
    { op: "add", path: "/attributes/condition_type", value: v(conditionType) },
    { op: "add", path: "/attributes/number_of_items", value: [{ value: 1, marketplace_id: MARKETPLACE_ID }] },
    { op: "add", path: "/attributes/list_price", value: [{ currency: "USD", value: child.price, marketplace_id: MARKETPLACE_ID }] },
    { op: "add", path: "/attributes/purchasable_offer", value: [{ currency: "USD", our_price: [{ schedule: [{ value_with_tax: child.price }] }], marketplace_id: MARKETPLACE_ID }] },
    { op: "add", path: "/attributes/fulfillment_availability", value: donorFulfillment },
    { op: "add", path: "/attributes/parentage_level", value: v("child") },
    { op: "add", path: "/attributes/child_parent_sku_relationship", value: [{ child_relationship_type: "variation", parent_sku: parentSku, marketplace_id: MARKETPLACE_ID }] },
    { op: "add", path: "/attributes/variation_theme", value: [{ name: theme, marketplace_id: MARKETPLACE_ID }] },
    { op: "add", path: `/attributes/${themeAttr}`, value: v(child.size) },
  ];
}

async function build(opts) {
  const {
    parentSku, theme, donorSku, parentTitle = "", countryOfOrigin = "",
    conditionType = "new_new", children = [], commit = false,
    productType: ptOverride,
  } = opts;

  const log = [];
  const donorAsin = (children.find((c) => c.sku === donorSku) || {}).asin || children[0]?.asin;
  const productType = ptOverride || (await discover(donorAsin)).productType;
  // theme attribute key: SIZE -> "size", COLOR -> "color", etc.
  const themeAttr = (theme || "").toLowerCase();

  const donorAttrs = await getDonorAttributes(donorSku);
  const parentAttrs = buildParentAttributes(donorAttrs, { theme, parentTitle, countryOfOrigin });
  const parentBody = { productType, requirements: "LISTING", attributes: parentAttrs };

  // STEP 1 — parent
  if (commit) {
    const res = await sp("PUT", `/listings/2021-08-01/items/${SELLER_ID}/${encodeURIComponent(parentSku)}`,
      { query: { marketplaceIds: MARKETPLACE_ID }, body: parentBody });
    log.push({ step: "parent", sku: parentSku, status: res.status, issues: res.issues || [] });
  } else {
    log.push({ step: "parent", sku: parentSku, dryRun: true, attributeKeys: Object.keys(parentAttrs) });
  }

  // STEP 2 — children
  const donorFulfillment = donorAttrs.fulfillment_availability;
  for (const child of children) {
    if (child.sku === donorSku && (child.price == null || child.price === "")) {
      log.push({ step: "child", sku: child.sku, note: "donor — left untouched" });
      continue;
    }
    const body = { productType, patches: childOfferPatches(child, donorFulfillment, { parentSku, theme, conditionType, themeAttr }) };
    if (commit) {
      const res = await sp("PATCH", `/listings/2021-08-01/items/${SELLER_ID}/${encodeURIComponent(child.sku)}`,
        { query: { marketplaceIds: MARKETPLACE_ID }, body });
      log.push({ step: "child", sku: child.sku, size: child.size, price: child.price, status: res.status, issues: res.issues || [] });
    } else {
      log.push({ step: "child", sku: child.sku, dryRun: true, size: child.size, price: child.price, note: "match + offer; FBA cloned from donor" });
    }
  }
  return { commit, productType, theme, log };
}

// ===========================================================================
// MODIFY FAMILY — add/remove children on an EXISTING parent (no parent PUT)
// ===========================================================================
function childJoinPatches(child, { parentSku, theme, themeAttr }) {
  const p = [
    { op: "add", path: "/attributes/parentage_level", value: v("child") },
    { op: "add", path: "/attributes/child_parent_sku_relationship", value: [{ child_relationship_type: "variation", parent_sku: parentSku, marketplace_id: MARKETPLACE_ID }] },
    { op: "add", path: "/attributes/variation_theme", value: [{ name: theme, marketplace_id: MARKETPLACE_ID }] },
  ];
  if (themeAttr && child.size) p.push({ op: "add", path: `/attributes/${themeAttr}`, value: v(child.size) });
  return p;
}
function childDetachPatches() {
  return [
    { op: "delete", path: "/attributes/child_parent_sku_relationship" },
    { op: "delete", path: "/attributes/parentage_level" },
    { op: "delete", path: "/attributes/variation_theme" },
  ];
}
async function modifyFamily(opts) {
  const { action, parentSku = "", theme = "", children = [], commit = false } = opts;
  if (action !== "add" && action !== "remove") throw new Error('action must be "add" or "remove"');
  const themeAttr = (theme || "").toLowerCase();
  const log = [];
  for (const child of children) {
    const info = await getListing(child.sku);
    if (!info.exists) { log.push({ sku: child.sku, action, error: "listing not found" }); continue; }
    if (!info.productType) { log.push({ sku: child.sku, action, error: "could not resolve product type" }); continue; }
    const patches = action === "add"
      ? childJoinPatches(child, { parentSku, theme, themeAttr })
      : childDetachPatches();
    const body = { productType: info.productType, patches };
    if (commit) {
      const res = await sp("PATCH", `/listings/2021-08-01/items/${SELLER_ID}/${encodeURIComponent(child.sku)}`,
        { query: { marketplaceIds: MARKETPLACE_ID }, body });
      log.push({ sku: child.sku, action, status: res.status, issues: res.issues || [] });
    } else {
      log.push({ sku: child.sku, action, dryRun: true, patches: patches.map((x) => x.op + " " + x.path) });
    }
  }
  return { action, commit, parentSku, theme, log };
}

// ===========================================================================
// LIST FAMILIES — page all listings, return every parent + its children
// ===========================================================================
async function listFamilies() {
  const families = [];
  let token = null;
  for (let page = 0; page < 30; page++) {
    const query = { marketplaceIds: MARKETPLACE_ID, includedData: "summaries,relationships", pageSize: "20" };
    if (token) query.pageToken = token;
    const res = await sp("GET", `/listings/2021-08-01/items/${SELLER_ID}`, { query });
    for (const it of res.items || []) {
      const rels = it.relationships?.[0]?.relationships || [];
      const childSkus = rels.flatMap((r) => r.childSkus || []);
      if (!childSkus.length) continue;
      const theme = rels.map((r) => r.variationTheme?.theme).filter(Boolean)[0] || null;
      const sm = it.summaries?.[0] || {};
      families.push({ parentSku: it.sku, asin: sm.asin || null, status: (sm.status || []).join(", ") || null, theme, childCount: childSkus.length, childSkus });
    }
    token = res.pagination?.nextToken;
    if (!token) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  families.sort((a, b) => a.parentSku.localeCompare(b.parentSku));
  return families;
}

// ===========================================================================
// APP — Basic Auth gate, then routes, then static UI
// ===========================================================================
const app = express();
app.use(express.json({ limit: "1mb" }));

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
app.use((req, res, next) => {
  const hdr = req.headers.authorization || "";
  const [scheme, encoded] = hdr.split(" ");
  if (scheme === "Basic" && encoded) {
    const [u, p] = Buffer.from(encoded, "base64").toString("utf8").split(/:(.*)/s);
    if (safeEqual(u, APP_USER) && safeEqual(p, APP_PASS)) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="fba-variations", charset="UTF-8"');
  return res.status(401).send("Authentication required.");
});

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
};

app.get("/api/health", (req, res) => res.json({ ok: true, sellerId: SELLER_ID, marketplace: MARKETPLACE_ID }));
app.post("/api/discover",  wrap(async (req) => discover(req.body.asin)));
app.post("/api/preflight", wrap(async (req) => ({ rows: await preflight(req.body.skus || []) })));
app.post("/api/status",    wrap(async (req) => ({ rows: await statusCheck(req.body.parentSku, req.body.childSkus || []) })));
app.post("/api/build",     wrap(async (req) => build(req.body || {})));
app.post("/api/modify",    wrap(async (req) => modifyFamily(req.body || {})));
app.get("/api/families",   wrap(async () => ({ families: await listFamilies() })));

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, "127.0.0.1", () => {
  console.log(`fba-variations listening on 127.0.0.1:${PORT}  (seller ${SELLER_ID}, ${MARKETPLACE_ID})`);
});
