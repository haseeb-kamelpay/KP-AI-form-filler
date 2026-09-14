/**
 * Inline one fixture, the content scripts and the assertions into one page.
 *
 * One fixture per page on purpose: `findContainer()` picks the richest form in
 * the document, so two fixtures side by side would both be judged against
 * whichever one it picked.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2]);
const fixture = process.argv[3];        // e.g. antd5.html
const major = process.argv[4];          // e.g. 5
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const scripts = ['src/content/kpaf-core.js', 'src/content/kpaf-scan.js', 'src/content/kpaf-fill.js']
  .map((f) => `<script>\n${read(f)}\n</script>`)
  .join('\n');

process.stdout.write(`<!doctype html>
<meta charset="utf-8">
<title>running…</title>
<body>
<div data-fixture="${major}" data-antd-major="${major}">
${read(path.join('test/fixtures', fixture))}
</div>
<pre id="out">(not run)</pre>
${scripts}
<script>\n${read('test/selectors.test.js')}\n</script>
<script>
  window.KPAF_TEST().catch((e) => {
    document.getElementById('out').textContent = 'THREW: ' + (e && e.stack || e);
    document.title = 'FAILED';
  });
</script>
</body>
`);
