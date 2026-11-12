export function changedSettings(baseline, draft) {
  return Object.fromEntries(Object.entries(draft).filter(([key, value]) => !Object.is(value, baseline[key])));
}

// All callers wait for the refresh requested after the latest mutation.
export function coalescedUpdater(update) {
  let pending = null, again = false;
  return function refresh() {
    again = true;
    if (!pending) pending = (async () => {
      try { do { again = false; await Promise.resolve().then(update); } while (again); }
      finally { pending = null; }
    })();
    return pending;
  };
}

// Replace a data list without sending keyboard users back to the document root.
export function replaceContent(container, ...children) {
  const active = container.ownerDocument.activeElement;
  const key = container.contains(active) ? active?.dataset.focusKey : null;
  container.replaceChildren(...children);
  if (key) {
    const target = [...container.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === key);
    if (target && !target.disabled && !target.hidden) target.focus({ preventScroll: true });
    else { const fallback = container.closest('[tabindex]') || container; if (!fallback.hasAttribute('tabindex')) fallback.tabIndex = -1; fallback.focus({ preventScroll: true }); }
  }
}

export function lockForm(form) {
  if (form.getAttribute('aria-busy') === 'true') return null;
  const controls = [...form.querySelectorAll('button, input, textarea, select')].map(node => [node, node.disabled]);
  form.setAttribute('aria-busy', 'true');
  for (const [node] of controls) node.disabled = true;
  return () => { for (const [node, disabled] of controls) node.disabled = disabled; form.setAttribute('aria-busy', 'false'); };
}

export function lockControl(node) {
  if (node.disabled || node.getAttribute('aria-busy') === 'true') return null;
  const document = node.ownerDocument, hadFocus = document.activeElement === node;
  node.disabled = true; node.setAttribute('aria-busy', 'true');
  return () => {
    node.disabled = false; node.setAttribute('aria-busy', 'false');
    if (hadFocus && node.isConnected && !node.hidden && document.activeElement === document.body) node.focus({ preventScroll: true });
  };
}

export function showFormError(node, text) {
  node.textContent = text; node.tabIndex = -1; node.focus();
}
