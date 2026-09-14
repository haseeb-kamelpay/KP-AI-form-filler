/**
 * Orchestration and the only place the API key is ever read.
 *
 * The key lives in chrome.storage.local and is used exclusively here, in the
 * worker. It is never passed to a content script, so it never enters the page
 * context where portal JavaScript (or anything else running on the page) could
 * reach it.
 *
 * The run is: inject → scan → ask DeepSeek → repair locally → fill → read the
 * page's own validation errors → optionally one corrective round-trip.
 */

import { complete, verifyKey, DEFAULT_MODEL } from '../lib/deepseek.js';
import { buildMessages, parseResponse } from '../lib/prompt.js';
import { repairValue, mirrorConfirmationFields } from '../lib/domain.js';

const CONTENT_FILES = [
  'src/content/kpaf-core.js',
  'src/content/kpaf-scan.js',
  'src/content/kpaf-fill.js',
  'src/content/kpaf-main.js',
];

const SETTINGS_DEFAULTS = {
  apiKey: '',
  model: DEFAULT_MODEL,
  overwrite: false,
  autoRetry: true,
};

/* ------------------------------------------------------------------ *
 * Settings + last-run state
 * ------------------------------------------------------------------ */

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_DEFAULTS);
  return { ...SETTINGS_DEFAULTS, ...stored };
}

/**
 * The popup closes the moment you click the page, so progress and results are
 * written to session storage and replayed when it reopens.
 */
async function setRunState(patch) {
  const current = (await chrome.storage.session.get('run')).run || {};
  const run = { ...current, ...patch, updatedAt: Date.now() };
  await chrome.storage.session.set({ run });
  chrome.runtime.sendMessage({ type: 'run-updated', payload: run }).catch(() => {});
  return run;
}

const setBadge = (text, color = '#0059f7') => {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
};

/* ------------------------------------------------------------------ *
 * Talking to the tab
 * ------------------------------------------------------------------ */

async function ensureInjected(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    if (pong?.ok) return;
  } catch {
    // Not injected yet — fall through.
  }

  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: CONTENT_FILES,
  });
}

const send = (tabId, type, payload = {}) => chrome.tabs.sendMessage(tabId, { type, payload });

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

/**
 * Apply the model's answer to local rules before it reaches the page.
 *
 * Two classes of mistake are fixed deterministically rather than by asking
 * again: a structured identifier in the wrong shape (regenerated from the Yup
 * regex it has to satisfy), and a confirmation field that does not mirror its
 * source. Both are cheap to get right here and expensive to argue about with
 * a model.
 */
/**
 * @param {Array}  allFields every scanned field, so confirmation pairs can be
 *   resolved even when only one half is being (re)filled
 * @param {object} plan      the instructions about to be applied
 * @param {object} knownValues values already sitting in the page from an
 *   earlier pass, keyed by uid
 */
function postProcess(allFields, plan, knownValues = {}) {
  const notes = [];
  const values = { ...knownValues };

  for (const f of allFields) {
    const instruction = plan[f.uid];
    if (!instruction || instruction.skip) continue;
    if (['select', 'multiselect', 'radio', 'checkbox', 'switch'].includes(f.kind)) continue;
    if (typeof instruction.value !== 'string') continue;

    const { value, repaired, reason } = repairValue(f, instruction.value);
    if (repaired && reason) {
      notes.push(`${f.label || f.uid}: ${reason} — replaced locally`);
    }
    instruction.value = value;
    values[f.uid] = value;
  }

  // Resolved across all fields, not just the ones being written, so a retried
  // "Confirm Password" copies the password already typed into the page rather
  // than a fresh one the source field will never be given.
  for (const note of mirrorConfirmationFields(allFields, values)) notes.push(note);

  for (const f of allFields) {
    if (values[f.uid] !== undefined && plan[f.uid] && !plan[f.uid].skip) {
      plan[f.uid].value = values[f.uid];
    }
  }

  return notes;
}

