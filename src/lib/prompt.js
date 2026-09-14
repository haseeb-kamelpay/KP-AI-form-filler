/**
 * Prompt construction for the fill request.
 *
 * The contract with the model is deliberately narrow: it never invents a
 * dropdown value (it picks an index out of a list we scraped from the live
 * DOM), it never invents a date format (always ISO, we reformat for the
 * widget), and it addresses every field by the opaque `uid` we assigned during
 * the scan. That keeps parsing total — there is no fuzzy name matching on the
 * way back in, so a hallucinated field name is dropped rather than mis-applied.
 */

import { ruleFor } from './domain.js';

/**
 * Cap on how many options we describe per dropdown.
 *
 * Set high deliberately: the long lists in these portals (nationality, bank,
 * employer) are exactly the ones where truncating would collapse the variety
 * of generated records, and ~150 options costs under a thousand tokens.
 */
const MAX_OPTIONS_IN_PROMPT = 150;

const SYSTEM_PROMPT = `You generate realistic test data for QA engineers working on KamelPay, a UAE-based HR, payroll and employee-banking platform. Its internal portals (Admin, Employer) are React apps validated with Formik and Yup.

You will be given a JSON description of the form fields currently on screen. You return JSON describing what to put in each one.

## Output format

Respond with a single JSON object and nothing else. No prose, no markdown code fences.

{
  "fields": [
    { "uid": "f1", "value": "Al Noor Trading LLC" },
    { "uid": "f2", "optionIndex": 3 },
    { "uid": "f3", "value": "1991-07-22" },
    { "uid": "f4", "value": true },
    { "uid": "f5", "skip": "read-only reference number" }
  ]
}

Rules for each entry:
- "uid" must be copied exactly from the input. Never invent one.
- Include exactly one entry per input field. If a field genuinely should be left
  empty, use "skip" with a short reason instead of omitting the entry.
- Text, email, number, password, textarea, phone: use "value" with a string.
- select, multiselect, radio: use "optionIndex", the integer "i" of your chosen
  option from that field's "options" list. Never write a free-text "value" for
  these, because the underlying form value is an opaque database id, not the
  visible label. For multiselect you may use "optionIndexes": [0, 2].
- date: use "value" as ISO "YYYY-MM-DD". For a datetime field use
  "YYYY-MM-DDTHH:mm:ss". Never use a display format like "12-Jan-2025".
- daterange: use "value" as "YYYY-MM-DD..YYYY-MM-DD" (start, then end).
- checkbox, switch: use "value" as a JSON boolean.

## Data rules

- Respect every constraint in a field's "constraints" object (maxLength,
  minLength, min, max, pattern). A value that violates one is a failure.
- When a field carries a "rule" string, that rule is the exact format the
  application validates against. Follow it literally; it overrides your
  instincts about what the field "usually" looks like.
- Honour "dateHint": "past" means strictly before today, "future" means
  strictly after today. Issue dates, dates of birth and joining dates are past;
  expiry dates are future. A date of birth should give an adult aged 21 to 60.
- Keep the record internally consistent. The email should derive from the person
  or company name you generated. A first name should suit the gender and
  nationality you picked. City and state must be real for the country selected.
- Default to UAE context: the seven emirates, AED amounts, +971 mobiles,
  UAE banks, Gulf-plausible company names.
- Randomise. This runs many times a day against the same forms, so do not
  fall back to the same handful of names, numbers or companies each time.
- Never output a real person's identity, a real bank account, or any real
  government identifier. Everything must be plainly synthetic test data.
- Keep values short and sane. These are test records, not prose.

## KamelPay specifics

- A "Document Name" dropdown on an employee form gates what its "Document
  Number" field accepts. Pick "Emirates Id" when it is offered — the Add
  Employee form refuses to submit unless at least one document is an Emirates
  Id or a Passport — and give the number as 15 bare digits.
- Identifier fields never carry display formatting. Emirates ID, IBAN and TRN
  go in unpunctuated: no dashes, no spaces, no country dial code.`;

