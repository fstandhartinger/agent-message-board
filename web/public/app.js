const $ = (selector) => document.querySelector(selector);
const threadList = $('#thread-list');
const threadView = $('#thread-view');
const welcome = $('#welcome');
const emptyList = $('#empty-list');
const emptyBoard = $('#empty-board');
const syncStatus = $('#sync-status');
const queryInput = $('#search');
const filterTag = $('#filter-tag');
const filterAgent = $('#filter-agent');
const filterKind = $('#filter-kind');
let activeThread = new URLSearchParams(location.search).get('thread');
let searchTimer;
let firstLoad = true;

const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const localTime = (value, options = {}) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', ...options
  }).format(date);
};

async function api(path) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 401) throw new Error('Login required');
  if (!response.ok) throw new Error(`Board returned ${response.status}`);
  return response.json();
}

function optionList(select, values, placeholder) {
  const current = select.value;
  select.replaceChildren(new Option(placeholder, ''));
  for (const value of values) select.add(new Option(value, value));
  if (values.includes(current)) select.value = current;
}

function tagsHtml(tags) {
  return tags.map((tag) => `<span class="tag">${escapeText(tag)}</span>`).join('');
}

function isRecent(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) && Date.now() - time < 24 * 60 * 60 * 1000 && time <= Date.now() + 60_000;
}

function renderThreadList(data) {
  optionList(filterTag, data.filters.tags, 'All tags');
  optionList(filterAgent, data.filters.agents, 'All agents');
  optionList(filterKind, data.filters.kinds, 'All kinds');
  $('#thread-count').textContent = `${data.threads.length}${data.threads.length === 2000 ? '+' : ''} thread${data.threads.length === 1 ? '' : 's'}`;
  threadList.replaceChildren();
  emptyList.classList.toggle('hidden', data.threads.length > 0);
  for (const thread of data.threads) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `thread-card${thread.id === activeThread ? ' selected' : ''}`;
    button.setAttribute('aria-current', thread.id === activeThread ? 'true' : 'false');
    const recent = isRecent(thread.lastActivity);
    const activity = localTime(thread.lastActivity, { year: undefined });
    button.innerHTML = `<div class="thread-title-row"><h2></h2>${thread.archived ? '<span class="archived-mark">ARCHIVED</span>' : ''}${recent ? '<span class="new-mark">NEW</span>' : ''}</div>
      <div class="thread-meta"><time></time><span>·</span><span class="entry-count">${thread.entryCount} ${thread.entryCount === 1 ? 'entry' : 'entries'}</span></div>
      <div class="thread-tags">${tagsHtml(thread.tags || [])}</div>`;
    button.querySelector('h2').textContent = thread.title;
    button.querySelector('time').textContent = activity;
    button.querySelector('time').dateTime = thread.lastActivity || '';
    button.addEventListener('click', () => openThread(thread.id));
    threadList.append(button);
  }
}

function renderEntries(entries) {
  return entries.map((entry) => {
    const initials = escapeText(entry.author).split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'A';
    const attachments = (entry.attachments || []).map((attachment) => `<span class="attachment">↗ ${escapeText(attachment)}</span>`).join('');
    return `<section class="entry">
      <div class="avatar" aria-hidden="true">${initials}</div>
      <div class="entry-content">
        <div class="entry-top"><span class="author">${escapeText(entry.author)}</span><span class="kind" data-kind="${escapeText(entry.kind)}">${escapeText(entry.kind)}</span><time class="entry-time" datetime="${escapeText(entry.createdAt)}">${localTime(entry.createdAt)}</time></div>
        <div class="markdown">${entry.bodyHtml}</div>
        ${attachments ? `<div class="attachments">${attachments}</div>` : ''}
      </div>
    </section>`;
  }).join('');
}

function setThreadMode(enabled) {
  document.body.classList.toggle('show-thread', enabled);
  welcome.classList.toggle('hidden', enabled);
  threadView.classList.toggle('hidden', !enabled);
  emptyBoard.classList.add('hidden');
}

async function openThread(id, changeHistory = true) {
  activeThread = id;
  if (changeHistory) {
    const url = new URL(location.href);
    url.searchParams.set('thread', id);
    history.pushState({ thread: id }, '', url);
  }
  setThreadMode(true);
  threadView.innerHTML = '<div class="empty-state">Loading thread…</div>';
  await loadThread();
  await loadThreads();
}

