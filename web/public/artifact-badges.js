(() => {
  const targets = [[".topbar", "06a2a4"]];
  function mount() {
    for (const [selector, id] of targets) for (const host of document.querySelectorAll(selector)) {
      if (getComputedStyle(host).position === 'static') host.classList.add('aid-host');
      if ([...host.children].some(el => el.dataset.aid === id)) continue;
      const badge = document.createElement('span');
      badge.className = 'aid'; badge.dataset.aid = id; badge.textContent = 'a#' + id;
      badge.title = 'Artefakt-ID – klicken zum Kopieren'; badge.tabIndex = 0; badge.setAttribute('role', 'button');
      badge.setAttribute('aria-label', 'Artefakt-ID a#' + id + ' kopieren'); host.append(badge);
    }
  }
  async function copy(event) {
    const badge = event.target.closest?.('.aid');
    if (!badge || (event.type === 'keydown' && !['Enter', ' '].includes(event.key))) return;
    event.preventDefault(); event.stopImmediatePropagation();
    try {
      const value = 'a#' + badge.dataset.aid;
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        const input = document.createElement('textarea'); input.value = value;
        input.style.position = 'fixed'; input.style.opacity = '0'; document.body.append(input);
        input.select(); const copied = document.execCommand('copy'); input.remove();
        if (!copied) throw new Error('clipboard unavailable'); badge.focus();
      }
      badge.title = 'Kopiert';
    } catch { badge.title = 'Kopieren nicht möglich'; }
  }
  document.addEventListener('click', copy, true); document.addEventListener('keydown', copy, true);
  mount(); new MutationObserver(mount).observe(document.body, {childList:true, subtree:true});
})();
