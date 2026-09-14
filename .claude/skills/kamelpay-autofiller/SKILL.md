---
name: kamelpay-autofiller
description: Architecture and navigation guide for the KamelPay AutoFiller Chrome extension — an MV3 extension that scans React/Ant Design/Formik forms, asks DeepSeek for test data, and types it in. Use when reading, debugging, or changing anything in this repo — the service worker, the kpaf-* content scripts, the prompt/domain/deepseek libs, the popup or the options page — or when the question involves form detection, field classification, antd Select/DatePicker filling, Yup validation rules, the retry pass, or why a field was skipped.
---

# KamelPay AutoFiller — architecture

A Chrome MV3 extension. It reads the form currently on screen in a KamelPay
portal, asks DeepSeek for test data that fits it, and types the result in.
Plain JavaScript, no build step, no dependencies, no tests. What you edit is
what Chrome loads.

**Target apps** (a separate repo, `hrcms` — not present here):

| Portal | Path in hrcms | Stack |
| --- | --- | --- |
| Admin | `client/admin` | React 18, antd 5, Formik 2, Yup 0.32 |
| Employer v1 | `client/employer` | React 18, antd 5, Formik 2, Yup 0.32 |
| Employer v2 | `clientV2/employer` | React 19, antd 6, Formik 2.4, Yup 1.7 |

