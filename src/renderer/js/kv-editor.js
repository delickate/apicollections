'use strict';

/**
 * Editable key/value table (headers, form fields, variables).
 * Calls onChange(rows) after every edit; always shows one empty row to type into.
 */
function kvEditor(rows, onChange, { keyPlaceholder = 'Key', valuePlaceholder = 'Value', toggle = true } = {}) {
  const data = rows.map((row) => ({ key: row.key ?? '', value: row.value ?? '', enabled: row.enabled !== false }));
  const tbody = h('tbody');

  const emit = () => onChange(data.filter((row) => row.key !== '' || row.value !== '').map((row) => ({ ...row })));

  function render(focus) {
    tbody.replaceChildren(...[...data, null].map((row, index) => {
      const placeholder = row === null;
      const current = row || { key: '', value: '', enabled: true };
      const keyInput = h('input', { type: 'text', value: current.key, placeholder: keyPlaceholder, spellcheck: false });
      const valueInput = h('input', { type: 'text', value: current.value, placeholder: valuePlaceholder, spellcheck: false });

      const onInput = (field, input) => () => {
        if (placeholder) {
          data.push({ key: '', value: '', enabled: true, [field]: input.value });
          emit();
          render({ index, field, caret: input.selectionStart });
          return;
        }
        current[field] = input.value;
        emit();
      };
      keyInput.addEventListener('input', onInput('key', keyInput));
      valueInput.addEventListener('input', onInput('value', valueInput));

      const tr = h('tr', { class: `${placeholder ? 'placeholder' : ''} ${!placeholder && !current.enabled ? 'disabled' : ''}` },
        h('td', {}, toggle ? h('input', {
          type: 'checkbox',
          checked: current.enabled,
          title: 'Enabled',
          onchange: (event) => {
            current.enabled = event.target.checked;
            tr.classList.toggle('disabled', !current.enabled);
            emit();
          },
        }) : null),
        h('td', {}, keyInput),
        h('td', {}, valueInput),
        h('td', {}, h('button', {
          type: 'button',
          class: 'icon-btn',
          title: 'Remove',
          onclick: () => {
            data.splice(index, 1);
            emit();
            render();
          },
        }, icon('trash'))));

      if (focus && focus.index === index) {
        setTimeout(() => {
          const input = focus.field === 'key' ? keyInput : valueInput;
          input.focus();
          input.setSelectionRange(focus.caret, focus.caret);
        }, 0);
      }
      return tr;
    }));
  }

  render();
  return h('table', { class: 'kv' },
    h('thead', {}, h('tr', {}, h('th'), h('th', {}, keyPlaceholder), h('th', {}, valuePlaceholder), h('th'))),
    tbody);
}
