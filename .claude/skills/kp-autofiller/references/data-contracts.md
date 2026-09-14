# Data contracts

There are no types in this codebase. These are the shapes that cross a context
boundary, and they are the thing most likely to break silently. Anything here
that changes must change in **both** the producer and the consumer, which are
usually in different execution contexts.

## Message types

Every message is `{ type, payload }`. Every response is `{ ok: true, ... }` or
`{ ok: false, error: string }`.

### Popup/command → worker

| type | payload | response |
| --- | --- | --- |
| `run-fill` | `{ tabId?, overwrite? }` | `{ ok, filled, problems }` |
| `highlight` | `{ tabId? }` | `{ ok, kind }` |
| `verify-key` | `{ apiKey }` | `{ ok }` |
| `get-run` | — | `{ ok, run }` |
| `clear-run` | — | `{ ok }` |

`tabId` falls back to `activeTabId()`. `overwrite` here overrides the stored
setting for this run only (`overwriteOverride`).

### Worker → content script

| type | payload | response |
| --- | --- | --- |
| `ping` | — | `{ ok: true }` — the injection probe |
| `scan` | `{ overwrite }` | `{ ok, container, fields[], skipped[], pageTitle, url }` |
| `fill` | `{ plan }` | `{ ok, results[], errors[] }` |
| `highlight` | — | `{ ok, kind }` |
| `toast` | `{ message, tone }` | `{ ok }` — `tone` is `ok` \| `warn` \| `error` |

### Worker → popup (broadcast)

`{ type: 'run-updated', payload: run }`, fired by `setRunState()`. Sent with
`.catch(() => {})` because no popup may be listening.

## Field