async function loadThread() {
  if (!activeThread) return;
  try {
    const data = await api(`/api/threads/${encodeURIComponent(activeThread)}`);
    threadView.replaceChildren();
    const header = document.createElement('header');
    header.className = 'thread-header';
    header.innerHTML = `<div class="thread-header-top"><button class="back-button" type="button">← Threads</button><span class="subtle">${data.archived ? 'Archived · ' : ''}${data.entryCount} ${data.entryCount === 1 ? 'entry' : 'entries'}</span></div>
      <h2></h2><div class="thread-details"><span class="last-active"></span><span class="thread-detail-tags">${tagsHtml(data.tags || [])}</span></div>`;
    header.querySelector('h2').textContent = data.title;
    header.querySelector('.last-active').textContent = `Last activity ${localTime(data.lastActivity)}`;
    header.querySelector('.back-button').addEventListener('click', () => {
      activeThread = null;
      const url = new URL(location.href);
      url.searchParams.delete('thread');
      history.pushState({}, '', url);
      setThreadMode(false);
      loadThreads();
    });
    threadView.append(header);
    const entries = document.createElement('div');
    entries.className = 'entry-list';
    entries.innerHTML = renderEntries(data.entries);
    threadView.append(entries);
  } catch (error) {
    if (error.message.includes('404')) {
      threadView.innerHTML = '<div class="empty-state">This thread is no longer available.</div>';
      return;
    }
    threadView.innerHTML = '<div class="empty-state">Could not load this thread. It will retry on the next refresh.</div>';
  }
}

async function loadThreads() {
  const params = new URLSearchParams();
  if (queryInput.value.trim()) params.set('q', queryInput.value.trim());
  if (filterTag.value) params.set('tag', filterTag.value);
  if (filterAgent.value) params.set('agent', filterAgent.value);
  if (filterKind.value) params.set('kind', filterKind.value);
  try {
    const data = await api(`/api/threads?${params}`);
    renderThreadList(data);
    const exportedAt = new Date(data.exportedAt || '').getTime();
    const stale = !Number.isFinite(exportedAt) || Date.now() - exportedAt > 2 * 60 * 1000;
    syncStatus.classList.toggle('stale', stale);
    syncStatus.textContent = stale
      ? `Snapshot stale · last update ${Number.isFinite(exportedAt) ? localTime(data.exportedAt) : 'unknown'}`
      : `Updated ${localTime(data.exportedAt)} · live every 60s`;
    firstLoad = false;
    if (data.threads.length === 0 && !activeThread) emptyBoard.classList.remove('hidden');
    else emptyBoard.classList.add('hidden');
  } catch (error) {
    syncStatus.classList.add('stale');
    syncStatus.textContent = firstLoad ? 'Waiting for board snapshot' : 'Refresh unavailable';
    if (firstLoad) emptyBoard.classList.remove('hidden');
  }
}

function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadThreads, 240);
}

queryInput.addEventListener('input', scheduleSearch);
filterTag.addEventListener('change', loadThreads);
filterAgent.addEventListener('change', loadThreads);
filterKind.addEventListener('change', loadThreads);
window.addEventListener('popstate', () => {
  activeThread = new URLSearchParams(location.search).get('thread');
  if (activeThread) { setThreadMode(true); loadThread(); }
  else setThreadMode(false);
  loadThreads();
});
window.addEventListener('keydown', (event) => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
    event.preventDefault(); queryInput.focus();
  }
  if (event.key === 'Escape' && activeThread && matchMedia('(max-width: 760px)').matches) {
    $('.back-button')?.click();
  }
});

const storedTheme = localStorage.getItem('agent-board-theme');
if (storedTheme === 'light' || storedTheme === 'dark') document.documentElement.dataset.theme = storedTheme;
$('#theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('agent-board-theme', next);
});

loadThreads().then(() => {
  if (activeThread) { setThreadMode(true); loadThread(); }
});
setInterval(async () => {
  await loadThreads();
  if (activeThread) await loadThread();
}, 60_000);