async function runFill(tabId, { overwriteOverride } = {}) {
  const settings = await getSettings();

  if (!settings.apiKey) {
    const error = 'No DeepSeek API key set. Open the extension options and add one.';
    await setRunState({ phase: 'error', error, results: [], errors: [] });
    setBadge('!', '#b91c1c');
    return { ok: false, error };
  }

  const overwrite = overwriteOverride ?? settings.overwrite;

  try {
    setBadge('…');
    await setRunState({
      phase: 'scanning',
      error: null,
      results: [],
      errors: [],
      notes: [],
      startedAt: Date.now(),
    });

    await ensureInjected(tabId);

    const scan = await send(tabId, 'scan', { overwrite });
    if (!scan?.ok) throw new Error(scan?.error || 'The page scan failed.');

    if (!scan.fields.length) {
      const error = scan.skipped?.length
        ? 'Found no fields to fill — everything detected was skipped. See the details below.'
        : 'Found no form fields on this page.';
      await setRunState({
        phase: 'error',
        error,
        container: scan.container,
        skipped: scan.skipped || [],
      });
      setBadge('0', '#b45309');
      return { ok: false, error };
    }

    await setRunState({
      phase: 'thinking',
      container: scan.container,
      fieldCount: scan.fields.length,
      skipped: scan.skipped || [],
    });

    const messages = buildMessages({
      fields: scan.fields,
      pageTitle: scan.pageTitle,
      url: scan.url,
      formTitle: scan.container?.title,
    });

    const { text, usage } = await complete({
      apiKey: settings.apiKey,
      messages,
      model: settings.model,
    });

    const { plan, unknown } = parseResponse(text, scan.fields);
    const notes = postProcess(scan.fields, plan);
    if (unknown.length) {
      notes.push(`Model referenced ${unknown.length} unknown field id(s); ignored.`);
    }

    await setRunState({ phase: 'filling', notes, usage });

    const filled = await send(tabId, 'fill', { plan });
    if (!filled?.ok) throw new Error(filled?.error || 'Filling failed.');

    let results = filled.results;
    let errors = filled.errors;
    let retried = false;

    // A widget that refused the value is as much a reason to try again as a
    // Yup message is — a date the calendar rejects outright never gets as far
    // as being validated, so waiting for a painted error would leave it empty.
    const refused = results
      .filter((r) => !r.ok && !r.skipped && r.error)
      .map((r) => ({ uid: r.uid, label: r.label, message: r.error }));

    // One corrective pass, using the app's own validation messages as the
    // brief. Anything still failing after this is reported rather than looped.
    if (settings.autoRetry && (errors.length || refused.length)) {
      retried = true;
      await setRunState({ phase: 'retrying', results, errors, notes });

      const retryMessages = buildMessages({
        fields: scan.fields,
        pageTitle: scan.pageTitle,
        url: scan.url,
        formTitle: scan.container?.title,
        previousErrors: [...errors, ...refused],
      });

      try {
        const retry = await complete({
          apiKey: settings.apiKey,
          messages: retryMessages,
          model: settings.model,
        });
        const parsedRetry = parseResponse(retry.text, scan.fields);

        // Only re-apply the fields that actually complained, so a correct
        // value elsewhere is not churned into a different correct value.
        const failing = new Set(errors.map((e) => e.uid).filter(Boolean));
        for (const r of results) if (!r.ok && !r.skipped) failing.add(r.uid);

        const narrowed = {};
        for (const uid of failing) {
          if (parsedRetry.plan[uid]) narrowed[uid] = parsedRetry.plan[uid];
        }

        if (Object.keys(narrowed).length) {
          // What pass one actually left in the page, so mirroring has a
          // source to copy from even when the source is not being rewritten.
          const applied = {};
          for (const r of results) {
            if (r.ok && !r.skipped && typeof r.value === 'string') applied[r.uid] = r.value;
          }

          for (const note of postProcess(scan.fields, narrowed, applied)) notes.push(note);
          const second = await send(tabId, 'fill', { plan: narrowed });
          if (second?.ok) {
            // Merge back only the fields the retry actually addressed. The
            // second pass walks every field and reports "no value returned"
            // for the ones absent from the narrowed plan, which would
            // otherwise bury the successes from pass one.
            const byUid = new Map(
              second.results.filter((r) => narrowed[r.uid]).map((r) => [r.uid, r]),
            );
            results = results.map((r) => byUid.get(r.uid) || r);
            errors = second.errors;
          }
        }
      } catch (err) {
        notes.push(`Retry pass failed: ${err.message}`);
      }
    }

    const okCount = results.filter((r) => r.ok && !r.skipped).length;
    const problemCount = results.filter((r) => !r.ok).length + errors.length;

    setBadge(problemCount ? String(problemCount) : String(okCount), problemCount ? '#b45309' : '#0f9d58');

    await setRunState({
      phase: 'done',
      container: scan.container,
      results,
      errors,
      notes,
      retried,
      usage,
      skipped: scan.skipped || [],
      finishedAt: Date.now(),
    });

    return { ok: true, filled: okCount, problems: problemCount };
  } catch (err) {
    const error = err?.message || String(err);
    setBadge('!', '#b91c1c');
    await setRunState({ phase: 'error', error });
    // Surface it on the page too, for when the popup is not open.
    try {
      await send(tabId, 'toast', { message: `AutoFiller: ${error}`, tone: 'error' });
    } catch {
      /* the tab may not be injectable */
    }
    return { ok: false, error };
  }
}

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'run-fill': {
        const tabId = msg.payload?.tabId ?? (await activeTabId());
        if (!tabId) return sendResponse({ ok: false, error: 'No active tab.' });
        return sendResponse(await runFill(tabId, { overwriteOverride: msg.payload?.overwrite }));
      }
      case 'highlight': {
        const tabId = msg.payload?.tabId ?? (await activeTabId());
        if (!tabId) return sendResponse({ ok: false, error: 'No active tab.' });
        try {
          await ensureInjected(tabId);
          return sendResponse(await send(tabId, 'highlight'));
        } catch (err) {
          return sendResponse({ ok: false, error: err.message });
        }
      }
      case 'verify-key': {
        try {
          await verifyKey(msg.payload?.apiKey);
          return sendResponse({ ok: true });
        } catch (err) {
          return sendResponse({ ok: false, error: err.message });
        }
      }
      case 'get-run': {
        const { run } = await chrome.storage.session.get('run');
        return sendResponse({ ok: true, run: run || null });
      }
      case 'clear-run': {
        await chrome.storage.session.remove('run');
        setBadge('');
        return sendResponse({ ok: true });
      }
      default:
        return sendResponse({ ok: false, error: `Unknown message: ${msg?.type}` });
    }
  })();
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'fill-now') return;
  const tabId = await activeTabId();
  if (tabId) runFill(tabId);
});

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

// A fresh tab should not show the previous run's badge.
chrome.tabs.onActivated.addListener(() => setBadge(''));
