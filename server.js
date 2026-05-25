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
  // never let a parent inherit child-link/parentage from the donor clone (avoids 8031)
  "child_parent_sku_relationship", "parentage_level",
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

  // RULE: parent SKU is always donor SKU + "-Parent" (guarantees it can never
  // collide with a child SKU -> avoids error 8031). A non-derived parentSku
  // passed in is ignored in favor of this rule.
  const effectiveParentSku = `${donorSku}-Parent`;

  // RULE: parent title is always the donor's title + " Parent".
  const donorTitle = donorAttrs.item_name?.[0]?.value || "";
  const effectiveParentTitle = donorTitle ? `${donorTitle} Parent` : (parentTitle || "");

  const parentAttrs = buildParentAttributes(donorAttrs, { theme, parentTitle: effectiveParentTitle, countryOfOrigin });
  const parentBody = { productType, requirements: "LISTING", attributes: parentAttrs };

  // STEP 1 — parent
  if (commit) {
    const res = await sp("PUT", `/listings/2021-08-01/items/${SELLER_ID}/${encodeURIComponent(effectiveParentSku)}`,
      { query: { marketplaceIds: MARKETPLACE_ID }, body: parentBody });
    log.push({ step: "parent", sku: effectiveParentSku, parentTitle: effectiveParentTitle, status: res.status, issues: res.issues || [] });
  } else {
    log.push({ step: "parent", sku: effectiveParentSku, parentTitle: effectiveParentTitle, dryRun: true, attributeKeys: Object.keys(parentAttrs) });
  }

  // STEP 2 — children
  const donorFulfillment = donorAttrs.fulfillment_availability;
  for (const child of children) {
    if (child.sku === donorSku && (child.price == null || child.price === "")) {
      log.push({ step: "child", sku: child.sku, note: "donor — left untouched" });
      continue;
    }
    const body = { productType, patches: childOfferPatches(child, donorFulfillment, { parentSku: effectiveParentSku, theme, conditionType, themeAttr }) };
    if (commit) {
      const res = await sp("PATCH", `/listings/2021-08-01/items/${SELLER_ID}/${encodeURIComponent(child.sku)}`,
        { query: { marketplaceIds: MARKETPLACE_ID }, body });
      log.push({ step: "child", sku: child.sku, size: child.size, price: child.price, status: res.status, issues: res.issues || [] });
    } else {
      log.push({ step: "child", sku: child.sku, dryRun: true, size: child.size, price: child.price, note: "match + offer; FBA cloned from donor" });
    }
  }
  return { commit, productType, theme, parentSku: effectiveParentSku, parentTitle: effectiveParentTitle, log };
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
// RESET PARENTAGE — strip all parent/child attributes off a SKU/ASIN so it
// becomes a clean standalone listing again. Fixes 8031 (SKU is both parent &
// child) and 8066 (broken parentage). Then the family can be rebuilt fresh.
// Only deletes attributes that are actually PRESENT (safe on broken listings).
// ===========================================================================
const PARENTAGE_ATTRS = ["child_parent_sku_relationship", "parentage_level", "variation_theme"];

async function getItemFull(sku) {
  const res = await sp("GET", `/listings/2021-08-01/items/${SELLER_ID}/${encodeURIComponent(sku)}`, {
    query: { marketplaceIds: MARKETPLACE_ID, includedData: "summaries,attributes,relationships" },
  });
  const sm = res.summaries?.[0] || {};
  const rels = res.relationships?.[0]?.relationships || [];
  return {
    sku, exists: true,
    asin: sm.asin || null,
    productType: sm.productType || null,
    status: (sm.status || []).join(", ") || null,
    attributes: res.attributes || {},
    childSkus: rels.flatMap((r) => r.childSkus || []),
    parentSkus: rels.flatMap((r) => r.parentSkus || []),
  };
}

