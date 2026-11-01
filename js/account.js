/* CHILL ZONE — личный кабинет: вход, баланс, пополнение, история, брони */
(function () {
  const { $, $$, esc, rub, rpc, toast } = CZ;
  CZ.header('/account');
  const box = $('#acc');
  let ME = null, TOPUP = null, preview = null;
  const ret = (r => r && /^\/(?!\/)/.test(r) ? r : '')(new URLSearchParams(location.search).get('ret'));  // только внутренние ссылки

  function token() { try { return localStorage.getItem('cz_ctoken') || ''; } catch (e) { return ''; } }
  function setToken(t) { try { t ? localStorage.setItem('cz_ctoken', t) : localStorage.removeItem('cz_ctoken'); } catch (e) {} }
  const call = (fn, p = {}) => rpc(fn, Object.assign({ ctoken: token() }, p));
  const fmtDT = d => `${CZ.fmtDate(d)}, ${CZ.localTime(d)}`;
  const KIND = { topup: 'Пополнение', bonus: 'Бонус', payment: 'Оплата брони', refund: 'Возврат', adjust: 'Корректировка' };
  const pct = v => (Math.round(+v * 100) / 100).toString().replace('.', ',') + '%';
  // расчёт бонуса по действующей шкале (окончательно считает сервер при создании заявки)
  function bonusFor(amt) {
    const b = ME && ME.bonus_settings; if (!b || !b.enabled || !(amt > 0)) return { p: 0, a: 0 };
    let p = 0; (b.tiers || []).forEach(t => { if (t.enabled !== false && amt >= +t.min && (t.max == null || amt <= +t.max) && +t.percent > p) p = +t.percent; });
    p = Math.min(p, b.max_percent ?? 100); return { p, a: Math.floor(amt * p / 100) };
  }
  // минимальная сумма, с которой начисляется бонус
  function bonusMin() { const b = ME && ME.bonus_settings; if (!b || !b.enabled) return null; const t = (b.tiers || []).filter(x => x.enabled !== false && +x.percent > 0).map(x => +x.min); return t.length ? Math.min(...t) : null; }
  // всегда видимый расчёт бонуса под полем суммы
  function bonusPreview(amt) {
    const b = ME && ME.bonus_settings; if (!b || !b.enabled) return '';
    const mn = bonusMin(); if (mn == null) return '';
    const tiers = (b.tiers || []).filter(t => t.enabled !== false && +t.percent > 0).sort((x, y) => x.min - y.min);
    const scale = `<div class="bn-line">${tiers.map(t => `<span>${t.max == null ? 'от ' + rub(t.min) : rub(t.min) + '–' + rub(t.max)} <b>+${pct(Math.min(t.percent, b.max_percent ?? 100))}</b></span>`).join('')}</div>`;
    if (!(amt > 0)) return `<div class="bn-live"><div class="bn-title">🎁 Бонус за пополнение</div>${scale}</div>`;
    const bn = bonusFor(amt);
    if (amt < mn || !bn.a) return `<div class="bn-live"><div class="bn-row"><span>Сумма пополнения</span><b>${rub(amt)}</b></div><div class="bn-hint">Бонус начисляется при пополнении от ${rub(mn)}</div>${scale}</div>`;
    return `<div class="bn-live on"><div class="bn-row"><span>Сумма пополнения</span><b>${rub(amt)}</b></div>
      <div class="bn-row bn-plus"><span>Ваш бонус:</span><b>+${rub(bn.a)} (${pct(bn.p)})</b></div>
      <div class="bn-row bn-total"><span>На баланс поступит:</span><b>${rub(amt + bn.a)}</b></div>
      <div class="bn-hint">Бонус начислится вместе с пополнением после того, как администратор подтвердит оплату.</div></div>`;
  }
  const bonusLine = t => +t.bonus_amount > 0 ? `<div class="tp-bonus"><span>Пополнение</span><b>${rub(t.amount)}</b><span>Бонус ${pct(t.bonus_percent)}</span><b class="plus">+${rub(t.bonus_amount)}</b><span>Итого на баланс</span><b>${rub(t.amount + t.bonus_amount)}</b></div>` : '';
  const TST = { awaiting_payment: 'Ожидает подтверждения', receipt_sent: 'Чек на проверке', approved: 'Зачислено', rejected: 'Отклонено', cancelled: 'Отменено' };
  const METHOD = { cash: 'наличные', transfer: 'перевод', other: 'другой способ', balance: 'с баланса' };
  function maskPhone(v) {
    let d = v.replace(/\D/g, ''); if (d.startsWith('8')) d = '7' + d.slice(1); if (d && !d.startsWith('7')) d = '7' + d; d = d.slice(0, 11);
    if (!d) return ''; let r = '+7'; if (d.length > 1) r += ' (' + d.slice(1, 4); if (d.length >= 4) r += ')'; if (d.length > 4) r += ' ' + d.slice(4, 7); if (d.length > 7) r += '-' + d.slice(7, 9); if (d.length > 9) r += '-' + d.slice(9, 11); return r;
  }
  const fmtPhone = p => { const d = String(p || ''); return d.length === 11 ? `+${d[0]} ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}` : p; };

  async function load() {
    CZ.footer();
    try { const d = await rpc('get_public_data'); if (!(d.features && d.features.balance)) return soon(); } catch (e) {}
    if (!token()) return getR() ? resetView() : authView();
    try { ME = await call('client_me'); render(); }
    catch (e) {
      if (e.code === 'CLIENT_AUTH_REQUIRED') { setToken(''); return authView(); }
      if (e.code === 'NOT_READY') return soon();
      box.innerHTML = `<div class="empty-state"><h3>Не удалось загрузить</h3><p class="muted">${esc(e.message)}</p><button class="btn btn-neon" onclick="location.reload()">Обновить</button></div>`;
    }
  }

  function soon() { box.innerHTML = '<div class="empty-state"><h3>Личный кабинет скоро откроется</h3><p class="muted">Мы заканчиваем запуск. А пока бронируйте как обычно — на главной странице.</p><a class="btn btn-neon" href="/#room">Забронировать</a></div>'; }

  // ---------- вход / регистрация ----------
  function authView(mode = ret ? 'reg' : 'login') {
    box.innerHTML = `<div class="acc-auth card">
      <div class="kicker">CHILL ZONE</div><h1 class="h2" style="font-size:clamp(28px,6vw,44px)">Личный <span class="grad-text">кабинет</span></h1>
      ${ret ? '<div class="note info" style="margin:6px 0 0">Чтобы забронировать, зарегистрируйтесь или войдите — это займёт минуту. После этого вы сразу вернётесь к брони.</div>' : '<p class="muted">Бронируй, пополняй баланс и оплачивай брони в один клик.</p>'}
      <div class="segs" id="mode" style="margin:18px 0"><button data-m="login" class="${mode === 'login' ? 'on' : ''}">Вход</button><button data-m="reg" class="${mode === 'reg' ? 'on' : ''}">Регистрация</button></div>
      <form id="af" class="stack">
        ${mode === 'reg' ? '<input class="inp" id="aN" placeholder="Имя" autocomplete="name" maxlength="60" required>' : ''}
        <input class="inp" id="aP" placeholder="+7 (___) ___-__-__" inputmode="tel" autocomplete="tel" required>
        <input class="inp" id="aW" type="password" placeholder="${mode === 'reg' ? 'Придумайте пароль (от 6 символов)' : 'Пароль'}" autocomplete="${mode === 'reg' ? 'new-password' : 'current-password'}" required>
        <button class="btn btn-neon btn-wide" id="aB">${mode === 'reg' ? 'Создать аккаунт' : 'Войти'}</button>
        <p class="form-err" id="aE"></p>
      </form>
      <p class="dim" style="font-size:13px">${mode === 'reg' ? 'Ваш логин для входа — номер телефона. Пароль никому не сообщайте: мы храним его только в зашифрованном виде.' : '<a href="#" id="forgot" style="color:#22e3ff;font-weight:700">Забыли пароль?</a>'}</p>
    </div>`;
    const fg = $('#forgot'); if (fg) fg.onclick = e => { e.preventDefault(); resetView(ph.value); };
    $$('#mode button').forEach(b => b.onclick = () => authView(b.dataset.m));
    const ph = $('#aP'); ph.oninput = () => ph.value = maskPhone(ph.value);
    try { ph.value = maskPhone(localStorage.getItem('cz_phone') || ''); const n = $('#aN'); if (n) n.value = localStorage.getItem('cz_name') || ''; } catch (e) {}
    $('#af').onsubmit = async e => {
      e.preventDefault(); $('#aB').disabled = true; $('#aE').textContent = '';
      try {
        const r = mode === 'reg' ? await rpc('client_register', { name: $('#aN').value, phone: ph.value, password: $('#aW').value })
                                 : await rpc('client_login', { phone: ph.value, password: $('#aW').value });
        setToken(r.ctoken); ME = r;
        if (ret) { location.href = ret; return; }
        render();
      } catch (er) { $('#aE').textContent = er.message; $('#aB').disabled = false; }
    };
  }

  // ---------- восстановление пароля ----------
  // 1) телефон → код; 2) клиент отправляет код в WhatsApp клуба со своего номера; 3) админ подтверждает; 4) клиент задаёт новый пароль
  const RKEY = 'cz_reset';
  const getR = () => { try { return JSON.parse(sessionStorage.getItem(RKEY) || 'null'); } catch (e) { return null; } };
  const setR = v => { try { v ? sessionStorage.setItem(RKEY, JSON.stringify(v)) : sessionStorage.removeItem(RKEY); } catch (e) {} };
  let CLUB_WA = '79285535252', rTimer = null;
  async function resetClubWa() { try { const d = await rpc('get_public_data'); const n = (d.settings.notify || {}).whatsapp || (d.settings.contacts || {}).whatsapp; if (n) CLUB_WA = String(n).replace(/\D/g, ''); } catch (e) {} return CLUB_WA; }
  function resetView(phone) {
    clearInterval(rTimer);
    const R = getR();
    if (R && R.rid) return resetWait(R);
    box.innerHTML = `<div class="acc-auth card">
      <div class="kicker">CHILL ZONE</div><h1 class="h2" style="font-size:clamp(26px,6vw,40px)">Восстановление <span class="grad-text">пароля</span></h1>
      <p class="muted">Укажите номер телефона, на который зарегистрирован аккаунт. Мы покажем код — его нужно отправить в WhatsApp клуба <b>с этого же номера</b>. Так мы убедимся, что номер ваш.</p>
      <form id="rf" class="stack"><input class="inp" id="rP" placeholder="+7 (___) ___-__-__" inputmode="tel" autocomplete="tel" required>
        <button class="btn btn-neon btn-wide" id="rB">Получить код</button><p class="form-err" id="rE"></p></form>
      <p class="dim" style="font-size:13px"><a href="#" id="rBack">← Назад ко входу</a></p></div>`;
    const ph = $('#rP'); ph.value = phone || ''; ph.oninput = () => ph.value = maskPhone(ph.value);
    $('#rBack').onclick = e => { e.preventDefault(); authView('login'); };
    $('#rf').onsubmit = async e => {
      e.preventDefault(); $('#rB').disabled = true; $('#rE').textContent = '';
      try { const r = await rpc('client_reset_start', { phone: ph.value }); const v = { rid: r.rid, secret: r.secret, code: r.code, phone: r.phone, status: r.status }; setR(v); resetWait(v); }
      catch (er) { $('#rE').textContent = er.message; $('#rB').disabled = false; }
    };
  }
  async function resetWait(R) {
    const wa = await resetClubWa();
    const text = `Здравствуйте! Прошу восстановить пароль в личном кабинете CHILL ZONE.\nТелефон: ${fmtPhone(R.phone)}\nКод восстановления: ${R.code}`;
    const draw = st => {
      if (st === 'approved') {
        box.innerHTML = `<div class="acc-auth card"><div class="kicker">CHILL ZONE</div><h1 class="h2" style="font-size:clamp(26px,6vw,40px)">Новый <span class="grad-text">пароль</span></h1>
          <div class="note info" style="margin:0 0 12px">✅ Номер подтверждён. Придумайте новый пароль.</div>
          <form id="nf" class="stack"><input class="inp" id="n1" type="password" placeholder="Новый пароль (от 6 символов)" autocomplete="new-password" required>
          <input class="inp" id="n2" type="password" placeholder="Повторите пароль" autocomplete="new-password" required>
          <button class="btn btn-neon btn-wide" id="nB">Сохранить пароль</button><p class="form-err" id="nE"></p></form></div>`;
        $('#nf').onsubmit = async e => {
          e.preventDefault(); $('#nE').textContent = '';
          if ($('#n1').value !== $('#n2').value) { $('#nE').textContent = 'Пароли не совпадают'; return; }
          $('#nB').disabled = true;
          try { const r = await rpc('client_reset_finish', { rid: R.rid, secret: R.secret, password: $('#n1').value }); setR(null); setToken(r.ctoken); ME = r; render(); toast('Ваш пароль успешно изменён', 'ok'); }
          catch (er) { $('#nE').textContent = er.message; $('#nB').disabled = false; }
        };
        return;
      }
      if (st !== 'pending') {
        setR(null);
        box.innerHTML = `<div class="acc-auth card"><h2>${st === 'rejected' ? 'Запрос отклонён' : st === 'used' ? 'Пароль уже изменён' : 'Время запроса истекло'}</h2>
          <p class="muted">${st === 'rejected' ? 'Администратор не подтвердил запрос. Убедитесь, что пишете в WhatsApp с номера, на который зарегистрирован аккаунт, и попробуйте снова.' : st === 'used' ? 'Войдите с новым паролем.' : 'Код действует 30 минут. Запросите новый код.'}</p>
          <button class="btn btn-neon btn-wide" id="again">${st === 'used' ? 'Войти' : 'Запросить новый код'}</button></div>`;
        $('#again').onclick = () => st === 'used' ? authView('login') : resetView(R.phone); return;
      }
      box.innerHTML = `<div class="acc-auth card"><div class="kicker">CHILL ZONE</div><h1 class="h2" style="font-size:clamp(26px,6vw,40px)">Восстановление <span class="grad-text">пароля</span></h1>
        <p class="muted" style="margin-bottom:6px">Ваш код восстановления:</p>
        <div class="reset-code">${esc(R.code)}</div>
        <p class="muted">Нажмите кнопку ниже и отправьте сообщение в WhatsApp клуба <b>с номера ${esc(fmtPhone(R.phone))}</b>. Администратор сверит номер и подтвердит — после этого здесь появится поле для нового пароля.</p>
        <a class="btn btn-wa btn-wide wa-big" target="_blank" rel="noopener" href="https://wa.me/${wa}?text=${encodeURIComponent(text)}">💬 ОТПРАВИТЬ КОД В WHATSAPP</a>
        <p class="dim" style="font-size:13px;margin-top:12px">⏳ Ждём подтверждения администратора… Страница обновится сама. Код действует 30 минут.</p>
        <p class="dim" style="font-size:13px"><a href="#" id="rCancel">Отменить и вернуться ко входу</a></p></div>`;
      $('#rCancel').onclick = e => { e.preventDefault(); clearInterval(rTimer); setR(null); authView('login'); };
    };
    draw(R.status || 'pending');
    const poll = async () => { try { const r = await rpc('client_reset_status', { rid: R.rid, secret: R.secret }); if (r.status !== R.status) { R.status = r.status; setR(R); draw(r.status); if (r.status !== 'pending') clearInterval(rTimer); } } catch (e) { if (e.code === 'RESET_NOT_FOUND') { clearInterval(rTimer); setR(null); authView('login'); } } };
    clearInterval(rTimer); if ((R.status || 'pending') === 'pending') rTimer = setInterval(() => { if (!document.hidden) poll(); }, 5000); poll();
  }

  // ---------- уведомления ----------
  function welcomePopup() {
    const w = (ME.notifications || []).find(n => n.event === 'client_welcome' && !n.seen); if (!w || $('#welcome')) return;
    const d = document.createElement('div'); d.id = 'welcome'; d.className = 'cz-pop';
    d.innerHTML = `<div class="card cz-pop-card"><div class="kicker">Уведомление</div><h2 style="margin:4px 0 10px">${esc(w.title || 'CHILL ZONE')}</h2>
      <div style="white-space:pre-line;line-height:1.5">${esc(w.message)}</div>
      <div class="note info" style="margin:14px 0 0"><b>Ваши данные для входа</b><br>Логин: <b>${esc(fmtPhone(ME.phone))}</b> (номер телефона)<br>Пароль: тот, что вы придумали при регистрации. Мы храним его только в зашифрованном виде и никому не показываем. Если забудете — нажмите «Забыли пароль?» на странице входа.</div>
      <button class="btn btn-neon btn-wide" id="wOk" style="margin-top:14px">Отлично, понятно!</button></div>`;
    document.body.appendChild(d);
    $('#wOk').onclick = async () => { d.remove(); try { const r = await call('client_notifications_read', { id: w.id }); w.seen = true; ME.unread = r.unread; render(); } catch (e) {} };
  }
  function notifSection() {
    const L = ME.notifications || []; if (!L.length) return '';
    return `<section class="acc-sec" id="ntSec"><h2>🔔 Уведомления ${ME.unread ? `<span class="chip" style="background:#ff2d55;color:#fff">${ME.unread} новых</span>` : ''}</h2>
      <div class="ops">${L.map(n => `<div class="op" style="${n.seen ? '' : 'border-color:rgba(34,227,255,.5)'}"><div><b>${esc(n.title || 'Уведомление')}</b>${n.seen ? '' : ' <span class="chip">новое</span>'}
        <div class="dim" style="font-size:13px;white-space:pre-line;margin-top:4px">${esc(n.message)}</div><div class="dim" style="font-size:12px;margin-top:4px">${fmtDT(n.at)}</div></div></div>`).join('')}</div>
      ${ME.unread ? '<button class="btn btn-sm btn-ghost" id="ntRead" style="margin-top:10px">Отметить все прочитанными</button>' : ''}</section>`;
  }

  // ---------- кабинет ----------
  function render() {
    const s = ME.balance_settings || {}; const presets = s.presets || [500, 1000, 2000, 3000];
    const pending = (ME.topups || []).filter(t => ['awaiting_payment', 'receipt_sent'].includes(t.status));
    box.innerHTML = `
      <div class="acc-head">
        <div><div class="kicker">Личный кабинет</div><h1 class="h2" style="font-size:clamp(26px,5vw,40px);margin:0">${esc(ME.name)}</h1><p class="muted" style="margin:4px 0 0">${fmtPhone(ME.phone)}${ME.client_id ? ` · <span style="white-space:nowrap">ID <b>${esc(ME.client_id)}</b></span>` : ''}</p></div>
        <div style="display:flex;gap:8px;align-items:center">${(ME.notifications || []).length ? `<a class="btn btn-sm btn-ghost" href="#ntSec" title="Уведомления">🔔${ME.unread ? ` <b style="color:#ff2d55">${ME.unread}</b>` : ''}</a>` : ''}<button class="btn btn-sm btn-ghost" id="out">Выйти</button></div>
      </div>
      ${ME.frozen ? `<div class="note">⛔ Операции по балансу временно приостановлены${ME.frozen_reason ? ': ' + esc(ME.frozen_reason) : ''}. Свяжитесь с клубом.</div>` : ''}
      <div class="bal-card">
        <div class="muted" style="font-weight:700;letter-spacing:.12em;text-transform:uppercase;font-size:12px">Мой баланс</div>
        <div class="bal-amt">${rub(ME.balance)}</div>
        ${ME.reserved ? `<p class="muted" style="margin:-8px 0 14px;font-size:14px">Доступно: <b style="color:#fff">${rub(ME.available)}</b> · ${rub(ME.reserved)} зарезервировано под заявки, ожидающие подтверждения</p>` : `<p class="muted" style="margin:-8px 0 14px;font-size:14px">Доступно для оплаты: <b style="color:#fff">${rub(ME.available ?? ME.balance)}</b></p>`}
        <a class="btn btn-neon btn-sm" href="/#room">Забронировать с баланса</a>
      </div>

      <section class="acc-sec" id="topSec">
        <h2>Пополнить баланс</h2>
        ${ME.frozen ? '<p class="muted">Пополнение недоступно, пока операции приостановлены.</p>' : `
        <div class="segs" id="amts">${presets.map(v => `<button data-a="${v}">${rub(v)}</button>`).join('')}<button data-a="custom">Своя сумма</button></div>
        <input class="inp" id="amtC" type="number" inputmode="numeric" min="${s.min_topup || 100}" max="${s.max_topup || 50000}" placeholder="Сумма, ₽ (от ${s.min_topup || 100} до ${(s.max_topup || 50000).toLocaleString('ru-RU')})" style="margin-top:8px;display:none">
        <div id="bnPrev" aria-live="polite">${bonusPreview(0)}</div>
        <button class="btn btn-neon btn-wide" id="tpGo" style="margin-top:12px" disabled>Выберите сумму</button>
        <p class="dim" style="font-size:13px;margin:8px 0 0">Деньги зачисляются только после того, как администратор проверит поступление и подтвердит пополнение.</p>`}
        ${pending.map(topupCard).join('')}
      </section>

      ${(ME.topups || []).some(t => !['awaiting_payment', 'receipt_sent'].includes(t.status)) ? `<section class="acc-sec"><h2>Заявки на пополнение</h2><div class="ops">${ME.topups.filter(t => !['awaiting_payment', 'receipt_sent'].includes(t.status)).map(t => `<div class="op"><div><b>${esc(t.code)}</b> <span class="chip">${TST[t.status] || t.status}</span>
          <div class="dim" style="font-size:12px">${fmtDT(t.created_at)}${t.created_by === 'admin' ? ' · в клубе' : ''}${t.method ? ' · ' + (METHOD[t.method] || t.method) : ''}${t.admin_note && t.status === 'rejected' ? ' · ' + esc(t.admin_note) : ''}</div></div>
          <div style="text-align:right"><b>${rub(t.amount)}</b>${+t.bonus_amount > 0 ? `<div class="dim" style="font-size:12px">бонус ${pct(t.bonus_percent)}: <span class="plus">+${rub(t.bonus_amount)}</span></div><div style="font-size:12px">итого <b>${rub(t.amount + t.bonus_amount)}</b></div>` : ''}</div></div>`).join('')}</div></section>` : ''}

      <section class="acc-sec"><h2>История операций</h2>
        ${(ME.ops || []).length ? `<div class="ops">${ME.ops.map(o => `<div class="op"><div><b>${KIND[o.kind] || o.kind}</b><div class="dim" style="font-size:13px">${esc(o.description)}</div><div class="dim" style="font-size:12px">${fmtDT(o.at)}${o.method ? ' · ' + (METHOD[o.method] || o.method) : ''} · <span style="color:#3dffb0">выполнено</span></div></div>
          <div style="text-align:right"><b class="${o.amount > 0 ? 'plus' : 'minus'}">${o.amount > 0 ? '+' : '−'}${rub(Math.abs(o.amount))}</b><div class="dim" style="font-size:12px">баланс ${rub(o.balance_after)}</div></div></div>`).join('')}</div>`
        : '<p class="muted">Операций пока нет.</p>'}
      </section>

      ${notifSection()}
      <section class="acc-sec"><h2>Данные для входа</h2>
        <div class="op"><div><span class="dim" style="font-size:13px">Логин (номер телефона)</span><div><b>${esc(fmtPhone(ME.phone))}</b></div></div><div style="text-align:right"><span class="dim" style="font-size:13px">Пароль</span><div><b>••••••</b></div></div></div>
        <p class="dim" style="font-size:12px;margin-top:8px">Пароль хранится только в зашифрованном виде — мы его не видим и не отправляем. Забыли? На странице входа нажмите «Забыли пароль?».</p></section>

      <section class="acc-sec"><h2>Мои брони</h2>
        ${(ME.bookings || []).length ? ME.bookings.map(b => `<div class="op"><div><b>${esc(b.equipment_name)}</b> <span class="dim" style="font-size:12px">${esc(b.code)}</span>
          <div class="dim" style="font-size:13px">${CZ.fmtRange(b.starts_at, b.ends_at)} · ${rub(b.total)} · ${b.payment_status === 'balance' ? 'оплачено с баланса' : b.payment_status === 'balance_pending' ? 'с баланса после подтверждения' : 'перевод'}</div>
          <div style="font-size:13px"><b class="${b.status === 'confirmed' ? 'plus' : ['rejected', 'cancelled', 'expired'].includes(b.status) ? 'minus' : ''}">${b.status === 'confirmed' ? 'Бронирование подтверждено' : b.status === 'rejected' ? 'Заявка отклонена' : esc(b.status_ru)}</b>${b.refunded ? ` · возвращено ${rub(b.refunded)}` : ''}</div></div>
          <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">${['awaiting_payment', 'pending_review', 'receipt_sent', 'payment_verified'].includes(b.status) ? `<a class="btn btn-sm btn-wa" target="_blank" rel="noopener" href="${waLink(bookingWa(b))}">WhatsApp</a>` : ''}${b.can_cancel ? `<button class="btn btn-sm btn-ghost" data-cancel="${esc(b.code)}" data-bal="${['balance', 'verified', 'onsite'].includes(b.payment_status) ? 1 : 0}" data-paid="${b.payment_status === 'claimed' ? 1 : 0}">Отменить бронирование</button>` : ''}</div></div>`).join('')
        : '<p class="muted">Броней, оформленных из аккаунта, пока нет.</p>'}
        <p class="dim" style="font-size:12px;margin-top:10px">Бронь можно отменить в любое время до её начала. Если она оплачена (с баланса или переводом), деньги полностью вернутся на ваш баланс. После начала брони отмена недоступна. Вопросы — <a href="tel:+79285535252">+7 928 553-52-52</a>.</p>
      </section>`;
    $('#out').onclick = async () => { try { await call('client_logout'); } catch (e) {} setToken(''); authView(); };
    bindTopup(); bindPending();
    const nr = $('#ntRead'); if (nr) nr.onclick = async () => { try { await call('client_notifications_read'); (ME.notifications || []).forEach(n => n.seen = true); ME.unread = 0; render(); } catch (e) { toast(e.message, 'err'); } };
    welcomePopup();
    $$('[data-cancel]').forEach(b => b.onclick = async () => {
      const bal = b.dataset.bal === '1', paid = b.dataset.paid === '1';
      if (!confirm(bal ? 'Вы действительно хотите отменить бронирование? Средства будут возвращены на ваш баланс.'
        : paid ? 'Вы действительно хотите отменить бронирование? Ваш перевод ещё не проверен администратором — после проверки деньги вернутся на баланс.'
        : 'Вы действительно хотите отменить бронирование?')) return;
      b.disabled = true;
      try { ME = await call('client_cancel_booking', { code: b.dataset.cancel });
        toast(bal ? 'Бронирование отменено. Средства возвращены на ваш баланс' : paid ? 'Бронирование отменено. После проверки перевода администратор вернёт деньги на баланс' : 'Бронирование отменено, время освобождено', 'ok'); render();
      } catch (e) { b.disabled = false; toast(e.message, 'err'); render(); }
    });
  }

  const clubWa = () => String((ME.notify || {}).whatsapp || '79285535252').replace(/\D/g, '');
  const waLink = t => `https://wa.me/${clubWa()}?text=${encodeURIComponent(t)}`;
  const dnum = iso => new Intl.DateTimeFormat('ru-RU', { timeZone: CZ.TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));
  const topupWa = t => `Здравствуйте! Хочу пополнить баланс CHILL ZONE.\n\nИмя: ${ME.name}\nТелефон: ${fmtPhone(ME.phone)}\nID аккаунта: ${ME.client_id || '—'}\nСумма пополнения: ${rub(t.amount)}\nБонус: ${pct(t.bonus_percent || 0)}\nСумма бонуса: ${rub(t.bonus_amount || 0)}\nИтоговое зачисление: ${rub(t.amount + (t.bonus_amount || 0))}\nНомер заявки: ${t.code}\n\nПрошу подтвердить пополнение.`;
  const bookingWa = b => `Здравствуйте! Хочу оформить бронирование в CHILL ZONE.\n\nИмя: ${ME.name}\nТелефон: ${fmtPhone(ME.phone)}\nОборудование: ${b.equipment_name}\nДата: ${dnum(b.starts_at)}\nВремя: ${CZ.localTime(b.starts_at)}–${CZ.localTime(b.ends_at)}\nСтоимость: ${rub(b.total)}\nСпособ оплаты: ${['balance', 'balance_pending'].includes(b.payment_status) ? 'с личного баланса' : 'перевод на Т-Банк'}\nНомер заявки: ${b.code}\n\nПрошу проверить заявку и подтвердить бронирование.`;
  function topupCard(t) {
    const pay = ME.payment || {};
    return `<div class="tp-card" data-tp="${t.id}">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><b>Заявка ${esc(t.code)}</b><span class="chip">${TST[t.status]}</span></div>
      <div class="amount" style="font-size:34px;margin:6px 0">${rub(t.amount)}</div>
      ${bonusLine(t)}
      <p class="muted" style="margin:0 0 10px;font-size:14px">Баланс <b>не изменится</b>, пока администратор не проверит поступление денег и не подтвердит пополнение.</p>
      <div class="wa-big" style="margin:0 0 12px"><a class="btn btn-wa btn-wide" target="_blank" rel="noopener" href="${waLink(topupWa(t))}">💬 ОТПРАВИТЬ ЗАЯВКУ В WHATSAPP</a>
        <p class="dim" style="font-size:13px;margin:8px 0 0">Откроется WhatsApp клуба с готовым сообщением — просто нажмите «Отправить».</p></div>
      ${t.status === 'awaiting_payment' ? `
        <p style="margin:0">Оплата: переведите <b>${rub(t.amount)}</b> · <b>${esc(pay.bank || 'Т-Банк')}</b> по номеру телефона (или передайте деньги администратору в клубе):</p>
        <div class="pay-phone"><b>${esc(pay.phone || '')}</b><button class="btn btn-sm" data-copy="${esc((pay.phone || '').replace(/[^\d+]/g, ''))}">Скопировать номер</button></div>
        <label class="drop" style="margin-top:8px"><input type="file" accept="image/*,application/pdf" data-file="${t.id}"><b>📎 Загрузить чек (по желанию)</b><br><span class="muted" style="font-size:14px">Скриншот перевода или PDF</span></label>
        <div style="margin-top:10px"><button class="btn btn-sm btn-ghost" data-tpcancel="${t.id}">Отменить заявку</button></div>`
      : `<p class="muted" style="margin:0">Чек получен. Деньги зачислятся, как только администратор проверит поступление.</p>`}
    </div>`;
  }
  function bindTopup() {
    const go = $('#tpGo'); if (!go) return; let amt = 0;
    const set = v => { amt = +v || 0; go.disabled = !(amt > 0); go.textContent = amt > 0 ? `Пополнить баланс на ${rub(amt)}` : 'Выберите сумму';
      const pv = $('#bnPrev'); if (pv) pv.innerHTML = bonusPreview(amt); };
    $('#amts').onclick = e => { const b = e.target.closest('[data-a]'); if (!b) return; $$('#amts button').forEach(x => x.classList.toggle('on', x === b));
      const c = $('#amtC'); if (b.dataset.a === 'custom') { c.style.display = ''; c.focus(); set(c.value); } else { c.style.display = 'none'; set(b.dataset.a); } };
    $('#amtC').oninput = e => set(Math.round(+e.target.value));
    go.onclick = async () => {
      go.disabled = true;
      try { await call('client_topup_create', { amount: amt }); ME = await call('client_me'); render(); toast('Заявка создана — отправьте её в WhatsApp', 'ok'); setTimeout(() => { const c = $('.tp-card'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 100); }
      catch (e) { toast(e.message, 'err'); go.disabled = false; }
    };
  }
  function bindPending() {
    $$('[data-copy]').forEach(b => b.onclick = async () => (await CZ.copy(b.dataset.copy)) ? toast('Номер скопирован', 'ok') : toast('Не удалось скопировать', 'err'));
    $$('[data-file]').forEach(inp => inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      try { toast('Загружаю чек…'); const p = await CZ.fileToPayload(f); await call('client_topup_receipt', { topup_id: inp.dataset.file, mime: p.mime, data: p.data }); ME = await call('client_me'); render(); toast('Чек отправлен администратору', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    });
    $$('[data-tpcancel]').forEach(b => b.onclick = async () => { try { await call('client_topup_cancel', { topup_id: b.dataset.tpcancel }); ME = await call('client_me'); render(); } catch (e) { toast(e.message, 'err'); } });
  }
  load();
  setInterval(async () => { if (!document.hidden && ME && token() && ((ME.topups || []).some(t => ['awaiting_payment', 'receipt_sent'].includes(t.status)) || (ME.bookings || []).some(b => ['awaiting_payment', 'pending_review', 'receipt_sent', 'payment_verified'].includes(b.status)))) { try { ME = await call('client_me'); render(); } catch (e) {} } }, 30000);
})();
