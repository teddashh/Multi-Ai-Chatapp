# TOOLS.md - ai-sister (Multi-AI Chatapp)

## Project root
`/home/ubuntu/Multi-Ai-Chatapp/` (parent of this workspace)

## Repo
`git@github.com:teddashh/Multi-Ai-Chatapp.git` (private, SSH)

## Stack
- Backend: Node **22** (host upgraded 2026-05-02 from Node 20) + Hono + TypeScript → `server/dist/index.js`
- Frontend: React 18 + Vite + Tailwind + TypeScript
- Storage: better-sqlite3 (NATIVE — `npm rebuild` REQUIRED after any host Node version bump)
- Auth: JWT cookie (30 days), bcrypt
- Email outbound: Resend SMTP (`hello@ai-sister.com`); inbound: Porkbun forwarding → ted@ted-h.com
- Backend shells out to host CLIs: `claude`, `codex`, `gemini`, plus Grok via xAI API

## Layout
- `server/` — Hono backend
  - `src/routes/` — auth, chat, sessions, admin, forum
  - `src/lib/` — db (schema + statements), auth (JWT/bcrypt), uploads, mail, audit
  - `src/shared/` — types, models, prices, aiProfiles
  - `src/scripts/` — backup, migration helpers
  - `data-prod/` — PROD database files (NEVER overwrite from local or dev)
  - `data-dev/` — dev database files
  - `data-{prod,dev}/uploads/{_avatars,_forum-media,_pending}/` — files-on-disk
  - `dist/` — built JS (`npm run build`)
- `web/` — React frontend → `web/dist/` (built, served by backend or Vite dev)
- `web/public/themes/` — bg images for seasonal + per-AI themes
- `scripts/` — setup/systemd helpers + `import_md_to_forum.py`
- `setup.sh`, `Caddyfile.example`, `README.md`

## systemd services (host-level, owned by main but you operate them)
- prod: `multi-ai-chatapp-prod.service` (port 3001) — reads `data-prod/`
- dev: `multi-ai-chatapp-dev.service` (port 3002) — reads `data-dev/`
- backup: `multi-ai-chatapp-backup.timer` (every 30 min)
- Restart: `sudo systemctl restart multi-ai-chatapp-prod` (or `-dev`)
- Logs: `sudo journalctl -u multi-ai-chatapp-prod -f`

## npm scripts
- Server: `npm run dev` (tsx watch), `npm run build` (tsc), `npm start` (node dist)
- Web: `npm run dev` (Vite), `npm run build` (tsc -b && vite build)
- User admin: `npm run user:add -- <user> <pass> <tier>`, `user:list`, `user:delete`
- Other: `backup:oracle`, `models:test`, `grok:search-test`

## Domains (read-only — main owns Caddyfile)
- ai-sister.com → reverse_proxy 127.0.0.1:3001 (prod, canonical)
- www.ai-sister.com → 301 → ai-sister.com
- chat.ted-h.com → 301 → ai-sister.com (legacy redirect)
- sisters.ted-h.com → reverse_proxy 127.0.0.1:3002 (dev, X-Robots-Tag: noindex)

## SPA routes
- `/` — LandingPage (public marketing; logged-in users see 聊天室 nav)
- `/chat` — chat UI (was `/` pre-2026-04-30)
- `/forum`, `/forum/cat/<cat>`, `/forum/post/<id>`, `/forum/user/<username|provider>`, `/forum/mode/<chatMode>`
- `/terms`, `/privacy`, `/data-deletion` — bilingual legal docs
- `/admin` — admin panel (tier=admin only)
- `/?verify=<token>`, `/?reset=<token>` — email-link landings

## Forum module
- Source: `server/src/routes/forum.ts` (~1100 lines), schema + stmts in `server/src/lib/db.ts`
- Endpoints: GET / (list, optionalAuth), /bulk, /:postId; POST /share, /:postId/comments, /comments/:id/replies, /posts/:id/replies, /posts/:id/share-summary, /posts/:id/media; DELETE replies + media
- Vote-as-share: re-sharing same source_session_id appends new messages as comments instead of duplicate post
- NSFW gate: `forum_posts.nsfw` flag → anon 404 on detail + filtered out of list; logged-in see badge + click-confirm overlay (localStorage 'nsfw-acknowledged')
- Media: polymorphic `forum_media` (post_id XOR ai_provider); thumbnail flag = og:image
- share_summary: per-post curated 2-sentence OG description (author/admin editable, falls back to body excerpt)
- PTT replies on BOTH posts (forum_post_replies) AND comments (forum_comment_replies) — duplicate ±vote downgrades to none
- See SCHEMA.md for the full table layout.

## Chat modes (9 total)
- Multi: Free / Debate (4-step) / Consult (4-step) / Coding (8-step) / Roundtable (5×4)
- Agent (single-AI): Personal / Profession / Reasoning / Image
- Tier-gated models (free/standard/pro/super/admin)

## Themes
- Seasonal: spring (default, sakura pink, bg blurred), summer, fall (autumn maple, blurred), winter
- Per-AI: claude, chatgpt, gemini, grok
- Definitions in `web/src/styles.css`; assets in `web/public/themes/`
- Light family (spring/summer/fall/claude/chatgpt) gets bg-* opacity overrides; dark family (winter/grok/gemini) renders translucent over bg image

## Helper CLIs (also what the product itself uses)
`claude`, `codex`, `gemini` available. Useful for second-opinion code review, fixture generation, debug. **Caveat:** signed in to Ted's paid accounts, billable.

## Critical
- **`server/data-prod/` is real users' data** — chat history, accounts, Forum posts/votes, uploaded media. NEVER overwrite from `data-dev/` or local. Test in dev (port 3002) first.
- After any host Node version change: `cd server && npm rebuild` BEFORE restarting prod service. Skipping = NODE_MODULE_VERSION mismatch crash.
- Backup runs every 30 min via `multi-ai-chatapp-backup.timer`. Verify with `sudo systemctl list-timers | grep multi-ai`.
- See RUNBOOK.md for ops procedures and known gotchas.
