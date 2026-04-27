#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# backup-to-gdrive.sh
#
# Mirrors the SQLite DB and the uploads directory to Google Drive via rclone.
#
# Layout in Drive (under the configured remote):
#   multi-ai-chatapp/
#     db/app-YYYYMMDD-HHMMSS.db   ← timestamped snapshots (kept)
#     db/latest.db                ← always overwritten with newest
#     uploads/                    ← rsync-style mirror of UPLOAD_DIR
#
# Requires rclone with a configured remote named in $RCLONE_REMOTE
# (default: "gdrive"). Run `rclone config` once to set it up.
#
# Cron usage (daily at 04:00):
#   0 4 * * * /home/ubuntu/Multi-Ai-Chatapp/scripts/backup-to-gdrive.sh \
#             >> /home/ubuntu/Multi-Ai-Chatapp/data/backup.log 2>&1
# ----------------------------------------------------------------------------
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/Multi-Ai-Chatapp}"
DB_PATH="${DB_PATH:-$APP_DIR/server/data/app.db}"
UPLOAD_DIR="${UPLOAD_DIR:-$APP_DIR/server/data/uploads}"
RCLONE_REMOTE="${RCLONE_REMOTE:-gdrive}"
REMOTE_ROOT="${REMOTE_ROOT:-multi-ai-chatapp}"
TS="$(date +%Y%m%d-%H%M%S)"

log() { echo "[$(date -Iseconds)] $*"; }

if ! command -v rclone >/dev/null 2>&1; then
  log "ERROR: rclone is not installed. Install with: curl https://rclone.org/install.sh | sudo bash"
  exit 1
fi

if [[ ! -f "$DB_PATH" ]]; then
  log "ERROR: DB not found at $DB_PATH"
  exit 1
fi

if ! rclone listremotes | grep -q "^${RCLONE_REMOTE}:$"; then
  log "ERROR: rclone remote '${RCLONE_REMOTE}' not configured. Run: rclone config"
  exit 1
fi

# ---- 1. SQLite snapshot ----
# Use the .backup pragma via sqlite3 so we get a consistent copy even if the
# server is mid-write. Falls back to plain copy if sqlite3 isn't available.
SNAP_DIR="$(mktemp -d)"
trap 'rm -rf "$SNAP_DIR"' EXIT
SNAP_FILE="$SNAP_DIR/app.db"
if command -v sqlite3 >/dev/null 2>&1; then
  log "Snapshotting DB via sqlite3 .backup"
  sqlite3 "$DB_PATH" ".backup '$SNAP_FILE'"
else
  log "sqlite3 missing, falling back to file copy (may catch a partial write)"
  cp "$DB_PATH" "$SNAP_FILE"
fi

log "Uploading DB snapshot → ${RCLONE_REMOTE}:${REMOTE_ROOT}/db/app-${TS}.db"
rclone copyto "$SNAP_FILE" "${RCLONE_REMOTE}:${REMOTE_ROOT}/db/app-${TS}.db" --quiet

log "Refreshing latest pointer → ${RCLONE_REMOTE}:${REMOTE_ROOT}/db/latest.db"
rclone copyto "$SNAP_FILE" "${RCLONE_REMOTE}:${REMOTE_ROOT}/db/latest.db" --quiet

# ---- 2. Uploads mirror ----
if [[ -d "$UPLOAD_DIR" ]]; then
  log "Syncing uploads → ${RCLONE_REMOTE}:${REMOTE_ROOT}/uploads/"
  # `sync` makes the remote match the local; new files are uploaded, removed
  # files are deleted. Use --copy-links so we follow symlinks if any.
  rclone sync "$UPLOAD_DIR" "${RCLONE_REMOTE}:${REMOTE_ROOT}/uploads/" \
    --transfers=4 --checkers=8 --quiet
else
  log "WARN: upload dir missing at $UPLOAD_DIR"
fi

log "Backup complete."
