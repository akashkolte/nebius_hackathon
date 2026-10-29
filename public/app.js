// Dispatch web app: plain ES modules, no build step. Talks to the JSON API in src/server.ts.
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
  me: null, sessions: [], tasks: [], models: {}, served: [],
  view: 'home', drawer: null, drawerTab: 'conversation', modelsHarness: 'nebius', modelsDraft: null,
};
const STATUS_LABEL = { running: 'Working', waiting: 'Needs your OK', completed: 'Done', failed: 'Failed', cancelled: 'Stopped' };
const SOURCE_LABEL = { nebius: '✦ Nebius', local: 'local match', selected: 'you chose', session: 'kept', default: 'default', 'single-option': 'only option', 'harness-default': 'harness default' };

// ---- Utilities -----------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function ago(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const shortPath = p => (p || '').replace(/^\/(Users|home)\/[^/]+/, '~');
const label = harness => state.me?.labels?.[harness] || harness;

function inline(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

// Small, safe Markdown: everything is escaped first, then a few constructs are re-enabled.
export function markdown(source) {
  const parts = String(source || '').split(/```[^\n]*\n?/);
  return parts.map((part, index) => {
    if (index % 2 === 1) return `<pre><code>${escapeHtml(part.replace(/\n$/, ''))}</code></pre>`;
    const blocks = escapeHtml(part).split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
    return blocks.map(block => {
      const lines = block.split('\n');
      if (lines.every(l => /^\s*[-*] /.test(l))) return `<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`;
      if (lines.every(l => /^\s*\d+[.)] /.test(l))) return `<ol>${lines.map(l => `<li>${inline(l.replace(/^\s*\d+[.)] /, ''))}</li>`).join('')}</ol>`;
      const heading = block.match(/^(#{1,4}) (.+)$/);
      if (heading && lines.length === 1) return `<h${heading[1].length + 2}>${inline(heading[2])}</h${heading[1].length + 2}>`;
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    }).join('');
  }).join('');
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !path.startsWith('/api/auth')) { showAuth(); throw new Error('Sign in first.'); }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function feedback(element, message, kind = 'info') {
  element.textContent = message;
  element.className = `feedback ${kind}`;
  if (!message) element.classList.add('hidden');
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ---- Auth ----------------------------------------------------------------------------------

let authMode = 'login';
async function showAuth() {
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  const status = await fetch('/api/auth/status').then(r => r.json()).catch(() => ({}));
  authMode = status.canSetup ? 'setup' : 'login';
  $('#auth-confirm').classList.toggle('hidden', authMode !== 'setup');
  $('#auth-confirm').required = authMode === 'setup';
  $('#auth-submit').textContent = authMode === 'setup' ? 'Set password' : 'Sign in';
  $('#auth-copy').textContent = authMode === 'setup' ? 'Choose a password (8+ characters). You will use it to sign in from your phone.'
    : status.configured ? 'Sign in to message your coding agents.' : 'Open Dispatch on the machine it runs on (http://localhost) to set the first password.';
  $('#auth-password').autocomplete = authMode === 'setup' ? 'new-password' : 'current-password';
  $('#auth-password').focus();
}

$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#auth-error').textContent = '';
  const password = $('#auth-password').value;
  try {
    if (authMode === 'setup') {
      if (password !== $('#auth-confirm').value) throw new Error('The passwords do not match.');
      await api('/api/password/setup', { method: 'POST', body: { password } });
    } else await api('/api/auth', { method: 'POST', body: { password } });
    $('#auth-password').value = $('#auth-confirm').value = '';
    $('#auth').classList.add('hidden');
    start();
  } catch (error) { $('#auth-error').textContent = error.message; }
});

$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST', body: {} }).catch(() => {}); location.reload(); });

// ---- Data ----------------------------------------------------------------------------------

async function loadMe() { state.me = await api('/api/me'); renderSidebar(); renderComposerOptions(); }
async function loadSessions() { state.sessions = (await api('/api/sessions')).sessions; renderSessions(); }
async function loadTasks() { state.tasks = (await api('/api/tasks')).tasks; renderTasks(); }
async function loadModels() { const data = await api('/api/models'); state.models = data.configs; state.served = data.served; state.routerModel = data.routerModel; renderComposerOptions(); renderSettings(); }

function upsertTask(summary) {
  const index = state.tasks.findIndex(t => t.id === summary.id);
  if (index >= 0) state.tasks[index] = summary; else state.tasks.unshift(summary);
}

function connectEvents() {
  const source = new EventSource('/api/events');
  // After a reconnect (phone locked, network switch) catch up on whatever was missed.
  source.onopen = () => { $('#live-dot').classList.remove('off'); syncNow(); };
  source.onerror = () => $('#live-dot').classList.add('off');
  source.addEventListener('task', event => {
    const task = JSON.parse(event.data);
    const wasKnown = state.tasks.some(t => t.id === task.id && t.status === task.status);
    upsertTask(task);
    renderTasks();
    if (!wasKnown) loadSessions().catch(() => {});
    if (state.drawer && (state.drawer.sessionId === task.sessionId || state.drawer.taskId === task.id)) refreshDrawer();
  });
  source.addEventListener('sessions', () => loadSessions().catch(() => {}));
}

const liveTasks = () => state.tasks.filter(t => t.status === 'running' || t.status === 'waiting').length;

async function syncNow() {
  await loadTasks().catch(() => {});
  if (state.drawer) refreshDrawer();
}

// Polling backs up the event stream, which some tunnels buffer and phones drop when they sleep:
// every 3 s while an agent is working, every 15 s otherwise.
async function pollLoop() {
  await syncNow();
  setTimeout(pollLoop, liveTasks() ? 3000 : 15000);
}

// ---- Rendering: sidebar & lists ------------------------------------------------------------

function renderSidebar() {
  const health = state.me?.harnesses || {};
  $('#harness-list').innerHTML = Object.entries(health).map(([name, h]) =>
    `<div class="harness ${h.state}" title="${escapeHtml(h.detail)}"><i></i><span>${escapeHtml(label(name))}</span><small>${escapeHtml(h.state.replace('_', ' '))}</small></div>`).join('');
  $('#router-status').innerHTML = `<div class="harness ${health.nebius?.state || 'checking'}"><i></i><span>${escapeHtml((state.routerModel || state.me?.routerModel || '').split('/').pop())}</span></div>`;
  $('#nebius-info').textContent = `Endpoint: ${state.me?.nebiusBaseUrl || ''} · ${health.nebius?.detail || ''}`;
}

function sessionRow(session) {
  const live = session.liveState !== 'history' ? `<span class="badge ${session.liveState}">${session.liveState === 'waiting' ? 'Needs your OK' : 'Working'}</span>` : '';
  return `<button class="row-item" data-session="${escapeHtml(session.id)}">
    <span class="chip ${escapeHtml(session.harness)}">${escapeHtml(label(session.harness))}</span>
    <span class="row-main"><strong>${escapeHtml(session.title)}</strong><small>${escapeHtml(shortPath(session.cwd))}${session.lastPrompt && session.lastPrompt !== session.title ? ` · ${escapeHtml(session.lastPrompt)}` : ''}</small></span>
    <span class="row-side">${live}<small>${ago(session.updatedAt)}</small></span>
  </button>`;
}

function taskRow(task) {
  return `<button class="row-item" data-task="${escapeHtml(task.id)}" ${task.sessionId ? `data-session="${escapeHtml(task.sessionId)}"` : ''}>
    <span class="chip ${escapeHtml(task.harness)}">${escapeHtml(label(task.harness))}</span>
    <span class="row-main"><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.lastEvent || task.error || shortPath(task.cwd))}</small></span>
    <span class="row-side"><span class="badge ${task.status}">${STATUS_LABEL[task.status] || task.status}</span><small>${ago(task.updatedAt)}</small></span>
  </button>`;
}

function approvalCard(task) {
  return `<div class="approval card" data-task="${escapeHtml(task.id)}">
    <div class="eyebrow">${escapeHtml(label(task.harness))} wants to run a command</div>
    <strong>${escapeHtml(task.title)}</strong>
    <pre><code>${escapeHtml(task.approval?.detail || task.approval?.summary || '')}</code></pre>
    <div class="controls"><button class="primary" data-approve="${escapeHtml(task.id)}">Approve</button><button data-decline="${escapeHtml(task.id)}">Decline</button>${task.sessionId ? `<button class="link" data-session="${escapeHtml(task.sessionId)}">Open session ↗</button>` : ''}</div>
  </div>`;
}

function renderTasks() {
  const live = state.tasks.filter(t => t.status === 'running' || t.status === 'waiting');
  $('#active-count').textContent = live.length;
  $('#attention').innerHTML = live.filter(t => t.status === 'waiting').map(approvalCard).join('');
  $('#live-tasks').innerHTML = live.length ? live.map(taskRow).join('') : '<p class="empty">No agent is working right now. Start a task above.</p>';
  $('#all-tasks').innerHTML = state.tasks.length ? state.tasks.map(taskRow).join('') : '<p class="empty">No tasks yet.</p>';
}

function renderSessions() {
  $('#session-count').textContent = state.sessions.length;
  $('#recent-sessions').innerHTML = state.sessions.slice(0, 8).map(sessionRow).join('') || '<p class="empty">No sessions yet. Your first task will create one.</p>';
  const query = $('#session-search').value.trim().toLowerCase();
  const harness = $('#session-filter').value;
  const filtered = state.sessions.filter(s => (!harness || s.harness === harness) && (!query || `${s.title} ${s.cwd} ${s.lastPrompt}`.toLowerCase().includes(query)));
  $('#all-sessions').innerHTML = filtered.map(sessionRow).join('') || '<p class="empty">No matching sessions.</p>';
}

// ---- Composer ------------------------------------------------------------------------------

function harnessReady(name) { const s = state.me?.harnesses?.[name]?.state; return s === 'ready' || s === 'unknown'; }

function modelOptions(harness, includeAuto = true) {
  const config = state.models[harness];
  const options = includeAuto ? ['<option value="">✦ Nebius chooses</option>'] : [];
  for (const model of config?.models || []) if (model.enabled) options.push(`<option value="${escapeHtml(model.id)}">${escapeHtml(model.label)}</option>`);
  return options.join('');
}

function renderComposerOptions() {
  if (!state.me) return;
  const names = Object.keys(state.me.harnesses);
  const current = $('#harness').value || 'auto';
  $('#harness').innerHTML = `<option value="auto">✦ Nebius chooses</option>${names.map(name => `<option value="${name}" ${harnessReady(name) ? '' : 'disabled'}>${escapeHtml(label(name))}${harnessReady(name) ? '' : ` (${escapeHtml(state.me.harnesses[name].state.replace('_', ' '))})`}</option>`).join('')}`;
  $('#harness').value = [...$('#harness').options].some(o => o.value === current && !o.disabled) ? current : 'auto';
  const model = $('#model').value;
  $('#model').innerHTML = $('#harness').value === 'auto' ? '<option value="">✦ Nebius chooses</option>' : modelOptions($('#harness').value);
  if ([...$('#model').options].some(o => o.value === model)) $('#model').value = model;
  const project = $('#project').value;
  $('#project').innerHTML = `<option value="">New folder from your message</option><option value="__new__">+ Named workspace…</option>${(state.me.projects || []).map(p => `<option value="${escapeHtml(p)}">${escapeHtml(shortPath(p))}</option>`).join('')}`;
  if ([...$('#project').options].some(o => o.value === project)) $('#project').value = project;
  $('#session-filter').innerHTML = `<option value="">All harnesses</option>${names.map(n => `<option value="${n}">${escapeHtml(label(n))}</option>`).join('')}`;
}

function composerInput() {
  const project = $('#project').value;
  return {
    prompt: $('#prompt').value.trim(),
    harness: $('#harness').value,
    model: $('#model').value,
    newSession: $('#session-mode').value === 'new',
    cwd: project === '__new__' ? '' : project,
    newWorkspace: project === '__new__' ? $('#workspace-name').value.trim() : '',
    skipPermissions: $('#skip').checked,
  };
}

function routeText(route, prefix) {
  const target = route.sessionId ? `Continue “${escapeHtml(route.sessionTitle)}” in ${escapeHtml(label(route.harness))}` : `New ${escapeHtml(label(route.harness))} session`;
  return `<span class="spark">✦</span><span><b>${prefix}</b> ${target} · ${escapeHtml(route.reason)} · model <b>${escapeHtml((route.model || 'harness default').split('/').pop())}</b> <small>(${escapeHtml(SOURCE_LABEL[route.modelSource] || route.modelSource)})</small> · <small>${escapeHtml(shortPath(route.cwd))}</small></span>`;
}

const previewRoute = debounce(async () => {
  const input = composerInput();
  if (input.prompt.length < 9) { $('#preview').classList.add('hidden'); return; }
  try {
    const { route } = await api('/api/route', { method: 'POST', body: input });
    if ($('#prompt').value.trim() !== input.prompt) return;
    $('#preview').innerHTML = routeText(route, 'Quick preview:');
    $('#preview').classList.remove('hidden');
  } catch { $('#preview').classList.add('hidden'); }
}, 450);

async function startTask() {
  const input = composerInput();
  if (!input.prompt) return feedback($('#feedback'), 'Write what the agent should do first.', 'error');
  $('#start').disabled = true;
  feedback($('#feedback'), input.harness === 'auto' || !input.model ? 'Asking the Nebius router where this belongs…' : 'Starting…');
  try {
    const { task } = await api('/api/tasks', { method: 'POST', body: input });
    $('#prompt').value = '';
    $('#workspace-name').value = '';
    $('#preview').classList.add('hidden');
    feedback($('#feedback'), '');
    upsertTask(task);
    renderTasks();
    await Promise.all([loadSessions(), loadMe()]);
    openDrawer({ sessionId: task.sessionId, taskId: task.id });
  } catch (error) { feedback($('#feedback'), error.message, 'error'); }
  finally { $('#start').disabled = false; }
}

$('#prompt').addEventListener('input', previewRoute);
for (const id of ['#harness', '#session-mode', '#project']) $(id).addEventListener('change', () => {
  if (id === '#harness') $('#model').innerHTML = $('#harness').value === 'auto' ? '<option value="">✦ Nebius chooses</option>' : modelOptions($('#harness').value);
  $('#workspace-row').classList.toggle('hidden', $('#project').value !== '__new__');
  previewRoute();
});
$('#model').addEventListener('change', previewRoute);
$('#start').addEventListener('click', startTask);
$('#prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) startTask(); });

// ---- Drawer --------------------------------------------------------------------------------

function openDrawer(target) {
  state.drawer = { ...target, data: null, task: null };
  state.drawerTab = 'conversation';
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'conversation'));
  $$('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== 'tab-conversation'));
  $('#drawer').classList.remove('hidden');
  $('#tab-conversation').innerHTML = '<p class="empty">Loading…</p>';
  feedback($('#followup-feedback'), '');
  refreshDrawer(true);
}

function closeDrawer() { state.drawer = null; $('#drawer').classList.add('hidden'); }
$('#drawer-close').addEventListener('click', closeDrawer);
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDrawer(); });

const refreshDrawer = debounce(async (resetControls = false) => {
  const drawer = state.drawer;
  if (!drawer) return;
  try {
    let session = null, messages = [], tasks = [];
    if (!drawer.sessionId && drawer.taskId) {
      // CLI tasks learn their session id from the CLI's output a moment after starting.
      const summary = state.tasks.find(t => t.id === drawer.taskId);
      if (summary?.sessionId) drawer.sessionId = summary.sessionId;
    }
    if (drawer.sessionId) {
      const data = await api(`/api/sessions/${encodeURIComponent(drawer.sessionId)}`).catch(() => null);
      if (data) ({ session, messages, tasks } = data);
    }
    const latestId = drawer.taskId && (!tasks.length || tasks[0].id === drawer.taskId || !tasks.some(t => t.id === drawer.taskId)) ? drawer.taskId : tasks[0]?.id;
    const task = latestId ? (await api(`/api/tasks/${latestId}`)).task : null;
    if (state.drawer !== drawer) return;
    Object.assign(drawer, { session, messages, task });
    renderDrawer(resetControls);
  } catch (error) { $('#tab-conversation').innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`; }
}, 150);