Straddling antd 5 and antd 6 is why selectors are always written in pairs — see
[Gotchas](#gotcha-index).

## Runtime topology

Three isolated JavaScript contexts. Knowing which one your code runs in decides
what it can touch:

| Context | Files | Can reach | Cannot reach |
| --- | --- | --- | --- |
| **Background worker** (ES modules) | `src/background/`, `src/lib/` | `chrome.*`, network, the API key | the page's DOM |
| **Content scripts** (IIFEs, injected on demand) | `src/content/` | the page DOM, `chrome.runtime` messaging | the API key, ES `import` |
| **Popup / Options** (extension pages) | `src/popup/`, `src/options/` | `chrome.*` | the page DOM directly |

`src/lib/` is imported **only** by the worker. Content scripts share state
through the `window.KPAF` namespace instead, because `chrome.scripting` injects
them as classic scripts.

## The pipeline

One run, end to end. `runFill()` at [service-worker.js:129](../../../src/background/service-worker.js#L129) is the spine:

```
popup "Fill this form" (or Alt+Shift+F)
  │
  ▼  chrome.runtime.sendMessage {type:'run-fill'}
service-worker.runFill()
  │
  ├─ 1. ensureInjected(tab)   ping, else inject the 4 content files in order
  ├─ 2. send 'scan'      ─────▶ page: find container, classify fields,
  │                              open every dropdown and read its options
  ├─ 3. buildMessages()        prompt.js: field JSON + domain rule specs
  ├─ 4. complete()             deepseek.js: POST /chat/completions
  ├─ 5. parseResponse()        tolerant JSON extraction, uid-keyed plan
  ├─ 6. postProcess()          domain.js: repair bad values, mirror confirms
  ├─ 7. send 'fill'      ─────▶ page: type/select/pick, blur each field,
  │                              then read back the app's own Yup errors
  ├─ 8. if errors && autoRetry: one corrective round-trip, narrowed to the
  │                              failing uids only
  └─ 9. setRunState('done')    chrome.storage.session → popup re-renders
```

Every step writes progress to `chrome.storage.session` via `setRunState()`
([service-worker.js:44](../../../src/background/service-worker.js#L44)), because
the popup closes the moment focus moves to the page. The popup holds **no state
of its own** — it renders whatever the worker last wrote.

## File map

| File | Lines | Responsibility |
| --- | --- | --- |
| [manifest.json](../../../manifest.json) | 45 | MV3 config. No `content_scripts` block — injection is on demand |
| [src/background/service-worker.js](../../../src/background/service-worker.js) | 355 | Orchestration, retry logic, run state, badge. **The only reader of the API key** |
| [src/content/kpaf-core.js](../../../src/content/kpaf-core.js) | 346 | React-aware DOM primitives, label resolution, date formatting |
| [src/content/kpaf-scan.js](../../../src/content/kpaf-scan.js) | 722 | Container detection, field classification, dropdown enumeration |
| [src/content/kpaf-fill.js](../../../src/content/kpaf-fill.js) | 560 | Per-widget fill strategies, reading validation errors back |
| [src/content/kpaf-main.js](../../../src/content/kpaf-main.js) | 128 | Message router in the page; holds live field state; toasts |
| [src/lib/deepseek.js](../../../src/lib/deepseek.js) | 144 | OpenAI-compatible chat client, HTTP error translation |
| [src/lib/prompt.js](../../../src/lib/prompt.js) | 208 | System prompt, field serialisation, tolerant response parsing |
| [src/lib/domain.js](../../../src/lib/domain.js) | 276 | KamelPay Yup rules → prompt specs + local repair |
| [src/popup/](../../../src/popup/) | | Run button, live status, results breakdown |
| [src/options/](../../../src/options/) | | API key, model, `overwrite`, `autoRetry` |

**Content script load order is load-bearing**: `CONTENT_FILES`
([service-worker.js:17](../../../src/background/service-worker.js#L17)) lists
core → scan → fill → main. `kpaf-scan.js` does `const C = KPAF.core` at IIFE
time, so core must already have run. Adding a file means adding it to that array
in the right position.

## Invariants

Break one of these and the extension fails in a way that is hard to trace.

1. **The API key never leaves the worker.** It lives in
   `chrome.storage.local`, is read only in `getSettings()`, and is never put in
   a message payload to a content script. A content script runs in the page's
   tab, where portal JavaScript could reach it.
2. **`field._entry` never crosses the messaging boundary.** It holds live DOM
   nodes, which are not structured-cloneable. `serialisable()`
   ([kpaf-main.js:20](../../../src/content/kpaf-main.js#L20)) strips it on the
   way out; the fill step refers back to the parked fields by `uid`.
3. **Dropdowns are chosen by index, never by value.** The stored value is a
   database id that never appears as text. The model gets `options: [{i, label}]`
   and must return `optionIndex`. See
   [data-contracts.md](references/data-contracts.md#instruction).
4. **Dates cross as ISO only.** The model returns `YYYY-MM-DD`; `formatDate()`
   ([kpaf-core.js:296](../../../src/content/kpaf-core.js#L296)) converts to
   whatever display format the picker accepts. The model never guesses a format.
5. **Fields are filled in DOM order.** Dependent dropdowns (state after country,
   branch after bank) only populate once their parent has a value. `apply()`
   ([kpaf-fill.js:471](../../../src/content/kpaf-fill.js#L471)) walks the array
   as scanned — do not sort or parallelise it.
6. **Options are re-read at fill time**, not trusted from the scan, for the same
   reason.
7. **Every fill verifies by reading back from the DOM.** No strategy assumes its
   write landed. That is what separates "the model gave a bad value" from "the
   widget refused it".
8. **Content scripts are re-injected on every run and must be idempotent.**
   core/scan/fill guard with `if (window.KPAF?.x) return;`; main guards with
   `KPAF.__wired` so exactly one message listener stays alive.
9. **Nothing is keyed on the Formik path.** Values go in through DOM events and
   the component's own `onChange` maps them into Formik state — which is what
   makes nested paths like `properties.0.documentNumber` work without the
   extension knowing they exist.
10. **The extension never submits.** Filling stops at the last field,
    deliberately.

## Where to change what

| Goal | Touch |
| --- | --- |
| Add/adjust a KamelPay validation rule | `DOMAIN_RULES` ([domain.js:81](../../../src/lib/domain.js#L81)) — see [task-recipes.md](references/task-recipes.md#add-a-domain-rule) |
| Support a new widget type | 5 places in scan + fill — see [task-recipes.md](references/task-recipes.md#support-a-new-widget-kind) |
| Change what the model is told | `SYSTEM_PROMPT` ([prompt.js:23](../../../src/lib/prompt.js#L23)) and `describeField()` ([prompt.js:81](../../../src/lib/prompt.js#L81)) |
| Swap the AI provider | `deepseek.js` — base URL, model name, `JSON_MODE_MODELS`. `prompt.js`/`domain.js` are provider-agnostic |
| Change form detection | `floatingSurfaces()` / `findContainer()` ([kpaf-scan.js:51](../../../src/content/kpaf-scan.js#L51), [:137](../../../src/content/kpaf-scan.js#L137)) |
| Change what counts as noise | `ALWAYS_NOISE` / `CHROME_NOISE` / `FLOATING` ([kpaf-scan.js:206-232](../../../src/content/kpaf-scan.js#L206)) |
| Fix a mislabelled field | `labelFor()` ([kpaf-core.js:132](../../../src/content/kpaf-core.js#L132)) — six strategies, in order |
| Add a date format | `DATE_FORMATS` / `DATETIME_FORMATS` ([kpaf-fill.js:18](../../../src/content/kpaf-fill.js#L18)) |
| Change retry behaviour | `runFill()` retry block ([service-worker.js:208](../../../src/background/service-worker.js#L208)) |
| Add a result/note to the popup | `render()` ([popup.js:56](../../../src/popup/popup.js#L56)) + markup in `popup.html` |
| Add a setting | `SETTINGS_DEFAULTS` ([service-worker.js:24](../../../src/background/service-worker.js#L24)) **and** `DEFAULTS` ([options.js:5](../../../src/options/options.js#L5)) — they are duplicated, keep them in sync |

## Limits and caps

Deliberate, and worth knowing before you "fix" one:

| Cap | Value | Where | Why |
| --- | --- | --- | --- |
| Fields per scan | 80 | `MAX_FIELDS` ([kpaf-scan.js:21](../../../src/content/kpaf-scan.js#L21)) | Token budget; a runaway page cannot hang the scan |
| Options scanned per dropdown | 250 | `MAX_OPTIONS` ([kpaf-scan.js:22](../../../src/content/kpaf-scan.js#L22)) | Virtual-list scrolling cost |
| Options shown to the model | 150 | `MAX_OPTIONS_IN_PROMPT` ([prompt.js:21](../../../src/lib/prompt.js#L21)) | ~1k tokens; set high on purpose so long lists stay varied |
| Multiselect picks | 4 | [kpaf-fill.js:435](../../../src/content/kpaf-fill.js#L435) | |
| Response tokens | 8000 | `max_tokens` ([deepseek.js:93](../../../src/lib/deepseek.js#L93)) | |
| Request timeout | 90 s | `timeoutMs` ([deepseek.js:68](../../../src/lib/deepseek.js#L68)) | A 40-field form is slow |
| Temperature | 1.3 | [deepseek.js:67](../../../src/lib/deepseek.js#L67) | High on purpose: the same forms are filled many times a day |
| Retry passes | exactly 1 | [service-worker.js:208](../../../src/background/service-worker.js#L208) | Anything still failing is reported, not looped |

Not handled at all: **file uploads** (listed as skipped), **submitting**, and
**OTP fields** get a random 6-digit value that will not match a real one.

## Reference material

- **[data-contracts.md](references/data-contracts.md)** — exact shapes of `Field`,
  `Instruction`, `Result`, `ValidationError`, the run-state object, and every
  message type. Read this before changing anything that crosses a boundary.
- **[dom-techniques.md](references/dom-techniques.md)** — why `.value = x` and
  `.click()` do not work on these widgets, and what does. Label resolution,
  dropdown enumeration, date entry, error attribution.
- **[task-recipes.md](references/task-recipes.md)** — step-by-step for the common
  changes, with every place that needs touching.
- **[debugging.md](references/debugging.md)** — no build and no tests, so this is
  how you actually verify a change.

## Gotcha index

The traps, each explained in [dom-techniques.md](references/dom-techniques.md):

- React's `_valueTracker` swallows a plain `.value` assignment → `setNativeValue()`
- rc-select listens for `mousedown`, not `click` → `realClick()` fires the full sequence
- antd 6 renamed the modal panel `-content` → `-container`, and the drawer panel
  `-content` → `-section`. **Always list both.**
- v2's `ThemeInput` hardcodes `id="theme-input-id"` on every input → the id is
  useless, use `name` + `.theme-label`
- antd marks a Select's search input `readonly` when `showSearch` is off → test
  the **wrapper's** `-disabled` class, never the inner input
- Formik field names contain `.` and `[]` → never build a selector from one
- A field's error only paints after blur (Formik marks it touched)
- Label/marker walks are bounded to 5 levels — unbounded, they pick up a
  neighbouring field's label
- `.color-error` holding just `*` is v2's required marker, not an error message

## Style

Comments here explain **why**, not what — usually naming the antd or React
behaviour that forced the code into its shape. Match that: a new workaround
without a note saying what it works around will read as noise. British spelling
(`serialisable`, `humanise`, `randomise`). No semicolon-free style, no build
tooling, no dependencies — keep it that way.
