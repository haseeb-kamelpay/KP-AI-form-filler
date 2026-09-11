/**
 * DeepSeek chat-completions client.
 *
 * DeepSeek exposes an OpenAI-compatible endpoint, so swapping in another
 * provider later is mostly a base-URL and model-name change — which is why the
 * request shape below sticks to the common subset rather than anything
 * DeepSeek-specific.
 */

export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';

export const DEFAULT_MODEL = 'deepseek-chat';

/**
 * Models that accept `response_format: { type: 'json_object' }`.
 *
 * `deepseek-reasoner` rejects the parameter, so asking for JSON mode there
 * fails the whole request. It still returns JSON perfectly well when only the
 * prompt asks for it, and `extractJson` copes with the fencing it sometimes
 * adds — so the mode is simply omitted rather than the model disallowed.
 */
const JSON_MODE_MODELS = new Set(['deepseek-chat']);

/**
 * Turn a failed response into a message that tells you what to actually do,
 * rather than surfacing a bare status code in the popup.
 */
function describeHttpFailure(status, body) {
  const apiMessage =
    body?.error?.message || body?.message || (typeof body === 'string' ? body : '');

  switch (status) {
    case 400:
      return `DeepSeek rejected the request (400). ${apiMessage || 'The form may be too large for one request.'}`;
    case 401:
      return 'DeepSeek rejected the API key (401). Check the key in the extension options.';
    case 402:
      return 'Your DeepSeek account is out of credit (402). Top it up and retry.';
    case 422:
      return `DeepSeek could not process the request (422). ${apiMessage}`;
    case 429:
      return 'DeepSeek is rate-limiting this key (429). Wait a moment and retry.';
    case 500:
    case 502:
    case 503:
      return `DeepSeek is unavailable right now (${status}). Retry shortly.`;
    default:
      return `DeepSeek returned ${status}. ${apiMessage}`.trim();
  }
}

/**
 * Send messages to DeepSeek and return the assistant's text.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {Array}  opts.messages
 * @param {string} [opts.model]
 * @param {number} [opts.temperature] higher keeps runs from repeating themselves
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ text: string, usage: object|null }>}
 */
export async function complete({
  apiKey,
  messages,
  model = DEFAULT_MODEL,
  temperature = 1.3,
  timeoutMs = 90_000,
}) {
  if (!apiKey) {
    throw new Error('No DeepSeek API key set. Open the extension options and add one.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        // JSON mode, where the model supports it. DeepSeek additionally
        // requires the word "json" in the prompt, which the system prompt
        // satisfies.
        ...(JSON_MODE_MODELS.has(model) ? { response_format: { type: 'json_object' } } : {}),
        max_tokens: 8000,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`DeepSeek did not respond within ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw new Error(`Could not reach DeepSeek: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await response.text();
  let body = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = bodyText;
  }

  if (!response.ok) {
    throw new Error(describeHttpFailure(response.status, body));
  }

  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    const reason = body?.choices?.[0]?.finish_reason;
    throw new Error(
      reason === 'length'
        ? 'DeepSeek hit the token limit before finishing. Try a smaller form or fewer fields.'
        : 'DeepSeek returned an empty response.',
    );
  }

  return { text, usage: body?.usage ?? null };
}

/** Cheap credential check for the options page. */
export async function verifyKey(apiKey) {
  const { text } = await complete({
    apiKey,
    messages: [
      { role: 'system', content: 'Reply with JSON only.' },
      { role: 'user', content: 'Return the json object {"ok":true}' },
    ],
    temperature: 0,
    timeoutMs: 20_000,
  });
  return text;
}
