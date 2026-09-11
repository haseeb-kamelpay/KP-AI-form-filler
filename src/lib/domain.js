/**
 * KamelPay domain rules.
 *
 * Every rule here was lifted from a real Yup schema in the hrcms repos
 * (client/admin, client/employer, clientV2/employer). They are used twice:
 *
 *  1. `spec` is injected into the AI prompt for any field whose label/name
 *     matches, so the model knows the exact format before it generates.
 *  2. `regex` + `gen` run locally AFTER the model replies, so a value the model
 *     still got wrong is repaired deterministically instead of being typed into
 *     the page and failing validation.
 *
 * Order matters: the first matching rule wins, so put narrow patterns first.
 */

/* ------------------------------------------------------------------ *
 * Random helpers
 * ------------------------------------------------------------------ */

const digits = (n) =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

const upperAlnum = (n) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: n }, () => pick(chars.split(''))).join('');
};

/* ------------------------------------------------------------------ *
 * Generators for KamelPay's structured identifiers
 * ------------------------------------------------------------------ */

// UAE IBAN: "AE" + 2 check digits + 3-digit bank code + 16-digit account.
// Source: /^AE\d{2}\d{3}\d{16}$/ (employeeForm/validation.ts, bankDetails).
const genIban = () => `AE${digits(21)}`;

// Emirates ID is stored as 15 bare digits; the 784-YYYY-NNNNNNN-C form is
// display only. Source: emiratesIdValidation() + /^[0-9]*$/ + length 15.
const genEid = () => `784${String(randInt(1960, 2005))}${digits(7)}${digits(1)}`;

// MOL number: 14-35 chars, alphanumeric, at least one digit.
// Source: /^(?=.*\d)[a-zA-Z\d]+$/ with .min(14).max(35).
const genMol = () => `MOL${digits(randInt(11, 14))}`;

// Establishment / Business Unit ID: 13-35 chars, alphanumeric, >=1 digit.
const genEstablishment = () => digits(randInt(13, 16));

// TRN: exactly 15 digits.
const genTrn = () => digits(15);

// Employee code: 4-16 of [0-9A-Za-z_-].
const genEmpCode = () => `EMP${digits(randInt(4, 8))}`;

// UAE mobile, national part only (no dial code, no leading zero).
// Source: /^5[024568]\d{7}$/ in utils/validations.ts phoneValidation().
const genUaeMobile = () => `5${pick(['0', '2', '4', '5', '6', '8'])}${digits(7)}`;

// 12-20 chars with upper + lower + digit + special.
const genPassword = () => {
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const nums = '23456789';
  const spec = '!@#$%^&*';
  const body = Array.from({ length: randInt(8, 12) }, () =>
    pick((lower + upper + nums).split('')),
  ).join('');
  return `${pick(upper.split(''))}${body}${pick(nums.split(''))}${pick(spec.split(''))}${pick(lower.split(''))}`;
};

const genPassport = () => `${pick(['A', 'B', 'C', 'K', 'P', 'Z'])}${digits(7)}`;

const genZip = () => digits(randInt(4, 5));

/* ------------------------------------------------------------------ *
 * The rule table
 * ------------------------------------------------------------------ */

