#!/usr/bin/env bash
# Builds a standalone static site in _site/ for GitHub Pages.
# app/index.html is written as page content for the claude.ai artifact host,
# which supplies the document skeleton; here we add that skeleton ourselves.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="${1:-$root/_site}"
rm -rf "$out"
mkdir -p "$out"
cp -r "$root/app/engine" "$root/app/ui" "$out/"
{
  cat <<'HEAD'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
:root { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
body { margin: 0; }
img { max-width: 100%; }
[hidden] { display: none !important; }
</style>
</head>
<body>
HEAD
  cat "$root/app/index.html"
  printf '\n</body>\n</html>\n'
} > "$out/index.html"
touch "$out/.nojekyll"
echo "Built $out"
