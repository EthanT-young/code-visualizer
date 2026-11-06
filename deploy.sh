#!/usr/bin/env bash
# Pull the latest version from GitHub and rebuild if anything changed.
#
#   ./deploy.sh           update now
#   ./deploy.sh --force   rebuild even if nothing changed
#
# To update automatically, add a cron job (crontab -e), e.g. every 15 minutes:
#   */15 * * * * cd /path/to/code-visualizer && ./deploy.sh >> deploy.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p socket

before=$(git rev-parse HEAD)
git pull --ff-only --quiet
after=$(git rev-parse HEAD)

if [[ "$before" == "$after" && "${1:-}" != "--force" ]] && [[ -n "$(docker compose ps --status running -q)" ]]; then
  echo "$(date '+%F %T') already up to date ($(git log -1 --format='%h %s'))"
  exit 0
fi

docker compose up -d --build
docker image prune -f > /dev/null   # remove the previous build's leftovers
echo "$(date '+%F %T') deployed $(git log -1 --format='%h %s')"
