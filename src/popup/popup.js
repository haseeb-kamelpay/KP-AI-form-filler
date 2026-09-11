/**
 * Popup UI.
 *
 * The popup is disposable — it closes as soon as focus moves to the page, and
 * a fill takes long enough that this happens routinely. So it holds no state
 * of its own: it renders whatever the worker last wrote to session storage,
 * and subscribes to updates while it happens to be open.
 */

const $ = (id) => document.getElementById(id);

const PHASES = {
  scanning: 'Scanning the page…',
  thinking: 'Asking DeepSeek for test data…',
  filling: 'Filling fields…',
  retrying: 'Fixing rejected fields…',
  done: 'Done',
  error: 'Failed',
};

const ask = (type, payload) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res);
    });
  });

const activeTab = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
};

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const show = (el, on) => {
  el.hidden = !on;
};

function li(html) {
  const el = document.createElement('li');
  el.innerHTML = html;
  return el;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

function render(run) {
  const busy = run && ['scanning', 'thinking', 'filling', 'retrying'].includes(run.phase);

  $('fill').disabled = Boolean(busy);
  $('fill').querySelector('.btn-label').textContent = busy ? 'Working…' : 'Fill this form';

  if (!run) {
    for (const id of ['status', 'errorPanel', 'summary', 'problems', 'notes', 'detailsBlock', 'skippedBlock']) {
      show($(id), false);
    }
    return;
  }

  // Status line
  show($('status'), true);
  show($('spinner'), Boolean(busy));
  $('statusText').textContent = PHASES[run.phase] || run.phase || '';

  const bits = [];
  if (run.container?.kind) {
    bits.push(run.container.title ? `${run.container.kind}: ${run.container.title}` : run.container.kind);
  }
  if (run.fieldCount) bits.push(`${run.fieldCount} fields`);
  if (run.retried) bits.push('one retry');
  if (run.usage?.total_tokens) bits.push(`${run.usage.total_tokens} tokens`);
  $('contextLine').textContent = bits.join(' · ');

  // Hard failure
  show($('errorPanel'), run.phase === 'error' && Boolean(run.error));
  if (run.error) $('errorText').textContent = run.error;

  const results = run.results || [];
  const errors = run.errors || [];
  const skipped = run.skipped || [];

  const filled = results.filter((r) => r.ok && !r.skipped);
  const failed = results.filter((r) => !r.ok);
  const modelSkipped = results.filter((r) => r.skipped);

  // Counters
  const hasRun = run.phase === 'done' || results.length > 0;
  show($('summary'), hasRun);
  if (hasRun) {
    $('statFilled').textContent = filled.length;
    $('statProblems').textContent = failed.length + errors.length;
    $('statSkipped').textContent = skipped.length + modelSkipped.length;
  }

  // Problems: both our own fill failures and the app's validation messages.
  const problemList = $('problemList');
  problemList.replaceChildren();

  for (const r of failed) {
    problemList.append(
      li(`<span class="f">${esc(r.label || r.uid)}</span> <span class="m">— ${esc(r.error)}</span>`),
    );
  }
  for (const e of errors) {
    problemList.append(
      li(`<span class="f">${esc(e.label)}</span> <span class="m">— ${esc(e.message)}</span>`),
    );
  }
  show($('problems'), problemList.childElementCount > 0);

  // Local repairs and other notes.
  const noteList = $('noteList');
  noteList.replaceChildren();
  for (const n of run.notes || []) noteList.append(li(esc(n)));
  const warnings = filled.filter((r) => r.warning);
  for (const r of warnings) {
    noteList.append(
      li(`<span class="f">${esc(r.label)}</span> <span class="m">— ${esc(r.warning)}</span>`),
    );
  }
  show($('notes'), noteList.childElementCount > 0);

  // What actually landed.
  const filledList = $('filledList');
  filledList.replaceChildren();
  for (const r of filled) {
    filledList.append(
      li(`<span class="f">${esc(r.label)}</span> <span class="v m">${esc(r.value)}</span>`),
    );
  }
  show($('detailsBlock'), filledList.childElementCount > 0);

  // Why fields were left alone.
  const skippedList = $('skippedList');
  skippedList.replaceChildren();
  for (const s of skipped) {
    skippedList.append(
      li(`<span class="f">${esc(s.label)}</span> <span class="m">— ${esc(s.reason)}</span>`),
    );
  }
  for (const r of modelSkipped) {
    skippedList.append(
      li(`<span class="f">${esc(r.label)}</span> <span class="m">— ${esc(r.reason)}</span>`),
    );
  }
  show($('skippedBlock'), skippedList.childElementCount > 0);
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

async function init() {
  const settings = await chrome.storage.local.get({ apiKey: '', overwrite: false });

  show($('needsKey'), !settings.apiKey);
  show($('main'), true);
  $('fill').disabled = !settings.apiKey;
  $('overwrite').checked = Boolean(settings.overwrite);

  const { run } = await ask('get-run');
  render(run);
}

$('fill').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab?.id) return;
  render({ phase: 'scanning' });
  const res = await ask('run-fill', { tabId: tab.id, overwrite: $('overwrite').checked });
  if (!res?.ok && res?.error) {
    render({ phase: 'error', error: res.error });
  }
});

$('overwrite').addEventListener('change', (e) => {
  chrome.storage.local.set({ overwrite: e.target.checked });
});

$('highlight').addEventListener('click', async () => {
  const tab = await activeTab();
  if (tab?.id) await ask('highlight', { tabId: tab.id });
});

$('clear').addEventListener('click', async () => {
  await ask('clear-run');
  render(null);
});

const openOptions = () => chrome.runtime.openOptionsPage();
$('openOptions').addEventListener('click', openOptions);
$('goToOptions').addEventListener('click', openOptions);

// Live progress while the popup happens to still be open.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'run-updated') render(msg.payload);
});

init();
