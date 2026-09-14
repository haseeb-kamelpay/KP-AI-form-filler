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

  /** Anything that calls itself a dialog without using antd's markup. */
  const GENERIC_DIALOG = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]';

  /**
   * Every layer currently floating above the page.
   *
   * Two generations of class names have to be recognised at once. Ant Design 6
   * renamed the modal panel `-content` to `-container` and the drawer panel
   * `-content` to `-section`, and the portals straddle that release: admin and
   * employer v1 are on antd 5, employer v2 on antd 6. Matching both is what
   * keeps one scanner working across all three. The generic `role="dialog"`
   * pass at the end catches custom and non-antd surfaces.
   *
   * `el` is the region the form lives in and `shell` is the whole layer — the
   * title sits outside the panel in a drawer, and the stacking order is set on
   * the layer, not the panel.
   *
   * `blocking` marks a surface that covers the page. A modal or a drawer is
   * the target even when it turns out to hold no fields, because the form
   * behind it is unreachable and filling it unseen would be worse than
   * reporting nothing. A popover or a dropdown is transient and usually just a
   * menu, so it only takes over when it actually holds something fillable.
   */
  function floatingSurfaces() {
    const found = [];

    const add = (el, shell, kind, blocking) => {
      if (!el || !C.isVisible(el)) return;
      // One layer is reachable through several selectors — an antd modal panel
      // also carries `role="dialog"` on its parent. Keep the first, most
      // specific hit and ignore anything that nests with it.
      if (found.some((s) => s.el === el || s.el.contains(el) || el.contains(s.el))) return;
      found.push({ el, shell: shell || el, kind, blocking, floating: true });
    };

    for (const wrap of document.querySelectorAll('.ant-modal-wrap')) {
      add(wrap.querySelector('.ant-modal-container, .ant-modal-content'), wrap, 'modal', true);
    }

    for (const root of document.querySelectorAll('.ant-drawer-open')) {
      // The body, not the whole panel: a drawer's header holds the `extra`
      // slot, which is where these portals put bulk-action toolbars.
      const body =
        root.querySelector('.ant-drawer-body') ||
        root.querySelector('.ant-drawer-section, .ant-drawer-content');
      add(body, root, 'drawer', true);
    }

    for (const dialog of document.querySelectorAll('dialog[open]')) {
      add(dialog, dialog, 'dialog', true);
    }

    // `dropdownRender` and the column-filter popovers put real inputs in here.
    for (const pop of document.querySelectorAll('.ant-popover')) {
      add(pop.querySelector('.ant-popover-inner') || pop, pop, 'popover', false);
    }
    for (const dd of document.querySelectorAll('.ant-dropdown')) {
      add(dd, dd, 'dropdown', false);
    }

    for (const el of document.querySelectorAll(GENERIC_DIALOG)) {
      add(el, el, 'dialog', false);
    }

    return found;
  }

  /**
   * The stacking level a layer paints at.
   *
   * antd writes a z-index onto each layer as it opens, so a modal launched
   * from a drawer — or a second modal stacked on the first — sits higher than
   * the thing that opened it. Reading it back is how we pick the one the user
   * is actually looking at rather than the one that happens to be last in the
   * DOM.
   */
  function stackDepth(el) {
    let z = 0;
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const value = Number.parseInt(getComputedStyle(node).zIndex, 10);
      if (Number.isFinite(value) && value > z) z = value;
    }
    return z;
  }

  /** Highest layer wins; between layers at the same height, the later mount. */
  function topmost(surfaces) {
    let best = null;
    let bestZ = -Infinity;
    for (const surface of surfaces) {
      const z = stackDepth(surface.shell);
      const later =
        best &&
        (best.el.compareDocumentPosition(surface.el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      if (!best || z > bestZ || (z === bestZ && later)) {
        best = surface;
        bestZ = z;
      }
    }
    return best;
  }

  /**
   * Find the region that holds "the form the user is looking at".
   *
   * Anything floating beats everything, because in these portals a surface you
   * had to open is almost always the thing you opened in order to fill it.
   * Only when nothing is floating do we fall back to page-level forms.
   */
  function findContainer() {
    const surfaces = floatingSurfaces().filter(
      (s) => s.blocking || countCandidates(s.el) > 0,
    );
    const top = topmost(surfaces);
    if (top) return top;

    // The page form with the most fillable controls.
    const forms = [...document.querySelectorAll('form, .c-form, .cc-form')].filter((f) =>
      C.isVisible(f),
    );
    let best = null;
    let bestCount = 0;
    for (const f of forms) {
      const n = countCandidates(f);
      if (n > bestCount) {
        best = f;
        bestCount = n;
      }
    }
    if (best && bestCount > 0) return { el: best, shell: best, kind: 'form', floating: false };

    // Nothing structured — scan the page and lean on the noise filters.
    return { el: document.body, shell: document.body, kind: 'page', floating: false };
  }

  /**
   * How many fillable controls a region holds.
   *
   * Option portals are discounted: a table's filter dropdown is full of
   * inputs, and counting them would let it pose as a form worth filling.
   */
  function countCandidates(root) {
    return collectRoots(root).filter((e) => !e.el.closest(ALWAYS_NOISE)).length;
  }

  /** A short human name for the detected container, shown in the popup. */
  function containerTitle(container) {
    const shell = container.shell || container.el;
    const titled =
      shell.querySelector('.ant-modal-title, .ant-drawer-title, .ant-popover-title') ||
      container.el.querySelector('.form-title, h1, h2, h3');
    if (titled) {
      const t = C.clean(titled.textContent);
      if (t) return t.slice(0, 80);
    }
    // A custom dialog names itself through ARIA rather than a class.
    const aria =
      shell.getAttribute?.('aria-label') ||
      (shell.getAttribute?.('aria-labelledby') || '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ');
    return C.clean(aria).slice(0, 80);
  }

  /* ---------------------------------------------------------------- *
   * Candidate collection
   * ---------------------------------------------------------------- */

  /**
   * Portals that are never a form, wherever they sit.
   *
   * These hold a widget's own options or a table's filters, so their inputs
   * belong to a control we already collected rather than to the record. A
   * plain `.ant-dropdown` is deliberately absent: `dropdownRender` can put a
   * real form in one, so it is judged against the chosen container instead.
   */
  const ALWAYS_NOISE = [
    '.ant-select-dropdown',
    '.ant-picker-dropdown',
    '.ant-table-filter-dropdown',
    // clientV2's EstablishmentSelect portals its panel to <body>.
    '.establishment-select__panel',
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
  const FLOATING = [
    '.ant-modal-wrap',
    '.ant-drawer',
    '.ant-popover',
    '.ant-dropdown',
    'dialog',
    GENERIC_DIALOG,
  ].join(',');

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

    // clientV2's EstablishmentSelect is not an antd Select at all: a custom
    // `div[role=combobox]` face over a portalled panel of rows.
    for (const el of root.querySelectorAll('.establishment-select')) {
      add(el, 'kp-establishment');
    }

    for (const el of root.querySelectorAll('.ant-select')) {
      if (el.closest('.ant-select-dropdown')) continue;
      // A nested select inside another select's render is not its own field.
      if (el.parentElement?.closest('.ant-select') && el.parentElement.closest('.ant-select') !== el) {
        continue;
      }
      // A select sitting in another input's prefix/suffix decorates that input
      // — v2's Full Name carries the Mr./Ms. title select in its prefix — so it
      // is the host field's ornament, not a field of its own. Collected anyway
      // so the scan can say why it was left alone.
      if (el.closest('.ant-input-prefix, .ant-input-suffix')) {
        add(el, 'affix-select');
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
      if (el.closest('.ant-select, .ant-picker, .establishment-select')) continue;
      add(el, 'textarea');
    }

    for (const el of root.querySelectorAll('select')) add(el, 'native-select');

    for (const el of root.querySelectorAll('input')) {
      if (el.closest('.ant-select, .ant-picker, .establishment-select')) continue;
      const type = (el.type || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) continue;
      if (type === 'checkbox' || type === 'radio') {
        if (el.closest('.ant-checkbox-group, .ant-radio-group')) continue;
        add(el, type);
        continue;
      }
      add(el, 'text');
    }

    // Fill order follows the page, not the order these selectors happened to
    // run in: dependent controls (state after country, branch after bank,
    // document number after document type) only settle once the field above
    // them has a value.
    out.sort((a, b) => {
      if (a.el === b.el) return 0;
      return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    return out;
  }

  /* ---------------------------------------------------------------- *
   * Per-field description
   * ---------------------------------------------------------------- */

  /** Map the DOM control onto one of the kinds the prompt documents. */
  function kindOf(entry, el) {
    switch (entry.kind) {
      case 'kp-establishment':
        return 'select';
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
    if (kind === 'kp-establishment') return el.querySelector('.establishment-select__face') || el;
    if (kind === 'antd-select' || kind === 'affix-select') return searchInputFor(el);
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
      case 'kp-establishment': {
        const face = el.querySelector('.establishment-select__face');
        return !!face && !face.classList.contains('establishment-select__face--disabled');
      }
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
      case 'affix-select':
      case 'antd-select':
        return selectedLabels(el).join(', ');
      case 'kp-establishment':
        return establishmentValue(el);
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
   * Reading an antd Select, across antd 5 and antd 6
   * ---------------------------------------------------------------- */

  /**
   * antd 6 rebuilt the Select's internals, and the old selectors are gone:
   *
   *   antd 5  .ant-select-selector > .ant-select-selection-item
   *           input.ant-select-selection-search-input
   *   antd 6  .ant-select-content(.ant-select-content-has-value)[title]
   *           input.ant-select-input
   *
   * In antd 6 a single select's chosen label is a bare text node inside
   * `-content` — there is no element wrapping it — so the `-has-value` class
   * and the `title` attribute are the handles. Multiple mode still renders one
   * `-selection-item` per chip in both versions.
   *
   * Every read goes through here so clientV2 (antd 6) and the v1 portals
   * (antd 5) are both answered correctly. Getting this wrong is what made a
   * dropdown that filled perfectly report "the selection did not stick".
   */
  function selectedLabels(el) {
    const chips = [...el.querySelectorAll('.ant-select-selection-item')]
      .map((n) => C.clean(n.getAttribute('title') || n.textContent))
      .filter(Boolean);
    if (chips.length) return chips;

    const content = el.querySelector('.ant-select-content-has-value');
    if (!content) return [];
    // `title` is the option's own label; the text fallback covers a custom
    // `optionRender` where antd leaves the attribute off.
    const label = C.clean(content.getAttribute('title') || content.textContent);
    return label ? [label] : [];
  }

  /** The Select's search box, under either antd's class name. */
  const searchInputFor = (el) =>
    el.querySelector('input.ant-select-selection-search-input, input.ant-select-input');

  /** The element that opens the Select when clicked. */
  const selectOpener = (el) =>
    el.querySelector(':scope > .ant-select-selector') ||
    el.querySelector(':scope > .ant-select-content') ||
    el;

  /* ---------------------------------------------------------------- *
   * EstablishmentSelect (clientV2)
   * ---------------------------------------------------------------- */

  const establishmentFace = (el) => el.querySelector('.establishment-select__face');

  /** The selected business unit(s), read off the trigger face. */
  function establishmentValue(el) {
    const chips = [...el.querySelectorAll('.establishment-select__chip')]
      .map((n) => C.clean(n.textContent))
      .filter(Boolean);
    if (chips.length) return chips.join(', ');
    return C.clean(el.querySelector('.establishment-select__value')?.textContent || '');
  }

  /**
   * The open panel. It is portalled to <body>, and nothing on it points back at
   * the select that opened it, so the only safe rule is: at most one panel is
   * ever open, so a visible one belongs to whatever we just clicked.
   */
  function establishmentPanel() {
    return (
      [...document.querySelectorAll('.establishment-select__panel')].find(
        (p) => C.isVisible(p) && !p.closest('.ant-dropdown-hidden'),
      ) || null
    );
  }

  /** Selectable rows in the panel, labelled by company name. */
  function establishmentRows(panel) {
    if (!panel) return [];
    return [...panel.querySelectorAll('.establishment-select__row')]
      .filter((row) => !row.classList.contains('establishment-select__row--disabled'))
      .map((row) => ({
        el: row,
        label: C.clean(
          row.querySelector('.entity-info__title')?.textContent || row.textContent,
        ),
      }))
      .filter((row) => row.label);
  }

  /**
   * Open the establishment panel and read its rows.
   *
   * The hierarchy renders expanded by default, so every unit is present
   * without having to drive the expand chevrons.
   */
  async function readEstablishmentOptions(el) {
    const face = establishmentFace(el);
    if (!face) return { options: [], note: 'the business unit selector has no trigger' };

    C.realClick(face);
    await C.tick(160);

    let panel = establishmentPanel();
    if (!panel) {
      // The panel mounts lazily the first time it is opened.
      await C.tick(220);
      panel = establishmentPanel();
    }
    if (!panel) return { options: [], note: 'the business unit panel did not open' };

    const rows = establishmentRows(panel);
    const options = rows.slice(0, MAX_OPTIONS).map((row, i) => ({ i, label: row.label }));

    C.pressEscape(face);
    C.realClick(document.body);
    await C.tick(80);

    if (!options.length) {
      return { options: [], note: 'no business units are available to pick' };
    }
    return { options };
  }

  /* ---------------------------------------------------------------- *
   * Dropdown options
   * ---------------------------------------------------------------- */

  /** Locate the portal that belongs to a given antd Select. */
  function dropdownFor(selectEl) {
    const input = searchInputFor(selectEl);
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
  async function readSelectOptions(selectEl, { label, placeholder } = {}) {
    const opener = selectOpener(selectEl);
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
        const text = C.clean(node.getAttribute('title') || node.textContent);
        if (!text) continue;
        if (node.classList.contains('ant-select-item-option-disabled')) continue;
        // v1's blank `<Select.Option value="">` — picking it writes '' and
        // fails the field's own required rule.
        if (C.isPlaceholderChoice(text, label) || (placeholder && text === C.clean(placeholder))) {
          continue;
        }
        if (!seen.has(text)) seen.set(text, { label: text });
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
    // Inside a surface the user had to open, every control is there on
    // purpose — including the search box of a filter popover.
    if (container.floating) return false;
    const text = `${label} ${placeholder}`.toLowerCase();
    return /^\s*search\b|search by|filter\b|quick find/.test(text);
  }

  /* ---------------------------------------------------------------- *
   * Entry point
   * ---------------------------------------------------------------- */

  /**
   * The container the last scan settled on.
   *
   * Kept so the fill step can read validation messages out of the same region
   * rather than the whole document — with a modal open, the page behind it is
   * usually still showing errors of its own.
   */
  let lastContainer = null;

  async function scan({ overwrite = false } = {}) {
    const container = findContainer();
    lastContainer = container;
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
        // antd 5, then antd 6, then clientV2's own establishment selector.
        el.querySelector?.('.ant-select-selection-placeholder')?.textContent ||
        el.querySelector?.('.ant-select-placeholder')?.textContent ||
        el.querySelector?.('.establishment-select__placeholder')?.textContent ||
        '';

      if (entry.kind === 'affix-select') {
        skipped.push({
          label: label || '(unlabelled)',
          reason: 'a selector inside another field\u2019s input (left as the app set it)',
        });
        continue;
      }

      if (!isEntryInteractive(entry)) {
        skipped.push({ label: label || '(unlabelled)', reason: 'disabled or read-only' });
        continue;
      }

      if (looksLikeSearch(label, placeholder, container)) {
        skipped.push({ label: label || '(unlabelled)', reason: 'looks like a search/filter box' });
        continue;
      }

      const existing = currentValue(entry);
      const isDropdown = kind === 'select' || kind === 'multiselect';
      const hasValue =
        typeof existing === 'boolean'
          ? false
          : Boolean(existing && String(existing).trim()) &&
            !(isDropdown && C.isPlaceholderChoice(existing, label));
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
        if (entry.kind === 'antd-select' || entry.kind === 'kp-establishment') {
          const { options, note } =
            entry.kind === 'kp-establishment'
              ? await readEstablishmentOptions(el)
              : await readSelectOptions(el, { label, placeholder });
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

  KPAF.scan = {
    scan,
    findContainer,
    dropdownFor,
    innerInput,
    currentValue,
    selectedLabels,
    searchInputFor,
    selectOpener,
    establishmentFace,
    establishmentValue,
    establishmentPanel,
    establishmentRows,
    lastContainer: () => lastContainer,
  };
})();
