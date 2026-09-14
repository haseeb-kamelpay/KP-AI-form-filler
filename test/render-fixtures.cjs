/**
 * Render real antd markup for the widgets the extension has to read.
 *
 * Run it from inside a portal so it picks up that portal's own antd:
 *
 *   node test/render-fixtures.cjs <portal-dir> > test/fixtures/antd5.html
 *
 * The point is to test the scanner against markup antd produced, not markup
 * anyone hand-wrote from reading its source. Portal-specific wrappers
 * (`.c-field`/`.input-title` in v1, `.cc-form__field`/`.theme-label` in v2)
 * are added around each control the way the portals do, since label and
 * required-marker resolution keys off them.
 */
const path = require('path');

// Resolve against the portal's own dependency tree, not this file's — the
// whole point is to render with the antd that portal actually ships.
const portal = path.resolve(process.argv[2] || process.cwd());
module.paths.unshift(path.join(portal, 'node_modules'));

const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const antd = require('antd');
const dayjs = require('dayjs');

const { Select, DatePicker, Input, Radio, Checkbox, Switch } = antd;
const h = React.createElement;
const version = antd.version;
const major = Number(version.split('.')[0]);

const OPTIONS = [
  { value: '1', label: 'Emirates NBD' },
  { value: '2', label: 'Abu Dhabi Commercial Bank' },
  { value: '3', label: 'Mashreq Bank' },
];

/**
 * v1 renders CField; v2 renders ThemeLabel inside a cc-form field wrapper.
 *
 * The asterisk is v2-only on purpose: `CField.js` in client/admin and
 * client/employer renders `<div class="input-title">{label}</div>` and nothing
 * else, so required-ness genuinely has no DOM trace in the v1 portals. The
 * fixture has to reproduce that rather than a tidier version of it.
 */
function field(id, label, required, child) {
  if (major >= 6) {
    return h(
      'div',
      { className: 'cc-form__field', 'data-case': id },
      h('div', { className: 'theme-label' }, label, required ? h('span', { className: 'color-error' }, ' *') : null),
      child,
    );
  }
  return h(
    'div',
    { className: 'c-field-container', 'data-case': id },
    h(
      'div',
      { className: 'c-field' },
      h('div', { className: 'input-title' }, label),
      child,
    ),
  );
}

const cases = [
  field('select-single-valued', 'Bank Name', true,
    h(Select, { value: '1', options: OPTIONS, style: { width: 240 } })),

  field('select-single-empty', 'Nationality', true,
    h(Select, { placeholder: 'Select nationality', options: OPTIONS, style: { width: 240 } })),

  field('select-search-valued', 'State', true,
    h(Select, { showSearch: true, value: '2', options: OPTIONS, style: { width: 240 } })),

  field('select-multiple-valued', 'Modules', false,
    h(Select, { mode: 'multiple', value: ['1', '3'], options: OPTIONS, style: { width: 240 } })),

  field('select-disabled', 'Locked Unit', false,
    h(Select, { disabled: true, value: '1', options: OPTIONS, style: { width: 240 } })),

  // Exactly what v1's CField renders for an untouched dropdown: `value=""`
  // plus a blank first Option carrying the placeholder text. antd resolves
  // that pair to a *selected item*, which is why it needs its own case.
  field('select-v1-untouched', 'Select bank name', false,
    h(Select, { placeholder: 'Select bank name', showSearch: true, value: '', style: { width: 240 } },
      h(Select.Option, { value: '' }, 'Select bank name'),
      h(Select.Option, { value: '1' }, 'Emirates NBD'))),

  field('picker-valued', 'Date of Birth', true,
    h(DatePicker, { value: dayjs('1994-03-17'), format: 'DD-MMM-YYYY' })),

  field('picker-empty', 'Date of Joining', true,
    h(DatePicker, { format: 'DD-MMM-YYYY', placeholder: 'DD-MM-YYYY' })),

  field('picker-noclear-valued', 'Issue Date', false,
    h(DatePicker, { value: dayjs('2022-05-10'), allowClear: false, format: 'DD/MM/YYYY' })),

  field('range-valued', 'Validity', false,
    h(DatePicker.RangePicker, { value: [dayjs('2024-01-01'), dayjs('2024-03-31')] })),

  field('range-empty', 'Period', false, h(DatePicker.RangePicker, null)),

  field('input-prefix-select', 'Full Name', true,
    h(Input, {
      placeholder: 'First Name',
      prefix: h(Select, { value: 'Mr.', options: [{ value: 'Mr.', label: 'Mr.' }, { value: 'Ms.', label: 'Ms.' }] }),
    })),

  field('input-plain', 'Emp. Code', true, h(Input, { name: 'empCode', placeholder: '00000' })),

  // v1's own prefix pattern: CField puts the country-code Select in a sibling
  // `div.prefix`, not in antd's `.ant-input-prefix`, so it stays a field of its
  // own there. This guards the affix rule against reaching into v1.
  field('sibling-prefix-select', 'Phone Number', false,
    h('div', { className: 'prefix' },
      h(Select, { value: '+971', options: [{ value: '+971', label: '+971' }, { value: '+966', label: '+966' }] }),
      h(Input, { name: 'mobileNo', placeholder: 'Phone Number' }))),
  field('textarea', 'Remarks', false, h(Input.TextArea, { name: 'remarks' })),
  field('radio', 'Employee Type', true,
    h(Radio.Group, {
      options: [{ value: 'KP', label: 'KP' }, { value: 'OTHER_BANK', label: 'Other Bank' }],
    })),
  field('checkbox', 'Active', false, h(Checkbox, { name: 'active' }, 'Active')),
  field('switch', 'Notifications', false, h(Switch, null)),
];

const body = renderToStaticMarkup(
  h('div', { className: 'c-form cc-form', 'data-antd': version }, ...cases),
);

process.stdout.write(`<!-- antd ${version} -->\n${body}\n`);