async function resetParentage(opts) {
  const { sku = "", asin = "", includeRelated = false, commit = false } = opts;
  const idx = await getIndex();

  // resolve target SKUs from sku and/or asin (an ASIN can map to multiple SKUs)
  const targets = new Set();
  if (sku && String(sku).trim()) targets.add(String(sku).trim());
  if (asin && String(asin).trim()) {
    const a = String(asin).trim().toUpperCase();
    for (const it of Object.values(idx)) if ((it.asin || "").toUpperCase() === a) targets.add(it.sku);
  }
  if (!targets.size) return { commit, log: [], note: "No SKU/ASIN given, or ASIN not found in catalog index." };

  // optionally expand to related family members (children of a parent, or the
  // parent + siblings of a child) so an entire broken family can be cleaned.
  if (includeRelated) {
    for (const t of [...targets]) {
      const info = idx[t];
      if (!info) continue;
      for (const c of info.childSkus || []) targets.add(c);
      for (const pSku of info.parentSkus || []) {
        targets.add(pSku);
        for (const sib of idx[pSku]?.childSkus || []) targets.add(sib);
      }
    }
  }

  const log = [];
  for (const t of [...targets]) {
    let item;
    try { item = await getItemFull(t); }
    catch (e) { log.push({ sku: t, error: "fetch failed: " + String(e.message || e) }); continue; }

    const present = PARENTAGE_ATTRS.filter((k) => item.attributes[k] !== undefined);
    const role = item.childSkus.length && item.parentSkus.length ? "parent+child (8031)"
               : item.childSkus.length ? "parent"
               : item.parentSkus.length ? "child"
               : "standalone";

    if (!present.length) {
      log.push({ sku: t, role, note: "no parentage attributes present — already clean", asin: item.asin });
      continue;
    }
    if (!item.productType) { log.push({ sku: t, role, error: "could not resolve product type" }); continue; }

    const patches = present.map((k) => ({ op: "delete", path: `/attributes/${k}` }));
    if (commit) {
      const res = await sp("PATCH", `/listings/2021-08-01/items/${SELLER_ID}/${encodeURIComponent(t)}`,
        { query: { marketplaceIds: MARKETPLACE_ID }, body: { productType: item.productType, patches } });
      log.push({ sku: t, role, asin: item.asin, stripped: present, status: res.status, issues: res.issues || [] });
    } else {
      log.push({ sku: t, role, asin: item.asin, dryRun: true, willStrip: present,
                 relatedChildren: item.childSkus, relatedParents: item.parentSkus });
    }
  }
  return { commit, count: log.length, log };
}

// ===========================================================================
// LIST FAMILIES — page all listings, return every parent + its children
// ===========================================================================
// Page EVERY listing once into an index: sku -> {asin,status,theme,childSkus,parentSkus}.
// Cached briefly so families-list and search share a single catalog scan.
let _index = null, _indexAt = 0;
const INDEX_TTL = 5 * 60 * 1000; // 5 min

