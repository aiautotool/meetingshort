#!/usr/bin/env bash
# Fetch the latest main branch, build, install, and launch on the iPhone named Kct.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

readonly DEVICE_NAME="${IOS_DEVICE:-Kct}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "This script must run from a Git working tree." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree has local changes. Commit or stash them before updating." >&2
  exit 2
fi

git fetch --prune origin
git pull --ff-only origin main

exec ./scripts/build-install-ios.sh "$DEVICE_NAME"
