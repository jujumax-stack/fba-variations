# CLAUDE.md — fba-variations

Guidance for Claude Code (and humans) working in this repo.

## What this is
Two-page internal tool for managing Amazon listings via SP-API (`listings/2021-08-01`)
for 31337 LLC. Single Node/Express app, no build step.
- `server.js` — all backend (SP-API auth + helpers, build/modify/reset, cached catalog index, search, listing editor).
- `public/index.html` — **Variation Builder** page.
- `public/editor.html` — **Listing Editor** page.

Live: https://variations.flechanegra.co (HTTP Basic auth). Marketplace US (ATVPDKIKX0DER).

## Where it runs
- Server: DigitalOcean `165.245.174.58`, path `/root/projects/fba-variations/`, PM2 process `fba-variations`, port **3008**, behind nginx + Let's Encrypt.
- Deploy IS this repo on the box. Edit files here, then:
  ```
  node --check server.js            # always syntax-check first
  pm2 restart fba-variations
  ```
- After restart, the cached catalog index rebuilds on first /api/families or /api/search (~20s for ~380 listings; cached 5 min).

## Secrets — NEVER commit
- `.env` holds APP_USER/APP_PASS (login gate) and SP-API creds (LWA_* + SELLER_ID). It is gitignored and lives ONLY on the server.
- App refuses to start if APP_USER/APP_PASS are unset.
- Editor swap files (`*.swp`) are gitignored too — don't commit them.

## Hard rules (carried over from how this was built)
1. **Dry-run before any live write.** Every mutating endpoint (`/api/build`, `/api/modify`, `/api/reset`, `/api/update`) takes `commit:false` (default) and only writes when `commit:true`. The UIs lock the live button until a successful dry-run/Review.
2. **Re-read a file before editing it**; after an edit, prior views are stale. No stacking 3+ blind patches on a broken file — if syntax breaks, `git checkout` the last good commit and redo cleanly.
3. **Parent SKU is always `<donorSku>-Parent`; parent title is always `<donor title> Parent`.** This prevents Amazon error 8031 (a SKU being both parent and child). `STRIP_FROM_PARENT` also removes `child_parent_sku_relationship`/`parentage_level` from the donor clone for the same reason.
4. **Dry-run/Review validates STRUCTURE, not VALUES.** Bad attribute values (wrong enum/format) only surface in the live response — handle and resubmit.
5. **After any change: commit + push to GitHub AND update docs.** This is a standing instruction.

## Deploy / git loop
```
# edit files...
node --check server.js
git add -A && git commit -m "..." && git push      # remote: jujumax-stack/fba-variations (deploy key)
pm2 restart fba-variations
# verify: curl -s -u admin:*** https://variations.flechanegra.co/api/health
```
Docs to update after changes: this repo's `README.md`, and on the server
`/root/DO_INFRASTRUCTURE.md` (Project 8 section + rev) and `/root/DO_CHANGELOG.md`
(newest entry on top; back up both before editing).

## Endpoints (all behind Basic Auth)
- GET  `/api/health`
- POST `/api/discover` {asin} — product type + valid themes
- POST `/api/preflight` {skus[]} — status, FBA units, trailing-period twin-SKU warnings
- POST `/api/status` {parentSku, childSkus?} — live family tree
- POST `/api/build` {theme, donorSku, countryOfOrigin, conditionType, children[], commit} — parent SKU+title auto-derived from donor
- POST `/api/modify` {action:add|remove, parentSku, theme, children[], commit}
- POST `/api/reset` {sku?, asin?, includeRelated?, commit} — strip parentage -> standalone (fix 8031/8066)
- GET  `/api/families` — every parent + children (cached index)
- GET  `/api/search?q=` — families containing an ASIN/SKU/partial match
- GET  `/api/find?q=` — flat matched items (editor picker)
- GET  `/api/item?sku=` — full attributes for one listing
- POST `/api/update` {sku, patches[], commit} — apply diff JSON-patches (editor)

## Architecture notes
- `getIndex()` pages every listing once into `sku -> {asin,status,theme,childSkus,parentSkus}`, cached `INDEX_TTL` (5 min). Shared by families/search/find/reset.
- Image URLs are already in attributes (`main_product_image_locator`, `other_product_image_locator_1..8` -> `[0].media_location`); the editor renders them directly, no extra call.
- Likely next refactor: split `server.js` into `lib/` (sp-api, index, build, editor) + `routes/`, mirroring the amazon-seller app's modular layout.
