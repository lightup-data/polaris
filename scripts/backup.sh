#!/bin/bash
set -euo pipefail

# Polaris Postgres backup: pg_dump to a timestamped file.
#
# Never destructive — this script only creates new files. It never deletes,
# rotates, or overwrites anything (it refuses to clobber an existing dump).
#
# Usage:
#   DATABASE_URL=postgres://user:pass@host:5432/polaris ./scripts/backup.sh [output-dir]
#
# Parameters (env):
#   DATABASE_URL   (required)  Postgres connection string to back up.
#   BACKUP_DIR     (optional)  Output directory (default: ./backups).
#                              A positional arg, if given, takes precedence.
#   BACKUP_S3_URI  (optional)  Object-storage target, e.g. s3://my-bucket/polaris.
#                              If set and the `aws` CLI is installed, the dump is
#                              also uploaded there (the local copy is kept).
#
# Cron wiring (on the prod host, e.g. nightly at 03:17 UTC):
#   crontab -e
#   17 3 * * * DATABASE_URL=postgres://polaris:PASS@127.0.0.1:5432/polaris \
#     BACKUP_DIR=/var/backups/polaris /opt/polaris/scripts/backup.sh \
#     >> /var/log/polaris-backup.log 2>&1
#
# Retention is intentionally NOT handled here (this script never deletes).
# If you want it, pair the cron entry with something like:
#   find /var/backups/polaris -name 'polaris-*.dump' -mtime +30 -delete
#
# Restore with:
#   pg_restore --clean --if-exists -d "$DATABASE_URL" /path/to/polaris-<stamp>.dump
#
# Note: pg_dump's major version must be >= the server's (pg_dump aborts
# otherwise). On a host without a matching client, run via the container:
#   docker exec <postgres-container> pg_dump --format=custom "$DATABASE_URL" > out.dump

DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required (postgres://user:pass@host:port/db)}"
BACKUP_DIR="${1:-${BACKUP_DIR:-./backups}}"
BACKUP_S3_URI="${BACKUP_S3_URI:-}"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/polaris-$STAMP.dump"

mkdir -p "$BACKUP_DIR"

if [ -e "$OUT" ]; then
  echo "Refusing to overwrite existing $OUT" >&2
  exit 1
fi

echo "Backing up to $OUT ..."

# Custom format (-Fc): compressed, restorable with pg_restore.
# Dump to a .partial first so an interrupted dump is never mistaken for a
# complete backup, then atomically rename.
pg_dump --format=custom --file="$OUT.partial" "$DATABASE_URL"
mv "$OUT.partial" "$OUT"

echo "Backup written: $OUT ($(du -h "$OUT" | cut -f1))"

if [ -n "$BACKUP_S3_URI" ]; then
  if command -v aws >/dev/null 2>&1; then
    echo "Uploading to $BACKUP_S3_URI/ ..."
    aws s3 cp "$OUT" "$BACKUP_S3_URI/$(basename "$OUT")"
    echo "Upload complete."
  else
    echo "BACKUP_S3_URI is set but the aws CLI is not installed; skipping upload (local copy kept)." >&2
  fi
fi

echo "Done."
