/* CHILL ZONE — личный кабинет: вход, баланс, пополнение, история, брони */
(function () {
  const { $, $$, esc, rub, rpc, toast } = CZ;
  CZ.header('/account');
  const box = $('#acc');
  let ME = null, TOPUP = null, preview = null;
  const ret = new URLSearchParams(location.search).get('ret');

  function token() { try { return localStorage.getItem('cz_ctoken') || ''; } catch (e) { return ''; } }
  function setToken(t) { try { t ? localStorage.setItem('cz_ctoken', t) : localStorage.removeItem('cz_ctoken'); } catch (e) {} }
  const call = (fn, p = {}) => rpc(fn, Object.assign({ ctoken: token() }, p));
  const fmtDT = d => `${CZ.fmtDate(d)}, ${CZ.localTime(d)}`;
  const KIND = { topup: 'Пополнение', payment: 'Оплата брони', refund: 'Возврат', adjust: 'Корректировка' };
  const TST = { awaiting_payment: 'Ожидает оплаты', receipt_sent: 'Чек на проверке', approved: 'Зачислено', rejected: 'Отклонено', cancelled: 'Отменено' };
  function maskPhone(v) {
    let d = v.replace(/\D/g, ''); if (d.startsWith('8')) d = '7' + d.slice(1); if (d && !d.startsWith('7')) d = '7' + d; d = d.slice(0, 11);
    if (!d) return ''; let r = '+7'; if (d.length > 1) r += ' (' + d.slice(1, 4); if (d.length >= 4) r += ')'; if (d.length > 4) r += ' ' + d.slice(4, 7); if (d.length > 7) r += '-' + d.slice(7, 9); if (d.length > 9) r += '-' + d.slice(9, 11); return r;
  }
  const fmtPhone = p => { const d = String(p || ''); return d.length === 11 ? `+${d[0]} ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}` : p; };

  async function load() {
    CZ.footer();
    if (!token()) return authView();
    try { ME = await call('client_me'); render(); }
    catch (e) {
      if (e.code === 'CLIENT_AUTH_REQUIRED') { setToken(''); return authView(); }
      if (/function|Could not find|PGRST/i.test(e.message)) return box.innerHTML = '<div class="empty-state"><h3>Скоро</h3><p class="muted">Личный баланс запускается. Загляните чуть позже.</p></div>';
      box.innerHTML = `<div class="empty-state"><h3>Не удалось загрузить</h3><p class="muted">${esc(e.message)}</p><button class="btn btn-neon" onclick="location.reload()">Обновить</button></div>`;
    }
  }

  // ---------- вход / регистрация ----------
  function authView(mode = 'login') {
    box.innerHTML = `<div class="acc-auth card">
      <div class="kicker">Личный кабинет</div><h1 class="h2" style="font-size:clamp(28px,6vw,44px)">Мой <span class="grad-text">баланс</span></h1>
      <p class="muted">Пополняй баланс и оплачивай брони в один клик.</p>
      <div class="segs" id="mode" style="margin:18px 0"><button data-m="login" class="${mode === 'login' ? 'on' : ''}">Вход</button><button data-m="reg" class="${mode === 'reg' ? 'on' : ''}">Регистрация</button></div>
      <form id="af" class="stack">
        ${mode === 'reg' ? '<input class="inp" id="aN" placeholder="Имя" autocomplete="name" maxlength="60" required>' : ''}
        <input class="inp" id="aP" placeholder="+7 (___) ___-__-__" inputmode="tel" autocomplete="tel" required>
        <input class="inp" id="aW" type="password" placeholder="${mode === 'reg' ? 'Придумайте пароль (от 6 символов)' : 'Пароль'}" autocomplete="${mode === 'reg' ? 'new-password' : 'current-password'}" required>
        <button class="btn btn-neon btn-wide" id="aB">${mode === 'reg' ? 'Создать аккаунт' : 'Войти'}</button>
        <p class="form-err" id="aE"></p>
      </form>
      <p class="dim" style="font-size:13px">${mode === 'reg' ? 'Аккаунт привязан к номеру телефона. Пароль никому не сообщайте.' : 'Забыли пароль? Позвоните в клуб — администратор поможет восстановить доступ.'}</p>
    </div>`;
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

  // ---------- кабинет ----------
  function render() {
    const s = ME.balance_settings || {}; const presets = s.presets || [500, 1000, 2000, 3000];
    const pending = (ME.topups || []).filter(t => ['awaiting_payment', 'receipt_sent'].includes(t.status));
    box.innerHTML = `
      <div class="acc-head">
        <div><div class="kicker">Личный кабинет</div><h1 class="h2" style="font-size:clamp(26px,5vw,40px);margin:0">${esc(ME.name)}</h1><p class="muted" style="margin:4px 0 0">${fmtPhone(ME.phone)}</p></div>
        <button class="btn btn-sm btn-ghost" id="out">Выйти</button>
      </div>
      ${ME.frozen ? `<div class="note">⛔ Операции по балансу временно приостановлены${ME.frozen_reason ? ': ' + esc(ME.frozen_reason) : ''}. Свяжитесь с клубом.</div>` : ''}
      <div class="bal-card">
        <div class="muted" style="font-weight:700;letter-spacing:.12em;text-transform:uppercase;font-size:12px">Мой баланс</div>
        <div class="bal-amt">${rub(ME.balance)}</div>
        <a class="btn btn-neon btn-sm" href="/#room">Забронировать с баланса</a>
      </div>

      <section class="acc-sec" id="topSec">
        <h2>Пополнить баланс</h2>
        ${ME.frozen ? '<p class="muted">Пополнение недоступно, пока операции приостановлены.</p>' : `
        <div class="segs" id="amts">${presets.map(v => `<button data-a="${v}">${rub(v)}</button>`).join('')}<button data-a="custom">Своя сумма</button></div>
        <input class="inp" id="amtC" type="number" inputmode="numeric" min="${s.min_topup || 100}" max="${s.max_topup || 50000}" placeholder="Сумма, ₽ (от ${s.min_topup || 100} до ${(s.max_topup || 50000).toLocaleString('ru-RU')})" style="margin-top:8px;display:none">
        <button class="btn btn-neon btn-wide" id="tpGo" style="margin-top:12px" disabled>Выберите сумму</button>`}
        ${pending.map(topupCard).join('')}
      </section>

      <section class="acc-sec"><h2>История операций</h2>
        ${(ME.ops || []).length ? `<div class="ops">${ME.ops.map(o => `<div class="op"><div><b>${KIND[o.kind] || o.kind}</b><div class="dim" style="font-size:13px">${esc(o.description)}</div><div class="dim" style="font-size:12px">${fmtDT(o.at)}</div></div>
          <div style="text-align:right"><b class="${o.amount > 0 ? 'plus' : 'minus'}">${o.amount > 0 ? '+' : '−'}${rub(Math.abs(o.amount))}</b><div class="dim" style="font-size:12px">баланс ${rub(o.balance_after)}</div></div></div>`).join('')}</div>`
        : '<p class="muted">Операций пока нет.</p>'}
      </section>

      <section class="acc-sec"><h2>Мои брони</h2>
        ${(ME.bookings || []).length ? ME.bookings.map(b => `<div class="op"><div><b>${esc(b.equipment_name)}</b> <span class="dim" style="font-size:12px">${esc(b.code)}</span>
          <div class="dim" style="font-size:13px">${CZ.fmtRange(b.starts_at, b.ends_at)} · ${rub(b.total)} · ${b.payment_status === 'balance' ? 'оплачено с баланса' : 'перевод'}</div>
          <div style="font-size:13px">${esc(b.status_ru)}${b.refunded ? ` · возвращено ${rub(b.refunded)}` : ''}</div></div>
          </div></div>`).join('')
        : '<p class="muted">Броней, оформленных из аккаунта, пока нет.</p>'}
        <p class="dim" style="font-size:12px;margin-top:10px">Оплаченная и подтверждённая бронь не отменяется, деньги за неё не возвращаются. Вопросы — <a href="tel:+79285535252">+7 928 553-52-52</a>.</p>
      </section>`;
    $('#out').onclick = async () => { try { await call('client_logout'); } catch (e) {} setToken(''); authView(); };
    bindTopup(); bindPending();
    $$('[data-cancel]').forEach(b => b.onclick = async () => {
      const r = +b.dataset.refund;
      if (!confirm(`Отменить бронь ${b.dataset.cancel}?\nНа баланс вернётся ${r.toLocaleString('ru-RU')} ₽.`)) return;
      try { ME = await call('client_cancel_booking', { code: b.dataset.cancel }); toast(r ? `Бронь отменена, ${rub(r)} вернулись на баланс` : 'Бронь отменена', 'ok'); render(); } catch (e) { toast(e.message, 'err'); }
    });
  }

  function topupCard(t) {
    const pay = ME.payment || {};
    return `<div class="tp-card" data-tp="${t.id}">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><b>Пополнение ${esc(t.code)}</b><span class="chip">${TST[t.status]}</span></div>
      <div class="amount" style="font-size:34px;margin:6px 0">${rub(t.amount)}</div>
      ${t.status === 'awaiting_payment' ? `
        <p style="margin:0">Переведите <b>${rub(t.amount)}</b> · <b>${esc(pay.bank || 'Т-Банк')}</b> по номеру телефона:</p>
        <div class="pay-phone"><b>${esc(pay.phone || '')}</b><button class="btn btn-sm" data-copy="${esc((pay.phone || '').replace(/[^\d+]/g, ''))}">Скопировать номер</button></div>
        <label class="drop" style="margin-top:8px"><input type="file" accept="image/*,application/pdf" data-file="${t.id}"><b>📎 Загрузить чек</b><br><span class="muted" style="font-size:14px">Скриншот перевода или PDF</span></label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
          <a class="btn btn-sm btn-wa" target="_blank" rel="noopener" href="https://wa.me/${String((ME.notify || {}).whatsapp || '79285535252').replace(/\D/g, '')}?text=${encodeURIComponent(`Здравствуйте! Я пополнил баланс CHILL ZONE.\n\nЗаявка: ${t.code}\nИмя: ${ME.name}\nТелефон: ${fmtPhone(ME.phone)}\nСумма: ${rub(t.amount)}\n\nОтправляю чек`)}">Отправить чек в WhatsApp</a>
          <button class="btn btn-sm btn-ghost" data-tpcancel="${t.id}">Отменить заявку</button></div>`
      : `<p class="muted" style="margin:0">Чек получен. Деньги зачислятся на баланс, как только администратор проверит поступление.</p>`}
    </div>`;
  }
  function bindTopup() {
    const go = $('#tpGo'); if (!go) return; let amt = 0;
    const set = v => { amt = +v || 0; go.disabled = !(amt > 0); go.textContent = amt > 0 ? `Пополнить на ${rub(amt)}` : 'Выберите сумму'; };
    $('#amts').onclick = e => { const b = e.target.closest('[data-a]'); if (!b) return; $$('#amts button').forEach(x => x.classList.toggle('on', x === b));
      const c = $('#amtC'); if (b.dataset.a === 'custom') { c.style.display = ''; c.focus(); set(c.value); } else { c.style.display = 'none'; set(b.dataset.a); } };
    $('#amtC').oninput = e => set(Math.round(+e.target.value));
    go.onclick = async () => {
      go.disabled = true;
      try { await call('client_topup_create', { amount: amt }); ME = await call('client_me'); render(); toast('Заявка создана — переведите деньги и загрузите чек', 'ok'); setTimeout(() => { const c = $('.tp-card'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 100); }
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
  setInterval(async () => { if (!document.hidden && ME && token() && (ME.topups || []).some(t => t.status === 'receipt_sent')) { try { ME = await call('client_me'); render(); } catch (e) {} } }, 30000);
})();
