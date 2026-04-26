# Multi-AI Chatapp

Self-hosted webapp version of [multi-ai-chat](https://github.com/teddashh/multi-ai-chat) — orchestrates ChatGPT, Claude, Gemini, and Grok by shelling out to each vendor's official CLI on a server you own. Same five chat modes as the Chrome extension, but accessible from any browser (phone, tablet, desktop).

> **Heads up.** Vendor CLIs use *your* logged-in subscription — running this for multiple unrelated users is generally against each vendor's terms. This project is intended for personal / family use (a small fixed user list).

## Features

- **5 chat modes** — Free / Debate / Consult / Coding (8-step) / Roundtable (5×4) — same prompts as the extension
- **Tier-gated models** — `super` / `standard` / `test` decide which model each provider uses
- **Username + password auth** — bcrypt + JWT cookie, accounts created via CLI
- **SSE streaming** — chunks pipe live from each CLI to the browser
- **Markdown export** — one click downloads the conversation
- **Single-binary deploy** — Hono server + built React UI behind Caddy auto-HTTPS

## Architecture

```
browser  ──HTTPS──>  Caddy  ──reverse-proxy──>  Hono server  ──spawn──>  claude / codex / gemini / grok CLIs
```

- **Server** (Node 20 + Hono + SQLite + bcrypt) at `server/`
- **Web** (Vite + React + Tailwind) at `web/`
- **Static UI is served by the Hono server** in production (built into `web/dist`)
- CLIs are invoked with `child_process.spawn` and stream their stdout back over SSE

## Tier → Model mapping (`server/src/shared/models.ts`)

| Tier      | Claude            | OpenAI         | Gemini                    | Grok                            |
| --------- | ----------------- | -------------- | ------------------------- | ------------------------------- |
| test      | claude-haiku-4-5  | gpt-5.4-mini   | gemini-3-flash-preview    | grok-4-1-fast-reasoning         |
| standard  | claude-sonnet-4-6 | gpt-5.4        | gemini-3.1-pro-preview    | grok-4.20-multi-agent-0309      |
| super     | claude-opus-4-7   | gpt-5.5-pro    | gemini-3.1-pro-preview    | grok-4.20-0309-reasoning        |

Adjust `TIER_MODELS` in that file if vendors release new ones.

## Setup (Oracle ARM Ubuntu 22.04+)

```bash
git clone https://github.com/teddashh/Multi-Ai-Chatapp.git
cd Multi-Ai-Chatapp
chmod +x setup.sh
./setup.sh
```

Then follow the post-script instructions to:

1. Log in to each CLI (`claude`, `codex`, `gemini`, `grok`) — one-time interactive auth flow per vendor
2. Create users:
   ```bash
   cd server
   npm run user:add -- ted    your-pass super
   npm run user:add -- wife   her-pass  standard
   npm run user:add -- dad    his-pass  test
   npm run user:add -- mom    her-pass  test
   ```
3. Edit `Caddyfile.example` → set your domain → copy to `/etc/caddy/Caddyfile` → `sudo systemctl reload caddy`
4. Install the systemd unit: `sudo cp scripts/multi-ai-chatapp.service /etc/systemd/system/` (edit USERNAME/INSTALL_DIR first), then `sudo systemctl enable --now multi-ai-chatapp`
5. Point your domain's DNS A record at the server's public IP

## Local development

Two terminals:

```bash
# Terminal 1 — server
cd server
cp .env.example .env  # then fill in JWT_SECRET
npm install
npm run user:add -- dev devpass super
npm run dev

# Terminal 2 — web
cd web
npm install
npm run dev   # opens http://localhost:5173, proxies /api → :3000
```

The CLIs (claude / codex / gemini / grok) need to be installed and logged in on your dev machine too.

## User management

```bash
cd server
npm run user:add    -- <username> <password> <test|standard|super>
npm run user:list
npm run user:delete -- <username>
```

Passwords are bcrypt-hashed; JWT sits in an `httpOnly` cookie (30-day TTL).

## Security notes

- `JWT_SECRET` in `.env` must be a long random string — `setup.sh` generates one with `openssl rand -hex 32`
- The CLIs cache their auth tokens under `~/.config/<vendor>/`. The systemd service preserves `HOME` so they keep working after reboots
- Set up Oracle Cloud's VCN security list to only open 80 / 443
- The HTTPS termination is Caddy's job — Hono only listens on 127.0.0.1 by default

## License

Personal use only. Read each AI vendor's terms before sharing access beyond your household.
