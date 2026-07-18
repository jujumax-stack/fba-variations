# SESSION-CONTINUITY — fba-variations

> How to resume a Claude session for THIS project. Chat history + per-directory memory do NOT
> persist across sessions or machines; **files in git do.** This is the durable bootstrap.

## This project
- Server path: `/root/projects/fba-variations` · Port: **3008** · URL: variations.flechanegra.co
- Stack: Node · SP-API variations/family tooling
- In-repo docs: CLAUDE, README
- GitHub: `git@github-fba-variations:jujumax-stack/fba-variations.git`

## The droplet (shared)
- Server **165.245.174.58** (`ssh root@165.245.174.58`, key auth). Ubuntu 24.04 · 1 vCPU / **2 GB RAM** — memory-bound.
- Every app uses embedded **SQLite** (better-sqlite3), one `.db` each — no shared DB daemon (would OOM the box).
- **PM2 + nginx + Let's Encrypt.** Each app = a port + subdomain.
- **Secrets live ONLY in server `.env`** (chmod 600, gitignored) — never commit them, never copy to a Mac clone.
- Before any infra change read — and after, update — `/root/DO_INFRASTRUCTURE.md` + `/root/DO_CHANGELOG.md`.

## Full cross-project bootstrap (canonical, on GitHub)
- **`ads-connector`** repo → `SESSION-CONTINUITY.md` + `droplet-docs/DO_INFRASTRUCTURE.md` (sanitized):
  the full droplet map + index of **every** project. (`git@github-ads-connector:jujumax-stack/ads-connector.git`)

## Coding rules (inherited, non-negotiable)
1. `git commit` checkpoint at session start. 2. Re-read files before every edit.
3. `node --check` before any pm2 restart. 4. Verify against ground truth (live API/DB/console) before "done".
5. Never commit secrets. 6. Amazon API: a 2xx/207 write ≠ applied — read back; a report ≠ live state.

_Generated 2026-07-18 by the cross-project continuity pass._
