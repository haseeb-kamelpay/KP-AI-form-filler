# DOM techniques and traps

Everything here exists because the obvious approach does not work against
React-controlled Ant Design widgets. Before "simplifying" any of it, read the
reason — each one is a workaround for a specific library behaviour.

## Writing a value React will accept

`el.value = x` does nothing useful. React stores the last value it rendered on
`el._valueTracker` and **discards any input event whose value matches**, so the
component never sees the edit.

`setNativeValue()` ([kpaf-core.js:69](../../../../src/content/kpaf-core.js#L69)):

1. Get the **prototype's** `value` setter (React shadows the instance one).
2. Call it with the new value.
3. Rewind `_valueTracker` to the *previous* value.
4. Dispatch `input` and `change`, both bubbling.

Step 3 is the load-bearing one. Without it React treats the event as a no-op.
Note `fillText` sets `''` first and then the value, so a field with existing
content is replaced rather than appended to.

## Clicking something React will notice

`el.click()` on a styled `div` does nothing: rc-select and rc-picker open on
**`mousedown`**, not `click`.

`realClick()` ([kpaf-core.js:88](../../../../src/content/kpaf-core.js#L88)) fires
the full pointer sequence — `pointerdown`, `mousedown`, `pointerup`, `mouseup`,
`click` — which satisfies every widget in the portals. Use it for anything
antd-rendered. A plain `.click()` is only safe on a real `<input type=checkbox>`.

## Blur, and why it matters

`blur()` ([kpaf-core.js:108](../../../../src/content/kpaf-core.js#L108)) dispatches
`blur` (non-bubbling) **and** `focusout` (bubbling), then calls `el.blur()`.

This is not tidiness. Formik marks a field touched on blur, and an untouched
field **does not render its error**. Every fill blurs its field so that
`readErrors()` has something to read. Remove the blur and the retry pass goes
blind.

## Timing

`tick(ms)` is a sleep. The values are empirical — they let React flush and antd's
animations settle. The ones that matter:

| Wait | Where | Why |
| --- | --- | --- |
| 120 ms | after opening a dropdown | the portal must mount |
| 260 ms | after typing in a Select search | **several selects debounce search by 800 ms**; this is a compromise, and the code falls back to clearing the search and scanning the unfiltered list |
| 90 ms | after Enter in a picker | the calendar commits |
| 220 ms | after `apply()`, before `readErrors()` | let Formik finish validating |
| 30 ms | between fields | |

If a widget intermittently fails to take a value, a timing shortfall is the
first suspect.

## Finding the form

`findContainer()` ([kpaf-scan.js:137](../../../../src/content/kpaf-scan.js#L137)):

1. **Anything floating wins.** Modal, drawer, native `<dialog>`, or anything
   claiming to be a dialog through ARIA. In these portals a surface you had to
   open is almost always the thing you opened in order to fill it.
2. Among several open at once, **highest z-index wins** (`stackDepth()` walks
   ancestors taking the max), ties broken by later DOM position. A modal launched
   from a drawer therefore beats the drawer behind it.
3. Otherwise, the page-level `form` / `.c-form` / `.cc-form` holding the most
   fillable controls.
4. Otherwise `document.body`, leaning on the noise filters.

**`blocking`** is the subtle flag. A modal or drawer is `blocking: true` and wins
*even when it holds no fields at all* — it covers the page, so reporting "nothing
to fill here" beats silently filling a form the user cannot see. A popover or
dropdown is `blocking: false` and only wins when it actually holds a fillable
control, otherwise every open menu would hijack the scan.

`el` vs `shell`: `el` is the region the fields live in, `shell` is the whole
layer. They differ for drawers (the title sits outside the body) and the z-index
is read from the `shell`.

### Noise rejection

Three lists, and they are not interchangeable:

- **`ALWAYS_NOISE`** — `.ant-select-dropdown`, `.ant-picker-dropdown`,
  `.ant-table-filter-dropdown`. Never a form, anywhere. Their inputs belong to a
  widget already collected. A plain `.ant-dropdown` is deliberately *absent*,
  because `dropdownRender` can put a real form in one.
- **`CHROME_NOISE`** — headers, nav, pagination, table heads, menus.
- **`FLOATING`** — layers other than the one we chose.

For the last two, an ancestor match only means noise **when that ancestor does
not also contain the chosen container** ([kpaf-scan.js:243](../../../../src/content/kpaf-scan.js#L243)).
A modal's fields all sit under `.ant-modal-wrap`; that wrapper is the shell we
picked, not noise. Getting this backwards rejects every field in the form.

## Label resolution

The portals do not use `<label for>` and disagree about everything else, so
`labelFor()` ([kpaf-core.js:132](../../../../src/content/kpaf-core.js#L132)) tries
six conventions in order:

1. A real `<label for=id>` association.
2. **v1 (`CField`)** — `.input-title` inside `.c-field-container`, then
   `.ant-form-item-label label`.
3. **v2 (`ThemeInput`/`ThemeSelect`)** — the nearest `.theme-label`.
4. A wrapping `<label>` — this is the whole story for checkboxes and radios,
   where the text sits beside the box with no separate title element.
5. `aria-label`, then `aria-labelledby`, then `placeholder`.
6. `humanise(name || id)`.

Two traps:

- **`labelElementFor()`** ([kpaf-core.js:205](../../../../src/content/kpaf-core.js#L205))
  loops over `<label>` elements comparing the attribute, rather than building a
  `[for="…"]` selector. Formik names legitimately contain `.` and `[]`
  (`properties.0.documentNumber`), which are selector syntax. **Never build a
  selector from a field name.**
- **`nearestThemeLabel()`** walks up at most 5 levels. Unbounded, it starts
  picking up the label of whatever field sits above this one in the grid. The
  same bound applies in `isRequired()` and `ownerField()`, for the same reason.

v2's `ThemeInput` hardcodes `id="theme-input-id"` on *every* input, so the id is
worthless as an identifier — the scan explicitly discards it
([kpaf-scan.js:663](../../../../src/content/kpaf-scan.js#L663)) and falls back to
`name` + `.theme-label`. `ThemeSelect` passes neither `name` nor `id`, so its
label is the only handle it has.

## Interactivity, judged from the wrapper

`isEntryInteractive()` ([kpaf-scan.js:378](../../../../src/content/kpaf-scan.js#L378))
tests the **widget wrapper's** `-disabled` class, never the inner `<input>`.

Ant Design marks a Select's search input `readonly` whenever `showSearch` is off.
Testing the input would skip every plain dropdown in the app. Same for pickers: a
read-only picker is still attempted, and the filler reports a refusal rather than
the scan silently dropping it.

`isVisible()` ([kpaf-core.js:24](../../../../src/content/kpaf-core.js#L24)) has a
matching subtlety: antd hides the real `<input>` of checkboxes and radios behind
a styled span, so a zero-size box is **not** proof the control is unavailable —
computed style and `offsetParent` are checked before giving up.

## Dropdown enumeration

An antd `Select` is not a `<select>`:
- the stored value is a **database id that never appears as text**, and
- the options live in a **portal appended to `<body>` that only exists while the
  dropdown is open**.

So `readSelectOptions()` ([kpaf-scan.js:506](../../../../src/content/kpaf-scan.js#L506))
physically opens each one, reads the options out of the portal, and closes it
again without selecting anything. That is why a scan takes a second or two on a
form with many dropdowns — it is not a bug.

`dropdownFor()` locates the right portal via the search input's `aria-controls`,
falling back to the last still-visible `.ant-select-dropdown`.

**Virtualisation**: `rc-virtual-list` renders only the visible slice, so long
lists (banks, nationalities, employers) are scrolled a screenful at a time, with
a synthetic `scroll` event after each jump, until nothing new appears or the cap
is hit. Guard of 40 iterations. Scroll position is restored to 0 afterwards.

At **fill** time the options are re-read rather than trusted, because dependent
dropdowns repopulate as earlier fields are filled. `fillSelect()` also *types*
into the search box where possible — filtering pulls the target into the rendered
slice, which sidesteps virtualisation entirely. If the filtered list does not
contain the target (server-side search, debounce), it clears the search and looks
again; if it is still absent it takes any valid option and records a `warning`.

## Dates

The picker's display format is a React prop — invisible from the DOM. So
`fillDate()` ([kpaf-fill.js:208](../../../../src/content/kpaf-fill.js#L208)) types
each candidate format in turn and keeps the first that commits:

`DD-MMM-YYYY`, `YYYY-MM-DD`, `DD/MM/YYYY`, `DD-MM-YYYY`, `MM/DD/YYYY`

`guessFormatFromPlaceholder()` promotes the placeholder to first position when it
looks like a format string (antd falls back to the format as the placeholder when
none is set). **A format that fails to parse leaves the input empty after blur** —
that is the signal the loop checks, along with the dropdown having closed.

`dateHintFor()` ([kpaf-core.js:319](../../../../src/content/kpaf-core.js#L319))
reads past/future intent off the label, because the portals' `disabledDate`
callbacks are invisible from the DOM: `expiry|valid till|end date` → future;
`birth|dob|issue|joining|start date|hire` → past. Without the hint the model
proposes dates the calendar silently refuses.

## Attributing errors back to fields

`readErrors()` ([kpaf-fill.js:515](../../../../src/content/kpaf-fill.js#L515))
collects `.c-field-container .error`, `.ant-form-item-explain-error` and
`div.color-error`, then `ownerField()` walks up at most 6 levels looking for the
nearest wrapper containing exactly one of our controls.

Two filters worth keeping:
- Messages of `*` or under 3 characters are dropped — **v2's `ThemeLabel` renders
  its required marker as a `.color-error` span holding just `*`**. Note
  `isRequired()` compares the *raw* text for this, because `clean()` strips a
  trailing asterisk (right for a label like `Company Name *`, wrong for the
  marker itself).
- The scope is `lastContainer()`, not `document` — a modal sits over a page that
  is often still showing stale errors of its own, which would otherwise be fed
  back to the model as things to fix.

## One entry per logical control

`collectRoots()` ([kpaf-scan.js:263](../../../../src/content/kpaf-scan.js#L263))
collects wrappers first (`.ant-select`, `.ant-picker`, `.ant-radio-group`,
`.ant-switch`, `.ant-checkbox-group`) and then excludes any `input`/`textarea`
sitting inside one. A naive `querySelectorAll('input')` would report a single
Select twice — as the widget and as its inner search input. Also excluded:
nested selects inside another select's render, and `input` types
`hidden|submit|button|reset|image|file`.

**`file` is excluded here** — that is why uploads are never filled.

## antd 5 vs antd 6

The portals straddle the release, so class names are always listed in pairs:

| Concept | antd 5 | antd 6 |
| --- | --- | --- |
| Modal panel | `.ant-modal-content` | `.ant-modal-container` |
| Drawer panel | `.ant-drawer-content` | `.ant-drawer-section` |

Both appear in `floatingSurfaces()` ([kpaf-scan.js:51](../../../../src/content/kpaf-scan.js#L51))
and in `sectionFor()`'s shell selector ([kpaf-core.js:248](../../../../src/content/kpaf-core.js#L248)).
**Any new antd surface selector must list both generations**, or it will work in
one portal and silently fail in the others.
