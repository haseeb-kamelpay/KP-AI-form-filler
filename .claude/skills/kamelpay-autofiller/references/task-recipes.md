# Task recipes

Step-by-step for the changes that come up, with every place that needs touching.
Most bugs in this codebase are a change made in one place that needed making in
three.

## Add a domain rule

When a KamelPay field has a Yup rule the extension does not yet know about.

1. **Find the real rule.** These are lifted from Yup schemas in the `hrcms`
   repos (`client/admin`, `client/employer`, `clientV2/employer`). Cite the
   source in a comment, as the existing generators do — a guessed rule is worse
   than none, because it is enforced locally and will overwrite a value that
   would have passed.
2. **Add a generator** near the others
   ([domain.js:33-76](../../../../src/lib/domain.js#L33)). Use the `digits`,
   `pick`, `randInt`, `upperAlnum` helpers. It must produce a value its own
   `regex` accepts, every time.
3. **Add the rule to `DOMAIN_RULES`** ([domain.js:81](../../../../src/lib/domain.js#L81)):
   ```js
   {
     id: 'visaNumber',
     match: /visa\s*(no|number)/i,   // tested against label, then name, then id
     spec: 'Visa number: exactly 12 digits.',   // prose, goes in the prompt
     regex: /^\d{12}$/,                         // enforced after the model replies
     gen: () => digits(12),
   }
   ```
4. **Mind the order — first match wins.** Put narrow patterns above broad ones.
   `/\btrn\b/` must sit above anything matching `number`; `/emirates\s*id/` above
   a generic `/\bid\b/`. Check your `match` does not steal fields from a rule
   below it.
5. **If the model tends to add formatting** the form rejects (spaces, dashes, a
   `+971` prefix), add a normalisation step in `repairValue()`
   ([domain.js:215](../../../../src/lib/domain.js#L215)) *before* the regex test —
   see the existing IBAN/EID/TRN and phone cases. Normalising is better than
   regenerating: it keeps the model's semantically-chosen value.

`spec` is written for the model, so make it literal and unambiguous, and give an
example shape. It is injected per-field by `describeField()` and overrides the
model's instincts.

## Support a new widget kind

Say the portals start using an antd `InputNumber` stepper or a `Cascader`. Five
places, in this order:

1. **Collect it** — `collectRoots()` ([kpaf-scan.js:263](../../../../src/content/kpaf-scan.js#L263)).
   Add a wrapper query, and make sure its inner `input` is excluded from the
   generic `input` pass at the bottom, or you will get two fields for one widget.
2. **Name it** — `kindOf()` ([kpaf-scan.js:322](../../../../src/content/kpaf-scan.js#L322)).
   Map the DOM kind to a semantic `kind`. Reuse an existing semantic kind if the
   instruction shape is the same; only add a new one if the model needs to answer
   differently.
3. **Point at its input** — `innerInput()` ([kpaf-scan.js:360](../../../../src/content/kpaf-scan.js#L360)),
   `isEntryInteractive()` ([:378](../../../../src/content/kpaf-scan.js#L378)) and
   `currentValue()` ([:400](../../../../src/content/kpaf-scan.js#L400)). Judge
   disabled-ness from the **wrapper**, not the inner input.
4. **Fill it** — a `fillX()` in `kpaf-fill.js`, plus a `case` in `applyOne()`
   ([kpaf-fill.js:413](../../../../src/content/kpaf-fill.js#L413)). It must return
   the `Result` shape and **verify by reading back from the DOM**.
5. **Document it to the model** — if the `kind` is new, add it to the output-format
   rules in `SYSTEM_PROMPT` ([prompt.js:23](../../../../src/lib/prompt.js#L23)). The
   model can only produce an instruction shape it has been told about.

If the kind holds options, also decide whether they come from `readStaticOptions()`
(cheap, in-DOM) or need a `readSelectOptions()`-style open-and-read.

## Change the system prompt

`SYSTEM_PROMPT` at [prompt.js:23](../../../../src/lib/prompt.js#L23).

- The word **"json" must appear somewhere in the prompt** — DeepSeek requires it
  when `response_format: json_object` is set. It currently appears in the output
  format section.
- The output-format rules and `applyOne()`'s dispatch are a contract. Change one
  and check the other.
- `describeField()` ([prompt.js:81](../../../../src/lib/prompt.js#L81)) decides what
  each field actually costs in tokens. It deliberately omits `placeholder` and
  `name` when they duplicate the label. Adding a property here multiplies across
  up to 80 fields.
- Test a change by watching `usage.total_tokens` in the popup's context line.

## Change or add a setting

Three places, and they are not co-located:

1. `SETTINGS_DEFAULTS` ([service-worker.js:24](../../../../src/background/service-worker.js#L24))
2. `DEFAULTS` ([options.js:5](../../../../src/options/options.js#L5))
3. The control in `options.html`, plus a `$(id)` listener — booleans save
   immediately, the API key needs an explicit Save.

If the popup should override it per-run (as `overwrite` does), also thread it
through `run-fill`'s payload and the `overwriteOverride` parameter.

## Swap the AI provider

`deepseek.js` is the only provider-aware file. `prompt.js` and `domain.js` are
not.

1. `DEEPSEEK_ENDPOINT` → the new `/chat/completions`-compatible URL.
2. `DEFAULT_MODEL`, and the `<option>` list in `options.html`.
3. `JSON_MODE_MODELS` — the set that accepts `response_format: {type:'json_object'}`.
   Models outside it simply omit the parameter; `extractJson()` copes with the
   fencing they add. (`deepseek-reasoner` *rejects* the parameter outright, which
   fails the whole request — hence the set rather than a flag.)
4. `describeHttpFailure()` ([deepseek.js:28](../../../../src/lib/deepseek.js#L28)) —
   status-code meanings differ per provider.
5. **`host_permissions` in `manifest.json`** — the request is blocked without it.

## Debug a field that fills wrong

Work backwards along the pipeline; each stage has an observable output.

| Symptom | Look at |
| --- | --- |
| Field not in the scan at all | `skipped[]` in the popup — it usually says why. Then `collectRoots()`, then `isNoise()`, then `isVisible()` |
| Wrong form detected | Popup's **Show detected form** button, then `findContainer()` / `stackDepth()` |
| Field labelled wrongly | `labelFor()` — which of the six strategies is winning? |
| Model gave a bad value | The **Adjusted locally** panel shows local repairs. Consider a domain rule instead of prompt-wrangling |
| Value typed but rejected | The **Needs attention** panel carries the app's own Yup message verbatim |
| Dropdown picked the wrong option | `warning` on the result — `"X" was not in the list; used "Y"` means the option was gone at fill time, i.e. a dependency had not populated |
| Date refused | `fillDate` exhausted every format, or `disabledDate` rejected it — check `dateHint` |

## Add a field to the popup results

1. Produce it — a `Result` property from a `fillX()`, or a note pushed in
   `postProcess()`.
2. Carry it — check `setRunState()` actually persists it (the merge keeps
   omitted keys, but a new key must be in some patch).
3. Render it — `render()` ([popup.js:56](../../../../src/popup/popup.js#L56)) and
   markup in `popup.html`. **Escape it with `esc()`** — the lists use `innerHTML`,
   and labels and error messages come from the page.

## Things to leave alone

- **The retry narrowing** ([service-worker.js:208](../../../../src/background/service-worker.js#L208)).
  The second pass re-applies only the failing uids, and merges back only those
  results. Widening it churns correct values into different correct values, and
  merging all of pass two buries pass one's successes under "no value returned".
- **`knownValues` threading through `postProcess()`.** It exists so a retried
  `Confirm Password` copies the password already sitting in the page, rather than
  a fresh one the source field will never be given.
- **DOM-order filling.** See the invariants in [SKILL.md](../SKILL.md#invariants).
- **The `uid -= 1` rewinds** in `scan()` when a dropdown turns out to have no
  options. They keep uids contiguous with the fields actually emitted.
