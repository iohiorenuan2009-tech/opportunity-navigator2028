const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ADD = ['teacher', 'hod', 'admin'], PUBLISH = ['hod', 'admin'];
const ROLE_LABEL = { student: 'Student', teacher: 'Teacher', staff: 'Staff', hod: 'Head of department', admin: 'Approver' };
const PLURAL = { student: 'students', teacher: 'teachers', staff: 'staff', hod: 'heads of department', admin: 'admins' };
const filters = { q: '', field: '', type: '', aid: '', hideClosed: true };
let me = null, meta = null, pendingEmail = '';

async function api(path, method = 'GET', body) {
  const res = await fetch(path, { method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status });
  return data;
}
function flash(msg, bad) {
  const f = $('#flash');
  f.textContent = msg; f.className = 'flash' + (bad ? ' err' : ''); f.hidden = false;
  clearTimeout(flash.t); flash.t = setTimeout(() => f.hidden = true, 5000);
}
const view = html => { $('#app').innerHTML = html; };
const daysLeft = iso => Math.round((Date.parse(iso) - Date.now()) / 864e5);
const statusTag = o => { const d = daysLeft(o.deadline); return d < 0 ? ['closed', 'Closed'] : d <= 14 ? ['soon', 'Closing soon'] : ['open', 'Open']; };
const canEdit = o => PUBLISH.includes(me.role) || (o.created_by === me.id && ['pending', 'rejected'].includes(o.status));

function renderNav() {
  const n = $('#nav');
  if (!me) { n.hidden = true; return; }
  const links = [['discover', 'Discover']];
  if (me.role === 'student') links.push(['wishlist', 'Wishlist']);
  if (ADD.includes(me.role)) links.push(['manage', me.role === 'teacher' ? 'My submissions' : 'Review'], ['form', 'Add opportunity']);
  if (me.role === 'admin') links.push(['members', 'Members']);
  n.hidden = false;
  n.innerHTML = links.map(([p, l]) => `<a href="#/${p}">${l}</a>`).join('')
    + `<span class="who">${esc(me.name)} · ${esc(ROLE_LABEL[me.role] || me.role)}</span><button class="btn sm alt" id="logout">Log out</button>`;
  $('#logout').onclick = logout;
}

async function route() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [page, id] = path.split('/');
  if (!meta) meta = await api('/api/meta');
  if (page === 'verify') return renderVerify(new URLSearchParams(query));
  if (!me) { try { me = (await api('/api/me')).user; } catch { me = null; } }
  renderNav();
  if (!me) return renderLogin();
  if (!page || page === 'login') return (location.hash = '#/discover');
  try {
    if (page === 'discover') return await renderDiscover();
    if (page === 'detail') return await renderDetail(id);
    if (page === 'wishlist' && me.role === 'student') return await renderWishlist();
    if (page === 'manage' && ADD.includes(me.role)) return await renderManage();
    if (page === 'form' && ADD.includes(me.role)) return await renderForm(id);
    if (page === 'members' && me.role === 'admin') return await renderMembers();
    location.hash = '#/discover';
  } catch (e) {
    if (e.status === 401) { me = null; return route(); }
    view(`<div class="wrap"><p>${esc(e.message)}</p></div>`);
  }
}
window.addEventListener('hashchange', route);

/* ---------- LOGIN: password, then code or link from email ---------- */
function renderLogin() {
  view(`<div class="auth-page"><div class="auth-card">
    <h1>Welcome back</h1>
    <p class="sub">Accounts are set up by the school. Log in with your school email.</p>
    <div class="form-group"><label for="l-email">Email</label><input id="l-email" type="email" autocomplete="email"></div>
    <div class="form-group"><label for="l-pw">Password</label><input id="l-pw" type="password" autocomplete="current-password"></div>
    <button class="btn block" id="l-go">Continue</button>
    <p class="muted-text">We will email you a code and a sign-in link to confirm it is you.</p>
  </div></div>`);
  const submit = async () => {
    try {
      pendingEmail = $('#l-email').value.trim();
      await api('/api/login', 'POST', { email: pendingEmail, password: $('#l-pw').value });
      location.hash = '#/verify';
    } catch (e) { flash(e.message, true); }
  };
  $('#l-go').onclick = submit;
  $('#l-pw').onkeydown = e => { if (e.key === 'Enter') submit(); };
}