async function buildIndex() {
  const bySku = {};
  let token = null;
  for (let page = 0; page < 40; page++) {
    const query = { marketplaceIds: MARKETPLACE_ID, includedData: "summaries,relationships", pageSize: "20" };
    if (token) query.pageToken = token;
    const res = await sp("GET", `/listings/2021-08-01/items/${SELLER_ID}`, { query });
    for (const it of res.items || []) {
      const rels = it.relationships?.[0]?.relationships || [];
      const childSkus = rels.flatMap((r) => r.childSkus || []);
      const parentSkus = rels.flatMap((r) => r.parentSkus || []);
      const theme = rels.map((r) => r.variationTheme?.theme).filter(Boolean)[0] || null;
      const sm = it.summaries?.[0] || {};
      bySku[it.sku] = {
        sku: it.sku,
        asin: sm.asin || null,
        status: (sm.status || []).join(", ") || null,
        theme,
        childSkus,
        parentSkus,
      };
    }
    token = res.pagination?.nextToken;
    if (!token) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return bySku;
}

async function getIndex(force = false) {
  if (!force && _index && Date.now() - _indexAt < INDEX_TTL) return _index;
  _index = await buildIndex();
  _indexAt = Date.now();
  return _index;
}

// Assemble a family object (parent + children with ASINs) from the index.
function familyFromIndex(idx, parentSku) {
  const p = idx[parentSku];
  if (!p) return null;
  const childSkus = p.childSkus || [];
  return {
    parentSku,
    asin: p.asin || null,
    status: p.status || null,
    theme: p.theme || null,
    childCount: childSkus.length,
    childSkus,
    children: childSkus.map((cs) => ({ sku: cs, asin: idx[cs]?.asin || null, status: idx[cs]?.status || null })),
  };
}

async function listFamilies() {
  const idx = await getIndex();
  const families = Object.values(idx)
    .filter((it) => (it.childSkus || []).length)
    .map((it) => familyFromIndex(idx, it.sku))
    .filter(Boolean);
  families.sort((a, b) => a.parentSku.localeCompare(b.parentSku));
  return families;
}

// Search by ASIN, SKU, or partial SKU. Returns every family containing a match,
// plus any matching items that aren't part of a variation family.
async function searchItems(rawTerm) {
  const term = String(rawTerm || "").trim().toUpperCase();
  if (!term) return { term: "", families: [], standalone: [], scanned: 0 };
  const idx = await getIndex();

  const matched = Object.values(idx).filter((it) => {
    const skuHit = it.sku && it.sku.toUpperCase().includes(term);
    const asinHit = it.asin && it.asin.toUpperCase().includes(term);
    return skuHit || asinHit;
  });

  const familyRoots = new Map(); // parentSku -> matchedSkus[]
  const standalone = [];
  for (const it of matched) {
    let root = null;
    if ((it.childSkus || []).length) root = it.sku;            // matched item is itself a parent
    else if ((it.parentSkus || []).length) root = it.parentSkus[0]; // matched item is a child
    if (root && idx[root]) {
      if (!familyRoots.has(root)) familyRoots.set(root, []);
      familyRoots.get(root).push(it.sku);
    } else {
      standalone.push({ sku: it.sku, asin: it.asin, status: it.status });
    }
  }

  const families = [...familyRoots.entries()].map(([root, matchedSkus]) => {
    const fam = familyFromIndex(idx, root);
    if (fam) fam.matchedSkus = [...new Set(matchedSkus)];
    return fam;
  }).filter(Boolean);
  families.sort((a, b) => a.parentSku.localeCompare(b.parentSku));

  return { term: rawTerm, families, standalone, scanned: Object.keys(idx).length };
}

// ===========================================================================
// LISTING EDITOR — flat item search + fetch full attributes + apply edits
// ===========================================================================
// Flat list of items whose SKU or ASIN matches (for the editor's picker).
async function findItems(rawTerm) {
  const term = String(rawTerm || "").trim().toUpperCase();
  if (!term) return { term: "", items: [], scanned: 0 };
  const idx = await getIndex();
  const items = Object.values(idx)
    .filter((it) => (it.sku && it.sku.toUpperCase().includes(term)) || (it.asin && it.asin.toUpperCase().includes(term)))
    .map((it) => ({
      sku: it.sku, asin: it.asin, status: it.status,
      role: it.childSkus.length && it.parentSkus.length ? "parent+child"
          : it.childSkus.length ? "parent"
          : it.parentSkus.length ? "child" : "standalone",
    }))
    .sort((a, b) => a.sku.localeCompare(b.sku));
  return { term: rawTerm, items, scanned: Object.keys(idx).length };
}

// Apply caller-built JSON-Patch edits to one listing. Dry-run by default —
// the frontend computes the diff; backend just resolves productType and relays.
async function updateListing(opts) {
  const { sku = "", patches = [], commit = false } = opts;
  if (!sku) throw new Error("sku is required");
  if (!Array.isArray(patches) || !patches.length) throw new Error("no changes to submit");
  const item = await getItemFull(sku);
  if (!item.exists) throw new Error("listing not found: " + sku);
  if (!item.productType) throw new Error("could not resolve product type for " + sku);
  if (!commit) return { sku, commit: false, productType: item.productType, patchCount: patches.length, patches };
  const res = await sp("PATCH", `/listings/2021-08-01/items/${SELLER_ID}/${encodeURIComponent(sku)}`,
    { query: { marketplaceIds: MARKETPLACE_ID }, body: { productType: item.productType, patches } });
  return { sku, commit: true, productType: item.productType, status: res.status, issues: res.issues || [], patchCount: patches.length };
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
app.get("/api/families",   wrap(async (req) => ({ families: await listFamilies() })));
app.get("/api/search",     wrap(async (req) => searchItems(req.query.q)));
app.post("/api/reset",     wrap(async (req) => resetParentage(req.body || {})));
app.get("/api/find",       wrap(async (req) => findItems(req.query.q)));
app.get("/api/item",       wrap(async (req) => getItemFull(req.query.sku)));
app.post("/api/update",    wrap(async (req) => updateListing(req.body || {})));

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, "127.0.0.1", () => {
  console.log(`fba-variations listening on 127.0.0.1:${PORT}  (seller ${SELLER_ID}, ${MARKETPLACE_ID})`);
});
