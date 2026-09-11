#!/usr/bin/env bash
# Re-render the fixtures from each portal's own antd, then run the scanner
# against both in headless Chrome.
#
#   test/run.sh [path-to-hrcms]
#
# Everything is inlined into one page: Chrome will not let a file:// page fetch
# its siblings, and the content scripts have to run in the same document as the
# markup they read.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
hrcms="${1:-$(cd "$root/.." && pwd)/hrcms}"

v1="$hrcms/client/employer"      # antd 5 — same range as client/admin
v2="$hrcms/clientV2/employer"    # antd 6

for portal in "$v1" "$v2"; do
  [ -d "$portal/node_modules/antd" ] || { echo "missing deps: $portal/node_modules/antd" >&2; exit 2; }
done

echo "rendering fixtures…"
node "$here/render-fixtures.cjs" "$v1" > "$here/fixtures/antd5.html"
node "$here/render-fixtures.cjs" "$v2" > "$here/fixtures/antd6.html"

chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$chrome" ] || { echo "no Chrome at $chrome (set CHROME=…)" >&2; exit 2; }

status=0
for pair in "antd5.html:5" "antd6.html:6"; do
  file="${pair%%:*}"
  major="${pair##*:}"
  node "$here/build-page.cjs" "$root" "$file" "$major" > "$here/.run-$major.html"

  out="$("$chrome" --headless=new --disable-gpu --no-sandbox \
    --virtual-time-budget=8000 --dump-dom "file://$here/.run-$major.html" 2>/dev/null)"

  node -e '
    const out = process.argv[1];
    const m = out.match(/<pre id="out">([\s\S]*?)<\/pre>/);
    if (!m) { console.error("no results — the page did not run"); process.exit(1); }
    const text = m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    console.log(text);
    process.exit(/^FAIL/m.test(text) ? 1 : 0);
  ' "$out" || status=1
done
exit $status
