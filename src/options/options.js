/** Settings page. The API key never leaves chrome.storage.local on this profile. */

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  apiKey: '',
  model: 'deepseek-chat',
  overwrite: false,
  autoRetry: true,
};

function say(text, tone) {
  const msg = $('msg');
  msg.textContent = text;
  msg.className = `msg ${tone}`;
  msg.hidden = false;
}

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  $('apiKey').value = s.apiKey;
  $('model').value = s.model;
  $('overwrite').checked = Boolean(s.overwrite);
  $('autoRetry').checked = Boolean(s.autoRetry);
}

$('save').addEventListener('click', async () => {
  const apiKey = $('apiKey').value.trim();
  await chrome.storage.local.set({
    apiKey,
    model: $('model').value,
    overwrite: $('overwrite').checked,
    autoRetry: $('autoRetry').checked,
  });
  say(apiKey ? 'Saved.' : 'Saved — but with no API key the extension cannot run.', apiKey ? 'ok' : 'err');
});

$('test').addEventListener('click', async () => {
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) return say('Enter a key first.', 'err');

  $('test').disabled = true;
  say('Checking with DeepSeek…', 'ok');

  chrome.runtime.sendMessage({ type: 'verify-key', payload: { apiKey } }, (res) => {
    $('test').disabled = false;
    if (chrome.runtime.lastError) return say(chrome.runtime.lastError.message, 'err');
    if (res?.ok) return say('Key works.', 'ok');
    say(res?.error || 'The key did not work.', 'err');
  });
});

$('reveal').addEventListener('click', () => {
  const input = $('apiKey');
  const hidden = input.type === 'password';
  input.type = hidden ? 'text' : 'password';
  $('reveal').textContent = hidden ? 'Hide' : 'Show';
});

// Behaviour toggles save immediately; the key needs an explicit Save.
for (const id of ['overwrite', 'autoRetry']) {
  $(id).addEventListener('change', (e) => {
    chrome.storage.local.set({ [id]: e.target.checked });
  });
}

load();
