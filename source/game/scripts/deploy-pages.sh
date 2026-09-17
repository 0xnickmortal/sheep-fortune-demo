#!/bin/sh
# Publishes the static share build and source snapshot to GitHub Pages
# (repository 0xnickmortal/sheep-fortune-demo, branch main, site root).
# Run from anywhere: sh sheep-fortune/game/scripts/deploy-pages.sh
set -eu
cd "$(dirname "$0")/.."
REPO_URL="https://github.com/0xnickmortal/sheep-fortune-demo.git"
if [ ! -d .pages-repo/.git ]; then
  git clone --quiet "$REPO_URL" .pages-repo
fi
if [ -n "$(git -C .pages-repo status --porcelain)" ]; then
  echo "GitHub checkout has local changes; review them before publishing." >&2
  exit 1
fi
git -C .pages-repo fetch origin
git -C .pages-repo checkout main
git -C .pages-repo merge --ff-only origin/main
node scripts/build-share.mjs
node scripts/prepare-github.mjs .pages-repo
cd .pages-repo
git add -A
if git diff --cached --quiet; then echo "Nothing changed since the last deploy."; exit 0; fi
git commit -q -m "Publish game source and share build $(date '+%Y-%m-%d %H:%M')"
git push -u origin main
echo "Pushed. GitHub Pages updates within about a minute: https://0xnickmortal.github.io/sheep-fortune-demo/"