function renderDrawer(resetControls) {
  const { session, messages, task } = state.drawer;
  const harness = session?.harness || task?.harness;
  $('#drawer-meta').textContent = [label(harness), session?.currentModel?.split('/').pop() || task?.model?.split('/').pop(), session?.source === 'desktop' ? 'desktop session' : ''].filter(Boolean).join(' · ');
  $('#drawer-title').textContent = session?.title || task?.title || 'Task';
  $('#drawer-cwd').textContent = shortPath(session?.cwd || task?.cwd);

  const running = task && (task.status === 'running' || task.status === 'waiting');
  $('#drawer-approval').innerHTML = task?.status === 'waiting' ? approvalCard(task) : '';
  $('#cancel-task').classList.toggle('hidden', !running);

  const conversation = messages?.length ? messages : task ? [{ role: 'user', text: task.prompt }, ...(task.output ? [{ role: 'assistant', text: task.output }] : [])] : [];
  const bubbles = conversation.map(m => m.role === 'tool'
    ? `<div class="msg tool">↳ ${escapeHtml(m.text)}</div>`
    : `<div class="msg ${m.role}">${m.role === 'user' ? `<p>${escapeHtml(m.text).replace(/\n/g, '<br>')}</p>` : markdown(m.text)}</div>`).join('');
  const status = task ? `<div class="msg status ${task.status}">${running ? '<span class="pulse"></span>' : ''}${STATUS_LABEL[task.status]}${task.events?.length && running ? ` · ${escapeHtml(task.events.at(-1).text.slice(0, 140))}` : ''}${task.status === 'failed' && task.error ? `<br><small>${escapeHtml(task.error.slice(-400))}</small>` : ''}</div>` : '';
  const panel = $('#tab-conversation');
  const atBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 80;
  panel.innerHTML = (bubbles || '<p class="empty">No messages yet.</p>') + status;
  if (atBottom || resetControls) panel.scrollTop = panel.scrollHeight;

  $('#tab-activity').innerHTML = task ? `
    <dl class="facts">
      <dt>Route</dt><dd>${escapeHtml(task.routeReason)} <small>(${escapeHtml(SOURCE_LABEL[task.routeSource] || task.routeSource)})</small>${task.routeFallbackReason ? `<br><small>${escapeHtml(task.routeFallbackReason)}</small>` : ''}</dd>
      <dt>Model</dt><dd>${escapeHtml(task.model || 'harness default')} — ${escapeHtml(task.modelReason)}${task.modelFallbackReason ? `<br><small>${escapeHtml(task.modelFallbackReason)}</small>` : ''}</dd>
      ${task.usage ? `<dt>Tokens</dt><dd>${task.usage.prompt_tokens.toLocaleString()} in · ${task.usage.completion_tokens.toLocaleString()} out</dd>` : ''}
    </dl>
    <ol class="events">${task.events.map(e => `<li class="${e.kind}"><time>${new Date(e.at).toLocaleTimeString()}</time><span>${escapeHtml(e.text.slice(0, 600))}</span></li>`).join('')}</ol>` : '<p class="empty">No task has run in this session from Dispatch yet.</p>';

  if (resetControls) {
    const ready = Object.keys(state.me?.harnesses || {}).filter(h => harnessReady(h) && h !== harness);
    $('#followup-route').innerHTML = `<option value="stay">Stay in ${escapeHtml(label(harness))}</option>${ready.map(h => `<option value="${h}">Hand off to ${escapeHtml(label(h))}</option>`).join('')}`;
    $('#followup-model').innerHTML = modelOptions(harness);
    $('#followup-skip').checked = Boolean(task?.skipPermissions);
  }
  $('#followup-send').disabled = Boolean(running) || !session;
  $('#followup').placeholder = !session ? 'Waiting for the session to start…' : running ? 'The agent is working — you can send a follow-up when it finishes.' : 'Send a follow-up…';
}

