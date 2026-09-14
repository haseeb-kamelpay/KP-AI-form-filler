# Verifying a change

There is **no build step, no test suite, no linter and no package.json**. Nothing
validates a change except loading it. Plan for that: a typo in a content script
fails silently, because injection errors surface in the page's console, not the
worker's.

## Reload loop

1. `chrome://extensions` → Developer mode on → **Load unpacked** → this folder.
2. After editing:
   - **`src/lib/**` or `src/background/**`** → click the extension's ↻ reload
     icon. The worker is a module and is cached.
   - **`src/content/**`** → ↻ reload **and** reload the page. The scripts are
     injected fresh per run, but a stale `window.KPAF` from before the reload
     will short-circuit the idempotency guards and keep serving the old code.
   - **`src/popup/**` or `src/options/**`** → just reopen the popup/options page.
3. `manifest.json` changes always need the ↻ reload.

## Three consoles

Each context logs somewhere different. Knowing which to open saves most of the
time spent debugging here.

| Context | How to open |
| --- | --- |
| Background worker | `chrome://extensions` → **service worker** link under the extension |
| Content scripts | The page's own DevTools console (they run in the page's tab) |
| Popup | Right-click inside the popup → **Inspect** (it closes if you click away — inspect first, then it stays) |
| Options | It opens in a tab, so normal DevTools |

`chrome.scripting.executeScript` failures appear in the **worker** console; the
script's own runtime errors appear in the **page** console.

## Poking at the content scripts directly

Once a run has injected them, `window.KPAF` is live in the page console:

```js
KPAF.scan.findContainer()              // what would it pick right now?
await KPAF.scan.scan({overwrite:true}) // full scan, no API call, no filling
KPAF.scan.lastContainer()              // what the last scan settled on
KPAF.core.labelFor($0)                 // label for the selected element
KPAF.core.dateHintFor('Expiry Date')   // → 'future'
```

`scan()` is side-effecting — it opens and closes every dropdown — but it never
selects anything, so it is safe to run repeatedly.

To test filling without spending an API call, build a plan by hand:

```js
const r = await KPAF.scan.scan({overwrite: true});
// r.fields[n]._entry is live; uids are f1, f2, …
```

…but note `KPAF.fill.apply()` needs the **parked** fields (with `_entry`) that
`kpaf-main.js` holds in its closure, not a fresh scan's. Easiest path is to drive
it through the worker with the popup and read the results panel.

## Inspecting state

```js
// worker console
await chrome.storage.session.get('run')     // last run, exactly as the popup sees it
await chrome.storage.local.get(null)        // settings (includes the API key — care)
```

The popup's context line already surfaces the useful summary: container kind and
title, field count, whether a retry happened, and total tokens.

## What to check before calling a change done

The extension is a pipeline of heuristics against three different app versions, so
a change that works on one form routinely breaks another. Worth exercising:

- **A page form**, a **modal**, and a **drawer** — the three container paths.
- **A form on v1** (`client/admin` or `client/employer`, antd 5) and **on v2**
  (`clientV2/employer`, antd 6). Label resolution and surface selectors differ.
- **A dependent dropdown pair** — country → state, or bank → branch. This is what
  DOM-order filling and fill-time option re-reading exist for.
- **A long dropdown** — nationality or bank, to exercise virtual-list scrolling.
- **A partly-filled form**, with `overwrite` off then on.
- **A form with a date pair** — issue and expiry, to check `dateHint`.

Then read the popup's four panels, which are the real test output: **Needs
attention** (fill failures + the app's Yup messages), **Adjusted locally**
(domain repairs and mirrored confirmations — a rising count means the prompt or a
rule is drifting), **Filled values**, and **Skipped fields**.

## Common failure signatures

| What you see | Usually means |
| --- | --- |
| "Found no form fields on this page" | `findContainer()` picked a blocking surface with nothing in it, or everything was filtered — check `skipped[]` |
| Every field skipped as "already filled" | `overwrite` is off and the form is prefilled — expected |
| One field fills, the rest report "the model did not return a value" | The reply was truncated. Check `finish_reason`; lower the field count or `MAX_OPTIONS_IN_PROMPT` |
| "The model did not return valid JSON" | `extractJson()` could not find a body — log the raw `text` in `parseResponse()` |
| Dropdown "did not open" | Timing, or `dropdownFor()` lost the portal. Try raising the 120 ms wait |
| Selection "did not stick" | The option was clicked but React rejected it — usually a dependency not yet populated |
| A value lands then vanishes | `setNativeValue()`'s tracker rewind is not reaching this widget; it may have its own controlled wrapper |
| Nothing happens, no error | Content scripts did not inject. Check the worker console; `activeTab` does not apply to `chrome://` pages, the Web Store, or PDF viewers |

## Permissions model

No `content_scripts` block and no site host permissions, so the extension has
**no standing access to anything**. `activeTab` grants access only to the tab you
invoke it on, only at that moment. Future stage and prod URLs work with no
manifest change — do not add host permissions for portal domains, it would be a
regression in the security posture.

The only network host is `https://api.deepseek.com/*`.
