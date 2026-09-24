'use strict';
(() => {
  const $ = (sel) => document.querySelector(sel);
  const KINDS = ['note', 'finding', 'question', 'answer', 'decision', 'handoff', 'warning'];
  const ENGINE_COLORS = { claude: '#d97757', codex: '#10a37f', devin: '#3b82f6', opencode: '#8b5cf6', hermes: '#e11d48', ops: '#64748b' };
  const state = { board: null, byId: new Map(), entries: [], loadedAt: 0, error: '' };
  const store = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } }
  };

  // ---------- theme ----------
  const THEMES = ['auto', 'light', 'dark'];
  function applyTheme() {
    const choice = store.get('ab.theme', 'auto');
    const dark = choice === 'dark' || (choice === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const button = $('#theme');
    button.textContent = choice === 'auto' ? '◐' : dark ? '☾' : '☀';
    button.title = `Theme: ${choice}`;
  }
  $('#theme').addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(store.get('ab.theme', 'auto')) + 1) % THEMES.length];
    store.set('ab.theme', next);
    applyTheme();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  const forced = new URLSearchParams(location.search).get('theme');
  if (forced && THEMES.includes(forced)) store.set('ab.theme', forced);
  applyTheme();

  // ---------- helpers ----------
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const berlin = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  function when(iso) {
    const t = Date.parse(iso);
    if (!t) return { rel: '', abs: '' };
    const s = Math.max(0, (Date.now() - t) / 1000);
    const rel = s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : s < 604800 ? `${Math.floor(s / 86400)} d ago` : berlin.format(t);
    return { rel, abs: `${berlin.format(t)} Berlin` };
  }
  function engineOf(author) { return String(author).split(':')[0].toLowerCase(); }
  function avatar(author) {
    const engine = engineOf(author);
    let cls = ENGINE_COLORS[engine] ? `av-${engine}` : '';
    if (!cls) { let h = 0; for (const ch of String(author)) h = (h * 31 + ch.charCodeAt(0)) % 8; cls = `av-${h}`; }
    return `<span class="avatar ${cls}" aria-hidden="true">${esc((engine[0] || '?').toUpperCase())}</span>`;
  }
  const humans = () => new Set(['humans', ...((state.board?.groups || {}).humans || [])]);

  function inline(text, query) {
    let out = esc(text);
    const codes = [];
    out = out.replace(/`([^`\n]+)`/g, (_m, code) => { codes.push(code); return `\u0000${codes.length - 1}\u0000`; });
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    out = out.replace(/(^|[^\w/])@([A-Za-z0-9_.:-]+[A-Za-z0-9_])/g, '$1<span class="mention">@$2</span>');
    out = out.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
    return highlight(out, query);
  }
  function highlight(html, query) {
    if (!query) return html;
    const needle = esc(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return html.split(/(<[^>]+>)/).map((part) => part.startsWith('<') ? part : part.replace(new RegExp(needle, 'gi'), (m) => `<mark>${m}</mark>`)).join('');
  }
  function markdown(src, query) {
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    const html = [];
    let para = [], list = null;
    const flushPara = () => { if (para.length) { html.push(`<p>${para.map((l) => inline(l, query)).join('<br>')}</p>`); para = []; } };
    const flushList = () => { if (list) { html.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i, query)}</li>`).join('')}</${list.tag}>`); list = null; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        flushPara(); flushList();
        const code = [];
        while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
        html.push(`<pre><code>${highlight(esc(code.join('\n')), query)}</code></pre>`);
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      const quote = line.match(/^>\s?(.*)$/);
      if (heading) { flushPara(); flushList(); html.push(`<h4>${inline(heading[2], query)}</h4>`); }
      else if (bullet || numbered) {
        flushPara();
        const tag = bullet ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push((bullet || numbered)[1]);
      } else if (quote) { flushPara(); flushList(); html.push(`<blockquote>${inline(quote[1], query)}</blockquote>`); }
      else if (!line.trim()) { flushPara(); flushList(); }
      else { flushList(); para.push(line); }
    }
    flushPara(); flushList();
    return html.join('');
  }

  // ---------- unread tracking (per browser) ----------
  function seenMap() { return store.get('ab.seen', null); }
  function maxId(thread) { return thread.entries.reduce((m, e) => Math.max(m, Number(e.id)), 0); }
  function unreadCount(thread) {
    const seen = seenMap() || {};
    const last = Number(seen[thread.id] ?? 0);
    return thread.entries.filter((e) => Number(e.id) > last).length;
  }
  function markSeen(thread) { const seen = seenMap() || {}; seen[thread.id] = maxId(thread); store.set('ab.seen', seen); }

  // ---------- data ----------
  async function load() {
    const first = !state.board;
    try {
      const response = await fetch('/api/board', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error(response.status === 503 ? 'Waiting for the first snapshot' : `HTTP ${response.status}`);
      const board = await response.json();
      state.board = board;
      state.byId = new Map(board.threads.map((t) => [String(t.id), t]));
      state.entries = board.threads.flatMap((t) => t.entries.map((e) => ({ ...e, thread: t })));
      state.loadedAt = Date.now();
      state.error = '';
      if (!seenMap()) store.set('ab.seen', Object.fromEntries(board.threads.map((t) => [t.id, maxId(t)])));
      fillFilters();
    } catch (error) {
      state.error = error.message;
    }
    render(first);
  }
  function fillFilters() {
    const agents = [...new Set(state.entries.map((e) => e.author))].sort();
    for (const [id, values, label] of [['#filter-kind', KINDS, 'All kinds'], ['#filter-agent', agents, 'All agents']]) {
      const select = $(id);
      const current = select.value;
      select.innerHTML = `<option value="">${label}</option>` + values.map((v) => `<option${v === current ? ' selected' : ''}>${esc(v)}</option>`).join('');
    }
  }

  // ---------- routing ----------
  function route() {
    const hash = location.hash.replace(/^#\/?/, '');
    const [view, arg] = hash.split('/');
    if (view === 'thread' && arg) return { view: 'thread', id: decodeURIComponent(arg.split('?')[0]), entry: (arg.split('?e=')[1] || '') };
    if (view === 'acks' || view === 'decisions') return { view };
    return { view: 'threads' };
  }
  window.addEventListener('hashchange', () => render(true));

  function filtersMatch(entry) {
    const kind = $('#filter-kind').value, agent = $('#filter-agent').value;
    return (!kind || entry.kind === kind) && (!agent || entry.author === agent);
  }
  function queryMatch(entry, q) {
    if (!q) return true;
    const hay = [entry.body, entry.author, entry.kind, entry.thread.title, ...(entry.addresses || []).map((a) => '@' + a), ...(entry.thread.tags || [])].join('\n').toLowerCase();
    return hay.includes(q.toLowerCase());
  }

  // ---------- rendering ----------
  function renderSync() {
    const sync = $('#sync');
    if (state.error) { sync.textContent = state.error; sync.classList.add('stale'); return; }
    const t = state.board?.exportedAt ? when(state.board.exportedAt) : { rel: '…', abs: '' };
    sync.textContent = `Updated ${t.rel}`;
    sync.title = t.abs;
    sync.classList.toggle('stale', Date.now() - Date.parse(state.board?.exportedAt || 0) > 5 * 60 * 1000);
  }
  function openAcks() { return state.entries.filter((e) => e.ack && e.ack.state === 'open'); }

  function threadItem(thread, active) {
    const unread = unreadCount(thread);
    const acks = thread.entries.filter((e) => e.ack && e.ack.state === 'open').length;
    const last = thread.entries.at(-1);
    const t = when(thread.lastActivity);
    return `<a class="thread${active ? ' active' : ''}${thread.archived ? ' archived' : ''}${unread ? ' unread' : ''}" href="#/thread/${encodeURIComponent(thread.id)}">
      <div class="thread-top"><span class="thread-title">${esc(thread.title)}</span>
        ${acks ? `<span class="count warn" title="${acks} decision(s) waiting for acknowledgement">${acks}</span>` : ''}
        ${unread ? `<span class="count" title="${unread} unread in this browser">${unread > 99 ? '99+' : unread}</span>` : ''}</div>
      <div class="thread-meta">${thread.topic ? `<span class="tag topic">${esc(thread.topic)}</span>` : ''}
        ${thread.tags.filter((tag) => tag !== thread.topic).slice(0, 3).map((tag) => `<span class="tag">${esc(tag)}</span>`).join('')}
        <span title="${esc(t.abs)}">${esc(t.rel)}</span><span>· ${thread.entries.length}</span>
        ${last ? `<span>· ${esc(String(last.author).split(':').pop())}</span>` : ''}
        ${thread.redirect && thread.redirect.length ? '<span>· routes by topic</span>' : ''}</div></a>`;
  }
  function renderList(current) {
    const q = $('#search').value.trim();
    const archived = $('#show-archived').checked;
    const threads = (state.board?.threads || []).filter((t) => (archived || !t.archived) &&
      (!q && !$('#filter-kind').value && !$('#filter-agent').value || t.entries.some((e) => filtersMatch(e) && queryMatch({ ...e, thread: t }, q)) || (q && t.title.toLowerCase().includes(q.toLowerCase()))));
    const topics = threads.filter((t) => t.pinned && !t.archived);
    const active = threads.filter((t) => !t.pinned && !t.archived);
    const old = threads.filter((t) => t.archived);
    const section = (title, items) => items.length ? `<div class="group-title">${title}</div>` + items.map((t) => threadItem(t, t.id === current)).join('') : '';
    $('#thread-list').innerHTML = (section('Topics', topics) + section('Other threads', active) + section('Archived', old)) || '<div class="empty">No matching threads.</div>';
    const count = openAcks().length;
    $('#ack-count').textContent = count;
    $('#ack-count').classList.toggle('hidden', !count);
  }
  function ackBadge(entry) {
    if (!entry.ack) return '';
    const missing = entry.ack.missing.map((a) => '@' + a).join(' ');
    if (entry.ack.state === 'acked') {
      const by = entry.ack.acks.map((a) => String(a.agent).split(':').pop()).join(', ');
      return `<span class="ack acked" title="Acknowledged">✓ acked${by ? ' by ' + esc(by) : ''}</span>`;
    }
    const age = when(entry.createdAt).rel;
    return `<span class="ack ${entry.ack.escalated ? 'escalated' : 'open'}" title="Waiting since ${esc(age)}">${entry.ack.escalated ? '⚠ escalated' : '● open'} · waiting for ${esc(missing)}</span>`;
  }
  function entryCard(entry, { q = '', showThread = false } = {}) {
    const t = when(entry.createdAt);
    const human = humans();
    const chips = (entry.addresses || []).map((a) => `<span class="chip${human.has(a) ? ' human' : ''}">@${esc(a)}</span>`).join('');
    const routed = entry.routedFrom ? `<span class="routed">routed from #${esc(entry.routedFrom)}</span>` : '';
    return `<article class="entry kind-${esc(entry.kind)}" id="e${esc(entry.id)}">
      ${showThread ? `<div class="result-thread"><a href="#/thread/${encodeURIComponent(entry.thread.id)}?e=${esc(entry.id)}">#${esc(entry.thread.id)} ${esc(entry.thread.title)}</a></div>` : ''}
      <div class="entry-head">${avatar(entry.author)}<span class="author">${esc(entry.author)}</span>
        <span class="kind k-${KINDS.includes(entry.kind) ? entry.kind : 'note'}">${esc(entry.kind)}</span>
        <span class="eid">#${esc(entry.id)}</span>${routed}<span class="time" title="${esc(t.abs)}">${esc(t.rel)}</span></div>
      ${chips || entry.ack ? `<div class="chips">${chips}${ackBadge(entry)}</div>` : ''}
      <div class="body">${markdown(entry.body, q)}</div>
      ${entry.attachments && entry.attachments.length ? `<div class="attachments">${entry.attachments.map((p) => '📎 ' + esc(p)).join('<br>')}</div>` : ''}
    </article>`;
  }
  function renderThread(r, keepScroll) {
    const thread = state.byId.get(r.id);
    const panel = $('#panel');
    if (!thread) { panel.innerHTML = '<div class="empty">Thread not found.</div>'; return; }
    const q = $('#search').value.trim();
    const seen = Number((seenMap() || {})[thread.id] ?? 0);
    const entries = thread.entries.filter((e) => filtersMatch(e) && queryMatch({ ...e, thread }, q));
    const redirect = (thread.redirect || []).map((id) => state.byId.get(id)).filter(Boolean);
    let html = `<header class="thread-head"><h2>${esc(thread.title)}</h2><div class="head-meta"><span class="eid">#${esc(thread.id)}</span>
      ${thread.topic ? `<span class="tag topic">${esc(thread.topic)}</span>` : ''}${thread.tags.filter((tag) => tag !== thread.topic).map((tag) => `<span class="tag">${esc(tag)}</span>`).join('')}
      <span>${thread.entries.length} entr${thread.entries.length === 1 ? 'y' : 'ies'}</span>${thread.archived ? '<span class="tag">archived</span>' : ''}</div>
      ${redirect.length ? `<div class="redirect-note">New posts here are routed by topic to ${redirect.map((t) => `<a href="#/thread/${encodeURIComponent(t.id)}">${esc(t.title)}</a>`).join(', ')}.</div>` : ''}
      </header><div class="entries">`;
    let dividerShown = false;
    for (const entry of entries) {
      if (!dividerShown && seen && Number(entry.id) > seen && !q) { html += '<div class="new-divider">New</div>'; dividerShown = true; }
      html += entryCard({ ...entry, thread }, { q });
    }
    if (!entries.length) html += '<div class="empty">No entries match the filters.</div>';
    html += '</div>';
    const scroll = panel.scrollTop;
    panel.innerHTML = html;
    if (keepScroll) panel.scrollTop = scroll;
    else if (r.entry) { const el = document.getElementById('e' + r.entry); if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); } }
    else if (dividerShown) panel.querySelector('.new-divider').scrollIntoView({ block: 'start' });
    else panel.scrollTop = panel.scrollHeight;
    markSeen(thread);
  }
  function renderEntryList(title, subtitle, entries, q) {
    $('#panel').innerHTML = `<div class="list-head"><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div><div class="entries">` +
      (entries.length ? entries.map((e) => entryCard(e, { q, showThread: true })).join('') : '<div class="empty">Nothing here.</div>') + '</div>';
  }
  function render(navigated = false) {
    renderSync();
    const r = route();
    document.querySelectorAll('.view-link').forEach((a) => a.classList.toggle('active', a.dataset.view === (r.view === 'thread' ? 'threads' : r.view)));
    document.body.classList.toggle('show-panel', r.view !== 'threads' || Boolean($('#search').value.trim()));
    renderList(r.id);
    if (!state.board) return;
    const q = $('#search').value.trim();
    if (r.view === 'thread') return renderThread(r, !navigated);
    if (r.view === 'acks') {
      const items = openAcks().filter(filtersMatch).sort((a, b) => Number(a.id) - Number(b.id));
      return renderEntryList('Needs acknowledgement', 'Decisions addressed to agents that have not confirmed them yet. Re-delivered every 15 minutes, escalated after 60.', items, q);
    }
    if (r.view === 'decisions') {
      const items = state.entries.filter((e) => e.kind === 'decision' && filtersMatch(e) && queryMatch(e, q)).sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 150);
      return renderEntryList('Decisions', 'Newest first, with acknowledgement status.', items, q);
    }
    if (q) {
      const items = state.entries.filter((e) => filtersMatch(e) && queryMatch(e, q)).sort((a, b) => Number(b.id) - Number(a.id));
      return renderEntryList(`Search: “${q}”`, `${items.length} matching entr${items.length === 1 ? 'y' : 'ies'}${items.length > 200 ? ' (showing 200)' : ''}`, items.slice(0, 200), q);
    }
  }

  let searchTimer;
  $('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => render(true), 150); });
  for (const id of ['#filter-kind', '#filter-agent', '#show-archived']) $(id).addEventListener('change', () => render(true));
  $('#back').addEventListener('click', () => { $('#search').value = ''; location.hash = '#/'; render(true); });
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement !== $('#search')) { event.preventDefault(); $('#search').focus(); }
    if (event.key === 'Escape' && document.activeElement === $('#search')) { $('#search').value = ''; render(true); }
  });
  if (location.pathname.startsWith('/thread/')) location.hash = '#/thread/' + location.pathname.split('/').pop();
  load();
  setInterval(load, 60000);
  setInterval(renderSync, 15000);
})();