$$('.tab').forEach(tab => tab.addEventListener('click', async () => {
  state.drawerTab = tab.dataset.tab;
  $$('.tab').forEach(t => t.classList.toggle('active', t === tab));
  $$('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${tab.dataset.tab}`));
  if (tab.dataset.tab === 'changes' && state.drawer?.sessionId) {
    $('#tab-changes').innerHTML = '<p class="empty">Loading…</p>';
    const { changes } = await api(`/api/sessions/${encodeURIComponent(state.drawer.sessionId)}/changes`).catch(() => ({ changes: '' }));
    $('#tab-changes').innerHTML = changes ? `<pre><code>${escapeHtml(changes)}</code></pre>` : '<p class="empty">No uncommitted git changes in this project (or it is not a git repository).</p>';
  }
}));

$('#followup-route').addEventListener('change', () => {
  const route = $('#followup-route').value;
  const harness = route === 'stay' ? state.drawer?.session?.harness : route;
  $('#followup-model').innerHTML = modelOptions(harness);
});

async function sendFollowup() {
  const drawer = state.drawer;
  const prompt = $('#followup').value.trim();
  if (!drawer?.session || !prompt) return;
  $('#followup-send').disabled = true;
  try {
    const { task } = await api('/api/tasks', { method: 'POST', body: { prompt, sessionId: drawer.session.id, followup: $('#followup-route').value, model: $('#followup-model').value, skipPermissions: $('#followup-skip').checked } });
    $('#followup').value = '';
    upsertTask(task);
    renderTasks();
    if (task.sessionId !== drawer.session.id) { await loadSessions(); openDrawer({ sessionId: task.sessionId, taskId: task.id }); }
    else { drawer.taskId = task.id; refreshDrawer(); }
  } catch (error) { feedback($('#followup-feedback'), error.message, 'error'); $('#followup-send').disabled = false; }
}
$('#followup-send').addEventListener('click', sendFollowup);
$('#followup').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) sendFollowup(); });
$('#cancel-task').addEventListener('click', async () => {
  const task = state.drawer?.task;
  if (task) await api(`/api/tasks/${task.id}/cancel`, { method: 'POST', body: {} }).catch(error => feedback($('#followup-feedback'), error.message, 'error'));
});

