(function () {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  let mcpUrl = location.origin + '/mcp';

  fetch('/api/config').then((r) => r.json()).then((cfg) => {
    mcpUrl = cfg.mcp_url;
    $('mcp-url').textContent = cfg.mcp_url;
    $('ttl').textContent = String(cfg.reservation_ttl_hours);
    if (cfg.google_login) {
      $('google-btn').removeAttribute('aria-disabled');
      $('google-state').textContent = 'Available.';
    } else {
      $('google-state').textContent = 'Not configured on this deployment yet (the owner must register the OAuth client).';
    }
  }).catch(() => { $('google-state').textContent = 'Could not read the configuration.'; });

  $('anon-btn').addEventListener('click', async () => {
    const out = $('anon-out');
    out.hidden = false;
    out.replaceChildren(el('p', 'muted small', 'Generating…'));
    try {
      const res = await fetch('/auth/anonymous', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ? body.error.message : res.statusText);
      const cmd = 'claude mcp add --transport http gta6 ' + (body.mcp_url || mcpUrl) + ' --header "Authorization: Bearer ' + body.token + '"';
      out.replaceChildren(
        el('p', 'warn', 'This key is shown only now. Keep it: it is your anonymous identity.'),
        el('pre', '', cmd),
      );
      $('anon-btn').disabled = true;
    } catch (err) {
      out.replaceChildren(el('p', 'warn', 'Failed: ' + err.message));
    }
  });

  const fmt = (v, kind) => {
    if (v === null || v === undefined) return 'unknown';
    if (kind === 'pct') return Math.round(v * 100) + '%';
    if (kind === 'min') return v < 90 ? Math.round(v) + ' min' : (v / 60).toFixed(1) + ' h';
    return String(v);
  };
  const cell = (tr, v, cls) => { const td = el('td', cls, v); tr.append(td); };
  fetch('/api/metrics?period=30d').then((r) => r.json()).then((m) => {
    const s = m.summary;
    const k = $('kpis');
    k.replaceChildren();
    [['Accepted deliveries', s.accepted], ['Delivered', s.delivered], ['Rejected', s.rejected], ['Expired (24h)', s.expired],
      ['PRs merged', s.merged_prs], ['Within 24h', fmt(s.delivered_within_24h_rate, 'pct')],
      ['Median to delivery', fmt(s.median_minutes_to_delivery, 'min')], ['Active reservations', s.active_now],
      ['Google accounts', s.participants.google_verified], ['Anonymous pseudonyms', s.participants.anonymous_pseudonyms],
      ['Reported tokens (actual)', s.tokens.reported_actual], ['Estimated tokens', s.tokens.estimated]].forEach(([label, v]) => {
      const d = el('div', 'kpi');
      d.append(el('b', '', fmt(v)), el('span', '', label));
      k.append(d);
    });
    const tb = $('board').tBodies[0];
    tb.replaceChildren();
    if (!m.leaderboard.length) { const tr = el('tr'); cell(tr, 'No participation recorded yet.', 'muted'); tr.firstChild.colSpan = 10; tb.append(tr); }
    for (const r of m.leaderboard) {
      const tr = el('tr');
      [r.rank, r.participant + (r.flags.length ? ' ⚑' : ''), r.account === 'google_verified' ? 'Google' : 'anonymous', r.accepted, r.delivered, r.rejected, r.expired, r.merged_prs, r.verifications, fmt(r.delivered_within_24h_rate, 'pct')]
        .forEach((v, i) => cell(tr, String(v), i >= 3 ? 'num' : ''));
      tb.append(tr);
    }
    const mb = $('models').tBodies[0];
    mb.replaceChildren();
    if (!m.by_model.length) { const tr = el('tr'); cell(tr, 'No model usage reported yet (unknown).', 'muted'); tr.firstChild.colSpan = 6; mb.append(tr); }
    for (const x of m.by_model) {
      const tr = el('tr');
      [x.provider + '/' + x.model_id + (x.model_version ? '@' + x.model_version : ''), x.tasks, x.accepted_deliveries, x.tokens.reported_actual, x.tokens.estimated, x.tokens.unknown_reports]
        .forEach((v, i) => cell(tr, String(v), i ? 'num' : ''));
      mb.append(tr);
    }
  }).catch(() => { $('kpis').replaceChildren(el('p', 'muted', 'Could not load the indicators.')); });

  fetch('/api/tasks').then((r) => r.json()).then(({ tasks }) => {
    const box = $('tasks');
    box.replaceChildren();
    for (const t of tasks) {
      const card = el('div', 'task');
      const title = el('div', '');
      if (t.url) {
        const a = el('a', '', t.title);
        a.href = t.url;
        a.rel = 'noopener';
        title.append(a);
      } else title.textContent = t.title;
      card.append(title, el('span', 'tag' + (t.status === 'open' && !t.reserved && !t.blocked_by.length && t.filters.readiness === 'ready' ? ' ok' : ''),
        t.reserved ? 'reserved' : t.blocked_by.length ? 'blocked' : t.filters.readiness !== 'ready' ? t.filters.readiness : t.status));
      card.append(el('div', 'id', t.id));
      const tags = el('div', 'tags');
      const f = t.filters;
      [f.type, f.role, 'difficulty ' + f.difficulty, f.priority,
        'OS ' + (Array.isArray(f.os) ? f.os.join('/') : f.os),
        'GPU ' + f.gpu,
        'game (impl.) ' + f.needs_game_files.implementation,
        'game (valid.) ' + f.needs_game_files.validation].forEach((x) => tags.append(el('span', 'tag', x)));
      card.append(tags);
      box.append(card);
    }
  }).catch(() => { $('tasks').replaceChildren(el('p', 'muted', 'Could not load the catalog.')); });
})();
