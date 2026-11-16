#!/usr/bin/env bash
# Build the Windows hub installer, dist/Aeneas-Hub-Setup-VERSION.exe, and its SHA-256, on Linux with NSIS 3
# (apt-get install nsis). On Windows use build.ps1. Homebrew's makensis 3.13 crashes on macOS 26 (std::bad_alloc as
# soon as a script has a section, 2026-11-10), so a Mac cannot build it for now.
#
#   bash deploy/windows/installer/build.sh
#
# Its version is the repository's (tools/version.mjs), the one the hub and every app say; a version given as an
# argument must be the same.
#
# The installer carries deploy/install.ps1 as it is at this checkout; that script installs the hub from the public
# repository's main branch.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
command -v node >/dev/null || { echo "node is needed to read the repository's version" >&2; exit 1; }
node "$REPO/tools/version.mjs" >/dev/null || { echo "the hub and the apps say different versions: see node tools/version.mjs" >&2; exit 1; }
REPO_VERSION="$(node -p 'require(process.argv[1]).version' "$REPO/package.json")"
VERSION="${1:-$REPO_VERSION}"
case "$VERSION" in *[!0-9.]*|"") echo "the version is numbers and dots, like 1.0.2" >&2; exit 1 ;; esac
[ "$VERSION" = "$REPO_VERSION" ] || { echo "the installer's version is the repository's ($REPO_VERSION), so the hub it installs says the same; not $VERSION" >&2; exit 1; }
OUT="$REPO/dist"
mkdir -p "$OUT"
command -v makensis >/dev/null || { echo "makensis is needed: apt-get install nsis (Linux); on Windows use build.ps1" >&2; exit 1; }
makensis -V2 -DVERSION="$VERSION" -DOUTDIR="$OUT" "$HERE/aeneas-hub.nsi"
EXE="$OUT/Aeneas-Hub-Setup-$VERSION.exe"
( cd "$OUT" && shasum -a 256 "$(basename "$EXE")" > "$(basename "$EXE").sha256" )
echo "built $EXE ($(du -h "$EXE" | cut -f1)), sha256 $(cut -d' ' -f1 "$EXE.sha256")"
