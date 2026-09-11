/**
 * Writing values into the page.
 *
 * Every strategy verifies by reading the value back out of the DOM rather than
 * assuming the write landed. That is what lets the popup distinguish "the
 * model gave a bad value" from "the widget refused it" — a distinction you
 * need when a date is rejected by an invisible `disabledDate` callback, or a
 * dependent dropdown has not repopulated yet.
 */

(() => {
  if (window.KPAF?.fill) return;
  const KPAF = (window.KPAF = window.KPAF || {});
  const C = KPAF.core;
  const S = () => KPAF.scan;

  /** Formats to try for an antd DatePicker, most likely first. */
  const DATE_FORMATS = ['DD-MMM-YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY', 'DD-MM-YYYY', 'MM/DD/YYYY'];
  const DATETIME_FORMATS = [
    'DD-MMM-YYYY HH:mm:ss',
    'YYYY-MM-DD HH:mm:ss',
    'YYYY-MM-DDTHH:mm:ss',
    'DD/MM/YYYY HH:mm',
  ];

  /* ---------------------------------------------------------------- *
   * Text-like controls
   * ---------------------------------------------------------------- */

  async function fillText(field, value) {
    const el = S().innerInput(field._entry);
    if (!el) return { ok: false, error: 'could not find the input element' };

    el.focus();
    C.setNativeValue(el, '');
    C.setNativeValue(el, String(value));
    await C.tick(20);
    C.blur(el);
    await C.tick(20);

    const got = el.value;
    if (got !== String(value)) {
      // A component-level filter rejected part of it — ThemeInput's numeric
      // guard drops non-digits, and maxlength truncates.
      if (got && String(value).startsWith(got)) {
        return { ok: true, value: got, warning: `truncated to "${got}"` };
      }
      if (!got) return { ok: false, error: 'the field rejected the value (stayed empty)' };
      return { ok: true, value: got, warning: `stored as "${got}"` };
    }
    return { ok: true, value: got };
  }

  /* ---------------------------------------------------------------- *
   * Ant Design Select
   * ---------------------------------------------------------------- */

  /**
   * Pick an option by label.
   *
   * Options are re-read at fill time rather than trusted from the scan,
   * because dependent dropdowns (state after country, branch after bank)
   * repopulate as earlier fields are filled. If the model's choice is gone by
   * the time we get here, we take any valid option and say so.
   */
  async function fillSelect(field, wantedLabels, { multiple = false } = {}) {
    const root = field._entry.el;
    if (root.classList.contains('ant-select-disabled')) {
      return { ok: false, error: 'the dropdown is disabled' };
    }

    const opener = S().selectOpener(root);
    const searchInput = S().searchInputFor(root);
    const chosen = [];
    const warnings = [];

    for (const wanted of wantedLabels) {
      C.realClick(opener);
      await C.tick(120);

      let dd = S().dropdownFor(root);
      if (!dd) {
        return { ok: false, error: 'the dropdown would not open' };
      }

      // Typing filters the list, which also solves virtualisation: the target
      // is pulled into the rendered slice instead of needing to be scrolled to.
      const searchable = searchInput && !searchInput.readOnly;
      if (searchable && wanted) {
        C.setNativeValue(searchInput, wanted.slice(0, 24));
        await C.tick(260); // several selects debounce their search by 800ms/type
      }

      let node = findOption(dd, wanted, field.label);

      if (!node && searchable) {
        // Filtering may have hidden it (server-side search, debounce). Clear
        // and look through the unfiltered list.
        C.setNativeValue(searchInput, '');
        await C.tick(220);
        dd = S().dropdownFor(root) || dd;
        node = findOption(dd, wanted, field.label);
      }

      if (!node) {
        node = firstSelectableOption(dd, field.label);
        if (node) {
          warnings.push(
            `"${wanted}" was not in the list; used "${C.clean(node.getAttribute('title') || node.textContent)}"`,
          );
        }
      }

      if (!node) {
        C.pressEscape(searchInput || root);
        return { ok: false, error: `no option matching "${wanted}" and the list was empty` };
      }

      const picked = C.clean(node.getAttribute('title') || node.textContent);
      C.realClick(node);
      await C.tick(90);
      chosen.push(picked);

      if (!multiple) break;
    }

    C.pressEscape(searchInput || root);
    C.realClick(document.body);
    await C.tick(60);
    if (searchInput) C.blur(searchInput);
    await C.tick(40);

    // Read back through the scanner's version-aware reader: antd 6 renders a
    // single select's value as a bare text node in `.ant-select-content`, with
    // none of antd 5's `-selection-item` elements to find.
    const shown = S().selectedLabels(root);

    if (!shown.length) {
      return { ok: false, error: 'the selection did not stick' };
    }

    return {
      ok: true,
      value: shown.join(', '),
      warning: warnings.length ? warnings.join('; ') : undefined,
    };
  }

  function findOption(dd, wanted, fieldLabel) {
    if (!dd || !wanted) return null;
    const nodes = selectableOptions(dd, fieldLabel);
    const target = wanted.toLowerCase();

    return (
      nodes.find((n) => C.clean(n.getAttribute('title') || n.textContent).toLowerCase() === target) ||
      nodes.find((n) => C.clean(n.textContent).toLowerCase().includes(target)) ||
      nodes.find((n) => target.includes(C.clean(n.textContent).toLowerCase())) ||
      null
    );
  }

  function firstSelectableOption(dd, fieldLabel) {
    return selectableOptions(dd, fieldLabel)[0] || null;
  }

  /**
   * Options that are real choices.
   *
   * Excludes the disabled ones and v1's blank `<Select.Option value="">`, whose
   * label is the field's placeholder — clicking it writes '' and fails the
   * field's own required rule, which is worse than reporting no match.
   */
  function selectableOptions(dd, fieldLabel) {
    if (!dd) return [];
    return [...dd.querySelectorAll('.ant-select-item-option')].filter((n) => {
      if (n.classList.contains('ant-select-item-option-disabled')) return false;
      const text = C.clean(n.getAttribute('title') || n.textContent);
      return text.length > 0 && !C.isPlaceholderChoice(text, fieldLabel);
    });
  }

  /* ---------------------------------------------------------------- *
   * EstablishmentSelect (clientV2)
   * ---------------------------------------------------------------- */

  /**
   * Pick a business unit.
   *
   * Not an antd Select: a `div[role=combobox]` face over a panel of rows
   * portalled to <body>, so none of the Select machinery applies — no search
   * box, no `.ant-select-item-option`, and the value shows up as
   * `.establishment-select__value` on the face.
   */
  async function fillEstablishment(field, wanted) {
    const root = field._entry.el;
    const face = S().establishmentFace(root);
    if (!face) return { ok: false, error: 'the business unit selector has no trigger' };
    if (face.classList.contains('establishment-select__face--disabled')) {
      return { ok: false, error: 'the business unit selector is disabled' };
    }

    C.realClick(face);
    await C.tick(180);

    let panel = S().establishmentPanel();
    if (!panel) {
      await C.tick(220);
      panel = S().establishmentPanel();
    }
    if (!panel) return { ok: false, error: 'the business unit panel would not open' };

    const rows = S().establishmentRows(panel);
    if (!rows.length) {
      C.pressEscape(face);
      return { ok: false, error: 'the business unit panel is empty' };
    }

    const target = String(wanted || '').toLowerCase();
    const match =
      rows.find((r) => r.label.toLowerCase() === target) ||
      rows.find((r) => r.label.toLowerCase().includes(target)) ||
      rows[0];

    const warning =
      match.label.toLowerCase() === target
        ? undefined
        : `"${wanted}" was not in the list; used "${match.label}"`;

    C.realClick(match.el);
    await C.tick(140);

    // Selecting closes the panel itself; this only covers a stuck one.
    if (S().establishmentPanel()) {
      C.pressEscape(face);
      C.realClick(document.body);
      await C.tick(80);
    }

    const shown = S().establishmentValue(root);
    if (!shown) return { ok: false, error: 'the selection did not stick' };
    return { ok: true, value: shown, warning };
  }

  /* ---------------------------------------------------------------- *
   * Native select
   * ---------------------------------------------------------------- */

  async function fillNativeSelect(field, label) {
    const el = field._entry.el;
    const match =
      [...el.options].find((o) => C.clean(o.textContent).toLowerCase() === label.toLowerCase()) ||
      [...el.options].find((o) => C.clean(o.textContent).toLowerCase().includes(label.toLowerCase())) ||
      [...el.options].find((o) => !o.disabled && o.value !== '');

    if (!match) return { ok: false, error: `no option matching "${label}"` };

    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (setter) setter.call(el, match.value);
    else el.value = match.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await C.tick(20);
    return { ok: true, value: C.clean(match.textContent) };
  }

  /* ---------------------------------------------------------------- *
   * Dates
   * ---------------------------------------------------------------- */

  /**
   * Type a date into an antd picker and commit it with Enter.
   *
   * The picker's display format is a prop, invisible from the DOM, so the
   * portals' common formats are tried in turn until one commits.
   *
   * What counts as "committed" is the whole difficulty. Text left in the box
   * proves nothing: antd keeps whatever you typed while the field still has
   * focus, and clientV2 has date fields whose placeholder contradicts their
   * own format — `doj` renders `format: 'DD-MMM-YYYY'` under a
   * `placeholder: 'DD-MM-YYYY'` — so typing what the placeholder asks for
   * leaves `01-08-2023` sitting in a picker that parsed nothing, never fired
   * `onChange`, and left Formik holding null. The form then looked filled and
   * failed validation on submit. So the commit is verified against the
   * picker's own state instead, and a date that never lands is reported.
   */
  async function fillDate(field, iso, { datetime = false } = {}) {
    const root = field._entry.el;
    const input = root.querySelector('input');
    if (!input) return { ok: false, error: 'the picker has no input' };

    const formats = datetime ? DATETIME_FORMATS : DATE_FORMATS;
    const hinted = guessFormatFromPlaceholder(input.getAttribute('placeholder'));
    const ordered = hinted ? [hinted, ...formats.filter((f) => f !== hinted)] : formats;

    for (const fmt of ordered) {
      const text = C.formatDate(iso, fmt);
      if (!text) continue;

      await clearPicker(root, input);

      C.realClick(input);
      input.focus();
      await C.tick(70);
      C.setNativeValue(input, text);
      await C.tick(90);
      C.pressEnter(input);
      await C.tick(110);
      C.blur(input);
      await C.tick(60);

      if (await pickerHasValue(root, input)) {
        return { ok: true, value: input.value || text };
      }
    }

    // Nothing committed. Clear the last attempt's text: leaving it would show
    // a filled-looking field the app considers empty.
    await clearPicker(root, input);
    return {
      ok: false,
      error: `could not enter ${iso} — the calendar rejected every format tried (the date may be outside its allowed range)`,
    };
  }

  /**
   * Did the picker actually take a value?
   *
   * rc-picker renders the clear affordance only when one is committed
   * (`showClear = clearIcon && value.length`) — true of antd 5 and antd 6
   * alike, and independent of what text the input happens to be showing.
   * `allowClear={false}` removes that signal, so the panel is asked instead:
   * a real value paints a selected cell, rejected text paints none.
   */
  async function pickerHasValue(root, input) {
    if (root.querySelector('.ant-picker-clear')) return true;
    if (!input.value) return false;

    C.realClick(input);
    await C.tick(180);
    const panel = openPickerDropdown();
    const selected = !!panel?.querySelector('.ant-picker-cell-selected');
    C.pressEscape(input);
    C.blur(input);
    await C.tick(60);
    return selected;
  }

  /** Empty the box and dismiss any panel, so the next attempt starts clean. */
  async function clearPicker(root, input) {
    if (!input.value && !openPickerDropdown()) return;
    C.pressEscape(input);
    await C.tick(40);
    C.setNativeValue(input, '');
    await C.tick(40);
    C.blur(input);
    await C.tick(40);
  }

  async function fillDateRange(field, iso) {
    const [startIso, endIso] = String(iso).split('..').map((s) => s.trim());
    if (!startIso || !endIso) {
      return { ok: false, error: 'expected "YYYY-MM-DD..YYYY-MM-DD"' };
    }

    const root = field._entry.el;
    const inputs = [...root.querySelectorAll('input')];
    if (inputs.length < 2) return { ok: false, error: 'the range picker has no second input' };

    const hinted = guessFormatFromPlaceholder(inputs[0].getAttribute('placeholder'));
    const ordered = hinted ? [hinted, ...DATE_FORMATS.filter((f) => f !== hinted)] : DATE_FORMATS;

    for (const fmt of ordered) {
      const a = C.formatDate(startIso, fmt);
      const b = C.formatDate(endIso, fmt);
      if (!a || !b) continue;

      C.realClick(inputs[0]);
      inputs[0].focus();
      await C.tick(80);
      C.setNativeValue(inputs[0], a);
      await C.tick(70);
      C.pressEnter(inputs[0]);
      await C.tick(110);

      C.setNativeValue(inputs[1], b);
      await C.tick(70);
      C.pressEnter(inputs[1]);
      await C.tick(110);
      C.blur(inputs[1]);
      await C.tick(40);

      // Both ends must show text *and* the picker must hold a value — typed
      // text alone survives a parse failure (see `fillDate`).
      if (inputs[0].value && inputs[1].value && root.querySelector('.ant-picker-clear')) {
        return { ok: true, value: `${inputs[0].value} .. ${inputs[1].value}` };
      }
      C.setNativeValue(inputs[0], '');
      C.setNativeValue(inputs[1], '');
      C.pressEscape(inputs[0]);
      await C.tick(40);
    }

    return { ok: false, error: 'the range picker rejected both formats tried' };
  }

  /** The open calendar panel, if there is one. Only ever one at a time. */
  const openPickerDropdown = () =>
    [...document.querySelectorAll('.ant-picker-dropdown')].find(
      (d) => !d.classList.contains('ant-picker-dropdown-hidden') && C.isVisible(d),
    ) || null;

  /** antd falls back to the format string as the placeholder when none is set. */
  function guessFormatFromPlaceholder(ph) {
    if (!ph) return null;
    return /^[DMYHms/\-:. ]+$/.test(ph.trim()) && /[DMY]/.test(ph) ? ph.trim() : null;
  }

  /* ---------------------------------------------------------------- *
   * Booleans and radios
   * ---------------------------------------------------------------- */

  async function fillCheckbox(field, want) {
    const el = S().innerInput(field._entry);
    const desired = Boolean(want);
    if (el.checked !== desired) {
      C.realClick(el);
      await C.tick(50);
    }
    if (el.checked !== desired) {
      // Some wrappers only respond to a click on the visible label.
      const label = el.closest('label');
      if (label) {
        C.realClick(label);
        await C.tick(50);
      }
    }
    return el.checked === desired
      ? { ok: true, value: el.checked }
      : { ok: false, error: 'the checkbox would not toggle' };
  }

  async function fillSwitch(field, want) {
    const el = field._entry.el;
    const desired = Boolean(want);
    const current = el.getAttribute('aria-checked') === 'true';
    if (current !== desired) {
      C.realClick(el);
      await C.tick(60);
    }
    const now = el.getAttribute('aria-checked') === 'true';
    return now === desired ? { ok: true, value: now } : { ok: false, error: 'the switch would not toggle' };
  }

  async function fillRadio(field, label) {
    const root = field._entry.el;
    const wrappers = [...root.querySelectorAll('label.ant-radio-wrapper, label')].filter(
      (l) => !l.classList.contains('ant-radio-wrapper-disabled'),
    );
    const target = String(label).toLowerCase();
    const match =
      wrappers.find((l) => C.clean(l.textContent).toLowerCase() === target) ||
      wrappers.find((l) => C.clean(l.textContent).toLowerCase().includes(target)) ||
      wrappers[0];

    if (!match) return { ok: false, error: `no radio option matching "${label}"` };

    const input = match.querySelector('input');
    C.realClick(input || match);
    await C.tick(60);

    if (input && !input.checked) {
      C.realClick(match);
      await C.tick(60);
    }
    return input?.checked
      ? { ok: true, value: C.clean(match.textContent) }
      : { ok: false, error: 'the radio would not select' };
  }

  async function fillCheckboxGroup(field, labels) {
    const root = field._entry.el;
    const wrappers = [...root.querySelectorAll('label.ant-checkbox-wrapper')];
    const picked = [];
    for (const label of labels) {
      const target = String(label).toLowerCase();
      const match =
        wrappers.find((l) => C.clean(l.textContent).toLowerCase() === target) ||
        wrappers.find((l) => C.clean(l.textContent).toLowerCase().includes(target));
      if (!match) continue;
      const input = match.querySelector('input');
      if (input && !input.checked) {
        C.realClick(input);
        await C.tick(45);
      }
      picked.push(C.clean(match.textContent));
    }
    return picked.length
      ? { ok: true, value: picked.join(', ') }
      : { ok: false, error: 'none of the options matched' };
  }

  /* ---------------------------------------------------------------- *
   * Dispatch
   * ---------------------------------------------------------------- */

  /** Resolve an instruction's option indexes into labels from the scan. */
  function labelsFrom(field, instruction) {
    const indexes = Array.isArray(instruction.optionIndexes)
      ? instruction.optionIndexes
      : instruction.optionIndex !== undefined && instruction.optionIndex !== null
        ? [instruction.optionIndex]
        : [];

    const labels = indexes
      .map((i) => field.options?.find((o) => o.i === Number(i))?.label)
      .filter(Boolean);

    // Some replies use a label instead of an index despite the instructions.
    if (!labels.length && typeof instruction.value === 'string' && instruction.value.trim()) {
      return [instruction.value.trim()];
    }
    if (!labels.length && Array.isArray(instruction.value)) {
      return instruction.value.map(String);
    }
    return labels;
  }

  async function applyOne(field, instruction) {
    if (instruction.skip) {
      return { ok: true, skipped: true, reason: String(instruction.skip).slice(0, 120) };
    }

    const kind = field.kind;

    try {
      switch (kind) {
        case 'select': {
          const labels = labelsFrom(field, instruction);
          if (!labels.length) return { ok: false, error: 'the model gave no option to pick' };
          if (field._entry.kind === 'native-select') return await fillNativeSelect(field, labels[0]);
          if (field._entry.kind === 'kp-establishment') {
            return await fillEstablishment(field, labels[0]);
          }
          return await fillSelect(field, labels.slice(0, 1));
        }
        case 'multiselect': {
          const labels = labelsFrom(field, instruction);
          if (!labels.length) return { ok: false, error: 'the model gave no options to pick' };
          if (field._entry.kind === 'antd-checkbox-group') {
            return await fillCheckboxGroup(field, labels);
          }
          return await fillSelect(field, labels.slice(0, 4), { multiple: true });
        }
        case 'radio': {
          const labels = labelsFrom(field, instruction);
          if (!labels.length) return { ok: false, error: 'the model gave no option to pick' };
          return await fillRadio(field, labels[0]);
        }
        case 'date':
          return await fillDate(field, instruction.value);
        case 'datetime':
          return await fillDate(field, instruction.value, { datetime: true });
        case 'daterange':
          return await fillDateRange(field, instruction.value);
        case 'checkbox':
          return await fillCheckbox(field, instruction.value);
        case 'switch':
          return await fillSwitch(field, instruction.value);
        default: {
          if (instruction.value === undefined || instruction.value === null) {
            return { ok: false, error: 'the model returned no value' };
          }
          return await fillText(field, instruction.value);
        }
      }
    } catch (err) {
      return { ok: false, error: `unexpected failure: ${err.message}` };
    }
  }

  /**
   * Fill every field in DOM order.
   *
   * Order matters: dependent dropdowns only populate once the field they
   * depend on has a value, so filling top-to-bottom is what makes
   * country → state and bank → branch resolve on the first pass.
   */
  async function apply(fields, plan, onProgress) {
    const results = [];
    let index = 0;

    for (const field of fields) {
      index += 1;
      const instruction = plan[field.uid];

      if (!instruction) {
        results.push({
          uid: field.uid,
          label: field.label,
          ok: false,
          error: 'the model did not return a value for this field',
        });
        continue;
      }

      const outcome = await applyOne(field, instruction);
      results.push({ uid: field.uid, label: field.label, kind: field.kind, ...outcome });

      onProgress?.({ index, total: fields.length, label: field.label });
      await C.tick(30);
    }

    return results;
  }

  /* ---------------------------------------------------------------- *
   * Reading validation errors back out of the page
   * ---------------------------------------------------------------- */

  /**
   * Harvest the messages the app itself rendered after our fill.
   *
   * Blurring each field marks it touched in Formik, so by this point any
   * failing Yup rule has painted its message next to the field. Attributing a
   * message back to a field is done by containment: the nearest wrapper that
   * holds both the message and exactly one of our controls.
   */
  function readErrors(fields) {
    const nodes = [
      ...document.querySelectorAll(
        '.c-field-container .error, .ant-form-item-explain-error, div.color-error',
      ),
    ];

    const out = [];
    for (const node of nodes) {
      if (!C.isVisible(node)) continue;
      const message = C.clean(node.textContent);
      // ThemeLabel's required marker is a `.color-error` span holding just "*".
      if (!message || message === '*' || message.length < 3) continue;

      const owner = ownerField(node, fields);
      out.push({
        uid: owner?.uid || null,
        label: owner?.label || '(unknown field)',
        message: message.slice(0, 200),
      });
    }

    // One message per field is enough for a retry.
    const seen = new Set();
    return out.filter((e) => {
      const key = `${e.uid}|${e.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function ownerField(errorNode, fields) {
    let node = errorNode.parentElement;
    for (let depth = 0; node && depth < 6; depth += 1) {
      const hits = fields.filter((f) => f._entry?.el && node.contains(f._entry.el));
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) return hits[0];
      node = node.parentElement;
    }
    return null;
  }

  KPAF.fill = { apply, readErrors };
})();
