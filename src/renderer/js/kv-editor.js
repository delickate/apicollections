'use strict';

/**
 * Editable key/value table (headers, form fields, variables).
 * Calls onChange(rows) after every edit; always shows one empty row to type into.
 * With `files: pickFile`, each row can switch between Text and File; a File row
 * holds a local path in `src`, chosen with pickFile() (resolves to a path or null).
 * With `variables` (a function returning a Map), {{variables}} are highlighted and show their value on hover.
 */
function kvEditor(rows, onChange, { keyPlaceholder = 'Key', valuePlaceholder = 'Value', toggle = true, files = null, variables = null } = {}) {
  const data = rows.map((row) => {
    const entry = { key: row.key ?? '', value: row.value ?? '', enabled: row.enabled !== false };
    if (files) {
      entry.type = row.type === 'file' ? 'file' : 'text';
      if (entry.type === 'file') entry.src = row.src ?? '';
    }
    return entry;
  });
  const tbody = h('tbody');

  const isEmpty = (row) => row.key === '' && row.value === '' && !row.src && row.type !== 'file';
  const emit = () => onChange(data.filter((row) => !isEmpty(row)).map((row) => ({ ...row })));

  function render(focus) {
    tbody.replaceChildren(...[...data, null].map((row, index) => {
      const placeholder = row === null;
      const current = row || { key: '', value: '', enabled: true, ...(files ? { type: 'text' } : {}) };
      const keyInput = h('input', { type: 'text', value: current.key, placeholder: keyPlaceholder, spellcheck: false });
      const valueInput = h('input', { type: 'text', value: current.value, placeholder: valuePlaceholder, spellcheck: false });

      // Ensures this row exists in `data` (the trailing placeholder row is not in it yet).
      const materialise = () => {
        if (placeholder) data.push(current);
      };

      const withVars = (input) => (variables ? variableField(input, variables) : input);
      let keyCell = withVars(keyInput);
      let valueCell = withVars(valueInput);
      if (files) {
        const typeSelect = h('select', {
          class: 'kv-type',
          title: 'Field type',
          onchange: () => {
            materialise();
            current.type = typeSelect.value;
            if (current.type === 'file') {
              current.value = '';
              current.src = current.src || '';
            } else {
              delete current.src;
            }
            emit();
            render();
          },
        }, h('option', { value: 'text' }, 'Text'), h('option', { value: 'file' }, 'File'));
        typeSelect.value = current.type;
        keyCell = h('div', { class: 'kv-key' }, withVars(keyInput), typeSelect);

        if (current.type === 'file') {
          const fileName = current.src ? current.src.split(/[\\/]/).pop() : '';
          const choose = async () => {
            const picked = await files();
            if (!picked) return;
            materialise();
            current.src = picked;
            emit();
            render();
          };
          valueCell = h('div', { class: 'kv-file' },
            h('button', { type: 'button', class: 'kv-file-btn', title: current.src || 'Select a file to upload', onclick: choose },
              icon('paperclip'), h('span', {}, fileName || 'Select file…')),
            current.src ? h('button', {
              type: 'button',
              class: 'icon-btn',
              title: 'Clear file',
              onclick: () => {
                current.src = '';
                emit();
                render();
              },
            }, icon('close')) : null);
        }
      }

      const onInput = (field, input) => () => {
        if (placeholder) {
          data.push({ ...current, [field]: input.value });
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
        h('td', {}, keyCell),
        h('td', {}, valueCell),
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
