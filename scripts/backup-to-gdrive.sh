#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# backup-to-gdrive.sh
#
# Mirrors both prod and dev SQLite DBs and uploads dirs to Google Drive
# via rclone. Each instance lives under its own subdir on the remote.
#
# Layout in Drive (under the configured remote):
#   ai-sister/
#     prod/
#       db/app-YYYYMMDD-HHMMSS.db   ← timestamped snapshots (kept)
#       db/latest.db                ← always overwritten with newest
#       uploads/                    ← rsync-style mirror of data-prod/uploads
#     dev/
#       db/...
#       uploads/...
#
# Requires rclone with a configured remote named in $RCLONE_REMOTE
# (default: "gdrive"). Run `rclone config` once to set it up.
#
# Cron usage (daily at 04:00):
#   0 4 * * * /home/ubuntu/Multi-Ai-Chatapp/scripts/backup-to-gdrive.sh \
#             >> /home/ubuntu/Multi-Ai-Chatapp/backup.log 2>&1
# ----------------------------------------------------------------------------
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/Multi-Ai-Chatapp}"
RCLONE_REMOTE="${RCLONE_REMOTE:-gdrive}"
REMOTE_ROOT="${REMOTE_ROOT:-ai-sister}"
TS="$(date +%Y%m%d-%H%M%S)"

# instance-name : data-dir-name (relative to $APP_DIR/server)
INSTANCES=(
  "prod:data-prod"
  "dev:data-dev"
)

log() { echo "[$(date -Iseconds)] $*"; }

if ! command -v rclone >/dev/null 2>&1; then
  log "ERROR: rclone is not installed. Install with: curl https://rclone.org/install.sh | sudo bash"
  exit 1
fi

if ! rclone listremotes | grep -q "^${RCLONE_REMOTE}:$"; then
  log "ERROR: rclone remote '${RCLONE_REMOTE}' not configured. Run: rclone config"
  exit 1
fi

SNAP_DIR="$(mktemp -d)"
trap 'rm -rf "$SNAP_DIR"' EXIT

backup_instance() {
  local name="$1"
  local data_dir="$2"
  local db_path="$APP_DIR/server/$data_dir/app.db"
  local upload_dir="$APP_DIR/server/$data_dir/uploads"
  local remote_base="${RCLONE_REMOTE}:${REMOTE_ROOT}/${name}"

  log "=== Backing up instance: ${name} (${data_dir}) ==="

  if [[ ! -f "$db_path" ]]; then
    log "WARN: DB not found at $db_path, skipping ${name}"
    return 0
  fi

  # ---- 1. SQLite snapshot ----
  local snap_file="$SNAP_DIR/${name}-app.db"
  if command -v sqlite3 >/dev/null 2>&1; then
    log "[${name}] Snapshotting DB via sqlite3 .backup"
    sqlite3 "$db_path" ".backup '$snap_file'"
  else
    log "[${name}] sqlite3 missing, falling back to file copy (may catch a partial write)"
    cp "$db_path" "$snap_file"
  fi

  log "[${name}] Uploading DB snapshot → ${remote_base}/db/app-${TS}.db"
  rclone copyto "$snap_file" "${remote_base}/db/app-${TS}.db" --quiet

  log "[${name}] Refreshing latest pointer → ${remote_base}/db/latest.db"
  rclone copyto "$snap_file" "${remote_base}/db/latest.db" --quiet

  # ---- 2. Uploads mirror ----
  if [[ -d "$upload_dir" ]]; then
    log "[${name}] Syncing uploads → ${remote_base}/uploads/"
    rclone sync "$upload_dir" "${remote_base}/uploads/" \
      --transfers=4 --checkers=8 --quiet
  else
    log "[${name}] WARN: upload dir missing at $upload_dir"
  fi
}

for entry in "${INSTANCES[@]}"; do
  IFS=':' read -r name data_dir <<<"$entry"
  backup_instance "$name" "$data_dir"
done

log "Backup complete."
