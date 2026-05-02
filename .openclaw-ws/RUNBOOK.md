# RUNBOOK.md - ai-sister operations

Day-to-day procedures + known gotchas. Pair with TOOLS.md (what) + SCHEMA.md (data layout).

## Standard deploy (after `git push origin main` from Ted's box)

```bash
cd ~/Multi-Ai-Chatapp
git fetch && git reset --hard origin/main
cd server && npm install && npm run build
cd ../web && npm install && npm run build
sudo systemctl restart multi-ai-chatapp-prod multi-ai-chatapp-dev
sleep 3
curl -s http://127.0.0.1:3001/api/health   # → {"ok":true}
curl -s http://127.0.0.1:3002/api/health
```

## Service health

- Status: `sudo systemctl status multi-ai-chatapp-prod --no-pager`
- Tail logs: `sudo journalctl -u multi-ai-chatapp-prod -f`
- Last 50: `sudo journalctl -u multi-ai-chatapp-prod -n 50 --no-pager`
- Active check: `sudo systemctl is-active multi-ai-chatapp-prod multi-ai-chatapp-dev`

## Backups

- Timer: `sudo systemctl list-timers | grep multi-ai`
- Last run: `sudo journalctl -u multi-ai-chatapp-backup -n 20 --no-pager`
- Manual ad-hoc DB snapshot before risky ops:
  `cp ~/Multi-Ai-Chatapp/server/data-prod/app.db ~/Multi-Ai-Chatapp/server/data-prod/app.db.bak.$(date +%Y%m%d-%H%M%S)`

## DB inspection (sqlite3 on host)

```bash
DB=~/Multi-Ai-Chatapp/server/data-prod/app.db
sqlite3 $DB 'SELECT COUNT(*) FROM users WHERE disabled_at IS NULL'
sqlite3 $DB 'SELECT id, category, title, comment_count, nsfw FROM forum_posts ORDER BY id DESC LIMIT 10'
sqlite3 $DB '.schema forum_post_replies'
sqlite3 $DB 'PRAGMA user_version'   # current migration version
```

## Caddy

- Config: `/etc/caddy/Caddyfile` (read-only for this agent — main owns it)
- Validate before reload: `sudo caddy validate --config /etc/caddy/Caddyfile`
- Reload: `sudo systemctl reload caddy`

## DNS lookup (this host has no `dig` / `nslookup` / `file` installed)

Use Cloudflare DoH JSON:

```bash
curl -s 'https://1.1.1.1/dns-query?name=ai-sister.com&type=TXT' \
  -H 'accept: application/dns-json' | python3 -m json.tool
```

## Known gotchas + fixes

| Symptom | Cause | Fix |
|---|---|---|
| `ERR_DLOPEN_FAILED`, `NODE_MODULE_VERSION 115 vs 127` on service start | Host Node bumped (e.g. 20→22), better-sqlite3 native binding stale | `cd ~/Multi-Ai-Chatapp/server && npm rebuild` then restart services |
| Admin "delete user" returns 500 with `SQLITE_CONSTRAINT_NOTNULL: audit_log.admin_user_id` | (Pre-v6 migration only) audit_log column was `NOT NULL ... ON DELETE SET NULL` — internally inconsistent | Already fixed in db.ts migration v6 (`PRAGMA user_version=6`); shouldn't recur. If it does, check migration ran. |
| Mobile chat session "freezes" after backgrounding tab | iOS Safari kills SSE silently — fetch reader hangs, no error fires | App.tsx has a `visibilitychange` listener that auto-reloads on tab return + raises connection-lost banner. If still happens, check that handler is still wired. |
| Per-AI message header on resumed session shows no model name | Session-load mapping was dropping `answeredModel` / `requestedModel` / `answeredStage` | Already fixed in App.tsx `handleSelectSession` + `reloadActiveSession`. |
| 重試 button on chat does nothing while orchestrator is mid-flow | `handleRegenerate` used to silent-return when isProcessing=true | Now auto-cancels in-flight workflow then runs retry; should always respond. |
| Forum post body shows overlapping paragraphs at narrow widths | `line-clamp-[N]` interacts badly with multi-paragraph markdown | CollapsiblePostBody now uses `max-h + bg-gradient fade` instead. |
| TopNav text characters stack vertically on iPhone | flex children without `whitespace-nowrap` | Already fixed — Admin/tier badge hide below sm:; core nav has nowrap. |
| FB / X / Threads share preview shows old title or no image | Social cache hasn't re-scraped | https://developers.facebook.com/tools/debug/ — paste URL, click "Scrape Again". X / Threads have their own debuggers. |
| NSFW post visible to social-media bots | OG injector skips NSFW posts intentionally; site-wide defaults serve | Working as designed. To preview: nuke `forum_posts.nsfw` flag for test. |

## Email

- Outbound: Resend SMTP, `hello@ai-sister.com`. SMTP_PASSWORD lives in `server/.env.prod` and `.env.dev` (Resend API key).
- Verify SMTP from server with a tiny Node script using `--env-file=.env.prod` (see `server/src/scripts/` for examples or write inline).
- Inbound: Porkbun forwarding, `hello@` / `support@` → `ted@ted-h.com`. Apex MX records point to Porkbun fwd1/fwd2; outbound MX is on the `send.ai-sister.com` subdomain (independent — touching one doesn't break the other).

## Forum post import (legacy MD exports)

Script: `scripts/import_md_to_forum.py` (Python 3, sqlite3 stdlib).

```bash
python3 ~/Multi-Ai-Chatapp/scripts/import_md_to_forum.py \
  --db ~/Multi-Ai-Chatapp/server/data-prod/app.db \
  --user-id 1 --md-dir <dir-with-md-files> \
  --dry-run    # preview parse
# remove --dry-run + add --commit when happy
```

The `IMPORTS` list inside the script is hand-written (title + category + exported_at per file). Edit before running.

## Forum post export

Per-post UI: any logged-in viewer hits "⬇ 匯出 MD" on post detail → browser downloads `<title-slug>-<id>.md`. Mirrors import format so round-trips work.

## When something is on fire

1. Check service status (commands above).
2. Tail journal for the failing service.
3. If DB write failed: `sqlite3 $DB 'PRAGMA integrity_check'`.
4. If still down: revert last deploy → `cd ~/Multi-Ai-Chatapp && git reset --hard HEAD~1 && (rebuild) && systemctl restart …`. Ted's main session is best for picking the commit; agent should report and ask.
5. Last-resort DB rollback: pick latest `app.db.bak.*` from prod data dir and restore. Always confirm with Ted first — this drops user data written between the snapshot and now.
