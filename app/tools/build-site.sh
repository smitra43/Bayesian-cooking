#!/usr/bin/env bash
# Builds the static website into _site/ (used by .github/workflows/pages.yml).
#
# app/index.html is already a complete page, so this just copies the files a
# browser needs and leaves out the developer-only folders (tests/, tools/).
#
# Usage: app/tools/build-site.sh [output-folder]    (default: _site)
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="${1:-$root/_site}"
rm -rf "$out"
mkdir -p "$out"
cp "$root/app/index.html" "$root/app/styles.css" "$out/"
cp -r "$root/app/engine" "$root/app/ui" "$root/app/vendor" "$out/"
touch "$out/.nojekyll"   # tells GitHub Pages to serve files as-is
echo "Built $out"
