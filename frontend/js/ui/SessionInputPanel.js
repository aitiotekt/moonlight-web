/* MoonlightWeb — session input controls. GPLv3 — see repository LICENSE. */
import { t } from '../i18n/i18n.js';

function button(parent, key, action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-secondary';
    b.textContent = t(key);
    b.addEventListener('click', action);
    parent.append(b);
    return b;
}
function checkbox(parent, key, checked) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    label.append(input, document.createTextNode(t(key)));
    parent.append(label);
    return input;
}
function paragraph(parent, key) {
    const p = document.createElement('p');
    p.textContent = t(key);
    parent.append(p);
    return p;
}
function makeDialog(view, titleKey) {
    const dialog = document.createElement('dialog');
    dialog.className = 'session-input-panel';
    // Touch gestures in the editor belong to its controls, not the remote trackpad.
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
        dialog.addEventListener(type, (event) => event.stopPropagation());
    }
    dialog.setAttribute('aria-label', t(titleKey));
    const title = document.createElement('h2');
    title.textContent = t(titleKey);
    dialog.append(title);
    dialog.addEventListener('close', () => dialog.remove());
    view.streamEl.append(dialog);
    return dialog;
}

export function openKeyMappingDialog(view, draft) {
    view._releaseAllPhysKeys();
    const dialog = makeDialog(view, 'sessionInput.mapping');
    const hint = paragraph(dialog, 'sessionInput.mappingHint');
    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'session-input-info';
    info.textContent = 'i';
    info.title = t('sessionInput.mappingExample');
    info.setAttribute('aria-label', t('sessionInput.mappingExample'));
    hint.append(' ', info);
    const status = document.createElement('p');
    dialog.append(status);
    status.setAttribute('role', 'status');
    const table = document.createElement('table');
    const head = document.createElement('thead');
    const headings = document.createElement('tr');
    for (const key of ['from', 'to', 'remove']) {
        const th = document.createElement('th');
        th.textContent = t('sessionInput.' + key);
        headings.append(th);
    }
    head.append(headings);
    table.append(head);
    const body = document.createElement('tbody');
    table.append(body);
    dialog.append(table);
    const list = document.createElement('datalist');
    list.id = 'session-input-key-codes';
    for (const code of view.constructor.KEY_CODES) {
        const option = document.createElement('option');
        option.value = code;
        list.append(option);
    }
    dialog.append(list);
    const rows = [];
    const addRow = (from = '', to = '') => {
        if (rows.length >= 64) return;
        const row = document.createElement('tr');
        const fields = [];
        for (const [side, value] of [from, to].entries()) {
            const cell = document.createElement('td');
            const field = document.createElement('input');
            field.type = 'text';
            field.value = value;
            field.setAttribute('list', list.id);
            field.setAttribute('aria-label', t(side ? 'sessionInput.to' : 'sessionInput.from'));
            field.placeholder = t(side ? 'sessionInput.ignoreHint' : 'sessionInput.keyCode');
            field.autocomplete = 'off';
            field.spellcheck = false;
            cell.append(field);
            row.append(cell);
            fields.push(field);
        }
        const cell = document.createElement('td');
        button(cell, 'sessionInput.remove', () => {
            rows.splice(
                rows.findIndex((r) => r.row === row),
                1,
            );
            row.remove();
        });
        row.append(cell);
        body.append(row);
        rows.push({ row, fields });
        if (!from) fields[0].focus();
    };
    for (const [from, to] of Object.entries(draft.mappings)) addRow(from, to);
    button(dialog, 'sessionInput.add', () => addRow());
    const advanced = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = t('sessionInput.advanced');
    advanced.append(summary);
    paragraph(advanced, 'sessionInput.releaseHint');
    button(advanced, 'sessionInput.release', () => view._releaseAllPhysKeys());
    dialog.append(advanced);
    button(dialog, 'sessionInput.confirm', () => {
        const mappings = {};
        const valid = new Set(view.constructor.KEY_CODES);
        for (const {
            fields: [source, target],
        } of rows) {
            const from = source.value.trim();
            const to = target.value.trim();
            if (!valid.has(from) || (to && !valid.has(to))) {
                status.textContent = t('sessionInput.invalidCode');
                return;
            }
            if (Object.hasOwn(mappings, from)) {
                status.textContent = t('sessionInput.duplicate');
                return;
            }
            if (from === to) {
                status.textContent = t('sessionInput.sameCode');
                return;
            }
            mappings[from] = to;
        }
        draft.mappings = mappings;
        dialog.close();
    });
    button(dialog, 'sessionInput.close', () => dialog.close());
    dialog.showModal();
}