// Delegated clicks: rows open the drawer; approval buttons answer the agent.
document.addEventListener('click', async event => {
  const target = event.target.closest('[data-approve],[data-decline],[data-session],[data-task],[data-goto]');
  if (!target) return;
  if (target.dataset.approve || target.dataset.decline) {
    const id = target.dataset.approve || target.dataset.decline;
    target.disabled = true;
    await api(`/api/tasks/${id}/approve`, { method: 'POST', body: { allow: Boolean(target.dataset.approve) } }).catch(error => alert(error.message));
    return;
  }
  if (target.dataset.goto) return showView(target.dataset.goto);
  if (target.closest('#drawer') && !target.dataset.session) return;
  openDrawer({ sessionId: target.dataset.session || null, taskId: target.dataset.task || null });
});

// ---- Views & settings ----------------------------------------------------------------------

const TITLES = { home: 'Command center', sessions: 'Sessions', activity: 'Activity', settings: 'Settings' };
function showView(view) {
  state.view = view;
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach(v => v.classList.toggle('hidden', v.id !== `view-${view}`));
  $('#page-title').textContent = TITLES[view];
  $('#sidebar').classList.remove('open');
  $('#scrim').classList.add('hidden');
  if (view === 'settings') loadModels().catch(() => {});
}
$$('.nav-item').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
$('#menu').addEventListener('click', () => { $('#sidebar').classList.add('open'); $('#scrim').classList.remove('hidden'); });
$('#scrim').addEventListener('click', () => { $('#sidebar').classList.remove('open'); $('#scrim').classList.add('hidden'); });
$('#session-search').addEventListener('input', renderSessions);
$('#session-filter').addEventListener('change', renderSessions);