export const DOMAIN_RULES = [
  {
    id: 'iban',
    match: /\biban\b/i,
    spec: 'UAE IBAN: the literal "AE" followed by exactly 21 digits (23 characters total, no spaces). Example shape: AE070331234567890123456',
    regex: /^AE\d{21}$/,
    gen: genIban,
  },
  {
    id: 'emiratesId',
    match: /emirates\s*id|\beid\b|^eid/i,
    spec: 'Emirates ID as exactly 15 digit characters and nothing else — no dashes, no spaces, no "784-" prefix formatting. The punctuated 784-1990-1234567-1 form is display only and is REJECTED on submit. Starts with 784, then a 4-digit birth year, then 8 more digits: 784199027135476',
    regex: /^\d{15}$/,
    gen: genEid,
  },
  {
    id: 'molNo',
    match: /\bmol\b|ministry\s*of\s*labour/i,
    spec: 'MOL number: 14 to 35 characters, letters and digits only, and it must contain at least one digit.',
    regex: /^(?=.*\d)[a-zA-Z\d]{14,35}$/,
    gen: genMol,
  },
  {
    id: 'establishmentId',
    match: /establishment|business\s*unit\s*id/i,
    spec: 'Establishment ID: 13 to 35 characters, letters and digits only, and it must contain at least one digit.',
    regex: /^(?=.*\d)[a-zA-Z\d]{13,35}$/,
    gen: genEstablishment,
  },
  {
    id: 'trn',
    match: /\btrn\b|tax\s*registration/i,
    spec: 'TRN: exactly 15 digits, nothing else.',
    regex: /^\d{15}$/,
    gen: genTrn,
  },
  {
    id: 'empCode',
    match: /emp(loyee)?\s*(code|id|no)/i,
    spec: 'Employee code: 4 to 16 characters using only letters, digits, underscore and hyphen.',
    regex: /^[0-9A-Za-z_-]{4,16}$/,
    gen: genEmpCode,
  },
  {
    id: 'passport',
    match: /passport/i,
    spec: 'Passport number: letters and digits only, at most 20 characters.',
    regex: /^[A-Za-z0-9]{1,20}$/,
    gen: genPassport,
  },
  {
    // Sits after `emiratesId` and `passport` so an already-named field
    // ("Emirates Id Number", "Passport Number") keeps its own stricter rule.
    // This one catches the generic label the Add Employee documents grid shows
    // *before* a document type is chosen — the grid renders
    // `${documentName || 'Document'} Number`, and the form is scanned while it
    // still says "Document Number". 15 bare digits is the one shape that
    // satisfies every branch of the row schema: it is exactly what an Emirates
    // Id must be, and it is valid alphanumeric ≤20 for Passport and for
    // Labour Card / Residence Visa.
    id: 'documentNumber',
    match: /document\s*(number|no)\b|\bdocumentnumber\b/i,
    spec: 'Document number: exactly 15 digits, no dashes and no spaces. Use the Emirates ID shape — 784, a 4-digit birth year, then 8 more digits — which is the only value accepted for an Emirates Id and is also valid for every other document type.',
    regex: /^\d{15}$/,
    gen: genEid,
  },
  {
    id: 'password',
    match: /password|passcode/i,
    spec: 'Password: 12 to 20 characters containing at least one uppercase letter, one lowercase letter, one digit and one special character.',
    regex: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*(),.?":{}|<>_\-+=[\]\\/'`~;]).{12,20}$/,
    gen: genPassword,
  },
  {
    id: 'phone',
    match: /phone|mobile|contact\s*(no|number)|whatsapp/i,
    spec: 'UAE mobile number WITHOUT the country code and WITHOUT a leading zero: exactly 9 digits, starting with 5, where the second digit is one of 0, 2, 4, 5, 6 or 8. Example shape: 501234567',
    regex: /^5[024568]\d{7}$/,
    gen: genUaeMobile,
  },
  {
    id: 'zip',
    match: /zip|postal|post\s*code/i,
    spec: 'Zip code: 3 to 10 digits only.',
    regex: /^\d{3,10}$/,
    gen: genZip,
  },
  {
    id: 'otp',
    match: /^\s*otp\b|one\s*time\s*(pass|code)/i,
    spec: 'A 4 to 6 digit numeric code.',
    regex: /^\d{4,6}$/,
    gen: () => digits(6),
  },
  {
    id: 'pin',
    match: /^\s*pin\b|card\s*pin/i,
    spec: 'A 4 digit numeric PIN.',
    regex: /^\d{4}$/,
    gen: () => digits(4),
  },
  {
    id: 'routingCode',
    match: /routing\s*code|swift|\bbic\b/i,
    spec: 'Bank routing / SWIFT style code: 8 to 11 uppercase letters and digits.',
    regex: /^[A-Z0-9]{8,11}$/,
    gen: () => upperAlnum(randInt(8, 11)),
  },
  {
    id: 'address',
    match: /^(work\s*)?address$|street|building/i,
    spec: 'A short UAE street address of at most 40 characters (several KamelPay address fields cap at 40).',
    regex: /^.{1,40}$/,
    gen: () => `${randInt(1, 400)} ${pick(['Al Wasl', 'Jumeirah', 'Al Barsha', 'Khalifa', 'Corniche', 'Hamdan'])} St`,
  },
  {
    id: 'companyName',
    match: /company\s*name|establishment\s*name|employer\s*name|business\s*name/i,
    spec: 'A plausible UAE company name, 3 to 35 characters, letters/digits/spaces only, with no leading or trailing space.',
    regex: /^(?!\s)[a-zA-Z0-9\s$_&+,:;=?@#|'<>.^*()%!-]{3,35}(?<!\s)$/,
    gen: () =>
      `${pick(['Al Noor', 'Gulf', 'Emaar', 'Desert Rose', 'Falcon', 'Oasis', 'Pearl'])} ${pick(['Trading', 'Logistics', 'Contracting', 'Services', 'Group'])} LLC`,
  },
];

/**
 * The rule that applies to a field, or null. Matched against the field's
 * human label first, then its name/id, so `label:"Business Unit ID"` and
 * `name:"establishmentId"` both land on the same rule.
 */
export function ruleFor(field) {
  const haystacks = [field.label, field.name, field.id].filter(Boolean);
  for (const rule of DOMAIN_RULES) {
    if (haystacks.some((h) => rule.match.test(h))) return rule;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Local repair
 * ------------------------------------------------------------------ */

/**
 * Check a model-produced value against the matching domain rule and against
 * the DOM constraints, regenerating locally when it does not hold up.
 *
 * Returns `{ value, repaired, reason }`. `repaired` is true when we had to
 * replace the model's answer, which the popup surfaces so you can see how
 * often the model is drifting.
 */
export function repairValue(field, value) {
  if (value == null || value === '') return { value, repaired: false };
  if (typeof value !== 'string') return { value, repaired: false };

  let out = value.trim();
  const rule = ruleFor(field);

  if (rule) {
    // Strip formatting the model likes to add but the forms reject.
    if (['iban', 'emiratesId', 'documentNumber', 'trn'].includes(rule.id)) {
      out = out.replace(/[\s-]/g, '').toUpperCase();
    }
    if (rule.id === 'phone') {
      out = out.replace(/[\s()+-]/g, '').replace(/^(00)?971/, '').replace(/^0+/, '');
    }
    if (!rule.regex.test(out)) {
      return {
        value: rule.gen(),
        repaired: true,
        reason: `did not match the ${rule.id} format`,
      };
    }
  }

  // DOM-level constraints always win, rule or not.
  const max = field.constraints?.maxLength;
  if (max && out.length > max) {
    out = out.slice(0, max);
    return { value: out, repaired: true, reason: `longer than maxlength ${max}` };
  }

  return { value: out, repaired: out !== value };
}

/**
 * Confirmation fields must mirror their source exactly, which is a rule the
 * model has no reliable way to honour across independent field generations.
 * Resolve it here instead: `confirmPassword` copies `password`,
 * `confirmEmail` copies `email`, and so on.
 */
export function mirrorConfirmationFields(fields, values) {
  const byKey = new Map();
  for (const f of fields) {
    const key = (f.name || f.label || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key) byKey.set(key, f);
  }

  const notes = [];
  for (const f of fields) {
    const raw = (f.name || f.label || '').toLowerCase();
    const m = raw.match(/^(?:confirm|repeat|re-?enter|verify)[\s_-]*(.+)$/);
    if (!m) continue;
    const sourceKey = m[1].replace(/[^a-z0-9]/g, '');
    const source = byKey.get(sourceKey);
    if (!source || values[source.uid] == null) continue;
    if (values[f.uid] !== values[source.uid]) {
      values[f.uid] = values[source.uid];
      notes.push(`${f.label || f.name}: copied from ${source.label || source.name}`);
    }
  }
  return notes;
}