async function renderVerify(params) {
  const token = params.get('token');
  if (token) {
    try {
      me = (await api('/api/verify', 'POST', { token })).user;
      location.hash = '#/discover';
    } catch (e) {
      view(`<div class="auth-page"><div class="auth-card"><h1>Link not valid</h1>
        <p class="sub">${esc(e.message)}</p><a class="btn block" href="#/login">Back to log in</a></div></div>`);
    }
    return;
  }
  if (!pendingEmail) { location.hash = '#/login'; return; }
  view(`<div class="auth-page"><div class="auth-card">
    <h1>Check your email</h1>
    <p class="sub">We sent a 6-digit code and a sign-in link to ${esc(pendingEmail)}. Both expire in 10 minutes.</p>
    <div class="form-group"><label for="v-code">Code</label><input id="v-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div>
    <button class="btn block" id="v-go">Verify and continue</button>
  </div></div>`);
  $('#v-go').onclick = async () => {
    try {
      me = (await api('/api/verify', 'POST', { email: pendingEmail, code: $('#v-code').value })).user;
      pendingEmail = '';
      location.hash = '#/discover';
    } catch (e) { flash(e.message, true); }
  };
}

async function logout() {
  await api('/api/logout', 'POST').catch(() => {});
  me = null; flash('You have been logged out.');
  location.hash = '#/login'; route();
}

/* ---------- SHARED CARDS AND SAVE BUTTONS ---------- */
function oppCard(o, saved) {
  const [cls, txt] = statusTag(o);
  return `<div class="card"><div class="card-main">
    <div class="tags"><span class="tag">${esc(o.type)}</span><span class="tag" data-field="${esc(o.field)}">${esc(o.field)}</span>
      <span class="status ${cls}">${txt}</span></div>
    <h3><a href="#/detail/${o.id}">${esc(o.title)}</a></h3>
    <p class="muted-text">${esc(o.provider)} · ${esc(o.location)}</p>
    <div class="meta"><span>Deadline: ${esc(o.deadline)}</span><span>Aid: ${esc(o.aid)}</span><span>Ages ${o.age_min}–${o.age_max}</span></div>
  </div>${me.role === 'student' ? `<div class="card-side">
    <button class="heart ${saved ? 'on' : ''}" data-save="${o.id}">${saved ? '♥ Saved' : '♡ Save'}</button></div>` : ''}</div>`;
}

function wireSave() {
  document.querySelectorAll('[data-save]').forEach(b => b.onclick = async () => {
    const on = b.classList.contains('on');
    try {
      await api('/api/saved/' + b.dataset.save, on ? 'DELETE' : 'PUT');
      b.classList.toggle('on', !on);
      b.textContent = on ? '♡ Save' : '♥ Saved';
    } catch (e) { flash(e.message, true); }
  });
}

async function act(fn, msg) {
  try { await fn(); flash(msg); route(); } catch (e) { flash(e.message, true); }
}