function renderSettings() {
  $('#router-model').placeholder = `Automatic (${state.routerModel || 'none'})`;
  $('#served-models').innerHTML = state.served.map(id => `<option value="${escapeHtml(id)}">`).join('');
  const health = state.me?.harnesses || {};
  $('#health-table').innerHTML = `<table><tbody>${Object.entries(health).map(([name, h]) => `<tr><td><span class="harness ${h.state}"><i></i>${escapeHtml(label(name))}</span></td><td>${escapeHtml(h.state.replace('_', ' '))}</td><td class="muted">${escapeHtml(h.detail)}</td></tr>`).join('')}</tbody></table>`;
  $('#models-harness').innerHTML = Object.keys(state.models).map(h => `<option value="${h}">${escapeHtml(label(h))}</option>`).join('');
  $('#models-harness').value = state.modelsHarness;
  state.modelsDraft = structuredClone(state.models[state.modelsHarness] || { models: [], defaultModel: '' });
  renderModelsTable();
}

function renderModelsTable() {
  const draft = state.modelsDraft;
  const served = new Set(state.served);
  $('#models-table').innerHTML = draft.models.length ? `<table class="models"><thead><tr><th>On</th><th>Model ID</th><th>Label</th><th>When to use it</th><th></th></tr></thead><tbody>${draft.models.map((m, i) => `
    <tr><td><input type="checkbox" data-field="enabled" data-index="${i}" ${m.enabled ? 'checked' : ''}></td>
    <td><input data-field="id" data-index="${i}" value="${escapeHtml(m.id)}">${state.modelsHarness === 'nebius' && served.size && !served.has(m.id) ? '<small class="error">not served</small>' : ''}</td>
    <td><input data-field="label" data-index="${i}" value="${escapeHtml(m.label)}"></td>
    <td><input data-field="description" data-index="${i}" value="${escapeHtml(m.description)}"></td>
    <td><button class="icon-button" data-remove="${i}" aria-label="Remove">×</button></td></tr>`).join('')}</tbody></table>` : '<p class="empty">No models listed: the harness uses its own default.</p>';
  $('#default-model').innerHTML = `<option value="">None</option>${draft.models.filter(m => m.enabled && m.id).map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label || m.id)}</option>`).join('')}`;
  $('#default-model').value = draft.defaultModel || '';
}

$('#models-table').addEventListener('input', event => {
  const { field, index } = event.target.dataset;
  if (!field) return;
  state.modelsDraft.models[Number(index)][field] = field === 'enabled' ? event.target.checked : event.target.value;
  if (field === 'enabled') renderModelsTable();
});
$('#models-table').addEventListener('click', event => {
  const index = event.target.dataset.remove;
  if (index === undefined) return;
  state.modelsDraft.models.splice(Number(index), 1);
  renderModelsTable();
});
$('#models-harness').addEventListener('change', () => { state.modelsHarness = $('#models-harness').value; renderSettings(); });
$('#add-model').addEventListener('click', () => { state.modelsDraft.models.push({ id: '', label: '', description: '', enabled: true }); renderModelsTable(); });
$('#default-model').addEventListener('change', () => { state.modelsDraft.defaultModel = $('#default-model').value; });
$('#save-models').addEventListener('click', async () => {
  try {
    const models = state.modelsDraft.models.filter(m => m.id.trim()).map(m => ({ ...m, id: m.id.trim() }));
    await api('/api/models', { method: 'POST', body: { harness: state.modelsHarness, models, defaultModel: state.modelsDraft.defaultModel } });
    $('#models-result').textContent = 'Saved.';
    await loadModels();
  } catch (error) { $('#models-result').textContent = error.message; }
});
$('#save-router').addEventListener('click', async () => {
  try {
    const { routerModel } = await api('/api/router-model', { method: 'POST', body: { model: $('#router-model').value } });
    state.routerModel = routerModel;
    $('#nebius-result').textContent = `Router model: ${routerModel}`;
    renderSidebar();
  } catch (error) { $('#nebius-result').textContent = error.message; }
});
$('#test-nebius').addEventListener('click', async () => {
  $('#nebius-result').textContent = 'Testing…';
  try {
    const result = await api('/api/nebius/test', { method: 'POST', body: {} });
    $('#nebius-result').textContent = `✓ ${result.model} replied “${result.reply}” in ${result.latencyMs} ms`;
  } catch (error) { $('#nebius-result').textContent = `✗ ${error.message}`; }
});
$('#refresh-health').addEventListener('click', async () => {
  $('#refresh-health').disabled = true;
  try { await api('/api/harness-health?force=1'); await loadMe(); await loadModels(); } finally { $('#refresh-health').disabled = false; }
});

// ---- Boot ----------------------------------------------------------------------------------

let started = false;
async function start() {
  $('#app').classList.remove('hidden');
  if (started) return;
  started = true;
  await Promise.all([loadMe(), loadModels(), loadSessions(), loadTasks()]);
  connectEvents();
  setTimeout(pollLoop, 3000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { syncNow(); loadSessions().catch(() => {}); } });
  // Health settles after startup; keep the sidebar current.
  setInterval(() => { loadMe().catch(() => {}); }, 15000);
  setInterval(() => { loadSessions().catch(() => {}); }, 30000);
}

if (!window.__DISPATCH_TEST__) {
  fetch('/api/auth/status').then(r => r.json()).then(status => status.signedIn ? start() : showAuth()).catch(showAuth);
}