export function openSessionInputPanel(view) {
    view._inputDialog?.close();
    view._releaseAllPhysKeys();
    if (document.pointerLockElement) document.exitPointerLock();
    const dialog = makeDialog(view, 'sessionInput.title');
    paragraph(dialog, 'sessionInput.scope');
    const status = paragraph(
        dialog,
        view._clipboardEnabled ? 'sessionInput.available' : 'sessionInput.unavailable',
    );
    status.setAttribute('role', 'status');
    const draft = structuredClone(view._inputPreferences);
    const master = checkbox(dialog, 'sessionInput.clipboard', draft.clipboard !== 'off');
    master.setAttribute('role', 'switch');
    const advanced = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = t('sessionInput.advanced');
    advanced.append(summary);
    const send = checkbox(
        advanced,
        'sessionInput.send',
        ['send', 'both'].includes(draft.clipboard),
    );
    const receive = checkbox(
        advanced,
        'sessionInput.receive',
        ['receive', 'both'].includes(draft.clipboard),
    );
    paragraph(advanced, 'sessionInput.hostShortcut');
    dialog.append(advanced);
    const update = () => {
        master.checked = send.checked || receive.checked;
        master.indeterminate = send.checked !== receive.checked;
    };
    master.addEventListener('change', () => {
        send.checked = receive.checked = master.checked;
        update();
    });
    send.addEventListener('change', update);
    receive.addEventListener('change', update);
    update();
    button(dialog, 'sessionInput.mapping', () => openKeyMappingDialog(view, draft));
    const remember = checkbox(dialog, 'sessionInput.remember', draft.remember);
    remember.disabled = !view._inputStorageKey;
    paragraph(dialog, 'sessionInput.rememberHint');
    const manual = document.createElement('details');
    const manualSummary = document.createElement('summary');
    manualSummary.textContent = t('sessionInput.manual');
    manual.append(manualSummary);
    paragraph(manual, 'sessionInput.manualHint');
    const text = document.createElement('textarea');
    text.rows = 3;
    text.setAttribute('aria-label', t('sessionInput.manual'));
    manual.append(text);
    const paste = button(manual, 'sessionInput.paste', () => {
        if (!text.value) return;
        if (!view._canSendClipboard()) {
            status.textContent = t('sessionInput.disabled');
            return;
        }
        if (view._pasteSessionText(text.value)) status.textContent = t('sessionInput.sent');
    });
    paste.disabled = true;
    text.addEventListener('input', () => {
        paste.disabled = text.value.length === 0;
    });
    button(manual, 'sessionInput.copy', async () => {
        if (!view._canReceiveClipboard() || view._lastHostClipboard == null) {
            status.textContent = t('sessionInput.noText');
            return;
        }
        text.value = view._lastHostClipboard;
        paste.disabled = text.value.length === 0;
        try {
            await navigator.clipboard.writeText(text.value);
            status.textContent = t('sessionInput.copied');
        } catch {
            text.focus();
            text.select();
            status.textContent = t('sessionInput.copyManually');
        }
    });
    dialog.append(manual);
    button(dialog, 'sessionInput.apply', () => {
        view._setInputPreferences({
            ...draft,
            clipboard: send.checked
                ? receive.checked
                    ? 'both'
                    : 'send'
                : receive.checked
                  ? 'receive'
                  : 'off',
            remember: remember.checked,
        });
        dialog.close();
    });
    button(dialog, 'sessionInput.close', () => dialog.close());
    dialog.addEventListener('close', () => {
        if (view._inputDialog === dialog) view._inputDialog = null;
    });
    view._inputDialog = dialog;
    dialog.showModal();
}