/* ---------- DISCOVER (everyone) ---------- */
async function renderDiscover() {
  const [opps, saved] = await Promise.all([api('/api/opportunities'),
    me.role === 'student' ? api('/api/saved') : []]);
  const savedIds = new Set(saved.map(o => o.id));
  const list = opps.filter(o =>
    (!filters.q || (o.title + o.provider + o.description + o.field).toLowerCase().includes(filters.q.toLowerCase())) &&
    (!filters.field || o.field === filters.field) && (!filters.type || o.type === filters.type) &&
    (!filters.aid || o.aid === filters.aid) && (!filters.hideClosed || daysLeft(o.deadline) >= 0));
  const opt = (arr, cur) => '<option value="">All</option>' +
    arr.map(v => `<option ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('');
  view(`<div class="wrap">
    <div class="hero"><h1>Hi ${esc(me.first_name)}, this opportunity is about to find you.</h1>
      <p>Programmes, scholarships, competitions and conferences for ALA members.</p></div>
    <div class="page-grid"><aside class="filters">
      <h2>Filter by</h2>
      <input id="f-q" type="search" placeholder="Search" value="${esc(filters.q)}">
      <label class="fld" for="f-field">Field</label><select id="f-field">${opt(meta.fields, filters.field)}</select>
      <label class="fld" for="f-type">Type</label><select id="f-type">${opt(meta.types, filters.type)}</select>
      <label class="fld" for="f-aid">Financial aid</label><select id="f-aid">${opt(meta.aids, filters.aid)}</select>
      <label class="chk"><input type="checkbox" id="f-closed" ${filters.hideClosed ? 'checked' : ''}> Hide closed</label>
    </aside>
    <section><p class="count">${list.length} found</p>
      ${list.map(o => oppCard(o, savedIds.has(o.id))).join('') || '<div class="empty">No opportunities match.</div>'}
    </section></div></div>`);
  $('#f-q').onchange = e => { filters.q = e.target.value; renderDiscover(); };
  $('#f-field').onchange = e => { filters.field = e.target.value; renderDiscover(); };
  $('#f-type').onchange = e => { filters.type = e.target.value; renderDiscover(); };
  $('#f-aid').onchange = e => { filters.aid = e.target.value; renderDiscover(); };
  $('#f-closed').onchange = e => { filters.hideClosed = e.target.checked; renderDiscover(); };
  wireSave();
}

async function renderDetail(id) {
  const o = await api('/api/opportunities/' + id);
  const [cls, txt] = statusTag(o);
  const saved = me.role === 'student' && (await api('/api/saved')).some(s => s.id === o.id);
  const rows = [['Field', o.field], ['Type', o.type], ['Financial aid', o.aid], ['Deadline', o.deadline],
    ['Ages', `${o.age_min} to ${o.age_max}`], ['Duration', `${o.duration_weeks} weeks`],
    ['Location', o.location], ['Eligibility', o.eligibility], ['Status', o.status]];
  view(`<div class="wrap"><a class="back-link" href="#/discover">← Back</a>
    <h1 class="page-title">${esc(o.title)}</h1>
    <p class="muted-text">Offered by ${esc(o.provider)} · <span class="status ${cls}">${txt}</span></p>
    <div class="panel"><h2>Description</h2><p class="pre">${esc(o.description)}</p></div>
    <dl class="facts">${rows.map(([k, v]) => `<div class="fact"><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    <div class="actions">
      <a class="btn" href="${esc(o.link)}" target="_blank" rel="noopener noreferrer">Go to application ↗</a>
      ${me.role === 'student' ? `<button class="btn alt ${saved ? 'on' : ''}" data-save="${o.id}">${saved ? '♥ Saved' : '♡ Save to wishlist'}</button>` : ''}
      ${canEdit(o) ? `<a class="btn alt" href="#/form/${o.id}">Edit</a>` : ''}
    </div></div>`);
  wireSave();
}

/* ---------- WISHLIST (students only; nobody else can see it) ---------- */
async function renderWishlist() {
  const items = await api('/api/saved');
  view(`<div class="wrap"><h1 class="page-title">My Wishlist</h1>
    ${items.map(o => { const [cls, txt] = statusTag(o); return `<div class="card"><div class="card-main">
      <h3><a href="#/detail/${o.id}">${esc(o.title)}</a></h3>
      <div class="meta"><span>Deadline: ${esc(o.deadline)}</span><span class="status ${cls}">${txt}</span></div>
      </div><div class="card-side"><button class="heart on" data-save="${o.id}">♥ Saved</button></div></div>`; }).join('')
      || '<div class="empty">Your wishlist is empty. <a href="#/discover">Discover opportunities</a>.</div>'}
  </div>`);
  wireSave();
}

/* ---------- MANAGE (teachers see their submissions; HoD and admin review all) ---------- */
async function renderManage() {
  const rows = await api('/api/opportunities/manage');
  const reviewer = PUBLISH.includes(me.role);
  view(`<div class="wrap wide"><div class="row-between">
    <h1 class="page-title">${me.role === 'teacher' ? 'My submissions' : 'Review opportunities'}</h1>
    <a class="btn" href="#/form">Add opportunity</a></div>
    <div class="scroll"><table>
      <thead><tr><th>Name</th><th>Deadline</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows.map(o => `<tr>
        <td><a href="#/detail/${o.id}">${esc(o.title)}</a><br><span class="muted-text">${esc(o.created_by_name)}</span></td>
        <td>${esc(o.deadline)}</td>
        <td><span class="badge b-${o.status}">${esc(o.status)}</span></td>
        <td><div class="btn-row">
          ${canEdit(o) ? `<a class="btn alt sm" href="#/form/${o.id}">Edit</a>` : ''}
          ${reviewer && o.status !== 'published' ? `<button class="btn sm" data-review="${o.id}" data-action="approve">Approve</button>` : ''}
          ${reviewer && o.status !== 'rejected' ? `<button class="btn alt sm" data-review="${o.id}" data-action="reject">Reject</button>` : ''}
          ${canEdit(o) ? `<button class="btn danger sm" data-del="${o.id}">Delete</button>` : ''}
        </div></td></tr>`).join('') || '<tr><td colspan="4">Nothing here yet.</td></tr>'}</tbody>
    </table></div></div>`);
  document.querySelectorAll('[data-review]').forEach(b => b.onclick = () =>
    act(() => api(`/api/opportunities/${b.dataset.review}/review`, 'POST', { action: b.dataset.action }),
      b.dataset.action === 'approve' ? 'Published.' : 'Rejected.'));
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    if (confirm('Delete this opportunity? This cannot be undone.'))
      act(() => api('/api/opportunities/' + b.dataset.del, 'DELETE'), 'Deleted.');
  });
}

