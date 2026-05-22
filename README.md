# fba-variations

Web tool to build and manage Amazon **variation families** (parent + N children, any theme)
for 31337 LLC via the Selling Partner API. Ported from the `amazon-variation-builder` CLI.

- **Live URL:** https://variations.flechanegra.co
- **Auth:** HTTP Basic (login prompt). Credentials in `.env` (`APP_USER` / `APP_PASS`). App refuses to start if either is unset.
- **Server:** DO 165.245.174.58 - PM2 `fba-variations` (port 3008, fork) - `/root/projects/fba-variations/`
- **Mac source:** `~/Desktop/fba-variations/`

## Stack
- Node + Express + dotenv. No build step.
- `server.js` - API + SP-API logic. `public/index.html` - single-page UI (vanilla JS, no deps).
- `.env` - secrets (gitignored, server only).

## Environment (.env)
    APP_USER=admin
    APP_PASS=<set a fresh value; never commit>
    LWA_CLIENT_ID=...        # copied from amazon-seller
    LWA_CLIENT_SECRET=...
    LWA_REFRESH_TOKEN=...
    SELLER_ID=...
    MARKETPLACE_ID=ATVPDKIKX0DER
    REGION_HOST=https://sellingpartnerapi-na.amazon.com
    PORT=3008

## API endpoints (all behind Basic Auth)
- GET  /api/health - seller id + marketplace (sanity check)
- POST /api/discover {asin} - product type + valid variation themes
- POST /api/preflight {skus:[]} - per-SKU status, FBA units, trailing-period twin-SKU warnings
- POST /api/status {parentSku, childSkus?} - live family tree (auto-expands parent's children)
- POST /api/build {parentSku, theme, donorSku, countryOfOrigin, conditionType, parentTitle, children:[{sku,asin,size,price}], commit} - create parent (cloned from donor) + attach children. commit:false = dry-run (reads only).
- POST /api/modify {action:"add"|"remove", parentSku, theme, children:[{sku,size}], commit} - add/remove children on an existing parent. Add = minimal variation-join patch; Remove = JSON-patch delete of relationship/parentage/theme (listing + inventory kept).
- GET  /api/families - pages all listings; returns every parent {parentSku, asin, status, theme, childCount, childSkus}

## UI workflow
1. Families (top): Load all families -> list every parent -> "Edit children" loads one into the form.
2. Family definition: parent SKU, theme, donor SKU, country of origin, condition, child rows (any number).
3. Discover: confirm product type + that the theme is valid.
4. Pre-flight: catch duplicate/trailing-period SKUs + see FBA units before building.
5. Execute: Dry-run (sends nothing; unlocks Build) -> Build (live) (confirm dialog).
6. Modify existing family: Add / Remove children on an existing parent (own dry-run + confirm).
7. Status: live family tree + issues.

## Safety model
- Dry-run is the default everywhere; live writes require an explicit action.
- Build and Modify-apply stay LOCKED until a successful dry-run, then require a confirm dialog; editing any field re-locks them.
- Remove is a non-destructive DETACH (listing + FBA inventory preserved; reversible by Add).

## Deploy
    # edit ~/Desktop/fba-variations/ on the Mac, then:
    scp server.js public/index.html root@165.245.174.58:/root/projects/fba-variations/<paths>
    ssh root@165.245.174.58 'cd /root/projects/fba-variations && node --check server.js && pm2 restart fba-variations'
.env lives only on the server and is never committed.
nginx: /etc/nginx/sites-available/variations.flechanegra.co -> :3008. SSL via certbot (auto-renew).

## Known limitations
- Theme->attribute mapping is single-theme (SIZE->size, COLOR->color). Compound themes (e.g. COLOR/SIZE) work for Status/Remove but Add needs manual handling.
- Dry-run validates request STRUCTURE, not attribute VALUES - invalid values (e.g. an unaccepted color) surface only in the live response.
- Image-policy errors (e.g. 100238) are pre-existing listing-content issues; they do not block variation changes.
- Variation changes can take minutes to a few hours to propagate to the detail page.

## Version history
- v1.0 - build a family (discover, preflight, dry-run, build, status)
- v1.1 - add/remove children on an existing parent (/api/modify)
- v1.2 - families browser (/api/families) + Edit-children loader
