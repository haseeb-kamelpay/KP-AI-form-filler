/**
 * Shared DOM plumbing for the scanner and the filler.
 *
 * Everything here has to work against React-controlled Ant Design widgets,
 * which rules out the obvious approaches: assigning `.value` is swallowed by
 * React's value tracker, and `.click()` on a styled div does nothing because
 * rc-select listens for `mousedown`. The helpers below are the versions that
 * actually move the component's state.
 */

(() => {
  if (window.KPAF?.core) return; // injected once per run; keep the first copy
  const KPAF = (window.KPAF = window.KPAF || {});

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Let React flush, then let antd's animations settle. */
  const tick = (ms = 40) => sleep(ms);

  /* ---------------------------------------------------------------- *
   * Visibility
   * ---------------------------------------------------------------- */

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      // antd hides the real <input> of checkboxes and radios behind a styled
      // span, so a zero box is not proof the control is unavailable.
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (!el.offsetParent && style.position !== 'fixed') return false;
    }
    let node = el;
    while (node && node !== document.body) {
      if (node.nodeType === 1) {
        const s = getComputedStyle(node);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        if (node.hasAttribute('aria-hidden') && node.getAttribute('aria-hidden') === 'true') {
          return false;
        }
      }
      node = node.parentElement;
    }
    return true;
  }

  function isInteractive(el) {
    if (!el) return false;
    if (el.disabled || el.readOnly) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.closest('[disabled], .ant-select-disabled, .ant-picker-disabled, .ant-input-disabled')) {
      return false;
    }
    return true;
  }

  /* ---------------------------------------------------------------- *
   * React-aware value setting
   * ---------------------------------------------------------------- */

  /**
   * Write a value into a React-controlled input so the component sees it.
   *
   * React stores the last value it rendered on `_valueTracker` and drops any
   * input event whose value matches. Rewinding the tracker to the previous
   * value before dispatching is what makes React treat this as a real edit.
   */
  function setNativeValue(el, value) {
    const previous = el.value;
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;

    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;

    const tracker = el._valueTracker;
    if (tracker) tracker.setValue(previous);

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** A full pointer sequence. rc-select and rc-picker key off mousedown. */
  function realClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function pressKey(el, key, keyCode) {
    const init = { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  const pressEnter = (el) => pressKey(el, 'Enter', 13);
  const pressEscape = (el) => pressKey(el, 'Escape', 27);

  /** Formik marks a field touched on blur, which is what reveals its error. */
  function blur(el) {
    el.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    if (typeof el.blur === 'function') el.blur();
  }

  /* ---------------------------------------------------------------- *
   * Labels
   * ---------------------------------------------------------------- */

  const clean = (s) =>
    (s || '')
      .replace(/\s+/g, ' ')
      .replace(/[*:]\s*$/, '')
      .trim();

  /**
   * Resolve a human label, trying each portal's own convention in turn.
   *
   * client/admin + client/employer render `<div class="input-title">` inside
   * `.c-field`; clientV2 renders `<div class="theme-label">` as a sibling
   * above the control. Neither uses a real `<label for>`, so the generic
   * strategies sit at the bottom as a fallback for stray antd Form items.
   */
  function labelFor(el) {
    // 1. A real label association, when one exists.
    if (el.id) {
      const lbl = labelElementFor(el.id);
      if (lbl) {
        const t = clean(lbl.textContent);
        if (t) return t;
      }
    }

    const wrapper =
      el.closest('.c-field-container') ||
      el.closest('.ant-form-item') ||
      el.closest('.cc-form__field') ||
      null;

    // 2. v1 portals: .input-title inside the c-field wrapper.
    if (wrapper) {
      const title = wrapper.querySelector('.input-title');
      if (title) {
        const t = clean(title.textContent);
        if (t) return t;
      }
      const antLabel = wrapper.querySelector('.ant-form-item-label label');
      if (antLabel) {
        const t = clean(antLabel.textContent);
        if (t) return t;
      }
    }

    // 3. clientV2: .theme-label, emitted by ThemeLabel just above the control.
    const themed = nearestThemeLabel(el);
    if (themed) return themed;

    // 4. A wrapping <label>. This is the whole story for checkboxes and
    //    radios, where the text sits beside the box inside
    //    `label.ant-checkbox-wrapper` and there is no separate title element.
    const ownLabel = el.closest('label');
    if (ownLabel) {
      const t = clean(ownLabel.textContent);
      if (t) return t;
    }

    // 5. Generic accessible names.
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ');
      const t = clean(parts);
      if (t) return t;
    }

    const ph = el.getAttribute('placeholder');
    if (ph) return clean(ph);

    // 6. Last resort: humanise the field name.
    const name = el.getAttribute('name') || el.id || '';
    return humanise(name);
  }

  /**
   * Find `<label for=id>` without building a selector.
   *
   * Formik field names legitimately contain dots and brackets
   * (`properties.0.documentNumber`), which are selector syntax. Comparing the
   * attribute directly sidesteps both the escaping and any question of
   * whether `CSS.escape` exists in the host.
   */
  function labelElementFor(id) {
    for (const label of document.getElementsByTagName('label')) {
      if (label.getAttribute('for') === id) return label;
    }
    return null;
  }

  /**
   * Walk up a few levels looking for a `.theme-label` that belongs to this
   * control. Bounded, because going all the way to <body> starts picking up
   * the label of whatever field happens to be above this one in the grid.
   */
  function nearestThemeLabel(el) {
    let node = el;
    for (let depth = 0; node && depth < 5; depth += 1) {
      const parent = node.parentElement;
      if (!parent) break;
      const label = parent.querySelector(':scope > .theme-label');
      if (label) {
        const t = clean(label.textContent);
        if (t) return t;
      }
      node = parent;
    }
    return '';
  }

  function humanise(name) {
    if (!name) return '';
    return clean(
      name
        .replace(/[[\].]+/g, ' ')
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/\b\w/g, (c) => c.toUpperCase()),
    );
  }

  /**
   * The nearest heading above the field. Gives the model the section context
   * that distinguishes, say, a "Bank Details" address from a "Contact
   * Details" one on the same page.
   */
  function sectionFor(el) {
    const SELECTOR =
      'h1, h2, h3, h4, h5, .form-title, .ant-modal-title, .ant-drawer-title, ' +
      '.ant-popover-title, .cc-form__section-title, legend';

    // The title of whatever surface the field sits on wins, since it names the
    // whole task. Both class-name generations are listed: antd 6 renamed the
    // modal panel `-content` to `-container` and the drawer panel `-content`
    // to `-section`, and the portals span that release.
    const shell = el.closest(
      '.ant-modal-container, .ant-modal-content, .ant-drawer-section, .ant-drawer-content, ' +
        '.ant-modal, .ant-drawer, .ant-popover',
    );
    if (shell) {
      const t = shell.querySelector('.ant-modal-title, .ant-drawer-title, .ant-popover-title');
      if (t) {
        const text = clean(t.textContent);
        if (text) return text;
      }
    }

    let node = el;
    while (node && node !== document.body) {
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.matches?.(SELECTOR)) {
          const t = clean(sib.textContent);
          if (t && t.length < 80) return t;
        }
        const nested = sib.querySelector?.(SELECTOR);
        if (nested) {
          const t = clean(nested.textContent);
          if (t && t.length < 80) return t;
        }
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return '';
  }

  /* ---------------------------------------------------------------- *
   * Dates
   * ---------------------------------------------------------------- */

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** Format an ISO date for a picker, without pulling in dayjs. */
  function formatDate(iso, pattern) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(iso);
    if (!m) return null;
    const [, Y, M, D, h = '00', mi = '00', s = '00'] = m;
    return pattern
      .replace(/YYYY/g, Y)
      .replace(/MMM/g, MONTHS[Number(M) - 1])
      .replace(/MM/g, M)
      .replace(/DD/g, D)
      .replace(/HH/g, h)
      .replace(/mm/g, mi)
      .replace(/ss/g, s);
  }

  /**
   * Whether a date field wants a past or a future value.
   *
   * The portals attach `disabledDate` callbacks that reject the wrong side
   * (an issue date may not be in the future, an expiry date must be ahead of
   * its issue date), and those callbacks are invisible from the DOM. Reading
   * the intent off the label is what keeps the model from proposing a date the
   * calendar will refuse to accept.
   */
  function dateHintFor(label) {
    const l = (label || '').toLowerCase();
    if (/expiry|expires|expiration|valid\s*(till|until|to)|end\s*date/.test(l)) return 'future';
    if (/birth|\bdob\b|issue|issued|joining|\bdoj\b|start\s*date|from\s*date|hire/.test(l)) {
      return 'past';
    }
    return null;
  }

  KPAF.core = {
    sleep,
    tick,
    isVisible,
    isInteractive,
    setNativeValue,
    realClick,
    pressKey,
    pressEnter,
    pressEscape,
    blur,
    labelFor,
    sectionFor,
    humanise,
    clean,
    formatDate,
    dateHintFor,
  };
})();