/* ---------- ADD / EDIT ---------- */
const FORM_KEYS = ['title', 'provider', 'description', 'field', 'type', 'aid', 'deadline',
  'age_min', 'age_max', 'duration_weeks', 'location', 'eligibility', 'link'];

async function renderForm(id) {
  const o = id ? await api('/api/opportunities/' + id) : {};
  const sel = (k, arr) => `<select id="f-${k}"><option value="">Choose</option>${arr.map(v =>
    `<option ${o[k] === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
  const inp = (k, label, type = 'text', full = false) => `<div class="${full ? 'full ' : ''}form-group">
    <label for="f-${k}">${label}</label>${k === 'description'
      ? `<textarea id="f-${k}" rows="5" maxlength="2000">${esc(o[k])}</textarea>`
      : `<input id="f-${k}" type="${type}" value="${esc(o[k])}">`}</div>`;
  view(`<div class="wrap"><a class="back-link" href="#/manage">← Back</a>
    <h1 class="page-title">${id ? 'Edit opportunity' : 'Add opportunity'}</h1>
    ${me.role === 'teacher' ? '<p class="muted-text">Your opportunity will be sent to the head of department for approval.</p>' : ''}
    <div class="panel formgrid">
      ${inp('title', 'Name', 'text', true)}${inp('provider', 'Provider', 'text', true)}${inp('description', 'Description', 'text', true)}
      <div class="form-group"><label for="f-field">Field</label>${sel('field', meta.fields)}</div>
      <div class="form-group"><label for="f-type">Type</label>${sel('type', meta.types)}</div>
      <div class="form-group"><label for="f-aid">Financial aid</label>${sel('aid', meta.aids)}</div>
      ${inp('deadline', 'Deadline', 'date')}${inp('age_min', 'Minimum age', 'number')}${inp('age_max', 'Maximum age', 'number')}
      ${inp('duration_weeks', 'Duration (weeks)', 'number')}${inp('location', 'Location')}
      ${inp('eligibility', 'Eligibility', 'text', true)}${inp('link', 'Application link (https://…)', 'url', true)}
      <div class="full actions"><button class="btn" id="save-opp">Save opportunity</button></div>
    </div></div>`);
  $('#save-opp').onclick = async () => {
    const body = Object.fromEntries(FORM_KEYS.map(k => [k, $('#f-' + k).value.trim()]));
    try {
      await api(id ? '/api/opportunities/' + id : '/api/opportunities', id ? 'PUT' : 'POST', body);
      flash(PUBLISH.includes(me.role) ? 'Opportunity saved.' : 'Saved and sent for approval.');
      location.hash = '#/manage';
    } catch (e) { flash(e.message, true); }
  };
}

/* ---------- APPROVERS: see, add, import, edit and remove members ---------- */
const mf = { q: '', role: '', status: '', editing: null, report: null };
const MAX_APPROVERS = 3;

function parseTable(text) {            // reads CSV or text pasted from Excel / Google Sheets
  const first = text.split(/\r?\n/)[0] || '';
  const d = first.includes('\t') ? '\t' : first.includes(';') && !first.includes(',') ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === d) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  row.push(cur); rows.push(row);
  const clean = rows.filter(r => r.some(x => x.trim()));
  if (clean.length < 2) return [];
  const head = clean[0].map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  return clean.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

async function renderMembers() {
  const [rows, groups] = await Promise.all([api('/api/admin/members'), api('/api/admin/groups')]);
  const roles = [...new Set(rows.map(r => r.role))];
  const approvers = rows.filter(r => r.role === 'admin').length;
  const active = rows.filter(r => r.on_platform).length;
  const ed = mf.editing ? rows.find(r => r.id === mf.editing) : null;
  const shown = rows.filter(r =>
    (!mf.q || (r.name + r.email + r.group).toLowerCase().includes(mf.q.toLowerCase())) &&
    (!mf.role || r.role === mf.role) &&
    (!mf.status || (mf.status === 'on') === r.on_platform));
  const roleOpts = sel => Object.entries(ROLE_LABEL).map(([k, v]) =>
    `<option value="${k}" ${sel === k ? 'selected' : ''}>${v}</option>`).join('');
  const bulk = (scope, value, label) => `<div class="bulk"><span>${esc(label)}</span>
    <button class="btn sm" data-bulk data-label="${esc(label)}" data-scope="${scope}" data-value="${esc(value)}" data-on="1">Give access</button>
    <button class="btn alt sm" data-bulk data-label="${esc(label)}" data-scope="${scope}" data-value="${esc(value)}" data-on="">Remove access</button></div>`;

  view(`<div class="wrap wide"><h1 class="page-title">Members</h1>
    <p class="muted-text">${rows.length} people in the database · ${active} can log in · ${approvers} of ${MAX_APPROVERS} approvers.
      Nobody can sign up by themselves: only people added here can log in.</p>

    <div class="panel"><h2>${ed ? 'Edit ' + esc(ed.name) : 'Add one person'}</h2>
      <div class="formgrid">
        <div class="form-group"><label for="m-first">First name</label><input id="m-first" value="${esc(ed ? ed.first_name : '')}"></div>
        <div class="form-group"><label for="m-last">Last name</label><input id="m-last" value="${esc(ed ? ed.last_name : '')}"></div>
        <div class="form-group"><label for="m-email">Organisation email</label><input id="m-email" type="email" value="${esc(ed ? ed.email : '')}"></div>
        <div class="form-group"><label for="m-role">Role</label><select id="m-role">${roleOpts(ed ? ed.role : 'student')}</select></div>
        <div class="form-group"><label for="m-group">Group (e.g. Year 1) – optional</label><input id="m-group" value="${esc(ed ? ed.group : '')}"></div>
        ${ed ? '' : '<label class="chk full"><input type="checkbox" id="m-access" checked> Let them log in now (we email them a password)</label>'}
        <div class="full btn-row"><button class="btn" id="m-save">${ed ? 'Save changes' : 'Add person'}</button>
          ${ed ? '<button class="btn alt" id="m-cancel">Cancel</button>' : ''}</div>
      </div></div>

    ${ed ? '' : `<div class="panel"><h2>Add many people at once</h2>
      <p class="muted-text">Upload a CSV, or paste rows copied from Excel / Google Sheets. The first row must be headings:
        <b>first_name, last_name, email, role, group</b> (role and group are optional; role can be student, teacher, hod, staff or admin).
        <a href="#" id="tpl">Download a template</a></p>
      <div class="form-group"><input type="file" id="i-file" accept=".csv,.tsv,.txt"></div>
      <div class="form-group"><textarea id="i-text" rows="4" placeholder="first_name,last_name,email,role,group&#10;Amara,Okafor,amara@school.org,student,Year 1"></textarea></div>
      <label class="chk"><input type="checkbox" id="i-access" checked> Let them log in now (we email each person a password)</label>
      <div class="btn-row"><button class="btn" id="i-go">Import</button></div>
      ${mf.report ? `<p class="muted-text"><b>${mf.report.added} added.</b> ${mf.report.skipped.length ? mf.report.skipped.length + ' skipped:' : ''}</p>
        ${mf.report.skipped.length ? '<ul class="muted-text">' + mf.report.skipped.slice(0, 50).map(x => `<li>${esc(x)}</li>`).join('') + '</ul>' : ''}` : ''}
    </div>`}

    <div class="panel"><h2>Everyone in the organisation</h2>
      <div class="btn-row" style="margin-bottom:14px">
        <input id="s-q" type="search" placeholder="Search name, email or group" value="${esc(mf.q)}" style="flex:1;min-width:200px">
        <select id="s-role"><option value="">All roles</option>${roles.map(r => `<option value="${r}" ${mf.role === r ? 'selected' : ''}>${ROLE_LABEL[r] || r}</option>`).join('')}</select>
        <select id="s-status"><option value="">Any access</option><option value="on" ${mf.status === 'on' ? 'selected' : ''}>Can log in</option><option value="off" ${mf.status === 'off' ? 'selected' : ''}>No access</option></select>
      </div>
      <p class="muted-text">${shown.length} shown${shown.length > 300 ? ' (first 300; use search to narrow)' : ''}</p>
      <div class="scroll"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Group</th><th>Access</th><th>Actions</th></tr></thead>
        <tbody>${shown.slice(0, 300).map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td>${esc(ROLE_LABEL[r.role] || r.role)}</td><td>${esc(r.group)}</td>
          <td><span class="badge ${r.on_platform ? 'b-published' : 'b-rejected'}">${r.on_platform ? 'Can log in' : 'No access'}</span></td>
          <td><div class="btn-row">
            <button class="btn sm ${r.on_platform ? 'alt' : ''}" data-scope="member" data-value="${r.id}" data-on="${r.on_platform ? '' : '1'}">${r.on_platform ? 'Remove access' : 'Give access'}</button>
            ${r.on_platform ? `<button class="btn alt sm" data-reset="${r.id}">New password</button>` : ''}
            <button class="btn alt sm" data-edit="${r.id}">Edit</button>
            ${r.id === me.id ? '' : `<button class="btn danger sm" data-del="${r.id}" data-name="${esc(r.name)}">Delete</button>`}
          </div></td></tr>`).join('') || '<tr><td colspan="6">Nobody here yet. Add someone above.</td></tr>'}</tbody>
      </table></div></div>

    <details class="panel"><summary><b>Give or remove access for a whole group</b></summary>
      ${bulk('all', '', 'Everyone')}
      ${roles.map(r => bulk('role', r, 'All ' + (PLURAL[r] || r))).join('')}
      ${groups.map(g => bulk('group', g.group, `${g.group} (${g.count})`)).join('')}
    </details></div>`);

  const rerender = () => renderMembers();
  $('#s-q').onchange = e => { mf.q = e.target.value; rerender(); };
  $('#s-role').onchange = e => { mf.role = e.target.value; rerender(); };
  $('#s-status').onchange = e => { mf.status = e.target.value; rerender(); };

  $('#m-save').onclick = async () => {
    const body = { first_name: $('#m-first').value, last_name: $('#m-last').value, email: $('#m-email').value,
      role: $('#m-role').value, group: $('#m-group').value };
    try {
      if (ed) { await api('/api/admin/members/' + ed.id, 'PUT', body); mf.editing = null; flash('Saved.'); }
      else { await api('/api/admin/members', 'POST', { ...body, give_access: $('#m-access').checked });
        flash($('#m-access').checked ? 'Added. A password email is on its way.' : 'Added.'); }
      rerender();
    } catch (e) { flash(e.message, true); }
  };
  if (ed) $('#m-cancel').onclick = () => { mf.editing = null; rerender(); };

  if (!ed) {
    $('#tpl').onclick = e => { e.preventDefault();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['first_name,last_name,email,role,group\nAmara,Okafor,amara@school.org,student,Year 1\nLerato,Nkosi,lerato@school.org,teacher,Teachers\n'], { type: 'text/csv' }));
      a.download = 'members-template.csv'; a.click(); };
    $('#i-file').onchange = async e => { const f = e.target.files[0]; if (f) $('#i-text').value = await f.text(); };
    $('#i-go').onclick = async () => {
      const people = parseTable($('#i-text').value);
      if (!people.length) return flash('Nothing found. Make sure the first row has headings and there is at least one person.', true);
      if (!confirm(`Import ${people.length} people${$('#i-access').checked ? ' and email each of them a password' : ''}?`)) return;
      try {
        mf.report = await api('/api/admin/members/import', 'POST', { rows: people, give_access: $('#i-access').checked });
        flash(`${mf.report.added} added.`); rerender();
      } catch (e) { flash(e.message, true); }
    };
  }

  document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { mf.editing = +b.dataset.edit; rerender(); window.scrollTo(0, 0); });
  document.querySelectorAll('[data-reset]').forEach(b => b.onclick = () => { if (confirm('Email this person a new password?'))
    act(() => api(`/api/admin/members/${b.dataset.reset}/reset-password`, 'POST'), 'New password emailed.'); });
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { if (confirm(`Permanently delete ${b.dataset.name}?`))
    act(() => api('/api/admin/members/' + b.dataset.del, 'DELETE'), 'Deleted.'); });
  document.querySelectorAll('[data-scope]:not([data-bulk])').forEach(b => b.onclick = () =>
    act(() => api('/api/admin/members/platform', 'POST', { scope: b.dataset.scope, value: b.dataset.value, on: b.dataset.on === '1' }), 'Updated.'));
  document.querySelectorAll('[data-bulk]').forEach(b => b.onclick = () => {
    const on = b.dataset.on === '1';
    if (confirm(`${on ? 'Give access to' : 'Remove access from'}: ${b.dataset.label}?`))
      act(() => api('/api/admin/members/platform', 'POST', { scope: b.dataset.scope, value: b.dataset.value, on }), 'Updated.'); });
}

route();
