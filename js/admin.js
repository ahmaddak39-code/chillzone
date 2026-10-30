/* CHILL ZONE — административная панель */
(function () {
  const { $, $$, esc, rub, toast } = CZ;
  const root = $('#root');
  let TOKEN = null, IDLE_MIN = 30, lastAct = Date.now(), EQ = [], unseen = 0, SETTINGS = null;
  try { const s = JSON.parse(localStorage.getItem('cz_admin') || 'null'); if (s && s.token) { TOKEN = s.token; IDLE_MIN = s.idle || 30; lastAct = s.at || Date.now(); } } catch (e) {}

  const STATUS = { awaiting_payment: 'Ожидает оплаты', receipt_sent: 'Чек отправлен', pending_review: 'Ожидает проверки', payment_verified: 'Оплата проверена', confirmed: 'Подтверждено', rejected: 'Отклонено', cancelled: 'Отменено', expired: 'Время истекло' };
  const PAY = { unpaid: 'Не оплачено', claimed: 'Клиент сообщил об оплате', verified: 'Оплата проверена', onsite: 'Оплата на месте' };
  const KINDS = { pc: 'Компьютер', ps: 'PlayStation', wheel: 'Руль', vr: 'VR', tennis: 'Настольный теннис', airhockey: 'Аэрохоккей', foosball: 'Настольный футбол', tv: 'Телевизор', room: 'Вся комната', other: 'Другое' };
  const NAV = [['/admin', '📊', 'Главная'], ['/admin/bookings', '🧾', 'Брони'], ['/admin/calendar', '🗓️', 'Календарь'], ['/admin/equipment', '🖥️', 'Оборудование'], ['/admin/prices', '💰', 'Тарифы'], ['/admin/promos', '🎁', 'Акции'], ['/admin/settings', '⚙️', 'Настройки']];

  // ---------- API ----------
  async function api(fn, p = {}) {
    try { return await CZ.rpc(fn, Object.assign({ token: TOKEN }, p)); }
    catch (e) { if (e.code === 'AUTH_REQUIRED') { logout(true); } throw e; }
  }
  function touch() { lastAct = Date.now(); try { localStorage.setItem('cz_admin', JSON.stringify({ token: TOKEN, idle: IDLE_MIN, at: lastAct })); } catch (e) {} }
  ['pointerdown', 'keydown', 'scroll'].forEach(ev => addEventListener(ev, () => { if (TOKEN) touch(); }, { passive: true }));
  setInterval(() => { if (TOKEN && Date.now() - lastAct > IDLE_MIN * 60000) { toast('Вы вышли из-за бездействия'); logout(true); } }, 20000);
  async function logout(silent) {
    if (TOKEN && !silent) { try { await CZ.rpc('admin_logout', { token: TOKEN }); } catch (e) {} }
    TOKEN = null; try { localStorage.removeItem('cz_admin'); } catch (e) {}
    go('/admin/login');
  }

  // ---------- маршруты ----------
  function go(path, replace) { if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState']({}, '', path); route(); }
  addEventListener('popstate', route);
  document.addEventListener('click', e => { const a = e.target.closest('a[data-r]'); if (a) { e.preventDefault(); go(a.getAttribute('href')); } });
  function route() {
    closeModal();
    let p = location.pathname.replace(/\/+$/, '') || '/admin';
    if (!TOKEN && p !== '/admin/login') return go('/admin/login', true);
    if (TOKEN && p === '/admin/login') return go('/admin', true);
    if (p === '/admin/login') return loginView();
    shell(p);
    const v = { '/admin': dashboard, '/admin/bookings': bookings, '/admin/calendar': calendar, '/admin/equipment': equipment, '/admin/prices': prices, '/admin/promos': promos, '/admin/settings': settings }[p] || dashboard;
    v();
  }

  // ---------- вход ----------
  function loginView() {
    document.title = 'Вход — CHILL ZONE';
    root.innerHTML = `<div class="login"><form class="card" id="lf">${CZ.logoSVG('lg')}<h1>CHILL ZONE</h1><p class="muted">Административная панель</p>
      <input class="inp" type="password" id="pw" placeholder="Пароль" autocomplete="current-password" required style="margin:18px 0 12px">
      <button class="btn btn-neon btn-wide" id="lb">Войти</button><p class="form-err" id="le"></p>
      <p style="margin-top:14px"><a class="dim" href="/">← На сайт</a></p></form></div>`;
    $('#pw').focus();
    $('#lf').onsubmit = async e => {
      e.preventDefault(); $('#lb').disabled = true; $('#le').textContent = '';
      try {
        const r = await CZ.rpc('admin_login', { password: $('#pw').value });
        if (!r.ok) { $('#le').textContent = CZ.ERR[r.error] || r.error; $('#lb').disabled = false; return; }
        TOKEN = r.token; IDLE_MIN = r.idle_minutes || 30; touch();
        try { sessionStorage.setItem('cz_must_change', r.must_change_password ? '1' : ''); } catch (x) {}
        go('/admin');
      } catch (er) { $('#le').textContent = er.message; $('#lb').disabled = false; }
    };
  }

  // ---------- каркас ----------
  function shell(p) {
    document.title = 'Админ-панель — CHILL ZONE';
    const tabs = [NAV[0], NAV[1], NAV[2], NAV[3], ['/admin/settings', '☰', 'Ещё']];
    root.innerHTML = `<div class="shell"><aside class="side">${CZ.brand('/admin')}
      ${NAV.map(([h, i, t]) => `<a class="nv ${p === h ? 'on' : ''}" href="${h}" data-r>${i} ${t}${h === '/admin/bookings' && unseen ? `<span class="bdg">${unseen}</span>` : ''}</a>`).join('')}
      <div class="sp"></div><a class="nv" href="/" target="_blank">🌐 Открыть сайт</a><a class="nv" href="#" id="lo">🚪 Выйти</a></aside>
      <main class="main" id="main"><p class="muted">Загрузка…</p></main></div>
      <nav class="tabbar">${tabs.map(([h, i, t]) => `<a href="${h}" data-r class="${p === h || (h === '/admin/settings' && ['/admin/prices', '/admin/promos', '/admin/equipment'].includes(p) && false) ? 'on' : ''}"><span>${i}</span>${t}${h === '/admin/bookings' && unseen ? `<b class="bdg">${unseen}</b>` : ''}</a>`).join('')}</nav>`;
    $('#lo').onclick = e => { e.preventDefault(); logout(); };
  }
  const main = () => $('#main');
  function top(title, right = '') {
    const must = (() => { try { return sessionStorage.getItem('cz_must_change') === '1'; } catch (e) { return false; } })();
    return `<div class="top"><h1>${title}</h1><div class="grow"></div>${right}</div>${must ? '<div class="banner">🔐 Вы используете начальный пароль. Смените его в разделе <a href="/admin/settings" data-r><u>Настройки</u></a>.</div>' : ''}`;
  }
  async function loadEq() { EQ = await api('admin_equipment_list'); return EQ; }
  const eqName = id => (EQ.find(e => e.id === id) || {}).name || id;

  // ---------- модалка ----------
  function modal(html, onReady) {
    const m = $('#modal'); m.hidden = false; const c = $('.modal-card', m);
    c.innerHTML = `<button class="modal-x" aria-label="Закрыть">✕</button>${html}`;
    $('.modal-x', c).onclick = closeModal; m.onclick = e => { if (e.target === m) closeModal(); };
    document.body.style.overflow = 'hidden'; c.scrollTop = 0; m.scrollTop = 0;
    if (onReady) onReady(c);
    return c;
  }
  function closeModal() { const m = $('#modal'); if (m) { m.hidden = true; document.body.style.overflow = ''; } }
  addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  // ---------- элементы ----------
  const sb = s => `<span class="sb ${s}">${STATUS[s] || s}</span>`;
  const when = b => CZ.fmtRange(b.starts_at, b.ends_at);
  function bkItem(b) {
    return `<div class="bk-item" data-bk="${b.id}"><div><span class="c">${esc(b.code)}</span> · <span class="w">${esc(b.equipment_name)}</span></div><div class="r">${rub(b.total)}</div>
      <div class="m">${when(b)} · ${esc(b.customer_name)} · ${esc(fmtPhone(b.phone))}</div>
      <div class="m" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${sb(b.status)} <span class="pay ${b.payment_status}">${PAY[b.payment_status]}</span>${b.receipts && b.receipts.length ? '<span class="pay claimed">📎 чек</span>' : ''}</div></div>`;
  }
  function fmtPhone(p) { const d = String(p || ''); return d.length === 11 ? `+${d[0]} ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}` : '+' + d; }
  function bindBk(el, after) { $$('[data-bk]', el).forEach(x => x.onclick = () => openBooking(x.dataset.bk, after)); }

  // ================= ГЛАВНАЯ =================
  async function dashboard() {
    const d = await api('admin_dashboard'); unseen = d.unseen; CZ.setTz('Europe/Moscow');
    const max = Math.max(1, ...d.chart.map(x => x.revenue));
    const W = 700, H = 170, bw = W / d.chart.length;
    const bars = d.chart.map((x, i) => { const h = Math.round((x.revenue / max) * (H - 30)); return `<g><rect x="${i * bw + 6}" y="${H - 20 - h}" width="${bw - 12}" height="${Math.max(h, 2)}" rx="5" fill="url(#gb)"><title>${CZ.fmtDateStr(x.date)}: ${rub(x.revenue)}, броней: ${x.count}</title></rect><text x="${i * bw + bw / 2}" y="${H - 4}" fill="#9aa6d6" font-size="11" text-anchor="middle">${+x.date.slice(8)}</text>${x.revenue ? `<text x="${i * bw + bw / 2}" y="${H - 26 - h}" fill="#eef2ff" font-size="10" text-anchor="middle">${Math.round(x.revenue / 100) / 10}к</text>` : ''}</g>`; }).join('');
    main().innerHTML = top('Главная', `<button class="btn btn-sm btn-neon" id="newBk">+ Бронь</button>`) + `
      <div class="kpis">
        <div class="kpi ${d.pending_review ? 'hot' : ''}"><small>На проверке</small><b>${d.pending_review}</b></div>
        <div class="kpi"><small>Ожидают оплаты</small><b>${d.awaiting_payment}</b></div>
        <div class="kpi"><small>Брони сегодня</small><b>${d.today_count}</b></div>
        <div class="kpi"><small>Оплаченные</small><b>${d.paid_count}</b></div>
        <div class="kpi"><small>Выручка сегодня</small><b>${rub(d.revenue_day)}</b></div>
        <div class="kpi"><small>За 7 дней</small><b>${rub(d.revenue_week)}</b></div>
        <div class="kpi"><small>За месяц</small><b>${rub(d.revenue_month)}</b></div>
        <div class="kpi"><small>Клиентов</small><b>${d.clients}</b></div>
      </div>
      <div class="grid2"><div>
        <div class="box"><h2>⚡ Требуют действия</h2><div class="bk-list" id="rv">${d.review_list.length ? d.review_list.map(bkItem).join('') : '<div class="empty">Новых заявок нет</div>'}</div></div>
        <div class="box"><h2>🕒 Ближайшие брони</h2><div class="bk-list" id="up">${d.upcoming.length ? d.upcoming.map(bkItem).join('') : '<div class="empty">Нет предстоящих броней</div>'}</div></div>
      </div><div>
        <div class="box"><h2>🎮 Оборудование сейчас</h2><div class="eqnow">${d.equipment_now.map(e => `<span class="${e.status !== 'ok' ? 'off' : e.busy ? 'busy' : ''}">${esc(e.name)}</span>`).join('')}</div>
          <p class="dim" style="font-size:12px;margin:10px 0 0">Зелёный — свободно, красный — занято, серый — недоступно.</p></div>
        <div class="box chart"><h2>📈 Выручка за 14 дней</h2><svg viewBox="0 0 ${W} ${H}"><defs><linearGradient id="gb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22e3ff"/><stop offset="1" stop-color="#8b5cff"/></linearGradient></defs>${bars}</svg>
          <p class="dim" style="font-size:12px;margin:6px 0 0">Учитываются подтверждённые и оплаченные брони.</p></div>
      </div></div>`;
    bindBk(main(), dashboard);
    $('#newBk').onclick = () => newBookingForm(dashboard);
    if (location.pathname === '/admin') refreshBadge();
  }
  function refreshBadge() { $$('.nv[href="/admin/bookings"], .tabbar a[href="/admin/bookings"]').forEach(a => { const b = a.querySelector('.bdg'); if (b) b.remove(); if (unseen) a.insertAdjacentHTML('beforeend', a.classList.contains('nv') ? `<span class="bdg">${unseen}</span>` : `<b class="bdg">${unseen}</b>`); }); }
  // обновление «Главной» и уведомлений, пока админ активен
  setInterval(async () => {
    if (!TOKEN || document.hidden || Date.now() - lastAct > IDLE_MIN * 60000) return;
    try { const r = await CZ.rpc('admin_ping', { token: TOKEN }); if (r.unseen > unseen) { toast('🔔 Новое событие по заявкам', 'ok'); unseen = r.unseen; refreshBadge(); if (location.pathname === '/admin' && $('#modal').hidden) dashboard(); } else { unseen = r.unseen; refreshBadge(); } } catch (e) { if (e.code === 'AUTH_REQUIRED') logout(true); }
  }, 45000);

  // ================= БРОНИ =================
  let FILT = { date_from: '', date_to: '', equipment_id: '', status: '', q: '' };
  async function bookings() {
    await loadEq();
    main().innerHTML = top('Бронирования', `<button class="btn btn-sm btn-neon" id="newBk">+ Бронь</button>`) + `
      <div class="filters">
        <input class="inp" type="date" id="fFrom" value="${FILT.date_from}" title="С даты">
        <input class="inp" type="date" id="fTo" value="${FILT.date_to}" title="По дату">
        <select class="inp" id="fEq"><option value="">Всё оборудование</option>${EQ.filter(e => e.kind !== 'tv').map(e => `<option value="${e.id}" ${FILT.equipment_id === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>
        <select class="inp" id="fSt"><option value="">Все статусы</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${FILT.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <input class="inp" id="fQ" placeholder="Поиск: имя, телефон, номер" value="${esc(FILT.q)}">
      </div><div class="bk-list" id="list"><p class="muted">Загрузка…</p></div>`;
    const load = async () => {
      FILT = { date_from: $('#fFrom').value, date_to: $('#fTo').value, equipment_id: $('#fEq').value, status: $('#fSt').value, q: $('#fQ').value };
      const l = await api('admin_list_bookings', FILT);
      $('#list').innerHTML = l.length ? `<p class="dim" style="font-size:13px;margin:0 0 4px">Найдено: ${l.length}</p>` + l.map(bkItem).join('') : '<div class="empty">Ничего не найдено</div>';
      bindBk($('#list'), load);
    };
    ['fFrom', 'fTo', 'fEq', 'fSt'].forEach(id => $('#' + id).onchange = load);
    let t; $('#fQ').oninput = () => { clearTimeout(t); t = setTimeout(load, 350); };
    $('#newBk').onclick = () => newBookingForm(load);
    load();
    api('admin_notifications', { mark_seen: true }).then(() => { unseen = 0; refreshBadge(); }).catch(() => {});
  }

  async function openBooking(id, after) {
    if (!EQ.length) await loadEq();
    const b = await api('admin_get_booking', { id });
    const active = !['rejected', 'cancelled', 'expired'].includes(b.status);
    const paid = ['verified', 'onsite'].includes(b.payment_status);
    const wa = `https://wa.me/${b.phone}?text=${encodeURIComponent(`Здравствуйте, ${b.customer_name}! Это CHILL ZONE. По вашей заявке ${b.code} (${b.equipment_name}, ${when(b)}): `)}`;
    const c = modal(`<h2>${esc(b.code)} · ${esc(b.equipment_name)}</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">${sb(b.status)} <span class="sb ${paid ? 'confirmed' : b.payment_status === 'claimed' ? 'pending_review' : 'awaiting_payment'}">${PAY[b.payment_status]}</span></div>
      <dl class="kv">
        <dt>Клиент</dt><dd>${esc(b.customer_name)}</dd>
        <dt>Телефон</dt><dd><a href="tel:+${b.phone}">${fmtPhone(b.phone)}</a></dd>
        <dt>Дата</dt><dd>${CZ.fmtDate(b.starts_at)}</dd>
        <dt>Время</dt><dd>${CZ.localTime(b.starts_at)}–${CZ.localTime(b.ends_at)}</dd>
        <dt>Продолжительность</dt><dd>${CZ.fmtDur(b.paid_minutes)}${b.bonus_minutes ? ' + ' + CZ.fmtDur(b.bonus_minutes) + ' бонус' : ''}</dd>
        <dt>Человек</dt><dd>${b.people}</dd>
        <dt>Стоимость</dt><dd>${rub(b.total)}</dd>
        ${b.due_now !== b.total ? `<dt>Предоплата</dt><dd>${rub(b.due_now)}</dd>` : ''}
        ${b.is_night ? '<dt>Ночная бронь</dt><dd>да (18+)</dd>' : ''}
        ${b.is_student ? '<dt>Студент</dt><dd>да</dd>' : ''}
        ${b.status === 'awaiting_payment' && b.hold_until ? `<dt>Удержание до</dt><dd>${CZ.localTime(b.hold_until)}</dd>` : ''}
        <dt>Создана</dt><dd>${CZ.fmtDate(b.created_at)}, ${CZ.localTime(b.created_at)} · ${b.source === 'admin' ? 'вручную' : 'сайт'}</dd>
        ${b.admin_note ? `<dt>Заметка</dt><dd>${esc(b.admin_note)}</dd>` : ''}
      </dl>
      <h3 style="font-size:15px;margin:18px 0 8px">Чеки</h3>
      ${b.receipts.length ? b.receipts.map((r, i) => `<button class="btn btn-sm" data-rec="${r.id}">👁 Посмотреть чек ${i + 1}</button> `).join('') : `<p class="muted" style="font-size:14px">${b.payment_status === 'claimed' ? 'Клиент сообщил, что отправил чек в WhatsApp.' : 'Чек не загружен.'}</p>`}
      <div id="recBox"></div>
      ${!paid && active ? '<div class="note" style="margin-top:14px">Фото чека — не доказательство оплаты. Перед подтверждением проверьте поступление денег в банковском приложении.</div>' : ''}
      <div class="acts">
        ${active && b.status !== 'confirmed' ? '<button class="btn btn-ok" data-a="confirm">✅ Подтвердить</button>' : ''}
        ${active && !paid ? '<button class="btn" data-a="verify">💳 Оплата проверена</button>' : ''}
        ${active && !paid ? '<button class="btn" data-a="onsite">🏪 Оплата на месте</button>' : ''}
        ${b.status === 'awaiting_payment' ? '<button class="btn" data-a="extend">⏳ Продлить +30 мин</button>' : ''}
        ${active ? '<button class="btn" data-a="move">🔁 Перенести</button>' : ''}
        <button class="btn" data-a="edit">✏️ Изменить</button>
        ${active && b.status !== 'confirmed' ? '<button class="btn btn-bad" data-a="reject">✖ Отклонить</button>' : ''}
        ${active ? '<button class="btn btn-bad" data-a="cancel">🗑 Отменить</button>' : ''}
        <a class="btn" href="tel:+${b.phone}">📞 Позвонить</a>
        <a class="btn" href="${wa}" target="_blank" rel="noopener">💬 WhatsApp клиенту</a>
      </div>
      <details><summary class="muted" style="cursor:pointer">История действий (${b.history.length})</summary><div class="hist">${b.history.map(h => `<div>${CZ.fmtDate(h.at)} ${CZ.localTime(h.at)} · <b>${h.actor === 'admin' ? 'Админ' : h.actor === 'client' ? 'Клиент' : 'Система'}</b>: ${esc(ACT[h.action] || h.action)}${h.details && h.details.note ? ' — ' + esc(h.details.note) : ''}</div>`).join('') || 'Пусто'}</div></details>`);
    const done = async (r, msg) => { toast(msg, 'ok'); closeModal(); if (after) after(); };
    $$('[data-rec]', c).forEach(x => x.onclick = async () => {
      const r = await api('admin_get_receipt', { id: x.dataset.rec });
      const src = `data:${r.mime};base64,${r.data}`;
      $('#recBox', c).innerHTML = r.mime === 'application/pdf' ? `<p><a class="btn btn-sm" download="chek-${b.code}.pdf" href="${src}">Скачать PDF</a></p>` : `<a href="${src}" target="_blank" download="chek-${b.code}.jpg"><img class="rec-img" src="${src}" alt="Чек"></a>`;
    });
    $$('[data-a]', c).forEach(x => x.onclick = async () => {
      const a = x.dataset.a;
      try {
        if (a === 'confirm') return confirmDialog(b, after);
        if (a === 'verify' || a === 'onsite') {
          const ok = confirm(a === 'verify' ? `Подтверждаете, что ${rub(b.due_now)} поступили в банковском приложении?` : `Клиент оплатит / оплатил ${rub(b.total)} на месте?`); if (!ok) return;
          await api('admin_booking_action', { id: b.id, action: a === 'verify' ? 'verify_payment' : 'mark_onsite', attest: true }); return done(0, 'Оплата отмечена');
        }
        if (a === 'extend') { await api('admin_booking_action', { id: b.id, action: 'extend_hold', minutes: 30 }); return done(0, 'Удержание продлено на 30 минут'); }
        if (a === 'reject' || a === 'cancel') {
          const note = prompt(a === 'reject' ? 'Причина отклонения (необязательно):' : 'Причина отмены (необязательно):', ''); if (note === null) return;
          await api('admin_booking_action', { id: b.id, action: a, note }); return done(0, a === 'reject' ? 'Заявка отклонена, время освобождено' : 'Бронь отменена, время освобождено');
        }
        if (a === 'move') return moveForm(b, after);
        if (a === 'edit') return editForm(b, after);
      } catch (e) { toast(e.message, 'err'); }
    });
  }
  const ACT = { created: 'Заявка создана', created_manually: 'Создана вручную', receipt_uploaded: 'Загружен чек', client_reported_payment: 'Клиент сообщил об оплате (WhatsApp)', cancelled: 'Отменено', expired: 'Время удержания истекло', verify_payment: 'Оплата проверена', mark_onsite: 'Оплата на месте', confirm: 'Подтверждено', reject: 'Отклонено', cancel: 'Отменено администратором', extend_hold: 'Удержание продлено', to_review: 'На проверку', updated: 'Изменено / перенесено', receipt_viewed: 'Чек просмотрен' };

  function confirmDialog(b, after) {
    const paid = ['verified', 'onsite'].includes(b.payment_status);
    modal(`<h2>Подтвердить ${esc(b.code)}?</h2>
      <p class="muted">${esc(b.equipment_name)} · ${when(b)} · ${esc(b.customer_name)}</p>
      ${paid ? `<div class="note info">Оплата уже отмечена: ${PAY[b.payment_status]}.</div>` : `
      <label class="check"><input type="radio" name="pm" value="transfer" checked> Перевод на Т-Банк</label>
      <label class="check"><input type="radio" name="pm" value="onsite"> Оплата при личном посещении</label>
      <label class="check" style="color:var(--text)"><input type="checkbox" id="att"> <span id="attT">Я проверил в банковском приложении: <b>${rub(b.due_now)}</b> поступили на счёт</span></label>`}
      <button class="btn btn-ok btn-wide" id="cOk" ${paid ? '' : 'disabled'} style="margin-top:12px">Подтвердить бронирование</button>`, c => {
      const att = $('#att', c); const btn = $('#cOk', c);
      if (att) { att.onchange = () => btn.disabled = !att.checked; $$('[name=pm]', c).forEach(r => r.onchange = () => { $('#attT', c).innerHTML = r.value === 'onsite' && r.checked ? `Клиент оплачивает <b>${rub(b.total)}</b> на месте — я принимаю оплату лично` : `Я проверил в банковском приложении: <b>${rub(b.due_now)}</b> поступили на счёт`; att.checked = false; btn.disabled = true; }); }
      btn.onclick = async () => {
        btn.disabled = true;
        try { const pm = ($('[name=pm]:checked', c) || {}).value; await api('admin_booking_action', { id: b.id, action: 'confirm', attest: paid || att.checked, payment: pm }); toast('Бронирование подтверждено ✅', 'ok'); closeModal(); if (after) after(); }
        catch (e) { toast(e.message, 'err'); btn.disabled = false; }
      };
    });
  }

  function timeOptions(sel) { let o = ''; for (let m = 0; m < 1440; m += 30) { const t = CZ.pad(Math.floor(m / 60)) + ':' + CZ.pad(m % 60); o += `<option ${t === sel ? 'selected' : ''}>${t}</option>`; } return o; }
  function durOptions(sel) { let o = ''; for (let m = 30; m <= 720; m += 30) o += `<option value="${m}" ${m === sel ? 'selected' : ''}>${CZ.fmtDur(m)}</option>`; return o; }
  function eqOptions(sel, withTv) { return EQ.filter(e => withTv || e.kind !== 'tv').map(e => `<option value="${e.id}" ${e.id === sel ? 'selected' : ''}>${esc(e.name)}</option>`).join(''); }

  function moveForm(b, after) {
    modal(`<h2>Перенести ${esc(b.code)}</h2><div class="fgrid">
      <div class="fld full"><label>Оборудование</label><select class="inp" id="mEq">${eqOptions(b.equipment_id)}</select></div>
      <div class="fld"><label>Дата</label><input class="inp" type="date" id="mD" value="${CZ.localDateStr(new Date(b.starts_at))}"></div>
      <div class="fld"><label>Начало</label><select class="inp" id="mT">${timeOptions(CZ.localTime(b.starts_at))}</select></div>
      <div class="fld"><label>Оплачиваемое время</label><select class="inp" id="mP">${durOptions(b.paid_minutes)}</select></div>
      <div class="fld"><label>Бонусное время, мин</label><input class="inp" type="number" min="0" step="30" id="mB" value="${b.bonus_minutes}"></div>
      <label class="check full"><input type="checkbox" id="mR"> Пересчитать стоимость по текущим тарифам (иначе сохранится ${rub(b.total)})</label>
      </div><p class="form-err" id="mE"></p><button class="btn btn-neon btn-wide" id="mS">Сохранить перенос</button>`, c => {
      $('#mS', c).onclick = async () => {
        try {
          await api('admin_update_booking', { id: b.id, equipment_id: $('#mEq', c).value, starts_at: CZ.zoned($('#mD', c).value, $('#mT', c).value).toISOString(), paid_minutes: +$('#mP', c).value, bonus_minutes: +$('#mB', c).value || 0, recalc: $('#mR', c).checked });
          toast('Бронь перенесена', 'ok'); closeModal(); if (after) after();
        } catch (e) { $('#mE', c).textContent = e.message; }
      };
    });
  }
  function editForm(b, after) {
    modal(`<h2>Изменить ${esc(b.code)}</h2><div class="fgrid">
      <div class="fld"><label>Имя</label><input class="inp" id="eN" value="${esc(b.customer_name)}"></div>
      <div class="fld"><label>Телефон</label><input class="inp" id="eP" value="${esc(fmtPhone(b.phone))}" inputmode="tel"></div>
      <div class="fld"><label>Человек</label><input class="inp" type="number" min="1" id="eC" value="${b.people}"></div>
      <div class="fld"><label>Стоимость, ₽</label><input class="inp" type="number" min="0" id="eT" value="${b.total}"></div>
      <div class="fld full"><label>Заметка администратора</label><textarea class="inp" id="eA">${esc(b.admin_note || '')}</textarea></div>
      </div><p class="form-err" id="eE"></p><button class="btn btn-neon btn-wide" id="eS">Сохранить</button>`, c => {
      $('#eS', c).onclick = async () => {
        try { await api('admin_update_booking', { id: b.id, customer_name: $('#eN', c).value, phone: $('#eP', c).value, people: +$('#eC', c).value, total: $('#eT', c).value, admin_note: $('#eA', c).value }); toast('Сохранено', 'ok'); closeModal(); if (after) after(); }
        catch (e) { $('#eE', c).textContent = e.message; }
      };
    });
  }
  async function newBookingForm(after, preset = {}) {
    if (!EQ.length) await loadEq();
    const today = CZ.localDateStr(new Date());
    modal(`<h2>Новое бронирование</h2><div class="fgrid">
      <div class="fld full"><label>Оборудование</label><select class="inp" id="nEq">${eqOptions(preset.equipment_id || 'pc01')}</select></div>
      <div class="fld"><label>Дата</label><input class="inp" type="date" id="nD" value="${preset.date || today}"></div>
      <div class="fld"><label>Начало</label><select class="inp" id="nT">${timeOptions(preset.time || '18:00')}</select></div>
      <div class="fld"><label>Продолжительность</label><select class="inp" id="nP">${durOptions(120)}</select></div>
      <div class="fld"><label>Человек</label><input class="inp" type="number" min="1" id="nC" value="1"></div>
      <div class="fld"><label>Имя клиента</label><input class="inp" id="nN"></div>
      <div class="fld"><label>Телефон</label><input class="inp" id="nPh" inputmode="tel" placeholder="+7"></div>
      <div class="fld"><label>Стоимость, ₽ (пусто — по тарифу)</label><input class="inp" type="number" min="0" id="nTot"></div>
      <div class="fld"><label>Оплата</label><select class="inp" id="nPay"><option value="onsite">На месте</option><option value="verified">Перевод проверен</option><option value="unpaid">Не оплачено (на проверку)</option></select></div>
      <div class="fld full"><label>Заметка</label><input class="inp" id="nA"></div>
      </div><p class="form-err" id="nE"></p><button class="btn btn-neon btn-wide" id="nS">Создать бронь</button>`, c => {
      $('#nS', c).onclick = async () => {
        try {
          const pay = $('#nPay', c).value;
          await api('admin_create_booking', { equipment_id: $('#nEq', c).value, starts_at: CZ.zoned($('#nD', c).value, $('#nT', c).value).toISOString(), paid_minutes: +$('#nP', c).value, people: +$('#nC', c).value, name: $('#nN', c).value, phone: $('#nPh', c).value, total: $('#nTot', c).value, payment_status: pay, confirm: pay !== 'unpaid', admin_note: $('#nA', c).value });
          toast('Бронь создана', 'ok'); closeModal(); if (after) after();
        } catch (e) { $('#nE', c).textContent = e.message; }
      };
    });
  }

  // ================= КАЛЕНДАРЬ =================
  let CAL_DATE = null;
  async function calendar() {
    await loadEq(); CAL_DATE = CAL_DATE || CZ.localDateStr(new Date());
    main().innerHTML = top('Календарь', `<button class="btn btn-sm" id="blk">⛔ Заблокировать время</button><button class="btn btn-sm btn-neon" id="newBk">+ Бронь</button>`) + `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        <button class="btn btn-sm" id="cPrev">←</button><input class="inp" type="date" id="cD" value="${CAL_DATE}" style="width:auto;height:40px"><button class="btn btn-sm" id="cNext">→</button><button class="btn btn-sm" id="cToday">Сегодня</button>
        <span class="muted" id="cTitle"></span></div>
      <div class="cal-wrap"><div class="cal" id="cal"></div></div>
      <p class="dim" style="font-size:12px;margin-top:10px">🟩 подтверждено · 🟪 на проверке · 🟨 ожидает оплаты · ▨ блокировка. Оплата: 💳 перевод проверен · 🏪 на месте · 📎 клиент прислал чек · ⏳ не оплачено. 🌐 — бронь всей комнаты (занимает все устройства). 🔒 в строке «Вся комната» — какое устройство мешает арендовать комнату целиком.</p>`;
    const draw = async () => {
      $('#cTitle').textContent = `${CZ.wdOf(CAL_DATE)}, ${CZ.fmtDateStr(CAL_DATE)}`;
      const d = await api('admin_calendar', { date: CAL_DATE });
      const t0 = CZ.zoned(CAL_DATE, '00:00').getTime(), span = 86400000;
      const pos = (a, b) => { const l = Math.max(0, (new Date(a).getTime() - t0) / span), r = Math.min(1, (new Date(b).getTime() - t0) / span); return `left:${l * 100}%;width:${Math.max(.6, (r - l) * 100)}%`; };
      const rows = d.equipment.map(e => {
        const own = d.bookings.filter(b => b.equipment_id === e.id || (e.id !== 'room' && b.equipment_id === 'room'));
        const bl = d.blocks.filter(k => k.equipment_id === e.id || (e.id !== 'room' && k.equipment_id === 'room'));
        // строка «Вся комната»: показываем, какие устройства мешают арендовать комнату целиком
        const devBusy = e.id === 'room' ? d.bookings.filter(b => b.equipment_id !== 'room').concat(d.blocks.filter(k => k.equipment_id !== 'room').map(k => Object.assign({ isBlock: true }, k))) : [];
        const payIcon = b => b.payment_status === 'verified' ? '💳' : b.payment_status === 'onsite' ? '🏪' : b.payment_status === 'claimed' ? '📎' : '⏳';
        return `<div class="cal-row"><div class="cal-name">${esc(e.name)}${e.status !== 'ok' ? ' ⚠️' : ''}</div><div class="cal-track">
          ${devBusy.map(b => `<div class="cal-bar devlock" style="${pos(b.starts_at, b.ends_at)}" ${b.isBlock ? '' : `data-bk="${b.id}"`} title="Комнату нельзя забронировать целиком: занято ${esc(b.isBlock ? eqName(b.equipment_id) + ' (блокировка)' : (b.equipment_name || eqName(b.equipment_id)) + ' — ' + b.name)}">🔒 ${esc(b.isBlock ? eqName(b.equipment_id) : (b.equipment_name || eqName(b.equipment_id)))}</div>`).join('')}
          ${own.map(b => `<div class="cal-bar ${b.status === 'confirmed' ? 'confirmed' : b.status === 'awaiting_payment' ? 'hold' : 'wait'}" style="${pos(b.starts_at, b.ends_at)}" data-bk="${b.id}" title="${esc(b.code)} · ${esc(b.equipment_name || eqName(b.equipment_id))} · ${esc(b.name)} · ${CZ.localTime(b.starts_at)}–${CZ.localTime(b.ends_at)} · ${b.status_ru} · ${PAY[b.payment_status] || ''}">${b.equipment_id === 'room' && e.id !== 'room' ? '🌐 ' : ''}${payIcon(b)} ${CZ.localTime(b.starts_at)} ${esc(b.name)}</div>`).join('')}
          ${bl.map(k => `<div class="cal-bar block" style="${pos(k.starts_at, k.ends_at)}" data-block="${k.id}" title="${esc(k.reason)}">⛔ ${esc(k.reason || 'Блок')}</div>`).join('')}
        </div></div>`;
      }).join('');
      const nowL = (Date.now() - t0) / span;
      $('#cal').innerHTML = `<div class="cal-row cal-head"><div class="cal-name">Время</div><div class="cal-track">${Array.from({ length: 24 }, (_, i) => `<span>${CZ.pad(i)}</span>`).join('')}</div></div>${rows}
        ${nowL > 0 && nowL < 1 ? `<div class="cal-now" style="left:calc(130px + (100% - 130px) * ${nowL})"></div>` : ''}`;
      bindBk($('#cal'), draw);
      $$('[data-block]', $('#cal')).forEach(x => x.onclick = async () => { if (!confirm('Снять блокировку?')) return; try { await api('admin_block_delete', { id: x.dataset.block }); toast('Блокировка снята', 'ok'); draw(); } catch (e) { toast(e.message, 'err'); } });
      if (nowL > 0 && nowL < 1) $('.cal-wrap').scrollLeft = Math.max(0, nowL * 970 - 120);
    };
    $('#cD').onchange = () => { CAL_DATE = $('#cD').value; draw(); };
    $('#cPrev').onclick = () => { CAL_DATE = CZ.addDays(CAL_DATE, -1); $('#cD').value = CAL_DATE; draw(); };
    $('#cNext').onclick = () => { CAL_DATE = CZ.addDays(CAL_DATE, 1); $('#cD').value = CAL_DATE; draw(); };
    $('#cToday').onclick = () => { CAL_DATE = CZ.localDateStr(new Date()); $('#cD').value = CAL_DATE; draw(); };
    $('#newBk').onclick = () => newBookingForm(draw, { date: CAL_DATE });
    $('#blk').onclick = () => modal(`<h2>Заблокировать время</h2><p class="muted">Для техобслуживания, ремонта или частного мероприятия. Клиенты не смогут забронировать это время.</p><div class="fgrid">
        <div class="fld full"><label>Оборудование</label><select class="inp" id="kEq">${eqOptions('room')}</select></div>
        <div class="fld"><label>С (дата)</label><input class="inp" type="date" id="kD1" value="${CAL_DATE}"></div><div class="fld"><label>Время</label><select class="inp" id="kT1">${timeOptions('10:00')}</select></div>
        <div class="fld"><label>По (дата)</label><input class="inp" type="date" id="kD2" value="${CAL_DATE}"></div><div class="fld"><label>Время</label><select class="inp" id="kT2">${timeOptions('14:00')}</select></div>
        <div class="fld full"><label>Причина</label><input class="inp" id="kR" placeholder="Техобслуживание / частное мероприятие"></div></div>
        <p class="form-err" id="kE"></p><button class="btn btn-neon btn-wide" id="kS">Заблокировать</button>`, c => {
      $('#kS', c).onclick = async () => {
        try { await api('admin_block_create', { equipment_id: $('#kEq', c).value, starts_at: CZ.zoned($('#kD1', c).value, $('#kT1', c).value).toISOString(), ends_at: CZ.zoned($('#kD2', c).value, $('#kT2', c).value).toISOString(), reason: $('#kR', c).value }); toast('Время заблокировано', 'ok'); closeModal(); draw(); }
        catch (e) { $('#kE', c).textContent = e.code === 'SLOT_TAKEN' ? 'На это время уже есть брони — сначала перенесите или отмените их.' : e.message; }
      };
    });
    draw();
  }

  // ================= ОБОРУДОВАНИЕ =================
  const MODELS_RU = { pc: 'Игровой компьютер', ps: 'PlayStation-зона', wheel: 'Гоночный симулятор', vr: 'VR-платформа', tennis: 'Стол для тенниса', airhockey: 'Аэрохоккей', foosball: 'Настольный футбол', tv: 'Телевизор', other: 'Универсальный объект' };
  const STATUS_EQ = { ok: 'Работает', maintenance: 'Временно отключено', disabled: 'Отключено' };
  let SHOW_ARCHIVE = false;
  async function equipment() {
    await loadEq(); try { await loadSettings(); } catch (x) {}
    const list = EQ.filter(e => SHOW_ARCHIVE || e.is_active);
    const archived = EQ.filter(e => !e.is_active).length;
    main().innerHTML = top('Оборудование') + `
      <button class="btn btn-neon btn-wide" id="addEq" style="margin-bottom:16px;min-height:58px">+ Добавить оборудование</button>
      <div class="eq-grid">${list.map(e => eqCard(e)).join('')}</div>
      ${archived ? `<label class="tgl" style="margin-top:16px"><input type="checkbox" id="arch" ${SHOW_ARCHIVE ? 'checked' : ''}> Показать архив (${archived})</label>` : ''}`;
    $('#addEq').onclick = () => eqForm(newEqTemplate());
    const a = $('#arch'); if (a) a.onchange = () => { SHOW_ARCHIVE = a.checked; equipment(); };
    $$('[data-eq-edit]').forEach(x => x.onclick = () => eqForm(EQ.find(e => e.id === x.dataset.eqEdit)));
    $$('[data-eq-toggle]').forEach(x => x.onclick = () => toggleEq(EQ.find(e => e.id === x.dataset.eqToggle)));
    $$('[data-eq-del]').forEach(x => x.onclick = () => deleteEq(EQ.find(e => e.id === x.dataset.eqDel)));
    // фото, загруженные админом
    list.filter(e => e.has_photo).forEach(async e => { try { const r = await CZ.rpc('get_equipment_photo', { id: e.id }); const th = $(`[data-th="${e.id}"]`); if (r && th) th.innerHTML = `<img src="${r.src}" alt="">`; } catch (x) {} });
  }
  function eqCard(e) {
    const off = e.status !== 'ok';
    const thumb = e.photo_url ? `<img src="${esc(e.photo_url)}" alt="">` : `<div class="ph-art"><span>${esc((e.label || e.name).slice(0, 6))}</span></div>`;
    return `<div class="eq-tile ${!e.is_active ? 'archived' : ''}">
      <div class="eq-th" data-th="${e.id}">${thumb}</div>
      <div class="eq-body">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><div><b style="font-size:17px">${esc(e.name)}</b><div class="dim" style="font-size:12px">${KINDS[e.kind] || e.kind} · № ${esc(e.id)}</div></div>
          <span class="sb ${!e.is_active ? 'cancelled' : off ? 'rejected' : 'confirmed'}">${!e.is_active ? 'В архиве' : STATUS_EQ[e.status]}</span></div>
        <div class="eq-meta"><span>💰 ${e.price_per_hour != null ? rub(e.price_per_hour) + '/ч' : 'цена не задана'}</span><span>🧾 броней: <b>${e.bookings_count || 0}</b>${e.future_count ? ` (впереди ${e.future_count})` : ''}</span>${!e.bookable && e.kind !== 'tv' ? '<span>🔒 без онлайн-брони</span>' : ''}${e.schedule ? '<span>🕘 своё расписание</span>' : ''}</div>
        ${off && e.status_note ? `<div class="dim" style="font-size:13px">Причина: ${esc(e.status_note)}</div>` : ''}
        <div class="eq-acts">
          <button class="btn btn-sm" data-eq-edit="${e.id}">✏️ Редактировать</button>
          ${e.kind !== 'room' || true ? `<button class="btn btn-sm ${off ? 'btn-ok' : ''}" data-eq-toggle="${e.id}">${off ? '✅ Включить' : '⏸ Временно отключить'}</button>` : ''}
          ${e.kind !== 'room' ? `<button class="btn btn-sm btn-bad" data-eq-del="${e.id}">🗑 Удалить</button>` : ''}
        </div>
      </div></div>`;
  }
  async function toggleEq(e) {
    const off = e.status !== 'ok';
    try {
      if (off) { await api('admin_equipment_status', { id: e.id, status: 'ok' }); toast(`${e.name} снова доступно для брони`, 'ok'); return equipment(); }
      modal(`<h2>Временно отключить «${esc(e.name)}»?</h2><p class="muted">Клиенты не смогут его бронировать, на сайте и на 3D-схеме оно станет серым. История и уже оформленные брони сохранятся.</p>
        ${e.future_count ? `<div class="note">Впереди есть брони: ${e.future_count}. Они останутся в силе — при необходимости перенесите их на другое устройство в разделе «Брони».</div>` : ''}
        <div class="fld"><label>Причина (видна клиентам)</label><input class="inp" id="offN" placeholder="Например: техническое обслуживание"></div>
        <button class="btn btn-bad btn-wide" id="offOk" style="margin-top:14px">Временно отключить</button>`, c => {
        $('#offOk', c).onclick = async () => { try { await api('admin_equipment_status', { id: e.id, status: 'maintenance', note: $('#offN', c).value || 'Временно недоступно' }); toast(`${e.name} отключено`, 'ok'); closeModal(); equipment(); } catch (er) { toast(er.message, 'err'); } };
      });
    } catch (er) { toast(er.message, 'err'); }
  }
  function deleteEq(e) {
    modal(`<h2>Удалить «${esc(e.name)}»?</h2>
      ${e.future_count ? `<div class="note">У оборудования есть будущие брони (${e.future_count}). Удалить его нельзя, пока вы не перенесёте или не отмените их. Если оно сломалось — используйте «Временно отключить».</div>`
        : e.bookings_count ? `<p class="muted">По этому оборудованию были брони (${e.bookings_count}). Чтобы не потерять историю и выручку, оно будет перенесено в архив: исчезнет с сайта и из бронирования, а история сохранится.</p>`
        : `<p class="muted">Броней по этому оборудованию не было — оно будет удалено полностью.</p>`}
      ${e.future_count ? '' : `<button class="btn btn-bad btn-wide" id="delOk">${e.bookings_count ? 'Перенести в архив' : 'Удалить навсегда'}</button>`}`, c => {
      const b = $('#delOk', c); if (b) b.onclick = async () => { try { const r = await api('admin_equipment_delete', { id: e.id }); toast(r.hidden ? 'Оборудование в архиве, история сохранена' : 'Оборудование удалено', 'ok'); closeModal(); equipment(); } catch (er) { toast(er.message, 'err'); } };
    });
  }
  function slugify(name) {
    const tr = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sh', ы: 'y', э: 'e', ю: 'yu', я: 'ya' };
    return String(name || '').toLowerCase().split('').map(c => tr[c] ?? c).join('').replace(/[^a-z0-9]+/g, '').slice(0, 20);
  }
  // свободное место на схеме: ПК — рядом с остальными компьютерами, остальное — в любом свободном месте
  function suggestSpot(kind, selfId) {
    const others = EQ.filter(x => x.id !== selfId && x.kind !== 'room' && x.is_active).map(x => [+x.map_x, +x.map_y]).concat([[655, 335]]);
    const free = ([x, y], d) => others.every(([a, b]) => Math.hypot(a - x, b - y) >= d);
    const pcSpots = []; for (let x = 560; x <= 920; x += 90) pcSpots.push([x, 95]); for (let x = 920; x >= 380; x -= 90) pcSpots.push([x, 215]); for (let x = 470; x >= 290; x -= 90) pcSpots.push([x, 95]);
    if (kind === 'pc') { const s = pcSpots.find(p => free(p, 80)); if (s) return s; }
    for (let y = 120; y <= 620; y += 50) for (let x = 100; x <= 920; x += 50) if (free([x, y], 130)) return [x, y];
    return [500, 420];
  }
  function newEqTemplate() {
    const n = EQ.filter(e => e.kind === 'pc').length + 1; const pc0 = EQ.find(e => e.kind === 'pc') || {};
    const [x, y] = suggestSpot('pc');
    return { id: '', is_new: true, name: `PC ${String(n).padStart(2, '0')}`, kind: 'pc', description: pc0.description || '', features: pc0.features || [], price_per_hour: pc0.price_per_hour ?? 150, max_players: 1,
      bookable: true, is_active: true, status: 'ok', map_x: x, map_y: y, map_rot: 0, map_scale: 1, model: '', label: '', schedule: null, photo_url: pc0.photo_url || '', sort: Math.max(0, ...EQ.filter(e => e.kind === 'pc').map(e => e.sort || 0)) + 1 };
  }
  function eqForm(e0) {
    const e = Object.assign({}, e0); const isNew = !!e.is_new || !e.id;
    let sched = e.schedule ? JSON.parse(JSON.stringify(e.schedule)) : null;
    let photo = null; // {mime,data,preview}
    const club = (SETTINGS && SETTINGS.settings && SETTINGS.settings.work_hours) || null;
    const schedRows = s => [1, 2, 3, 4, 5, 6, 7].map(d => { const x = (s && s.days && s.days[d]) || { open: '10:00', close: '02:00' }; return `<tr><td><b>${DN[d]}</b></td><td><input class="inp" type="time" data-so="${d}" value="${x.open}"></td><td><input class="inp" type="time" data-sc="${d}" value="${x.close}"></td><td><input type="checkbox" data-sx="${d}" ${x.closed ? 'checked' : ''} style="width:22px;height:22px"></td></tr>`; }).join('');
    const c = modal(`<h2>${isNew ? 'Новое оборудование' : 'Редактировать: ' + esc(e.name)}</h2>
      <div class="fgrid">
        <div class="fld"><label>Название</label><input class="inp" id="qN" value="${esc(e.name)}" maxlength="40"></div>
        <div class="fld"><label>Категория</label><select class="inp" id="qK" ${e.kind === 'room' ? 'disabled' : ''}>${Object.entries(KINDS).filter(([k]) => k !== 'room' || e.kind === 'room').map(([k, v]) => `<option value="${k}" ${k === e.kind ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="fld"><label>Номер устройства (латиница/цифры)</label><input class="inp" id="qId" value="${esc(e.id)}" ${isNew ? '' : 'disabled'} placeholder="pc06"><small class="dim" style="font-size:11px">${isNew ? 'Заполнится сам из названия' : 'Номер не меняется — по нему хранится история'}</small></div>
        <div class="fld"><label>Стоимость за час, ₽</label><input class="inp" type="number" min="0" inputmode="numeric" id="qP" value="${e.price_per_hour ?? ''}" placeholder="пусто — «Цена скоро»"></div>
        <div class="fld full"><label>Описание</label><textarea class="inp" id="qD">${esc(e.description || '')}</textarea></div>
        <div class="fld full"><label>Особенности (через запятую)</label><input class="inp" id="qF" value="${esc((e.features || []).join(', '))}"></div>
        <div class="fld"><label>Макс. игроков</label><input class="inp" type="number" min="1" id="qM" value="${e.max_players ?? ''}"></div>
        <div class="fld"><label>Статус</label><select class="inp" id="qS">${Object.entries(STATUS_EQ).map(([k, v]) => `<option value="${k}" ${k === e.status ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="fld full" id="qSNw" ${e.status === 'ok' ? 'hidden' : ''}><label>Причина отключения (видна клиентам)</label><input class="inp" id="qSN" value="${esc(e.status_note || '')}"></div>
        <label class="tgl"><input type="checkbox" id="qB" ${e.bookable ? 'checked' : ''}> Можно бронировать онлайн</label>
        <label class="tgl"><input type="checkbox" id="qA" ${e.is_active ? 'checked' : ''}> Показывать на сайте</label>

        <div class="fld full"><label>Фотография</label>
          <div class="ph-edit"><div class="ph-prev" id="phPrev">${e.photo_url ? `<img src="${esc(e.photo_url)}" alt="">` : '<span class="dim">Нет фото</span>'}</div>
          <div class="stack" style="gap:8px"><label class="btn btn-sm">📷 Выбрать из галереи<input type="file" accept="image/*" id="qPh" hidden></label>
          ${e.has_photo ? '<button class="btn btn-sm btn-bad" id="qPhDel" type="button">Убрать своё фото</button>' : ''}<span class="dim" style="font-size:12px" id="qPhS">${e.has_photo ? 'Загружено своё фото' : e.photo_url ? 'Фото клуба' : ''}</span></div></div></div>

        <div class="fld full"><label>Расписание</label>
          <label class="check" style="margin:4px 0"><input type="radio" name="sm" value="club" ${!sched ? 'checked' : ''}> Как у клуба${club && club.always_open !== false ? ' (круглосуточно)' : ''}</label>
          <label class="check" style="margin:4px 0"><input type="radio" name="sm" value="own" ${sched ? 'checked' : ''}> Своё расписание для этого устройства</label>
          <table class="mini-table" id="schT" ${sched ? '' : 'hidden'}><thead><tr><th>День</th><th>С</th><th>До</th><th>Выходной</th></tr></thead><tbody>${schedRows(sched)}</tbody></table></div>

        ${e.kind !== 'room' ? `<div class="fld full"><label>Место на 3D-схеме</label>
          <div class="r3-prev" id="r3prev"></div>
          <div class="plan" id="plan" style="margin-top:8px"></div>
          <p class="dim" style="font-size:12px;margin:6px 0">Перетащите свою метку (подсвечена) на плане — 3D-превью обновится сразу.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-sm" type="button" id="autoSpot">📍 Найти свободное место${e.kind === 'pc' ? ' рядом с ПК' : ''}</button></div></div>
        <div class="fld"><label>Подпись на схеме</label><input class="inp" id="qL" value="${esc(e.label || '')}" placeholder="как название" maxlength="24"></div>
        <div class="fld"><label>3D-модель</label><select class="inp" id="qMod"><option value="">По категории</option>${Object.entries(MODELS_RU).map(([k, v]) => `<option value="${k}" ${e.model === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="fld"><label>Размер: <b id="scV">${Math.round((+e.map_scale || 1) * 100)}%</b></label><input type="range" min="50" max="200" step="10" id="qSc" value="${Math.round((+e.map_scale || 1) * 100)}" style="width:100%"></div>
        <div class="fld"><label>Поворот</label><select class="inp" id="qR">${[0, 45, 90, 135, 180, 225, 270, 315].map(r => `<option value="${r}" ${(+e.map_rot || 0) === r ? 'selected' : ''}>${r}°</option>`).join('')}</select></div>` : ''}
        <div class="fld"><label>Порядок отображения</label><input class="inp" type="number" id="qO" value="${e.sort ?? 100}"></div>
      </div>
      <p class="form-err" id="qE"></p>
      <button class="btn btn-neon btn-wide" id="qSave" style="min-height:56px">💾 Сохранить</button>`);

    // поля → объект
    const st = () => ({ name: $('#qN', c).value.trim(), kind: e.kind === 'room' ? 'room' : $('#qK', c).value, label: ($('#qL', c) || {}).value || '', model: ($('#qMod', c) || {}).value || '',
      map_scale: ($('#qSc', c) ? +$('#qSc', c).value / 100 : 1), map_rot: ($('#qR', c) ? +$('#qR', c).value : 0), map_x: e.map_x, map_y: e.map_y });
    // автономер из названия
    if (isNew) { const idI = $('#qId', c); let touched = false; idI.oninput = () => touched = true; $('#qN', c).addEventListener('input', () => { if (!touched) idI.value = slugify($('#qN', c).value); }); if (!idI.value) idI.value = slugify(e.name); }
    $('#qS', c).onchange = () => $('#qSNw', c).hidden = $('#qS', c).value === 'ok';
    $$('[name=sm]', c).forEach(r => r.onchange = () => { $('#schT', c).hidden = $('[name=sm]:checked', c).value !== 'own'; });
    // фото
    $('#qPh', c).onchange = async () => { const f = $('#qPh', c).files[0]; if (!f) return; try { photo = await CZ.fileToPayload(f, 1400, .82); $('#phPrev', c).innerHTML = `<img src="${photo.preview}" alt="">`; $('#qPhS', c).textContent = 'Новое фото — сохранится вместе с карточкой'; } catch (er) { toast(er.message, 'err'); } };
    const pd = $('#qPhDel', c); if (pd) pd.onclick = async () => { await api('admin_equipment_photo', { id: e.id, data: '' }); toast('Своё фото убрано', 'ok'); e.has_photo = false; pd.remove(); $('#qPhS', c).textContent = e.photo_url ? 'Фото клуба' : ''; };
    if (e.has_photo) CZ.rpc('get_equipment_photo', { id: e.id }).then(r => { if (r && r.src) $('#phPrev', c).innerHTML = `<img src="${r.src}" alt="">`; }).catch(() => {});

    // план и 3D-превью
    const plan = $('#plan', c);
    let prev = null;
    const previewItems = () => { const s = st(); const me = Object.assign({}, e, s, { id: e.id || '__new', name: s.name || 'Новое' }); return EQ.filter(x => x.is_active && x.id !== e.id).concat([me]); };
    const refresh = () => {
      if (!plan) return; const s = st();
      plan.innerHTML = EQ.filter(x => x.id !== e.id && x.kind !== 'room' && x.is_active).map(x => `<div class="dot" style="left:${x.map_x / 10}%;top:${x.map_y / 7}%">${esc(x.label || x.name)}</div>`).join('') +
        `<div class="dot me" id="me" style="left:${e.map_x / 10}%;top:${e.map_y / 7}%">${esc(s.label || s.name || 'Новое')}</div>`;
      if (prev) { prev.setItems(previewItems()); prev.focus(e.id || '__new', true); }
    };
    if (plan && window.Room3D) { try { prev = new Room3D($('#r3prev', c), { interactive: false }); } catch (x) { prev = null; } }
    refresh();
    let rT; const soft = () => { clearTimeout(rT); rT = setTimeout(refresh, 250); };
    ['#qN', '#qL', '#qMod', '#qSc', '#qR', '#qK'].forEach(s => { const el = $(s, c); if (el) el.addEventListener('input', () => { if (s === '#qSc') $('#scV', c).textContent = el.value + '%'; soft(); }); });
    if (plan) {
      let drag = false;
      const moveTo = ev => { const r = plan.getBoundingClientRect(); e.map_x = Math.round(Math.max(40, Math.min(960, (ev.clientX - r.left) / r.width * 1000))); e.map_y = Math.round(Math.max(40, Math.min(660, (ev.clientY - r.top) / r.height * 700))); const me = $('#me', plan); me.style.left = e.map_x / 10 + '%'; me.style.top = e.map_y / 7 + '%'; };
      plan.addEventListener('pointerdown', ev => { drag = true; plan.setPointerCapture(ev.pointerId); moveTo(ev); });
      plan.addEventListener('pointermove', ev => { if (drag) moveTo(ev); });
      plan.addEventListener('pointerup', () => { if (drag) { drag = false; refresh(); } });
      $('#autoSpot', c).onclick = () => { const [x, y] = suggestSpot($('#qK', c).value, e.id); e.map_x = x; e.map_y = y; refresh(); toast('Место выбрано — можно подвинуть'); };
    }

    $('#qSave', c).onclick = async () => {
      const btn = $('#qSave', c); btn.disabled = true; $('#qE', c).textContent = '';
      try {
        const s = st(); if (!s.name) throw new Error('Введите название');
        let schedule = null;
        if (($('[name=sm]:checked', c) || {}).value === 'own') { schedule = { always_open: false, days: {} }; [1, 2, 3, 4, 5, 6, 7].forEach(d => schedule.days[d] = { open: $(`[data-so="${d}"]`, c).value || '10:00', close: $(`[data-sc="${d}"]`, c).value || '02:00', closed: $(`[data-sx="${d}"]`, c).checked }); }
        const item = { id: isNew ? (slugify($('#qId', c).value) || slugify(s.name)) : e.id, is_new: isNew, name: s.name, kind: s.kind, description: $('#qD', c).value, features: $('#qF', c).value.split(',').map(x => x.trim()).filter(Boolean),
          price_per_hour: $('#qP', c).value, max_players: $('#qM', c).value, status: $('#qS', c).value, status_note: $('#qSN', c).value, bookable: $('#qB', c).checked, is_active: $('#qA', c).checked,
          sort: $('#qO', c).value, map_x: e.map_x, map_y: e.map_y, map_rot: s.map_rot, map_scale: s.map_scale, model: s.model, label: s.label, schedule,
          photo_url: e.photo_url || (s.kind === 'pc' ? '/img/pcs.webp' : ''), link_to: e.link_to || '' };
        const saved = await api('admin_equipment_save', { item });
        if (photo) await api('admin_equipment_photo', { id: saved.id, mime: photo.mime, data: photo.data });
        toast(isNew ? `${saved.name} добавлено — уже на сайте и на 3D-схеме` : 'Сохранено — изменения уже на сайте', 'ok'); closeModal(); equipment();
      } catch (er) { $('#qE', c).textContent = er.message; btn.disabled = false; }
    };
  }

  // ================= ЦЕНЫ =================
  async function loadSettings() { SETTINGS = await api('admin_settings_get'); return SETTINGS; }
  async function saveSetting(key, value) { await api('admin_settings_save', { key, value }); }
  async function prices() {
    await loadEq(); const S = await loadSettings(); const s = S.settings;
    const night = s.night || {}, room = s.room || {};
    main().innerHTML = top('Тарифы и цены') + `
      <div class="box"><h2>💰 Цены оборудования, ₽ / час</h2><table class="mini-table"><tbody>${EQ.filter(e => e.kind !== 'tv').map(e => `<tr><td><b>${esc(e.name)}</b></td><td style="width:150px"><input class="inp" type="number" min="0" data-price="${e.id}" value="${e.price_per_hour ?? ''}" placeholder="не задана"></td></tr>`).join('')}</tbody></table>
        <p class="dim" style="font-size:12px">Пустое поле — «Цена скоро», онлайн-бронь для этого оборудования закрыта. Новая цена действует только для новых броней.</p>
        <button class="btn btn-neon" id="svP">Сохранить цены</button></div>
      <div class="box"><h2>🌐 Вся комната</h2><div class="fgrid">
        <div class="fld"><label>Человек в базовой цене</label><input class="inp" type="number" min="1" id="rB" value="${room.base_people ?? 5}"></div>
        <div class="fld"><label>Доп. человек, ₽/час</label><input class="inp" type="number" min="0" id="rX" value="${room.extra_person_price ?? 400}"></div>
        <div class="fld"><label>Максимум человек</label><input class="inp" type="number" min="1" id="rM" value="${room.max_people ?? 20}"></div>
        <div class="fld"><label>Студенческая скидка, %</label><input class="inp" type="number" min="0" max="100" id="sd" value="${+s.student_discount_percent || 0}"></div>
      </div><p class="dim" style="font-size:12px">Студенческая скидка 0 — отключена. Скидка не суммируется с акциями: применяется большая.</p><button class="btn btn-neon" id="svR">Сохранить</button></div>
      <div class="box"><h2>🌙 Ночное бронирование</h2><div class="fgrid">
        <label class="tgl full"><input type="checkbox" id="nE" ${night.enabled ? 'checked' : ''}> Ночные правила включены</label>
        <div class="fld"><label>Начало ночи</label><input class="inp" type="time" id="nS" value="${night.start || '22:00'}"></div>
        <div class="fld"><label>Конец ночи</label><input class="inp" type="time" id="nEn" value="${night.end || '12:00'}"></div>
        <div class="fld"><label>Предоплата, ₽</label><input class="inp" type="number" min="0" id="nP" value="${night.prepay ?? 500}"></div>
        <div class="fld"><label>Минимальный возраст</label><input class="inp" type="number" min="0" id="nA" value="${night.min_age ?? 18}"></div>
        <div class="fld full"><label>Правила для клиента</label><textarea class="inp" id="nR">${esc(night.rules || '')}</textarea></div>
      </div><button class="btn btn-neon" id="svN">Сохранить</button></div>
      <div class="box"><h2>⏰ Специальные тарифы <button class="btn btn-sm" id="addT" style="margin-left:auto">+ Тариф</button></h2>
        <p class="dim" style="font-size:13px">Ночные, утренние, дневные, выходные и праздничные цены. Если подходят несколько тарифов — берётся с большим приоритетом.</p>
        <div id="tl">${S.tariffs.length ? S.tariffs.map(t => `<div class="bk-item" data-t="${t.id}"><div><b>${esc(t.name)}</b></div><div class="r">${t.mode === 'price' ? rub(t.value) + '/ч' : '−' + t.value + '%'}</div><div class="m">${tDesc(t)} · ${t.is_active ? '✅ включён' : '⏸ выключен'}</div></div>`).join('') : '<div class="empty">Специальных тарифов пока нет</div>'}</div></div>`;
    $('#svP').onclick = async () => {
      try { for (const inp of $$('[data-price]')) { const e = EQ.find(x => x.id === inp.dataset.price); const v = inp.value === '' ? null : +inp.value; if (v !== e.price_per_hour) await api('admin_equipment_save', { item: Object.assign({}, e, { price_per_hour: inp.value }) }); } toast('Цены сохранены', 'ok'); prices(); }
      catch (e) { toast(e.message, 'err'); }
    };
    $('#svR').onclick = async () => { try { await saveSetting('room', { base_people: +$('#rB').value, extra_person_price: +$('#rX').value, max_people: +$('#rM').value }); await saveSetting('student_discount_percent', +$('#sd').value || 0); toast('Сохранено', 'ok'); } catch (e) { toast(e.message, 'err'); } };
    $('#svN').onclick = async () => { try { await saveSetting('night', { enabled: $('#nE').checked, start: $('#nS').value, end: $('#nEn').value, prepay: +$('#nP').value, min_age: +$('#nA').value, rules: $('#nR').value }); toast('Сохранено', 'ok'); } catch (e) { toast(e.message, 'err'); } };
    $('#addT').onclick = () => tariffForm({ name: '', kind: 'night', applies_to: 'all', days: [], dates: [], time_from: '22:00', time_to: '08:00', mode: 'price', value: '', priority: 0, is_active: true });
    $$('[data-t]').forEach(x => x.onclick = () => tariffForm(S.tariffs.find(t => t.id === x.dataset.t)));
  }
  const DN = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  function applyLabel(a) { if (a === 'all') return 'всё оборудование'; if (a.startsWith('kind:')) return 'тип: ' + (KINDS[a.slice(5)] || a); return eqName(a.slice(3)); }
  function tDesc(t) { return [applyLabel(t.applies_to), t.days && t.days.length ? t.days.map(d => DN[d]).join(',') : 'все дни', t.dates && t.dates.length ? 'даты: ' + t.dates.join(', ') : '', t.time_from && t.time_to ? t.time_from.slice(0, 5) + '–' + t.time_to.slice(0, 5) : 'весь день'].filter(Boolean).join(' · '); }
  function tariffForm(t) {
    const apOpts = [['all', 'Всё оборудование'], ...['pc', 'ps', 'wheel', 'vr', 'tennis', 'airhockey', 'foosball', 'room'].map(k => ['kind:' + k, 'Тип: ' + KINDS[k]]), ...EQ.filter(e => e.kind !== 'tv').map(e => ['id:' + e.id, 'Только ' + e.name])];
    const c = modal(`<h2>${t.id ? 'Тариф' : 'Новый тариф'}</h2><div class="fgrid">
      <div class="fld"><label>Название</label><input class="inp" id="tN" value="${esc(t.name)}" placeholder="Ночной тариф"></div>
      <div class="fld"><label>Вид</label><select class="inp" id="tK">${[['night', 'Ночной'], ['morning', 'Утренний'], ['day', 'Дневной'], ['weekend', 'Выходные'], ['holiday', 'Праздничный'], ['custom', 'Другой']].map(([k, v]) => `<option value="${k}" ${t.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="fld full"><label>Для чего</label><select class="inp" id="tA">${apOpts.map(([k, v]) => `<option value="${k}" ${t.applies_to === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
      <div class="fld full"><label>Дни недели (не выбрано — все)</label><div class="days-pick">${[1, 2, 3, 4, 5, 6, 7].map(d => `<label><input type="checkbox" value="${d}" ${(t.days || []).includes(d) ? 'checked' : ''}>${DN[d]}</label>`).join('')}</div></div>
      <div class="fld"><label>С</label><input class="inp" type="time" id="tF" value="${(t.time_from || '').slice(0, 5)}"></div>
      <div class="fld"><label>До</label><input class="inp" type="time" id="tT" value="${(t.time_to || '').slice(0, 5)}"></div>
      <div class="fld full"><label>Конкретные даты (праздники), через запятую ГГГГ-ММ-ДД</label><input class="inp" id="tD" value="${esc((t.dates || []).join(', '))}" placeholder="2026-12-31, 2027-01-01"></div>
      <div class="fld"><label>Способ</label><select class="inp" id="tM"><option value="price" ${t.mode === 'price' ? 'selected' : ''}>Цена за час, ₽</option><option value="percent" ${t.mode === 'percent' ? 'selected' : ''}>Скидка, % (минус — наценка)</option></select></div>
      <div class="fld"><label>Значение</label><input class="inp" type="number" id="tV" value="${t.value ?? ''}"></div>
      <div class="fld"><label>Приоритет</label><input class="inp" type="number" id="tP" value="${t.priority || 0}"></div>
      <label class="tgl"><input type="checkbox" id="tOn" ${t.is_active ? 'checked' : ''}> Включён</label>
      </div><p class="form-err" id="tE"></p><button class="btn btn-neon btn-wide" id="tS">Сохранить</button>${t.id ? '<button class="btn btn-bad btn-wide" id="tDel" style="margin-top:8px">Удалить</button>' : ''}`);
    $('#tS', c).onclick = async () => {
      try {
        if ($('#tV', c).value === '') throw new Error('Укажите значение');
        await api('admin_tariff_save', { item: { id: t.id || '', name: $('#tN', c).value || 'Тариф', kind: $('#tK', c).value, applies_to: $('#tA', c).value, days: $$('.days-pick input:checked', c).map(x => +x.value), dates: $('#tD', c).value.split(',').map(s => s.trim()).filter(Boolean), time_from: $('#tF', c).value, time_to: $('#tT', c).value, mode: $('#tM', c).value, value: +$('#tV', c).value, priority: +$('#tP', c).value, is_active: $('#tOn', c).checked } });
        toast('Тариф сохранён', 'ok'); closeModal(); prices();
      } catch (e) { $('#tE', c).textContent = e.message; }
    };
    const d = $('#tDel', c); if (d) d.onclick = async () => { if (!confirm('Удалить тариф?')) return; await api('admin_tariff_delete', { id: t.id }); closeModal(); prices(); };
  }

  // ================= АКЦИИ =================
  const PT = { bonus_time: 'Бесплатное время', discount: 'Скидка', giveaway: 'Розыгрыш', student: 'Студентам', group: 'Для компаний', info: 'Информация' };
  async function promos() {
    await loadEq(); const S = await loadSettings();
    main().innerHTML = top('Акции и розыгрыши', `<button class="btn btn-sm btn-neon" id="addP">+ Акция</button>`) + `<div class="bk-list">${S.promotions.length ? S.promotions.map(p => `<div class="bk-item" data-p="${p.id}"><div><b>${esc(p.title)}</b></div><div class="r">${p.is_active ? '✅ Включена' : '⏸ Выключена'}</div><div class="m">${PT[p.type]} · ${esc(p.description)}</div></div>`).join('') : '<div class="empty">Акций пока нет</div>'}</div>
      <p class="dim" style="font-size:13px;margin-top:12px">«Бесплатное время» и «Скидка» автоматически применяются к бронированиям. Остальные типы — информационные карточки на сайте.</p>`;
    $('#addP').onclick = () => promoForm({ title: '', description: '', type: 'bonus_time', config: { applies_to: 'all', tiers: [{ min_minutes: 60, bonus_minutes: 30 }] }, is_active: true });
    $$('[data-p]').forEach(x => x.onclick = () => promoForm(S.promotions.find(p => p.id === x.dataset.p)));
  }
  function promoForm(p) {
    const cfg = p.config || {};
    const apOpts = [['all', 'Всё оборудование'], ...['pc', 'ps', 'wheel', 'vr', 'room'].map(k => ['kind:' + k, 'Тип: ' + KINDS[k]]), ...EQ.filter(e => e.kind !== 'tv').map(e => ['id:' + e.id, 'Только ' + e.name])];
    const c = modal(`<h2>${p.id ? 'Акция' : 'Новая акция'}</h2><div class="fgrid">
      <div class="fld full"><label>Заголовок</label><input class="inp" id="pT" value="${esc(p.title)}"></div>
      <div class="fld full"><label>Описание</label><textarea class="inp" id="pD">${esc(p.description)}</textarea></div>
      <div class="fld"><label>Тип</label><select class="inp" id="pY">${Object.entries(PT).map(([k, v]) => `<option value="${k}" ${p.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="fld"><label>Для чего</label><select class="inp" id="pA">${apOpts.map(([k, v]) => `<option value="${k}" ${(cfg.applies_to || 'all') === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
      <div class="fld full" id="pBonus"><label>Бонусное время: «бронируешь N минут — получаешь M бесплатно»</label><div id="tiers"></div><button class="btn btn-sm" id="addTier" type="button">+ Условие</button></div>
      <div class="fld" id="pDisc"><label>Скидка, %</label><input class="inp" type="number" min="0" max="100" id="pPc" value="${cfg.percent || ''}"></div>
      <div class="fld"><label>Начало (необязательно)</label><input class="inp" type="date" id="pS" value="${p.starts_on || ''}"></div>
      <div class="fld"><label>Окончание (необязательно)</label><input class="inp" type="date" id="pE" value="${p.ends_on || ''}"></div>
      <label class="tgl full"><input type="checkbox" id="pOn" ${p.is_active ? 'checked' : ''}> Акция включена</label>
      </div><p class="form-err" id="pErr"></p><button class="btn btn-neon btn-wide" id="pSv">Сохранить</button>${p.id ? '<button class="btn btn-bad btn-wide" id="pDel" style="margin-top:8px">Удалить</button>' : ''}`);
    let tiers = (cfg.tiers || []).slice();
    const drawT = () => { $('#tiers', c).innerHTML = tiers.map((t, i) => `<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px"><span class="muted" style="font-size:13px">от</span><input class="inp" type="number" step="30" data-ti="${i}" data-k="min_minutes" value="${t.min_minutes}" style="height:40px"><span class="muted" style="font-size:13px">мин → +</span><input class="inp" type="number" step="15" data-ti="${i}" data-k="bonus_minutes" value="${t.bonus_minutes}" style="height:40px"><span class="muted" style="font-size:13px">мин</span><button class="btn btn-sm btn-bad" data-rm="${i}" type="button">✕</button></div>`).join(''); $$('[data-ti]', c).forEach(x => x.oninput = () => tiers[x.dataset.ti][x.dataset.k] = +x.value); $$('[data-rm]', c).forEach(x => x.onclick = () => { tiers.splice(+x.dataset.rm, 1); drawT(); }); };
    const vis = () => { const t = $('#pY', c).value; $('#pBonus', c).style.display = t === 'bonus_time' ? '' : 'none'; $('#pDisc', c).style.display = t === 'discount' ? '' : 'none'; };
    drawT(); vis(); $('#pY', c).onchange = vis;
    $('#addTier', c).onclick = () => { tiers.push({ min_minutes: 120, bonus_minutes: 60 }); drawT(); };
    $('#pSv', c).onclick = async () => {
      try {
        const type = $('#pY', c).value; const config = { applies_to: $('#pA', c).value };
        if (type === 'bonus_time') config.tiers = tiers.filter(t => t.min_minutes > 0 && t.bonus_minutes > 0);
        if (type === 'discount') { config.percent = +$('#pPc', c).value; if (!(config.percent > 0)) throw new Error('Укажите процент скидки'); }
        await api('admin_promo_save', { item: { id: p.id || '', title: $('#pT', c).value, description: $('#pD', c).value, type, config, is_active: $('#pOn', c).checked, starts_on: $('#pS', c).value, ends_on: $('#pE', c).value } });
        toast('Акция сохранена', 'ok'); closeModal(); promos();
      } catch (e) { $('#pErr', c).textContent = e.message; }
    };
    const d = $('#pDel', c); if (d) d.onclick = async () => { if (!confirm('Удалить акцию?')) return; await api('admin_promo_delete', { id: p.id }); closeModal(); promos(); };
  }

  // ================= НАСТРОЙКИ =================
  async function settings() {
    const S = await loadSettings(); const s = S.settings;
    const wh = s.work_hours || { always_open: true, days: {} }; const cd = s.custom_duration || {}; const pay = s.payment || {}; const ct = s.contacts || {}; const tg = s.telegram || {};
    const durs = s.durations || [];
    main().innerHTML = top('Настройки') + `
      <div class="box" style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn btn-sm" href="/admin/prices" data-r>💰 Тарифы</a><a class="btn btn-sm" href="/admin/promos" data-r>🎁 Акции</a><a class="btn btn-sm" href="/admin/equipment" data-r>🖥️ Оборудование</a><a class="btn btn-sm" href="/" target="_blank">🌐 Сайт</a><button class="btn btn-sm btn-bad" id="lo2">🚪 Выйти</button></div>
      <div class="box"><h2>🕘 Рабочее время</h2>
        <label class="tgl"><input type="checkbox" id="wA" ${wh.always_open !== false ? 'checked' : ''}> Работаем круглосуточно</label>
        <table class="mini-table" id="wT" style="margin-top:10px;${wh.always_open !== false ? 'opacity:.4' : ''}"><thead><tr><th>День</th><th>Открытие</th><th>Закрытие</th><th>Выходной</th></tr></thead><tbody>
        ${[1, 2, 3, 4, 5, 6, 7].map(d => { const x = (wh.days || {})[d] || { open: '10:00', close: '02:00' }; return `<tr><td><b>${DN[d]}</b></td><td><input class="inp" type="time" data-wo="${d}" value="${x.open}"></td><td><input class="inp" type="time" data-wc="${d}" value="${x.close}"></td><td><input type="checkbox" data-wx="${d}" ${x.closed ? 'checked' : ''} style="width:22px;height:22px"></td></tr>`; }).join('')}</tbody></table>
        <p class="dim" style="font-size:12px">Если закрытие раньше открытия (например, 10:00–02:00), клуб работает после полуночи.</p><button class="btn btn-neon" id="svW">Сохранить</button></div>
      <div class="box"><h2>⏱ Бронирование</h2><div class="fgrid">
        <div class="fld full"><label>Варианты продолжительности</label><div class="days-pick">${[60, 90, 120, 180, 240, 300, 360].map(m => `<label style="width:auto;padding:0 12px"><input type="checkbox" value="${m}" ${durs.includes(m) ? 'checked' : ''}>${CZ.fmtDur(m)}</label>`).join('')}</div></div>
        <label class="tgl full"><input type="checkbox" id="cdE" ${cd.enabled ? 'checked' : ''}> Разрешить «другую» продолжительность</label>
        <div class="fld"><label>Другая: от, мин</label><input class="inp" type="number" step="30" id="cdMin" value="${cd.min || 30}"></div>
        <div class="fld"><label>Другая: до, мин</label><input class="inp" type="number" step="30" id="cdMax" value="${cd.max || 720}"></div>
        <div class="fld"><label>Удержание без оплаты, мин</label><input class="inp" type="number" min="5" max="120" id="hold" value="${s.hold_minutes || 15}"></div>
        <div class="fld"><label>Бронирование вперёд, дней</label><input class="inp" type="number" min="1" max="30" id="hor" value="${s.booking_horizon_days || 30}"></div>
      </div><button class="btn btn-neon" id="svB">Сохранить</button></div>
      <div class="box"><h2>💳 Реквизиты для оплаты</h2><div class="fgrid">
        <div class="fld"><label>Банк</label><input class="inp" id="pB" value="${esc(pay.bank || '')}"></div>
        <div class="fld"><label>Телефон для перевода</label><input class="inp" id="pP" value="${esc(pay.phone || '')}"></div>
      </div><p class="dim" style="font-size:12px">Этот номер клиенты видят только как номер для перевода денег. Уведомления на него не отправляются.</p><button class="btn btn-neon" id="svPay">Сохранить</button></div>
      <div class="box"><h2>📍 Контакты на сайте</h2><div class="fgrid">
        <div class="fld full"><label>Адрес</label><input class="inp" id="cA" value="${esc(ct.address || '')}"></div>
        <div class="fld"><label>Основной телефон</label><input class="inp" id="cP" value="${esc(ct.phone || '')}"></div>
        <div class="fld"><label>Instagram (без @)</label><input class="inp" id="cI" value="${esc(ct.instagram || '')}"></div>
      </div><button class="btn btn-neon" id="svC">Сохранить</button></div>
      <div class="box"><h2>🔔 Уведомления</h2>
        <div class="fgrid"><div class="fld full"><label>Рабочий номер для уведомлений (WhatsApp)</label><input class="inp" id="nW" inputmode="tel" value="${esc((s.notify || {}).label || '+7 928 553-52-52')}"></div></div>
        <p class="dim" style="font-size:12px;margin:6px 0 10px">На этот номер клиенты отправляют чеки и сообщения о заявке, об аренде всей комнаты и об отмене — кнопки на странице заявки открывают WhatsApp с готовым текстом: имя, оборудование, дата, время, сумма и статус.</p>
        <button class="btn btn-neon" id="svN">Сохранить номер</button>
        <p class="muted" style="font-size:14px;margin-top:16px">Все события — новая заявка, аренда всей комнаты, чек, «ожидает проверки», оплата проверена, бронь подтверждена, отмена, перенос — сразу появляются в этой панели (счётчик на вкладке «Брони») с полными данными заявки. Автоматически, без участия клиента, их можно получать в Telegram через официального бота.</p>
        <div class="fgrid"><label class="tgl full"><input type="checkbox" id="tgE" ${tg.enabled ? 'checked' : ''}> Отправлять в Telegram</label>
        <div class="fld"><label>Токен бота ${tg.has_token ? '(сохранён)' : ''}</label><input class="inp" id="tgT" type="password" placeholder="${tg.has_token ? '•••••• (оставьте пустым)' : '123456:ABC…'}"></div>
        <div class="fld"><label>Chat ID</label><input class="inp" id="tgC" value="${esc(tg.chat_id || '')}"></div></div>
        <p class="dim" style="font-size:12px">Для Telegram в Supabase должно быть включено расширение pg_net. Без него уведомления остаются в панели.</p>
        <button class="btn btn-neon" id="svT">Сохранить</button> <button class="btn" id="showN">Журнал уведомлений</button></div>
      <div class="box"><h2>🔐 Безопасность</h2><div class="fgrid">
        <div class="fld"><label>Текущий пароль</label><input class="inp" type="password" id="op" autocomplete="current-password"></div>
        <div class="fld"><label>Новый пароль (от 10 символов)</label><input class="inp" type="password" id="np" autocomplete="new-password"></div>
        <div class="fld"><label>Автовыход при бездействии, мин</label><input class="inp" type="number" min="5" max="240" id="idle" value="${s.admin_idle_minutes || 30}"></div>
      </div><button class="btn btn-neon" id="svPw">Сменить пароль</button> <button class="btn" id="svIdle">Сохранить автовыход</button></div>
      <div class="box"><h2>💾 Резервная копия и журнал</h2><p class="muted" style="font-size:14px">Скачайте полную копию данных (брони, клиенты, цены, акции, журнал) в файл. Делайте это регулярно, например раз в неделю.</p>
        <button class="btn btn-neon" id="exp">Скачать резервную копию</button> <button class="btn" id="aud">Журнал действий</button></div>`;
    $('#lo2').onclick = () => logout();
    $('#wA').onchange = () => $('#wT').style.opacity = $('#wA').checked ? .4 : 1;
    const ok = () => toast('Сохранено', 'ok'), bad = e => toast(e.message, 'err');
    $('#svW').onclick = async () => { const days = {}; [1, 2, 3, 4, 5, 6, 7].forEach(d => days[d] = { open: $(`[data-wo="${d}"]`).value || '10:00', close: $(`[data-wc="${d}"]`).value || '02:00', closed: $(`[data-wx="${d}"]`).checked }); try { await saveSetting('work_hours', { always_open: $('#wA').checked, days }); ok(); } catch (e) { bad(e); } };
    $('#svB').onclick = async () => { try { const d = $$('.days-pick input:checked', main()).map(x => +x.value); if (!d.length) throw new Error('Выберите хотя бы одну продолжительность'); await saveSetting('durations', d); await saveSetting('custom_duration', { enabled: $('#cdE').checked, min: +$('#cdMin').value, max: +$('#cdMax').value }); await saveSetting('hold_minutes', +$('#hold').value); await saveSetting('booking_horizon_days', +$('#hor').value); ok(); } catch (e) { bad(e); } };
    $('#svPay').onclick = async () => { try { await saveSetting('payment', Object.assign({}, pay, { bank: $('#pB').value, phone: $('#pP').value })); ok(); } catch (e) { bad(e); } };
    $('#svC').onclick = async () => { try { await saveSetting('contacts', { address: $('#cA').value, phone: $('#cP').value, instagram: $('#cI').value.replace(/^@/, '') }); ok(); } catch (e) { bad(e); } };
    $('#svN').onclick = async () => { try { let d = $('#nW').value.replace(/\D/g, ''); if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1); if (d.length === 10) d = '7' + d; if (d.length < 11) throw new Error('Введите номер полностью, например +7 928 553-52-52');
      const label = `+${d[0]} ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9, 11)}`; await saveSetting('notify', { whatsapp: d, label }); $('#nW').value = label; ok(); } catch (e) { bad(e); } };
    $('#svT').onclick = async () => { try { await saveSetting('telegram', { enabled: $('#tgE').checked, bot_token: $('#tgT').value, chat_id: $('#tgC').value }); ok(); } catch (e) { bad(e); } };
    $('#svPw').onclick = async () => { try { await api('admin_change_password', { old_password: $('#op').value, new_password: $('#np').value }); try { sessionStorage.removeItem('cz_must_change'); } catch (x) {} toast('Пароль изменён. Другие сессии завершены.', 'ok'); settings(); } catch (e) { bad(e); } };
    $('#svIdle').onclick = async () => { try { const v = +$('#idle').value; await saveSetting('admin_idle_minutes', v); IDLE_MIN = v; touch(); ok(); } catch (e) { bad(e); } };
    $('#exp').onclick = async () => { try { const d = await api('admin_export'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 1)], { type: 'application/json' })); a.download = `chillzone-backup-${CZ.localDateStr(new Date())}.json`; document.body.appendChild(a); a.click(); a.remove(); toast('Резервная копия скачана', 'ok'); } catch (e) { bad(e); } };
    $('#aud').onclick = async () => { const l = await api('admin_audit'); modal(`<h2>Журнал действий</h2><div class="hist">${l.map(h => `<div>${CZ.fmtDate(h.at)} ${CZ.localTime(h.at)} · <b>${h.actor}</b> · ${esc(ACT[h.action] || h.action)}</div>`).join('')}</div>`); };
    $('#showN').onclick = async () => { const l = await api('admin_notifications', { mark_seen: true }); unseen = 0; refreshBadge(); modal(`<h2>Уведомления</h2><div class="hist">${l.map(n => `<div>${CZ.fmtDate(n.at)} ${CZ.localTime(n.at)} · ${esc(n.message)} <span class="dim">(${n.channel_status === 'in_app' ? 'в панели' : n.channel_status === 'telegram_queued' ? 'отправлено в Telegram' : 'Telegram: ошибка/недоступно'})</span></div>`).join('') || 'Пусто'}</div>`); };
  }

  route();
})();
