/**
 * Form discovery and field classification.
 *
 * The output of `scan()` is the JSON the model sees, so this file decides both
 * what gets filled and how well the model understands it.
 *
 * The hard part is dropdowns. Ant Design's Select is not a `<select>`: the
 * chosen value is a database id that never appears in the DOM as text, and the
 * options live in a portal appended to <body> that only exists while the
 * dropdown is open. So the scanner physically opens each one, reads the
 * options out of the portal, and closes it again — which is why a scan takes a
 * second or two on a form with many dropdowns.
 */

(() => {
  if (window.KPAF?.scan) return;
  const KPAF = (window.KPAF = window.KPAF || {});
  const C = KPAF.core;

  /** Hard cap so a runaway page cannot hang the scan or blow the token budget. */
  const MAX_FIELDS = 80;
  const MAX_OPTIONS = 250;

  /* ---------------------------------------------------------------- *
   * Container detection
   * ---------------------------------------------------------------- */

  /**
   * Find the region that holds "the form the user is looking at".
   *
   * An open modal or drawer beats everything, because in these portals that is
   * almost always the thing you just opened in order to fill it. Only when
   * nothing is floating do we fall back to page-level forms.
   */
  function findContainer() {
    const visible = (el) => el && C.isVisible(el);

    // 1. Topmost open modal.
    const modals = [...document.querySelectorAll('.ant-modal-wrap')]
      .filter((w) => visible(w) && getComputedStyle(w).display !== 'none')
      .map((w) => w.querySelector('.ant-modal-content'))
      .filter(visible);
    if (modals.length) {
      return { el: modals[modals.length - 1], kind: 'modal' };
    }

    // 2. Open drawer.
    const drawer = [...document.querySelectorAll('.ant-drawer-open .ant-drawer-body')].filter(visible);
    if (drawer.length) return { el: drawer[drawer.length - 1], kind: 'drawer' };

    // 3. The page form with the most fillable controls.
    const forms = [...document.querySelectorAll('form, .c-form, .cc-form')].filter(visible);
    let best = null;
    let bestCount = 0;
    for (const f of forms) {
      const n = countCandidates(f);
      if (n > bestCount) {
        best = f;
        bestCount = n;
      }
    }
    if (best && bestCount > 0) return { el: best, kind: 'form' };

    // 4. Nothing structured — scan the page and lean on the noise filters.
    return { el: document.body, kind: 'page' };
  }

  function countCandidates(root) {
    return collectRoots(root).length;
  }

  /** A short human name for the detected container, shown in the popup. */
  function containerTitle(container) {
    const el = container.el;
    const t =
      el.querySelector('.ant-modal-title, .ant-drawer-title')?.textContent ||
      el.querySelector('.form-title, h1, h2, h3')?.textContent ||
      '';
    return C.clean(t).slice(0, 80);
  }

  /* ---------------------------------------------------------------- *
   * Candidate collection
   * ---------------------------------------------------------------- */

  /** Open portals are never part of the form, wherever they sit. */
  const ALWAYS_NOISE = [
    '.ant-select-dropdown',
    '.ant-picker-dropdown',
    '.ant-dropdown',
    '.ant-table-filter-dropdown',
  ].join(',');

  /** Page furniture: real noise, unless it happens to wrap our container. */
  const CHROME_NOISE = [
    'header',
    '.ant-layout-header',
    '.ant-table-thead',
    '.ant-pagination',
    '[role="search"]',
    'nav',
    '.sidebar',
    '.ant-menu',
  ].join(',');

  /** Floating layers. Only the one we picked counts. */
  const FLOATING = '.ant-modal-wrap, .ant-drawer';

  /**
   * Reject controls that are on screen but not part of the record.
   *
   * The subtlety is that the container we picked is often *inside* one of
   * these wrappers — a modal's fields all sit under `.ant-modal-wrap` — so an
   * ancestor match only means "noise" when that ancestor does not also
   * contain the container. Anything wrapping our container is just the shell
   * we deliberately chose.
   */
  function isNoise(el, container) {
    if (el.closest(ALWAYS_NOISE)) return true;

    const furniture = el.closest(CHROME_NOISE);
    if (furniture && !furniture.contains(container.el)) return true;

    const layer = el.closest(FLOATING);
    if (layer && !layer.contains(container.el)) return true;

    return false;
  }

  /**
   * Collect one entry per logical control.
   *
   * A single antd Select contains an `<input>`, so a naive querySelectorAll
   * would pick up both the widget and its inner input as separate fields.
   * Selects and pickers are therefore collected by their wrapper and their
   * inner inputs are excluded.
   */
  function collectRoots(root) {
    const out = [];
    const seen = new Set();

    const add = (el, kind) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      out.push({ el, kind });
    };

    for (const el of root.querySelectorAll('.ant-select')) {
      if (el.closest('.ant-select-dropdown')) continue;
      // A nested select inside another select's render is not its own field.
      if (el.parentElement?.closest('.ant-select') && el.parentElement.closest('.ant-select') !== el) {
        continue;
      }
      add(el, 'antd-select');
    }

    for (const el of root.querySelectorAll('.ant-picker')) {
      add(el, el.classList.contains('ant-picker-range') ? 'antd-range' : 'antd-picker');
    }

    for (const el of root.querySelectorAll('.ant-radio-group')) add(el, 'antd-radio');
    for (const el of root.querySelectorAll('.ant-switch')) add(el, 'antd-switch');

    for (const el of root.querySelectorAll('.ant-checkbox-input')) {
      if (el.closest('.ant-checkbox-group')) continue;
      add(el, 'checkbox');
    }
    for (const el of root.querySelectorAll('.ant-checkbox-group')) add(el, 'antd-checkbox-group');

    for (const el of root.querySelectorAll('textarea')) {
      if (el.closest('.ant-select, .ant-picker')) continue;
      add(el, 'textarea');
    }

    for (const el of root.querySelectorAll('select')) add(el, 'native-select');

    for (const el of root.querySelectorAll('input')) {
      if (el.closest('.ant-select, .ant-picker')) continue;
      const type = (el.type || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) continue;
      if (type === 'checkbox' || type === 'radio') {
        if (el.closest('.ant-checkbox-group, .ant-radio-group')) continue;
        add(el, type);
        continue;
      }
      add(el, 'text');
    }

    return out;
  }

  /* ---------------------------------------------------------------- *
   * Per-field description
   * ---------------------------------------------------------------- */

  /** Map the DOM control onto one of the kinds the prompt documents. */
  function kindOf(entry, el) {
    switch (entry.kind) {
      case 'antd-select':
        return el.classList.contains('ant-select-multiple') ? 'multiselect' : 'select';
      case 'antd-range':
        return 'daterange';
      case 'antd-picker':
        return el.querySelector('input')?.placeholder?.match(/time/i) ||
          el.classList.contains('ant-picker-show-time')
          ? 'datetime'
          : 'date';
      case 'antd-radio':
        return 'radio';
      case 'antd-switch':
        return 'switch';
      case 'antd-checkbox-group':
        return 'multiselect';
      case 'checkbox':
        return 'checkbox';
      case 'radio':
        return 'radio';
      case 'native-select':
        return 'select';
      case 'textarea':
        return 'textarea';
      default: {
        const t = (el.type || 'text').toLowerCase();
        if (t === 'email') return 'email';
        if (t === 'password') return 'password';
        if (t === 'number') return 'number';
        if (t === 'tel') return 'phone';
        if (t === 'date') return 'date';
        return 'text';
      }
    }
  }

  /** The `<input>` a control writes through, for reading/writing values. */
  function innerInput(entry) {
    const { el, kind } = entry;
    if (kind === 'antd-select') return el.querySelector('input.ant-select-selection-search-input');
    if (kind === 'antd-picker' || kind === 'antd-range') return el.querySelector('input');
    if (kind === 'antd-radio') return el.querySelector('input.ant-radio-input');
    if (kind === 'antd-switch') return el;
    if (kind === 'antd-checkbox-group') return el.querySelector('input.ant-checkbox-input');
    return el;
  }

  /**
   * Can this control actually be filled?
   *
   * Judged from the widget wrapper, never from the inner `<input>`: Ant Design
   * marks the search input of a Select `readonly` whenever `showSearch` is
   * off, so testing the input would skip every plain dropdown in the app.
   * The wrapper's own `-disabled` class is the honest signal.
   */
  function isEntryInteractive(entry) {
    const { el, kind } = entry;

    switch (kind) {
      case 'antd-select':
        return !el.classList.contains('ant-select-disabled');
      case 'antd-picker':
      case 'antd-range':
        // A read-only picker is still worth attempting; if typing is refused
        // the filler reports it rather than the scan silently dropping it.
        return !el.classList.contains('ant-picker-disabled');
      case 'antd-switch':
        return !el.disabled && !el.classList.contains('ant-switch-disabled');
      case 'antd-radio':
      case 'antd-checkbox-group':
        return [...el.querySelectorAll('input')].some((i) => !i.disabled);
      default:
        return C.isInteractive(el);
    }
  }

  /** Whatever is currently in the field, so we can skip the filled ones. */
  function currentValue(entry) {
    const { el, kind } = entry;
    switch (kind) {
      case 'antd-select': {
        const items = [...el.querySelectorAll('.ant-select-selection-item')]
          .map((n) => C.clean(n.getAttribute('title') || n.textContent))
          .filter(Boolean);
        return items.join(', ');
      }
      case 'antd-picker':
        return el.querySelector('input')?.value || '';
      case 'antd-range':
        return [...el.querySelectorAll('input')].map((i) => i.value).filter(Boolean).join(' .. ');
      case 'antd-switch':
        return el.getAttribute('aria-checked') === 'true';
      case 'antd-radio': {
        const checked = el.querySelector('input.ant-radio-input:checked');
        return checked ? C.clean(checked.closest('label')?.textContent || 'selected') : '';
      }
      case 'antd-checkbox-group':
        return [...el.querySelectorAll('input.ant-checkbox-input:checked')]
          .map((i) => C.clean(i.closest('label')?.textContent || ''))
          .join(', ');
      case 'checkbox':
      case 'radio':
        return el.checked;
      default:
        return el.value || '';
    }
  }

  function constraintsOf(input) {
    if (!input || input === undefined) return {};
    const c = {};
    const maxLength = Number(input.getAttribute?.('maxlength'));
    if (maxLength > 0) c.maxLength = maxLength;
    const minLength = Number(input.getAttribute?.('minlength'));
    if (minLength > 0) c.minLength = minLength;
    const min = input.getAttribute?.('min');
    if (min !== null && min !== undefined && min !== '') c.min = min;
    const max = input.getAttribute?.('max');
    if (max !== null && max !== undefined && max !== '') c.max = max;
    const pattern = input.getAttribute?.('pattern');
    if (pattern) c.pattern = pattern;
    return c;
  }

  /**
   * Required-ness, as far as the DOM admits it.
   *
   * Formik/Yup keeps `required` in JavaScript, so the only visible traces are
   * antd's own marker and clientV2's red asterisk from `ThemeLabel`.
   */
  function isRequired(el) {
    const input = el.querySelector?.('input, textarea') || el;
    if (input?.required || input?.getAttribute?.('aria-required') === 'true') return true;

    // Walk a bounded distance up. clientV2 puts the marker in a `.theme-label`
    // that is a sibling of the control's own wrapper, so `parentElement` alone
    // never reaches it — but going all the way to <body> would pick up the
    // asterisk belonging to a neighbouring field.
    let node = el;
    for (let depth = 0; node && depth < 5; depth += 1) {
      if (node.querySelector?.('.ant-form-item-required')) return true;

      const marker = node.querySelector?.('.theme-label .color-error');
      // Compare the raw text: `clean()` strips a trailing asterisk, which is
      // right for a label ("Company Name *") but erases the marker itself.
      if (marker && marker.textContent.trim() === '*') return true;

      if (node.matches?.('.ant-form-item, .c-field-container, .cc-form__field')) break;
      // Once the subtree holds more than one control we have left this
      // field's own wrapper and would start reading a neighbour's marker.
      if (depth > 0 && node.querySelectorAll?.('input, textarea, .ant-select').length > 1) break;
      node = node.parentElement;
    }
    return false;
  }

  /* ---------------------------------------------------------------- *
   * Dropdown options
   * ---------------------------------------------------------------- */

  /** Locate the portal that belongs to a given antd Select. */
  function dropdownFor(selectEl) {
    const input = selectEl.querySelector('input.ant-select-selection-search-input');
    const listId = input?.getAttribute('aria-controls');
    if (listId) {
      const list = document.getElementById(listId);
      const dd = list?.closest('.ant-select-dropdown');
      if (dd) return dd;
    }
    // Fallback: the most recently opened, still-visible dropdown.
    const open = [...document.querySelectorAll('.ant-select-dropdown')].filter(
      (d) => !d.classList.contains('ant-select-dropdown-hidden'),
    );
    return open[open.length - 1] || null;
  }

  /**
   * Read a Select's options by opening it.
   *
   * rc-virtual-list only renders the visible slice, so long lists (banks,
   * nationalities, employers) have to be scrolled to be enumerated. We walk
   * the viewport down in screenfuls until nothing new appears.
   */
  async function readSelectOptions(selectEl) {
    const opener = selectEl.querySelector('.ant-select-selector') || selectEl;
    C.realClick(opener);
    await C.tick(120);

    const dd = dropdownFor(selectEl);
    if (!dd) {
      C.pressEscape(selectEl.querySelector('input') || selectEl);
      return { options: [], note: 'dropdown did not open' };
    }

    const seen = new Map();
    const harvest = () => {
      for (const node of dd.querySelectorAll('.ant-select-item-option')) {
        const label = C.clean(node.getAttribute('title') || node.textContent);
        if (!label) continue;
        if (node.classList.contains('ant-select-item-option-disabled')) continue;
        if (!seen.has(label)) seen.set(label, { label });
      }
    };

    harvest();

    const holder = dd.querySelector('.rc-virtual-list-holder');
    if (holder && holder.scrollHeight > holder.clientHeight) {
      let guard = 0;
      let lastTop = -1;
      while (guard < 40 && seen.size < MAX_OPTIONS) {
        guard += 1;
        if (holder.scrollTop === lastTop) break;
        lastTop = holder.scrollTop;
        holder.scrollTop += Math.max(holder.clientHeight - 8, 40);
        holder.dispatchEvent(new Event('scroll', { bubbles: true }));
        await C.tick(35);
        harvest();
        if (holder.scrollTop + holder.clientHeight >= holder.scrollHeight - 2) {
          harvest();
          break;
        }
      }
      holder.scrollTop = 0;
      holder.dispatchEvent(new Event('scroll', { bubbles: true }));
    }

    // Close without selecting anything.
    C.pressEscape(selectEl.querySelector('input') || selectEl);
    C.realClick(document.body);
    await C.tick(60);

    const options = [...seen.values()]
      .map((o, i) => ({ i, label: o.label }))
      // The v1 CField renders a blank placeholder option; it is not a choice.
      .filter((o) => o.label && o.label.length > 0);

    return { options: options.slice(0, MAX_OPTIONS) };
  }

  function readStaticOptions(entry) {
    const { el, kind } = entry;
    if (kind === 'native-select') {
      return [...el.options]
        .filter((o) => !o.disabled && o.value !== '')
        .map((o, i) => ({ i, label: C.clean(o.textContent) || o.value }));
    }
    if (kind === 'antd-radio') {
      return [...el.querySelectorAll('label.ant-radio-wrapper')]
        .filter((l) => !l.classList.contains('ant-radio-wrapper-disabled'))
        .map((l, i) => ({ i, label: C.clean(l.textContent) }));
    }
    if (kind === 'antd-checkbox-group') {
      return [...el.querySelectorAll('label.ant-checkbox-wrapper')]
        .filter((l) => !l.classList.contains('ant-checkbox-wrapper-disabled'))
        .map((l, i) => ({ i, label: C.clean(l.textContent) }));
    }
    return [];
  }

  /* ---------------------------------------------------------------- *
   * Noise rejection
   * ---------------------------------------------------------------- */

  /**
   * Drop controls that are on the page but are not part of the record being
   * created — table search boxes being the common one when we fall back to a
   * page-level scan.
   */
  function looksLikeSearch(label, placeholder, container) {
    if (container.kind === 'modal' || container.kind === 'drawer') return false;
    const text = `${label} ${placeholder}`.toLowerCase();
    return /^\s*search\b|search by|filter\b|quick find/.test(text);
  }

  /* ---------------------------------------------------------------- *
   * Entry point
   * ---------------------------------------------------------------- */

  async function scan({ overwrite = false } = {}) {
    const container = findContainer();
    const entries = collectRoots(container.el).filter(
      (e) => C.isVisible(e.el) && !isNoise(e.el, container),
    );

    const fields = [];
    const skipped = [];
    let uid = 0;

    for (const entry of entries) {
      if (fields.length >= MAX_FIELDS) {
        skipped.push({ label: '(remaining fields)', reason: `field cap of ${MAX_FIELDS} reached` });
        break;
      }

      const el = entry.el;
      const input = innerInput(entry);
      const kind = kindOf(entry, el);
      const label = C.labelFor(input && input.getAttribute ? input : el) || C.labelFor(el);
      const placeholder =
        el.querySelector?.('input, textarea')?.getAttribute('placeholder') ||
        el.getAttribute?.('placeholder') ||
        el.querySelector?.('.ant-select-selection-placeholder')?.textContent ||
        '';

      if (!isEntryInteractive(entry)) {
        skipped.push({ label: label || '(unlabelled)', reason: 'disabled or read-only' });
        continue;
      }

      if (looksLikeSearch(label, placeholder, container)) {
        skipped.push({ label: label || '(unlabelled)', reason: 'looks like a search/filter box' });
        continue;
      }

      const existing = currentValue(entry);
      const hasValue =
        typeof existing === 'boolean' ? false : Boolean(existing && String(existing).trim());
      if (hasValue && !overwrite) {
        skipped.push({ label: label || '(unlabelled)', reason: `already filled: "${String(existing).slice(0, 30)}"` });
        continue;
      }

      const field = {
        uid: `f${++uid}`,
        kind,
        label,
        name: input?.getAttribute?.('name') || el.getAttribute?.('name') || '',
        id: input?.id && input.id !== 'theme-input-id' ? input.id : '',
        placeholder: C.clean(placeholder),
        section: C.sectionFor(el),
        required: isRequired(el),
        constraints: constraintsOf(input),
        options: [],
        // Kept only in the page; never sent to the model.
        _entry: entry,
      };

      if (kind === 'date' || kind === 'datetime' || kind === 'daterange') {
        field.dateHint = C.dateHintFor(`${label} ${placeholder}`);
      }

      if (kind === 'select' || kind === 'multiselect') {
        if (entry.kind === 'antd-select') {
          const { options, note } = await readSelectOptions(el);
          field.options = options;
          if (note) field.scanNote = note;
          if (!options.length) {
            skipped.push({
              label: label || '(unlabelled)',
              reason: note || 'dropdown has no selectable options yet',
            });
            uid -= 1;
            continue;
          }
        } else {
          field.options = readStaticOptions(entry);
        }
      } else if (kind === 'radio') {
        field.options = readStaticOptions(entry);
        if (!field.options.length) {
          skipped.push({ label: label || '(unlabelled)', reason: 'radio group has no options' });
          uid -= 1;
          continue;
        }
      }

      fields.push(field);
    }

    return {
      container: { kind: container.kind, title: containerTitle(container) },
      fields,
      skipped,
      pageTitle: document.title,
      url: location.href,
    };
  }

  KPAF.scan = { scan, findContainer, dropdownFor, innerInput, currentValue };
})();
