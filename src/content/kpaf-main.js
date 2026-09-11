/**
 * Message router inside the page.
 *
 * The scanned fields hold live DOM references (`_entry`), which cannot cross
 * the extension messaging boundary. They are therefore parked in `state` here
 * and only a serialisable projection is sent to the background worker; the
 * fill step refers back to them by uid.
 */

(() => {
  const KPAF = (window.KPAF = window.KPAF || {});

  // Re-injected on every run, so keep exactly one listener alive.
  if (KPAF.__wired) return;
  KPAF.__wired = true;

  const state = { fields: [], container: null };

  /** Strip the DOM handles before anything leaves the page. */
  const serialisable = (f) => {
    const { _entry, ...rest } = f;
    return rest;
  };

  function flash(message, tone = 'ok') {
    const id = 'kpaf-toast';
    document.getElementById(id)?.remove();
    const el = document.createElement('div');
    el.id = id;
    el.textContent = message;
    Object.assign(el.style, {
      position: 'fixed',
      zIndex: '2147483647',
      right: '16px',
      bottom: '16px',
      maxWidth: '320px',
      padding: '10px 14px',
      borderRadius: '8px',
      font: '500 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif',
      color: '#fff',
      background: tone === 'ok' ? '#0059f7' : tone === 'warn' ? '#b45309' : '#b91c1c',
      boxShadow: '0 6px 24px rgba(0,0,0,.28)',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity .18s ease',
    });
    document.documentElement.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = '1';
    });
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 250);
    }, 3200);
  }

  const handlers = {
    async ping() {
      return { ok: true };
    },

    async scan({ overwrite }) {
      const result = await KPAF.scan.scan({ overwrite });
      state.fields = result.fields;
      state.container = result.container;
      return {
        ok: true,
        container: result.container,
        fields: result.fields.map(serialisable),
        skipped: result.skipped,
        pageTitle: result.pageTitle,
        url: result.url,
      };
    },

    async fill({ plan }) {
      if (!state.fields.length) {
        return { ok: false, error: 'No scanned fields in this tab. Run a scan first.' };
      }
      const results = await KPAF.fill.apply(state.fields, plan);
      await KPAF.core.tick(220); // let Formik finish validating
      const errors = KPAF.fill.readErrors(state.fields);

      const filled = results.filter((r) => r.ok && !r.skipped).length;
      const failed = results.filter((r) => !r.ok).length;

      if (errors.length || failed) {
        flash(
          `Filled ${filled} field${filled === 1 ? '' : 's'} — ${errors.length + failed} need attention`,
          'warn',
        );
      } else {
        flash(`Filled ${filled} field${filled === 1 ? '' : 's'}`, 'ok');
      }

      return { ok: true, results, errors };
    },

    /** Briefly outline the detected form so you can confirm the target. */
    async highlight() {
      const container = KPAF.scan.findContainer();
      const el = container.el;
      const prev = el.style.outline;
      el.style.outline = '2px solid #0059f7';
      el.style.outlineOffset = '2px';
      setTimeout(() => {
        el.style.outline = prev;
      }, 1400);
      return { ok: true, kind: container.kind };
    },

    async toast({ message, tone }) {
      flash(message, tone);
      return { ok: true };
    },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handler = handlers[msg?.type];
    if (!handler) return false;

    handler(msg.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));

    return true; // async response
  });
})();
