/**
 * Cross-version checks for everything the scanner reads out of the DOM.
 *
 * Both fixtures are rendered by the portals' own antd (5.29 for client/admin
 * and client/employer, 6.3 for clientV2/employer), so these assertions fail
 * the day either version moves the DOM under us — which is exactly how the
 * "the selection did not stick" regression got in.
 *
 * What this cannot cover: opening a dropdown and reading its options needs a
 * live React app, since a click on static markup changes nothing. Option
 * enumeration and the fill strategies are still browser-tested by hand.
 */
(() => {
  const results = [];
  const ok = (name, pass, detail) => results.push({ name, pass, detail });

  const eq = (name, got, want) =>
    ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

  const caseEl = (root, id) => root.querySelector(`[data-case="${id}"]`);
  const selectIn = (root, id) => caseEl(root, id).querySelector('.ant-select');
  const pickerIn = (root, id) => caseEl(root, id).querySelector('.ant-picker');

  async function runFixture(label, root) {
    const S = window.KPAF.scan;
    const t = (name) => `${label} ${name}`;

    /* ---- the value readback that broke on antd 6 ---- */
    eq(t('selectedLabels: single with value'), S.selectedLabels(selectIn(root, 'select-single-valued')), ['Emirates NBD']);
    eq(t('selectedLabels: single empty'), S.selectedLabels(selectIn(root, 'select-single-empty')), []);
    eq(t('selectedLabels: searchable with value'), S.selectedLabels(selectIn(root, 'select-search-valued')), ['Abu Dhabi Commercial Bank']);
    eq(t('selectedLabels: multiple'), S.selectedLabels(selectIn(root, 'select-multiple-valued')), ['Emirates NBD', 'Mashreq Bank']);

    /* ---- the handles the filler drives ---- */
    for (const id of ['select-single-valued', 'select-single-empty', 'select-search-valued', 'select-multiple-valued']) {
      const el = selectIn(root, id);
      const input = S.searchInputFor(el);
      ok(t(`searchInputFor: ${id}`), !!input && input.tagName === 'INPUT', input ? input.className : 'null');
      const opener = S.selectOpener(el);
      ok(t(`selectOpener: ${id}`), !!opener && el.contains(opener), opener ? opener.className.split(' ')[0] : 'null');
    }
    // Only a searchable select accepts typing; the rest are readonly, which is
    // what stops the filler from typing into a plain dropdown.
    ok(t('searchInputFor: plain select is readonly'), S.searchInputFor(selectIn(root, 'select-single-valued')).readOnly === true);
    ok(t('searchInputFor: showSearch select is typeable'), S.searchInputFor(selectIn(root, 'select-search-valued')).readOnly === false);

    /* ---- the picker's commit signal ---- */
    ok(t('picker with a value renders .ant-picker-clear'), !!pickerIn(root, 'picker-valued').querySelector('.ant-picker-clear'));
    ok(t('empty picker renders no .ant-picker-clear'), !pickerIn(root, 'picker-empty').querySelector('.ant-picker-clear'));
    ok(t('range with values renders .ant-picker-clear'), !!pickerIn(root, 'range-valued').querySelector('.ant-picker-clear'));
    // allowClear={false} is why the panel fallback exists: a real value, no icon.
    ok(t('allowClear=false hides the signal (fallback path)'), !pickerIn(root, 'picker-noclear-valued').querySelector('.ant-picker-clear'));
    ok(t('allowClear=false still shows its text'), pickerIn(root, 'picker-noclear-valued').querySelector('input').value === '10/05/2022',
      pickerIn(root, 'picker-noclear-valued').querySelector('input').value);

    /* ---- a full scan of the fixture ---- */
    const scan = await S.scan({ overwrite: false });
    const byLabel = new Map(scan.fields.map((f) => [f.label, f]));
    const skipped = new Map(scan.skipped.map((s) => [s.label, s.reason]));

    const kindOf = (lbl) => byLabel.get(lbl)?.kind;
    eq(t('scan: Emp. Code kind'), kindOf('Emp. Code'), 'text');
    eq(t('scan: Date of Joining kind'), kindOf('Date of Joining'), 'date');
    eq(t('scan: Period kind'), kindOf('Period'), 'daterange');
    ok(t('scan: a filled date is seen as filled'), /already filled/.test(skipped.get('Date of Birth') || ''), skipped.get('Date of Birth'));
    ok(t('scan: a filled range is seen as filled'), /already filled/.test(skipped.get('Validity') || ''), skipped.get('Validity'));
    eq(t('scan: Remarks kind'), kindOf('Remarks'), 'textarea');
    eq(t('scan: Employee Type kind'), kindOf('Employee Type'), 'radio');
    eq(t('scan: Employee Type options'), byLabel.get('Employee Type')?.options.map((o) => o.label), ['KamelPay', 'Other Bank']);
    eq(t('scan: Notifications kind'), kindOf('Notifications'), 'switch');
    ok(t('scan: Active is a checkbox'), kindOf('Active') === 'checkbox', kindOf('Active'));

    ok(t('scan: labels come from the portal wrapper'), byLabel.has('Emp. Code') && byLabel.has('Date of Joining'),
      [...byLabel.keys()].join(' | '));
    // v2 paints a ThemeLabel asterisk; the v1 CField paints nothing at all, so
    // required-ness there is genuinely unreadable and the model only gets the
    // label and the domain rule.
    const major = Number(root.getAttribute('data-antd-major'));
    eq(t('scan: required marker'), byLabel.get('Emp. Code')?.required, major >= 6);
    eq(t('scan: optional field not required'), byLabel.get('Remarks')?.required, false);

    // The reported regression: a filled dropdown must read as filled.
    ok(t('scan: filled dropdown is seen as filled'), /already filled: "Emirates NBD"/.test(skipped.get('Bank Name') || ''),
      skipped.get('Bank Name'));
    ok(t('scan: filled multiselect is seen as filled'), /already filled/.test(skipped.get('Modules') || ''), skipped.get('Modules'));
    ok(t('scan: disabled dropdown skipped'), /disabled/.test(skipped.get('Locked Unit') || ''), skipped.get('Locked Unit'));

    // A select in another input's prefix is that input's ornament.
    ok(t('scan: prefix select not offered as a field'), !byLabel.has('Full Name') || byLabel.get('Full Name').kind === 'text',
      `kind=${kindOf('Full Name')}`);
    ok(t('scan: prefix select reported as skipped'), /selector inside another field/.test(skipped.get('Full Name') || ''),
      skipped.get('Full Name'));
    ok(t('scan: the Full Name text input is still fillable'),
      scan.fields.some((f) => f.label === 'Full Name' && f.kind === 'text'),
      scan.fields.filter((f) => f.label === 'Full Name').map((f) => f.kind).join(','));

    // v1's untouched CField dropdown: antd shows the blank option's label as a
    // selected item, and reading that as a value skipped every empty dropdown
    // in admin and employer v1.
    eq(t('v1 untouched select: antd really does render it as a selection'),
      S.selectedLabels(selectIn(root, 'select-v1-untouched')), ['Select bank name']);
    ok(t('v1 untouched select: not treated as already filled'),
      !/already filled/.test(skipped.get('Select bank name') || ''), skipped.get('Select bank name'));
    ok(t('v1 untouched select: offered as a field to fill'),
      scan.fields.some((f) => f.label === 'Select bank name') ||
        /dropdown/.test(skipped.get('Select bank name') || ''),
      skipped.get('Select bank name'));

    // A select in a sibling `div.prefix` — v1's country-code pattern — is a
    // field in its own right; only antd's own prefix slot is an ornament.
    ok(t('scan: v1-style sibling prefix select is still a field'),
      scan.fields.some((f) => f.label === 'Phone Number') || /already filled: "\+971"/.test(skipped.get('Phone Number') || ''),
      `fields=${scan.fields.filter((f) => f.label === 'Phone Number').length} skipped=${skipped.get('Phone Number')}`);

    // Document order, so dependent controls fill after what they depend on.
    const order = scan.fields.map((f) => f.label);
    const doj = order.indexOf('Date of Joining');
    const emp = order.indexOf('Emp. Code');
    const rem = order.indexOf('Remarks');
    ok(t('scan: fields come back in document order'), doj !== -1 && doj < emp && emp < rem, order.join(' → '));
  }

  window.KPAF_TEST = async () => {
    for (const root of document.querySelectorAll('[data-fixture]')) {
      await runFixture(`[antd ${root.getAttribute('data-antd-major')}]`, root);
    }
    const failed = results.filter((r) => !r.pass);
    const lines = results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `  — ${r.detail || ''}`}`);
    lines.push('', `${results.length - failed.length}/${results.length} passed`);
    document.getElementById('out').textContent = lines.join('\n');
    document.title = failed.length ? `FAILED ${failed.length}` : 'ALL PASS';
  };
})();