/**
 * Reduce a scanned field to the minimum the model needs. Dropping DOM noise
 * here matters: a 40-field form with long option lists is the difference
 * between a fast reply and a truncated one.
 */
function describeField(field) {
  const out = {
    uid: field.uid,
    kind: field.kind,
    label: field.label || field.name || '(unlabelled)',
  };

  if (field.section) out.section = field.section;
  if (field.name && field.name !== field.label) out.name = field.name;
  if (field.placeholder && field.placeholder !== field.label) {
    out.placeholder = field.placeholder;
  }
  if (field.required) out.required = true;
  if (field.dateHint) out.dateHint = field.dateHint;

  const c = field.constraints || {};
  const constraints = {};
  for (const k of ['maxLength', 'minLength', 'min', 'max', 'pattern', 'step']) {
    if (c[k] !== undefined && c[k] !== null && c[k] !== '') constraints[k] = c[k];
  }
  if (Object.keys(constraints).length) out.constraints = constraints;

  // Format rules describe text a model has to compose. A dropdown's value is
  // an index into options we scraped, so attaching one there only invites a
  // free-text answer — clientV2's "Business Unit ID" is a picker, not a field
  // you can type an id into.
  const optionBased = ['select', 'multiselect', 'radio'].includes(field.kind);
  const rule = optionBased ? null : ruleFor(field);
  if (rule) out.rule = rule.spec;

  if (Array.isArray(field.options) && field.options.length) {
    const shown = field.options.slice(0, MAX_OPTIONS_IN_PROMPT);
    out.options = shown.map((o) => ({ i: o.i, label: o.label }));
    if (field.options.length > shown.length) {
      out.optionsTruncated = `${field.options.length - shown.length} further options exist; choose from those listed`;
    }
  }

  return out;
}

/**
 * Build the DeepSeek messages array.
 *
 * @param {object} ctx
 * @param {Array}  ctx.fields   scanned fields
 * @param {string} ctx.pageTitle
 * @param {string} ctx.url
 * @param {string} ctx.formTitle heading of the detected modal/drawer/form
 * @param {Array}  [ctx.previousErrors] validation messages from a failed pass
 */
export function buildMessages({ fields, pageTitle, url, formTitle, previousErrors }) {
  const payload = {
    page: { title: pageTitle, url, form: formTitle || null },
    fields: fields.map(describeField),
  };

  let user =
    'Generate test data as JSON for the following KamelPay form.\n\n' +
    JSON.stringify(payload, null, 2);

  if (previousErrors?.length) {
    user +=
      '\n\nA previous attempt was rejected by the page. Fix these fields; the ' +
      'message next to each one is either the application\'s own validation ' +
      'error or the reason the widget refused the value:\n' +
      previousErrors
        .map((e) => `- ${e.label || e.uid} (uid ${e.uid}): ${e.message}`)
        .join('\n') +
      '\n\nReturn a full JSON response covering every field listed above, not just the failing ones.';
  }

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/**
 * Parse the model's reply into `{ [uid]: instruction }`.
 *
 * Tolerates the three things models do to JSON even in JSON mode: wrapping it
 * in a markdown fence, prefixing it with a sentence, and returning a bare array
 * instead of the documented object.
 */
export function parseResponse(text, fields) {
  const known = new Set(fields.map((f) => f.uid));
  const raw = extractJson(text);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`The model did not return valid JSON: ${err.message}`);
  }

  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.fields)
      ? parsed.fields
      : null;

  if (!list) {
    throw new Error('The model\'s JSON had no "fields" array.');
  }

  const plan = {};
  const unknown = [];

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const uid = String(entry.uid ?? entry.id ?? '');
    if (!known.has(uid)) {
      if (uid) unknown.push(uid);
      continue;
    }
    plan[uid] = entry;
  }

  return { plan, unknown };
}

/** Pull the JSON body out of a reply that may be fenced or prefixed. */
function extractJson(text) {
  const trimmed = (text || '').trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  const firstBrace = trimmed.search(/[[{]/);
  if (firstBrace > 0) return trimmed.slice(firstBrace);

  return trimmed;
}