Produced by `scan()` ([kpaf-scan.js:613](../../../../src/content/kpaf-scan.js#L613)).
Two versions of this object exist:

```js
{
  uid: 'f7',            // opaque, assigned in scan order. The ONLY handle the
                        // model gets. Never derived from anything in the DOM.
  kind: 'select',       // see the kind table below
  label: 'Bank Name',   // resolved by labelFor(); '' if nothing worked
  name: 'bankId',       // name attribute, or ''
  id: '',               // id attribute, BUT '' when it is 'theme-input-id'
  placeholder: '',
  section: 'Bank Details',   // nearest heading above, via sectionFor()
  required: false,           // best-effort; Yup required-ness is invisible
  constraints: { maxLength: 35, minLength: 3, min: '0', max: '100', pattern: '…' },
  options: [{ i: 0, label: 'Emirates NBD' }, …],  // select/multiselect/radio only
  dateHint: 'past' | 'future' | null,             // date kinds only
  scanNote: 'dropdown did not open',              // optional
  _entry: { el: <DOM node>, kind: 'antd-select' } // PAGE ONLY
}
```

**`_entry` is the invariant.** It holds live DOM nodes and is stripped by
`serialisable()` ([kpaf-main.js:20](../../../../src/content/kpaf-main.js#L20))
before the field leaves the page. The full objects stay parked in `state.fields`
in `kpaf-main.js`; the fill step looks them up by `uid`. If you add a field
property, decide deliberately whether it should survive serialisation.

`_entry.kind` is the **DOM-level** kind (`antd-select`, `antd-picker`,
`antd-range`, `antd-radio`, `antd-switch`, `antd-checkbox-group`, `checkbox`,
`radio`, `textarea`, `native-select`, `text`) assigned by `collectRoots()`.
`field.kind` is the **semantic** kind the model sees, derived from it by
`kindOf()` ([kpaf-scan.js:322](../../../../src/content/kpaf-scan.js#L322)). Fill
strategies dispatch on `field.kind` and then disambiguate on `_entry.kind` —
e.g. `select` splits into `fillNativeSelect` vs `fillSelect`.

### Semantic kinds

| `kind` | Instruction shape | Filled by |
| --- | --- | --- |
| `text` `email` `password` `number` `phone` `textarea` | `value: string` | `fillText` |
| `select` | `optionIndex: number` | `fillSelect` / `fillNativeSelect` |
| `multiselect` | `optionIndexes: number[]` | `fillSelect({multiple})` / `fillCheckboxGroup` |
| `radio` | `optionIndex: number` | `fillRadio` |
| `date` | `value: 'YYYY-MM-DD'` | `fillDate` |
| `datetime` | `value: 'YYYY-MM-DDTHH:mm:ss'` | `fillDate({datetime})` |
| `daterange` | `value: 'YYYY-MM-DD..YYYY-MM-DD'` | `fillDateRange` |
| `checkbox` `switch` | `value: boolean` | `fillCheckbox` / `fillSwitch` |

A `kind` added here must be added in five places — see
[task-recipes.md](task-recipes.md#support-a-new-widget-kind).

## Instruction

One entry of the model's reply, after `parseResponse()` keys it by uid:

```js
{ uid: 'f7', value: 'Al Noor Trading LLC' }
{ uid: 'f8', optionIndex: 3 }
{ uid: 'f9', optionIndexes: [0, 2] }
{ uid: 'f10', skip: 'read-only reference number' }
```

`parseResponse()` ([prompt.js:160](../../../../src/lib/prompt.js#L160)) **drops any
uid not in the scan** and returns them in `unknown` for the popup's notes. There
is no fuzzy name matching, so a hallucinated field cannot be misapplied.

`labelsFrom()` ([kpaf-fill.js:392](../../../../src/content/kpaf-fill.js#L392)) is
tolerant in one direction only: if the model returned a free-text `value` for an
option field despite the instructions, it is treated as a label to match. It is
never treated as a value to write.

## Result

One per field, from `apply()`. This is what the popup renders.

```js
{ uid, label, kind, ok: true,  value: 'what actually landed in the DOM' }
{ uid, label, kind, ok: true,  value: 'AE0703…', warning: 'truncated to "AE07"' }
{ uid, label, kind, ok: false, error: 'the dropdown would not open' }
{ uid, label, kind, ok: true,  skipped: true, reason: 'read-only reference number' }
```

`value` is always **read back out of the DOM**, never echoed from the
instruction. `warning` means it landed but was altered by the widget
(a `maxlength` truncation, a numeric input filter, a fallback option choice).

Popup arithmetic ([popup.js:56](../../../../src/popup/popup.js#L56)):
- **filled** = `ok && !skipped`
- **problems** = `!ok` + `errors.length`
- **skipped** = scan-time `skipped[]` + results with `skipped: true`

Note `ok: true, skipped: true` is a success, not a fill — always test both flags.

## ValidationError

The app's own Yup messages, harvested by `readErrors()`
([kpaf-fill.js:515](../../../../src/content/kpaf-fill.js#L515)) after every field
has been blurred:

```js
{ uid: 'f3' | null, label: 'Emirates ID', message: 'Must be exactly 15 digits' }
```

`uid` is `null` when attribution failed — the message is still shown, as
`(unknown field)`, but the retry cannot target it. Deduplicated on
`uid|message`. Scoped to the container the scan settled on, so a modal does not
pick up stale errors from the page behind it.

## Skipped

Scan-time rejections. Free-text, for humans only — never sent to the model:

```js
{ label: 'Employee Code', reason: 'already filled: "EMP1234"' }
```

Reasons in use: `disabled or read-only`, `looks like a search/filter box`,
`already filled: "…"`, `dropdown has no selectable options yet`, `radio group has
no options`, `field cap of 80 reached`.

## Run state

The single object in `chrome.storage.session` under key `run`. The popup is a
pure function of it.

```js
{
  phase: 'scanning' | 'thinking' | 'filling' | 'retrying' | 'done' | 'error',
  error: string | null,
  container: { kind: 'modal'|'drawer'|'dialog'|'popover'|'dropdown'|'form'|'page',
               title: string },
  fieldCount: number,
  results: Result[],
  errors: ValidationError[],
  notes: string[],        // local repairs, mirrored confirmations, retry failures
  skipped: Skipped[],
  retried: boolean,
  usage: { total_tokens, … } | null,
  startedAt, finishedAt, updatedAt
}
```

`setRunState()` **merges** a patch into the existing object — it does not
replace it. So a patch that omits `results` keeps the previous `results`. That is
intentional (progress updates are partial), and it is also the trap: to clear a
field you must patch it explicitly, as the `phase: 'scanning'` patch does.

## Settings

`chrome.storage.local`, read by `getSettings()`:

```js
{ apiKey: '', model: 'deepseek-chat', overwrite: false, autoRetry: true }
```

Defined **twice** — `SETTINGS_DEFAULTS`
([service-worker.js:24](../../../../src/background/service-worker.js#L24)) and
`DEFAULTS` ([options.js:5](../../../../src/options/options.js#L5)). Adding a setting
means editing both, plus the markup in `options.html`.

## Domain rule

An entry of `DOMAIN_RULES` ([domain.js:81](../../../../src/lib/domain.js#L81)):

```js
{
  id: 'iban',
  match: /\biban\b/i,     // tested against label, then name, then id
  spec: 'UAE IBAN: the literal "AE" followed by exactly 21 digits…',
  regex: /^AE\d{21}$/,    // enforced locally after the model replies
  gen: () => `AE${digits(21)}`,  // used when regex fails
}
```

`spec` goes into the prompt; `regex` + `gen` run in `repairValue()` afterwards.
**Order matters — first match wins**, so narrow patterns go above broad ones.
