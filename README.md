# KamelPay AutoFiller

A local Chrome extension that fills KamelPay portal forms with one click. It reads the form
that is on screen, asks DeepSeek for test data that fits it, and types the result in.

Built for the three portals in `hrcms`:

| Portal | Path | Stack |
| --- | --- | --- |
| Admin | `client/admin` | React 18, antd 5, Formik 2, Yup 0.32 |
| Employer (v1) | `client/employer` | React 18, antd 5, Formik 2, Yup 0.32 |
| Employer (v2) | `clientV2/employer` | React 19, antd 6, Formik 2.4, Yup 1.7 |

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open the extension's options (the ⚙ in the popup) and paste a DeepSeek API key from
   [platform.deepseek.com](https://platform.deepseek.com/api_keys). Hit **Test key** to confirm it.

The extension will not run without a key.

## Use

Open a form — on the page, or in a modal, drawer or popover — then either click the extension
icon and press **Fill this form**, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>.

The popup reports what happened: how many fields were filled, which ones failed and why, which
were left alone, and any value the extension had to correct itself. **Show detected form**
outlines the region it decided to fill, if you want to check it picked the right one.

Fields that already have a value are skipped by default, so partly-filled forms and
app-set defaults survive. Tick **Overwrite** to replace everything.

## How it works

```
popup  ──run──▶  service worker
                      │  1. inject content scripts (activeTab)
                      │  2. scan  ──▶ page: fields + dropdown options
                      │  3. DeepSeek ──▶ JSON plan
                      │  4. repair the plan against KamelPay's Yup rules
                      │  5. fill  ──▶ page: type, select, pick dates
                      │  6. read back the app's own validation errors
                      │  7. one corrective round-trip, if any errors
                      ▼
                   results ──▶ popup
```

### Finding the form

Anything floating over the page wins — a modal, a drawer, a native `<dialog>`, or any element
that calls itself a dialog through ARIA. When several are open at once the topmost one is
chosen by z-index, so a modal launched from a drawer beats the drawer behind it. Popovers and
`dropdownRender` panels count too, but only when they actually hold a fillable control;
otherwise every open menu would hijack the scan.

A modal or a drawer wins even when it turns out to hold no fields. It covers the page, so
reporting "nothing to fill here" is better than quietly filling a form the user cannot see.

With nothing floating, the target is whichever `<form>` / `.c-form` / `.cc-form` on the page
holds the most fillable controls. Header search boxes, table filters, pagination and menus are
excluded, as is everything in a layer other than the chosen one.

Both Ant Design generations are recognised. antd 6 renamed the modal panel `-content` to
`-container` and the drawer panel `-content` to `-section`, and the portals straddle that
release, so the selectors list both.

### Identifying fields

The portals do not use `<label for>`, and they disagree about everything else, so the label is
resolved by trying each convention in turn:

- **v1 (`CField`)** renders `<div class="input-title">` inside `.c-field`, and sets `id={name}`
  on the widget.
- **v2 (`ThemeInput`)** hardcodes `id="theme-input-id"` on *every* input, so the id is useless —
  the `name` attribute and the sibling `.theme-label` are used instead.
- **v2 (`ThemeSelect`)** passes neither `name` nor `id`, so its label is the only handle it has.

Nothing is keyed on the Formik path. Values are written through DOM events and the component's
own `onChange` maps them into Formik state, which is what makes nested paths like
`properties.0.documentNumber` work without the extension knowing they exist.

### Dropdowns

Ant Design's `Select` is not a `<select>`. The stored value is a database id that never appears
as text, and the options live in a portal that only exists while the dropdown is open. So the
scanner opens each dropdown, reads the options out of the portal (scrolling the virtual list for
long ones), and closes it again without selecting anything.

The model is then given those options with indexes and must return an **index**, never a value —
it cannot invent an id that would fail on submit. At fill time the options are re-read, because
dependent dropdowns (state after country, branch after bank) only populate once the field they
depend on is set. Fields are filled in DOM order for the same reason.

### Getting validation right

Constraints come from three places:

1. **The DOM** — `maxlength`, `min`, `max`, `pattern`, required markers.
2. **`src/lib/domain.js`** — KamelPay's own rules, lifted from the Yup schemas in the repos.
   Each one is injected into the prompt *and* enforced locally afterwards, so a value the model
   still gets wrong is regenerated instead of typed in:

   | Field | Rule | Source |
   | --- | --- | --- |
   | IBAN | `AE` + 21 digits | `/^AE\d{2}\d{3}\d{16}$/` |
   | Emirates ID | 15 digits | `emiratesIdValidation()` |
   | MOL number | 14–35 alphanumeric, ≥1 digit | `/^(?=.*\d)[a-zA-Z\d]+$/` + `.min(14).max(35)` |
   | Establishment ID | 13–35 alphanumeric, ≥1 digit | admin employer schema |
   | TRN | exactly 15 digits | admin employer schema |
   | Employee code | 4–16 of `[0-9A-Za-z_-]` | `addEmployeeSchema` |
   | UAE mobile | `5[024568]` + 7 digits, no dial code | `phoneValidation()` |
   | Password | 12–20, upper + lower + digit + special | `PASSWORD_RULES` |
   | Zip code | 3–10 digits | `workZipCode` |

3. **The page itself** — after filling, every field is blurred, which marks it touched in Formik
   and paints any failing Yup message. Those messages are read back and fed to the model for one
   corrective pass. Anything still failing is reported in the popup rather than retried forever.

Confirmation fields are never left to the model: `confirmPassword` is copied from `password`
after the fact, including across a retry where only the confirm field is being rewritten.

Dates are always exchanged as ISO and reformatted locally, so the model never guesses a display
format. `issue`/`dob`/`joining` are required to be past and `expiry` future, because the
`disabledDate` callbacks that enforce this are invisible from the DOM.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Read and fill the tab you invoke it on, at the moment you invoke it |
| `scripting` | Inject the content scripts on demand |
| `storage` | Store the API key and the last run's results |
| `https://api.deepseek.com/*` | The only network destination |

There is no `content_scripts` block and no site host permissions, so the extension has no
standing access to anything — including future stage and prod URLs, which will work with no
manifest change.

The API key is read only in the background worker. It is never passed to a content script, so it
never enters the page context where portal JavaScript could reach it.

## Layout

```
manifest.json
src/
  background/service-worker.js   orchestration; the only reader of the API key
  content/
    kpaf-core.js                 React-aware value setting, label resolution, date formatting
    kpaf-scan.js                 form detection, field classification, dropdown enumeration
    kpaf-fill.js                 per-widget fill strategies + reading errors back
    kpaf-main.js                 message router inside the page
  lib/
    deepseek.js                  API client
    prompt.js                    prompt construction + response parsing
    domain.js                    KamelPay validation rules and local repair
  popup/                         the one-click UI and the results panel
  options/                       API key and behaviour settings
```

## Notes and limits

- **File uploads are not filled.** Several employer/employee forms require a document upload;
  those must still be done by hand, and the popup lists them as skipped.
- **It does not submit.** Filling stops at the last field, deliberately.
- **OTP fields** get a random 6-digit value, which will not match a real one.
- A very long dropdown is capped at 250 options scanned and 150 shown to the model.
- Forms above 80 fields are truncated; fill twice if you hit that.

## Changing the AI provider

`src/lib/deepseek.js` targets an OpenAI-compatible `/chat/completions` endpoint. Swapping
provider is a base URL, a model name, and the `JSON_MODE_MODELS` set; `prompt.js` and
`domain.js` are provider-agnostic.
