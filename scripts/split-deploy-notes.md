# Dev / Prod split — one-time deploy steps

After this, the same git tree drives two independent services:

| Service                     | Port | Domains                                   | Data dir         | .env file   |
| --------------------------- | ---- | ----------------------------------------- | ---------------- | ----------- |
| `multi-ai-chatapp-prod`     | 3001 | `ai-sister.com`, `www.ai-sister.com`, `chat.ted-h.com` | `data-prod/`     | `.env.prod` |
| `multi-ai-chatapp-dev`      | 3002 | `sisters.ted-h.com`                       | `data-dev/`      | `.env.dev`  |

DB / uploads are fully separated; build is shared.

## 0. Prep

SSH to the server. All commands assume `~/Multi-Ai-Chatapp` working tree.

```bash
cd ~/Multi-Ai-Chatapp
git fetch && git reset --hard origin/main
cd server && npm install && npm run build
cd ../web && npm install && npm run build
```

## 1. Stop + disable the old single-service unit

```bash
sudo systemctl stop multi-ai-chatapp
sudo systemctl disable multi-ai-chatapp
```

## 2. Migrate data (Option 1 — existing DB → prod, dev fresh)

```bash
cd ~/Multi-Ai-Chatapp/server
mv data data-prod
mkdir -p data-dev/uploads
```

## 3. Create the two env files

Copy the existing `.env` to `.env.prod`, edit the data paths and port:

```bash
cp .env .env.prod
```

Open `.env.prod` and **add / overwrite** these lines (keep everything
else — JWT_SECRET, SMTP_*, XAI_API_KEY, SEARXNG_URL, etc):

```
PORT=3001
DB_PATH=/home/ubuntu/Multi-Ai-Chatapp/server/data-prod/app.db
UPLOAD_DIR=/home/ubuntu/Multi-Ai-Chatapp/server/data-prod/uploads
PUBLIC_URL=https://ai-sister.com
PROVIDER_MODE=cli
SMTP_FROM_NAME=AI Sister Support
```

> `PROVIDER_MODE=cli` for now. When we wire the API providers (Phase C)
> the prod env switches to `api` and adds `ANTHROPIC_API_KEY` /
> `OPENAI_API_KEY` / `GEMINI_API_KEY`. Until then both instances still
> share the CLI auth tokens — that's fine for testing.

Now build `.env.dev`:

```bash
cp .env.prod .env.dev
```

Open `.env.dev` and overwrite:

```
PORT=3002
DB_PATH=/home/ubuntu/Multi-Ai-Chatapp/server/data-dev/app.db
UPLOAD_DIR=/home/ubuntu/Multi-Ai-Chatapp/server/data-dev/uploads
PUBLIC_URL=https://sisters.ted-h.com
PROVIDER_MODE=cli
SMTP_FROM_NAME=AI Sister (dev)
```

JWT_SECRET should be **different** between dev and prod so leaking one
session doesn't compromise the other:

```bash
# generate fresh dev secret
openssl rand -hex 32
# paste into .env.dev as JWT_SECRET=<that hex>
```

## 4. Install systemd units

```bash
sudo cp ~/Multi-Ai-Chatapp/scripts/multi-ai-chatapp-prod.service /etc/systemd/system/
sudo cp ~/Multi-Ai-Chatapp/scripts/multi-ai-chatapp-dev.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now multi-ai-chatapp-prod
sudo systemctl enable --now multi-ai-chatapp-dev
sudo systemctl status multi-ai-chatapp-prod --no-pager
sudo systemctl status multi-ai-chatapp-dev --no-pager
```

Both should show `active (running)`. Quick health check:

```bash
curl -s http://127.0.0.1:3001/api/health
curl -s http://127.0.0.1:3002/api/health
# both should print {"ok":true}
```

## 5. Update Caddy

Edit `/etc/caddy/Caddyfile`. Replace the old `chat.ted-h.com { … }`
block with these two:

```caddy
ai-sister.com, www.ai-sister.com, chat.ted-h.com {
    reverse_proxy 127.0.0.1:3001
    encode gzip zstd
}

sisters.ted-h.com {
    reverse_proxy 127.0.0.1:3002
    encode gzip zstd
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy will auto-issue TLS certs for the new domains on first hit.

## 6. Set up the dev admin account

The dev DB is empty. Open `https://sisters.ted-h.com`, sign up (the form
gives you a free-tier account). Then promote yourself to admin from
the SQLite shell:

```bash
sqlite3 ~/Multi-Ai-Chatapp/server/data-dev/app.db \
  "UPDATE users SET tier='admin' WHERE username='YOUR_USERNAME';"
```

Log out + back in to pick up the new tier.

## 7. Verify

| URL                          | Expected                                |
| ---------------------------- | --------------------------------------- |
| `https://chat.ted-h.com`     | Old prod site, all existing users work  |
| `https://ai-sister.com`      | Same site as chat.ted-h.com             |
| `https://www.ai-sister.com`  | Same site as chat.ted-h.com             |
| `https://sisters.ted-h.com`  | Empty fresh site, just your dev account |

`favicon`, share preview, etc all branded "AI Sister".

## Day-to-day deploy after this

```bash
cd ~/Multi-Ai-Chatapp
git fetch && git reset --hard origin/main
cd server && npm install && npm run build
cd ../web && npm install && npm run build
sudo systemctl restart multi-ai-chatapp-prod multi-ai-chatapp-dev
```

Both services share the same compiled artefacts under
`server/dist/` and `web/dist/`, so one build → both instances pick it
up on restart.

## Rollback

If something breaks in this split, the old single-service path is one
command away:

```bash
sudo systemctl stop multi-ai-chatapp-prod multi-ai-chatapp-dev
sudo systemctl disable multi-ai-chatapp-prod multi-ai-chatapp-dev
mv ~/Multi-Ai-Chatapp/server/data-prod ~/Multi-Ai-Chatapp/server/data
sudo systemctl enable --now multi-ai-chatapp
```
