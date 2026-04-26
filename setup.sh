#!/usr/bin/env bash
# Oracle Cloud ARM (Ampere A1) Ubuntu 22.04+ setup script.
# Installs: Node 20, the 4 AI CLIs, Caddy (auto-HTTPS), and prepares the app.
#
# Run as a regular sudo user (not root):
#   chmod +x setup.sh && ./setup.sh
#
# After this script finishes, you need to log in to each CLI separately
# (the script cannot do that for you — auth is interactive).
set -euo pipefail

step() { printf "\n\033[1;36m==>\033[0m %s\n" "$1"; }
ok()   { printf "\033[1;32m✓\033[0m %s\n" "$1"; }
warn() { printf "\033[1;33m!\033[0m %s\n" "$1"; }

if [[ $EUID -eq 0 ]]; then
  echo "Run this script as a regular user with sudo, not as root." >&2
  exit 1
fi

step "Updating apt"
sudo apt-get update -y
sudo apt-get install -y curl ca-certificates gnupg lsb-release git build-essential python3

step "Installing Node.js 20 (NodeSource — supports ARM64)"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
ok "Node $(node -v) / npm $(npm -v)"

step "Installing the 4 AI CLIs globally"
# Anthropic Claude Code
sudo npm install -g @anthropic-ai/claude-code || warn "Claude Code install failed"
# OpenAI Codex CLI
sudo npm install -g @openai/codex || warn "OpenAI Codex install failed"
# Google Gemini CLI
sudo npm install -g @google/gemini-cli || warn "Gemini CLI install failed"
# xAI Grok CLI
sudo npm install -g @xai-official/grok || warn "Grok CLI install failed"

ok "CLI install attempts done. Verify each:"
for c in claude codex gemini grok; do
  if command -v "$c" >/dev/null 2>&1; then
    echo "  ✓ $c — $(command -v "$c")"
  else
    echo "  ✗ $c — NOT FOUND. Check the npm install output above."
  fi
done

step "Installing Caddy (reverse proxy with automatic HTTPS)"
if ! command -v caddy >/dev/null 2>&1; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi
ok "Caddy $(caddy version | head -n1)"

step "Opening firewall ports 80/443"
if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow 80/tcp || true
  sudo ufw allow 443/tcp || true
fi
# Oracle Cloud also blocks ports at the iptables level by default
sudo iptables -I INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT || true
sudo netfilter-persistent save 2>/dev/null || true
warn "Don't forget to open 80 / 443 in your Oracle Cloud Security List too."

step "Installing app dependencies"
cd "$(dirname "$0")"
( cd server && npm install )
( cd web && npm install )

step "Building the web frontend"
( cd web && npm run build )

step "Building the server"
( cd server && npm run build )

if [[ ! -f server/.env ]]; then
  step "Creating server/.env (with a generated JWT_SECRET)"
  jwt=$(openssl rand -hex 32)
  cp server/.env.example server/.env
  sed -i "s|^JWT_SECRET=.*$|JWT_SECRET=${jwt}|" server/.env
  ok "server/.env created"
fi

cat <<'NEXT'

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ Setup complete. Remaining manual steps:

1. Log in to each CLI (one-time, interactive, follow each prompt):
     claude        # Anthropic — completes OAuth flow in browser
     codex         # OpenAI — same
     gemini        # Google
     grok          # xAI

   For each, send a quick test prompt to confirm:
     echo "say hi" | claude -p --output-format text
     echo "say hi" | codex exec --quiet
     echo "say hi" | gemini -p
     echo "say hi" | grok exec

2. Create users with the right tier:
     cd server
     npm run user:add -- ted    your-password super
     npm run user:add -- wife   her-password  standard
     npm run user:add -- dad    his-password  test
     npm run user:add -- mom    her-password  test

3. Edit Caddyfile.example → put your real domain in, copy to /etc/caddy/Caddyfile,
   then start Caddy:
     sudo cp Caddyfile.example /etc/caddy/Caddyfile
     # edit /etc/caddy/Caddyfile and replace example.com with your domain
     sudo systemctl reload caddy

4. Install the systemd service to auto-start the server:
     sudo cp scripts/multi-ai-chatapp.service /etc/systemd/system/
     # edit the service file: replace USERNAME and INSTALL_DIR
     sudo systemctl daemon-reload
     sudo systemctl enable --now multi-ai-chatapp

5. Point your domain's DNS A record at this server's public IP.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NEXT
