/* CHILL ZONE — главная: 3D-комната, выбор и бронирование */
(function () {
  const { $, $$, esc, rub, rpc, toast } = CZ;
  let DATA = null, room = null, hero = null, statusMap = {}, viewWhen = 'now';
  const S = { id: null, date: null, dur: 120, start: null, people: 5, student: false, busy: [], quote: null, qTimer: 0, loadingAv: false };

  CZ.header('/');
  $('#heroLogo').innerHTML = CZ.logoSVG('big') + '<div class="hero-word"><span>CHILL</span><span>ZONE</span></div>';

  // ---------- 3D ----------
  // На телефонах и слабых устройствах первый экран — заранее отрисованный кадр той же 3D-сцены
  // (одна живая 3D-комната на странице вместо двух).
  if (window.CZ_LITE) {
    $('#heroRoom').innerHTML = '<div class="hero-still"><img src="/img/hero-room.webp" alt="3D-сцена игровой комнаты CHILL ZONE" width="1200" height="1100" fetchpriority="high"></div>';
    hero = { setItems() {}, intro() {}, autoOrbit() {}, setStatus() {} };
  } else {
    hero = new Room3D($('#heroRoom'), { labels: false, interactive: false });
  }
  room = new Room3D($('#room3d'), { onSelect: id => openPanel(id) });

  async function load() {
    try {
      DATA = await rpc('get_public_data', {});
    } catch (e) {
      toast(e.message, 'err');
      $('#panel').innerHTML = '';
      return;
    }
    CZ.setTz(DATA.settings.timezone);
    const items = DATA.equipment;
    hero.setItems(items); room.setItems(items);
    hero.intro(); hero.autoOrbit();
    if (window.CZ_watchFps) setTimeout(() => CZ_watchFps(() => {
      // устройство не тянет полную графику — переключаем первый экран на готовый кадр
      if (hero.orbit) clearInterval(hero.orbit); if (hero.ro) hero.ro.disconnect();
      $('#heroRoom').innerHTML = '<div class="hero-still"><img src="/img/hero-room.webp" alt="3D-сцена игровой комнаты CHILL ZONE"></div>';
      $('#heroRoom').classList.remove('room3d');
    }), 3000);
    S.date = CZ.localDateStr(new Date());
    S.people = (DATA.settings.room && DATA.settings.room.base_people) || 5;
    const durs = DATA.settings.durations || [60, 120, 180, 240]; S.dur = durs.includes(120) ? 120 : durs[0];
    buildWhenSelect(); computeStatus(); renderQuick(); renderFun(); renderPromos(); renderContacts();
    CZ.footer(DATA.settings.contacts);
    CZ.reveal();
    // ссылка вида /#book=pc01
    const m = location.hash.match(/book=([\w-]+)/); if (m) pick(m[1]);
  }

  // ---------- статусы ----------
  function itemStatus(it, busySet, roomBooked) {
    if (it.status !== 'ok' || !it.bookable && it.kind !== 'tv') return 'off';
    if (it.kind === 'room') return (busySet.size || roomBooked) ? 'busy' : 'free';
    if (it.kind === 'tv') { const ps = DATA.equipment.find(e => e.id === it.link_to); return ps ? itemStatus(ps, busySet, roomBooked) : 'free'; }
    return (busySet.has(it.id) || roomBooked) ? 'busy' : 'free';
  }
  async function computeStatus() {
    let busy = new Set(), roomBooked = false;
    if (viewWhen === 'now') {
      DATA.equipment.forEach(e => { if (e.busy_now && e.kind !== 'room') busy.add(e.id); });
    } else {
      const from = new Date(viewWhen), to = new Date(from.getTime() + 60 * 60000);
      try { const r = await rpc('get_occupancy', { from: from.toISOString(), to: to.toISOString() }); r.busy.forEach(x => busy.add(x)); roomBooked = r.room_booked; } catch (e) { toast(e.message, 'err'); }
    }
    statusMap = {}; DATA.equipment.forEach(it => statusMap[it.id] = itemStatus(it, busy, roomBooked));
    room.setStatus(statusMap); hero.setStatus(statusMap); renderQuick(); renderFun(true);
  }
  function buildWhenSelect() {
    const sel = $('#viewWhen'); const now = new Date(); const opts = [['now', 'Сейчас']];
    const start = new Date(Math.ceil(now.getTime() / 3600000) * 3600000);
    for (let i = 0; i < 36; i++) { const d = new Date(start.getTime() + i * 3600000); opts.push([d.toISOString(), (CZ.localDateStr(d) === CZ.localDateStr(now) ? 'Сегодня ' : CZ.fmtDate(d) + ', ') + CZ.localTime(d)]); }
    sel.innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
    sel.onchange = () => { viewWhen = sel.value; computeStatus(); };
  }
  setInterval(async () => { if (!DATA || document.hidden) return; try { const d = await rpc('get_public_data', {}); DATA.equipment = d.equipment; if (viewWhen === 'now') computeStatus(); } catch (e) {} }, 60000);

  // ---------- быстрый список ----------
  function renderQuick() {
    if (!DATA) return;
    $('#quick').innerHTML = DATA.equipment.filter(e => e.kind !== 'tv').map(e => `<button data-pick="${e.id}" data-st="${statusMap[e.id] || 'free'}" class="${S.id === e.id ? 'on' : ''}"><i></i>${esc(e.name)}</button>`).join('');
  }
  document.addEventListener('click', e => {
    const p = e.target.closest('[data-pick]'); if (p) { e.preventDefault(); pick(p.dataset.pick); }
    const g = e.target.closest('[data-go]');
    if (g) { e.preventDefault(); $('#room').scrollIntoView({ behavior: 'smooth' }); if (g.dataset.go === 'tour') setTimeout(() => { closePanel(); room.intro(); }, 600); }
  });
  $('#heroRoom').addEventListener('click', () => $('#room').scrollIntoView({ behavior: 'smooth' }));
  function pick(id) {
    $('#room').scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => room.focus(id), 450);
  }
  $('#btnWhole').onclick = () => room.focus('room');
  $('#btnReset').onclick = () => closePanel();
  $('#zIn').onclick = () => room.zoomBy(1.2); $('#zOut').onclick = () => room.zoomBy(1 / 1.2);
  $('#scrim').onclick = () => { if (Date.now() - (S.openedAt || 0) > 500) closePanel(); };
  addEventListener('keydown', e => { if (e.key === 'Escape' && S.id) closePanel(); });

  // ---------- панель ----------
  const isMobile = () => innerWidth <= 760;
  function placeCam() {
    if (!S.id) return room.setOffset(0, 0);
    if (isMobile()) room.setOffset(0, -$('#roomWrap').clientHeight * 0.36); else room.setOffset(-Math.min(215, $('#roomWrap').clientWidth * 0.25), 0);
  }
  async function openPanel(id) {
    const it = DATA.equipment.find(e => e.id === id); if (!it) return;
    if (it.kind === 'tv' && it.link_to) { /* телевизор показываем с карточкой PS, но камера на ТВ */ }
    S.id = id; S.start = null; S.quote = null; S.busy = []; S.openedAt = Date.now();
    $('#btnReset').hidden = false; renderQuick(); placeCam();
    const p = $('#panel');
    if (DATA.features && DATA.features.balance && canBook(it)) await loadClient();
    if (S.id !== id) return;
    p.innerHTML = panelHTML(it); p.classList.add('open'); p.scrollTop = 0;
    if (isMobile()) { $('#scrim').classList.add('on'); $('#mobCta').classList.add('hide'); scrollTo({ top: $('#roomWrap').getBoundingClientRect().top + scrollY - 70, behavior: 'smooth' }); }
    $('.bk-close', p).onclick = closePanel; $('.bk-back', p).onclick = closePanel;
    const src = await CZP.photoSrc(it); if (src && S.id === id) $('.bk-head', p).insertAdjacentHTML('afterbegin', `<img src="${src}" alt="${esc(it.name)}">`);
    else if (!src) $('.bk-head', p).insertAdjacentHTML('afterbegin', CZP.artHTML(it));
    const goPs = $('[data-open]', p); if (goPs) goPs.onclick = () => room.focus(goPs.dataset.open);
    if (canBook(it)) { bindBooking(it); loadAvailability(); }
  }
  function closePanel() {
    S.id = null; $('#panel').classList.remove('open'); $('#scrim').classList.remove('on'); $('#mobCta').classList.remove('hide');
    $('#btnReset').hidden = true; room.reset(); room.setOffset(0, 0); renderQuick();
  }
  const canBook = it => it.bookable && it.status === 'ok' && it.price_per_hour != null && it.kind !== 'tv';
  const KIND_RU = { pc: 'Игровой компьютер', ps: 'PlayStation-зона', wheel: 'Гоночный симулятор', vr: 'Виртуальная реальность', tennis: 'Настольная игра', airhockey: 'Настольная игра', foosball: 'Настольная игра', tv: 'PlayStation-зона', room: 'Вся комната', other: 'Развлечение' };

  function panelHTML(it) {
    const st = statusMap[it.id] || 'free';
    const badge = st === 'off' ? '<span class="st-badge off">Временно недоступно</span>' : st === 'busy' ? `<span class="st-badge busy">${viewWhen === 'now' ? 'Сейчас занято' : 'Занято в это время'}</span>` : `<span class="st-badge">${viewWhen === 'now' ? 'Сейчас свободно' : 'Свободно в это время'}</span>`;
    const roomS = DATA.settings.room || {};
    let body = `<div class="bk-price">${it.price_per_hour != null ? `<b>${rub(it.price_per_hour)}</b><span class="muted">/ час${it.kind === 'room' ? `, до ${roomS.base_people || 5} человек` : ''}</span>` : '<b style="font-size:20px">Цена скоро</b>'}</div>
      ${badge}${CZ.maxPeople(it, DATA.settings) ? `<span class="ppl-max">👥 Максимум ${CZ.people(CZ.maxPeople(it, DATA.settings))}</span>` : ''}
      <p class="muted" style="margin-top:12px">${esc(it.description)}</p>
      ${it.features && it.features.length ? `<div class="bk-feat">${it.features.map(f => `<span>${esc(f)}</span>`).join('')}</div>` : ''}`;
    if (it.kind === 'room' && roomS.extra_person_price && (roomS.max_people || 20) > (roomS.base_people || 5)) body += `<div class="note info">Каждый дополнительный человек сверх ${roomS.base_people} — ${rub(roomS.extra_person_price)}/час. На время брони всей комнаты все устройства закрываются для других гостей.<br>В расписании ниже показано только то время, когда свободно <b>всё</b> оборудование.</div>`;
    let foot = '';
    if (it.kind === 'tv') {
      body += `<div class="note info">Телевизор 75″ находится в PlayStation-зоне и бронируется вместе с PlayStation.</div>`;
      foot = `<button class="btn btn-neon btn-wide" data-open="${esc(it.link_to)}">Выбрать PlayStation</button>`;
    } else if (it.status !== 'ok' || !it.bookable) {
      body += `<div class="note">Оборудование временно недоступно для бронирования${it.status_note ? ': ' + esc(it.status_note) : '.'}</div>`;
    } else if (it.price_per_hour == null) {
      const c = DATA.settings.contacts;
      body += `<div class="note info">Стоимость скоро появится на сайте. Чтобы поиграть — позвоните нам, и мы всё организуем.</div>`;
      foot = `<a class="btn btn-neon btn-wide" href="tel:${CZ.telHref(c.phone)}">Позвонить ${esc(c.phone)}</a>`;
    } else {
      body += bookingFormHTML(it);
      foot = `<div class="form-err" id="bkErr"></div><button class="btn btn-neon btn-wide" id="bkSubmit" disabled>Выберите время</button>`;
    }
    return `<div class="bk-head"><button class="bk-back">← Общий вид</button><button class="bk-close" aria-label="Закрыть">✕</button>
        <div class="ttl"><span class="chip">${CZ.KIND_ICON[it.kind] || ''} ${KIND_RU[it.kind] || ''}</span><h3>${esc(it.name)}</h3></div></div>
      <div class="bk-body">${body}</div>${foot ? `<div class="bk-foot">${foot}</div>` : ''}`;
  }

  function bookingFormHTML(it) {
    const s = DATA.settings; const durs = s.durations || [60, 120, 180, 240]; const cd = s.custom_duration || {};
    const horizon = Math.min(+s.booking_horizon_days || 30, 30);
    const today = CZ.localDateStr(new Date());
    let days = ''; for (let i = 0; i < horizon; i++) { const d = CZ.addDays(today, i); days += `<button data-day="${d}" class="${d === S.date ? 'on' : ''}"><small>${i === 0 ? 'сег' : i === 1 ? 'завт' : CZ.wdOf(d)}</small><b>${+d.slice(8)}</b><small>${CZ.fmtDateStr(d).split(' ')[1].slice(0, 3)}</small></button>`; }
    let segs = durs.map(m => `<button data-dur="${m}" class="${m === S.dur ? 'on' : ''}">${CZ.fmtDur(m)}</button>`).join('');
    if (cd.enabled) segs += `<button data-dur="custom" class="${!durs.includes(S.dur) ? 'on' : ''}">Другое</button>`;
    let customSel = '';
    if (cd.enabled) { let o = ''; for (let m = cd.min || 30; m <= (cd.max || 720); m += 30) o += `<option value="${m}" ${m === S.dur ? 'selected' : ''}>${CZ.fmtDur(m)}</option>`; customSel = `<select class="inp" id="durCustom" style="margin-top:8px;${durs.includes(S.dur) ? 'display:none' : ''}">${o}</select>`; }
    const roomS = s.room || {};
    const people = it.kind === 'room' ? `<label class="lbl">Количество человек</label><div class="stepper"><button type="button" data-ppl="-1">−</button><b id="ppl">${S.people}</b><button type="button" data-ppl="1">+</button><span class="muted" style="font-size:13px">${(roomS.max_people || 20) > (roomS.base_people || 5) ? `до ${roomS.base_people || 5} — в базовой цене` : `максимум ${CZ.people(roomS.max_people)}`}</span></div>` : '';
    const stud = +s.student_discount_percent > 0 ? `<label class="check"><input type="checkbox" id="stud" ${S.student ? 'checked' : ''}> Я студент — скидка ${s.student_discount_percent}% (покажу студенческий билет)</label>` : '';
    return `<label class="lbl">Дата</label><div class="days" id="days">${days}</div>
      <label class="lbl">Продолжительность</label><div class="segs" id="durs">${segs}</div>${customSel}
      <div id="bonusNote"></div>
      <label class="lbl">Время начала <span class="dim" style="letter-spacing:0;text-transform:none;font-weight:600">· зелёное — свободно</span></label><div class="slots" id="slots"><div class="slots-empty">Загружаю свободное время…</div></div>
      ${people}
      <div id="nightBox"></div>
      ${needAcc() ? (CLIENT ? `<label class="lbl">Бронь на</label><div class="note info" style="margin:0">👤 <b>${esc(CLIENT.name)}</b> · ${esc(fmtPh(CLIENT.phone))} <a href="/account" style="margin-left:6px">Личный кабинет →</a></div>` : `<div class="note info">👤 Чтобы забронировать, <b>зарегистрируйтесь в личном кабинете</b> — это займёт минуту. Выбранное оборудование откроется снова.</div>`) : ''}
      <label class="lbl" ${needAcc() ? 'hidden' : ''}>Ваши данные</label>
      <div class="stack" ${needAcc() ? 'hidden' : ''}><input class="inp" id="nm" placeholder="Имя" autocomplete="name" maxlength="60" value="${esc(localStorage.getItem('cz_name') || '')}">
      <input class="inp" id="ph" placeholder="+7 (___) ___-__-__" inputmode="tel" autocomplete="tel" value="${esc(localStorage.getItem('cz_phone') || '')}"></div>
      ${stud}
      <div id="sumBox"></div>
      ${DATA.features && DATA.features.balance ? `<label class="lbl">Способ оплаты</label><div class="pay-choice" id="payCh">
        <label class="${S.pay !== 'balance' ? 'on' : ''}"><input type="radio" name="pm" value="transfer" ${S.pay !== 'balance' ? 'checked' : ''}>💸 Переводом<small>Т-Банк, по номеру телефона</small></label>
        <label class="${S.pay === 'balance' ? 'on' : ''}"><input type="radio" name="pm" value="balance" ${S.pay === 'balance' ? 'checked' : ''}>💳 С баланса<small id="balInfo">${CLIENT ? 'доступно ' + rub(avail()) : 'нужен вход в кабинет'}</small></label></div><div id="payNote"></div>` : ''}`;
  }

  function bindBooking(it) {
    const p = $('#panel');
    $('#days', p).onclick = e => { const b = e.target.closest('[data-day]'); if (!b) return; S.date = b.dataset.day; S.start = null; $$('#days button', p).forEach(x => x.classList.toggle('on', x === b)); loadAvailability(); };
    $('#durs', p).onclick = e => {
      const b = e.target.closest('[data-dur]'); if (!b) return; $$('#durs button', p).forEach(x => x.classList.toggle('on', x === b));
      const cs = $('#durCustom', p);
      if (b.dataset.dur === 'custom') { cs.style.display = ''; S.dur = +cs.value; } else { if (cs) cs.style.display = 'none'; S.dur = +b.dataset.dur; }
      renderSlots(); requote();
    };
    const cs = $('#durCustom', p); if (cs) cs.onchange = () => { S.dur = +cs.value; renderSlots(); requote(); };
    $$('[data-ppl]', p).forEach(b => b.onclick = () => { const max = (DATA.settings.room || {}).max_people || 20; S.people = Math.max(1, Math.min(max, S.people + +b.dataset.ppl)); $('#ppl', p).textContent = S.people; requote(); });
    const st = $('#stud', p); if (st) st.onchange = () => { S.student = st.checked; requote(); };
    const ph = $('#ph', p); ph.oninput = () => { ph.value = maskPhone(ph.value); validate(); };
    $('#nm', p).oninput = validate;
    $('#bkSubmit', p).onclick = () => submit(it);
    const pc = $('#payCh', p);
    if (pc) {
      pc.onchange = e => { S.pay = e.target.value; $$('label', pc).forEach(l => l.classList.toggle('on', l.querySelector('input').checked)); payNote(); validate(); };
      loadClient().then(() => { const bi = $('#balInfo'); if (bi) bi.textContent = CLIENT ? 'доступно ' + rub(avail()) : 'нужен вход в кабинет'; if (CLIENT) { if (!$('#nm').value || needAcc()) $('#nm').value = CLIENT.name; if (needAcc()) $('#ph').value = fmtPh(CLIENT.phone); } payNote(); validate(); });
    }
    renderBonusNote(it);
  }
  // ---------- личный кабинет ----------
  const avail = () => CLIENT ? (CLIENT.available ?? CLIENT.balance) : 0;
  const needAcc = () => !!(DATA.features && DATA.features.account_required);
  const fmtPh = p => { const d = String(p || ''); return d.length === 11 ? `+${d[0]} ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}` : d; };
  const goAccount = id => { location.href = '/account?ret=' + encodeURIComponent('/#book=' + id); };
  let CLIENT = null, clientLoaded = false;
  const ctoken = () => { try { return localStorage.getItem('cz_ctoken') || ''; } catch (e) { return ''; } };
  async function loadClient(force) {
    if (clientLoaded && !force) return CLIENT; clientLoaded = true;
    if (!ctoken()) return CLIENT = null;
    try { CLIENT = await rpc('client_me', { ctoken: ctoken() }); } catch (e) { CLIENT = null; if (e.code === 'CLIENT_AUTH_REQUIRED') try { localStorage.removeItem('cz_ctoken'); } catch (x) {} }
    return CLIENT;
  }
  function payNote() {
    const n = $('#payNote'); if (!n) return;
    if (S.pay !== 'balance') return n.innerHTML = '';
    const back = encodeURIComponent('/#room');
    if (!CLIENT) return n.innerHTML = `<div class="note info">Чтобы оплатить с баланса, <a href="/account?ret=${back}"><b>войдите в личный кабинет</b></a> — это займёт минуту.</div>`;
    if (CLIENT.frozen) return n.innerHTML = `<div class="note">Операции по балансу приостановлены. Выберите оплату переводом.</div>`;
    const tot = S.quote ? S.quote.total : 0;
    n.innerHTML = tot && avail() < tot
      ? `<div class="note">Доступно ${rub(avail())} — не хватает ${rub(tot - avail())}. <a href="/account"><b>Пополнить баланс</b></a> или выберите оплату переводом.</div>`
      : `<div class="note info">${tot ? rub(tot) : 'Стоимость'} спишется с баланса <b>только после подтверждения администратором</b>. Подтверждённую бронь отменить нельзя, деньги не возвращаются.</div>`;
  }
  function maskPhone(v) {
    let d = v.replace(/\D/g, ''); if (d.startsWith('8')) d = '7' + d.slice(1); if (d && !d.startsWith('7')) d = '7' + d; d = d.slice(0, 11);
    if (!d) return '';
    let r = '+7'; if (d.length > 1) r += ' (' + d.slice(1, 4); if (d.length >= 4) r += ')'; if (d.length > 4) r += ' ' + d.slice(4, 7); if (d.length > 7) r += '-' + d.slice(7, 9); if (d.length > 9) r += '-' + d.slice(9, 11);
    return r;
  }

  // бонусное время по акции (для проверки занятости; окончательно считает сервер)
  function bonusFor(it, mins) {
    let b = 0; (DATA.promotions || []).filter(p => p.type === 'bonus_time').forEach(p => {
      const ap = (p.config && p.config.applies_to) || 'all'; if (!['all', 'kind:' + it.kind, 'id:' + it.id].includes(ap)) return;
      ((p.config && p.config.tiers) || []).forEach(t => { if (mins >= t.min_minutes && t.bonus_minutes > b) b = t.bonus_minutes; });
    });
    return b;
  }
  function renderBonusNote(it) {
    const b = bonusFor(it, S.dur); const el = $('#bonusNote'); if (!el) return;
    el.innerHTML = b ? `<div class="note info" style="margin:10px 0 0">🎁 Акция: +${CZ.fmtDur(b)} бесплатно к вашему времени</div>` : '';
  }

  async function loadAvailability() {
    const id = S.id, date = S.date; const box = $('#slots'); if (!box) return;
    box.innerHTML = '<div class="slots-empty">Загружаю свободное время…</div>';
    try {
      const r = await rpc('get_availability', { equipment_id: id, date });
      if (S.id !== id || S.date !== date) return;
      S.busy = r.busy.map(b => [new Date(b.from).getTime(), new Date(b.to).getTime()]);
      S.serverNow = new Date(r.server_now).getTime();
      renderSlots();
    } catch (e) { box.innerHTML = `<div class="slots-empty">${esc(e.message)}</div>`; }
  }

  // расписание работы (повторяет серверную проверку)
  function tm(s) { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); }
  function isOpen(d, it) { return openBy(DATA.settings.work_hours, d) && (!it || !it.schedule || openBy(it.schedule, d)); }
  function openBy(wh, d) {
    if (!wh || wh.always_open !== false && wh.always_open !== 'false') return true;
    const p = CZ.parts(d); const t = p.h * 60 + p.mi; const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }; const dw = map[p.wd]; const pd = dw === 1 ? 7 : dw - 1;
    const today = wh.days[dw], prev = wh.days[pd];
    if (today && !today.closed) { const o = tm(today.open), c = tm(today.close); if (o < c && t >= o && t < c) return true; if (o >= c && t >= o) return true; }
    if (prev && !prev.closed) { const o = tm(prev.open), c = tm(prev.close); if (o >= c && t < c) return true; }
    return false;
  }
  function inNight(d) {
    const n = DATA.settings.night; if (!n || !n.enabled) return false;
    const p = CZ.parts(d); const t = p.h * 60 + p.mi; const f = tm(n.start), to = tm(n.end);
    return f < to ? (t >= f && t < to) : (t >= f || t < to);
  }

  function renderSlots() {
    const it = DATA.equipment.find(e => e.id === S.id); const box = $('#slots'); if (!box || !it) return;
    renderBonusNote(it);
    const now = S.serverNow ? Math.max(Date.now(), S.serverNow) : Date.now();
    const occ = (S.dur + bonusFor(it, S.dur)) * 60000;
    let html = '', free = 0;
    for (let m = 0; m < 24 * 60; m += 30) {
      const t = CZ.zoned(S.date, CZ.pad(Math.floor(m / 60)) + ':' + CZ.pad(m % 60)); const a = t.getTime(), b = a + occ;
      const past = a < now - 5 * 60000;
      let ok = !past; if (ok) for (let k = 0; k < S.dur; k += 30) if (!isOpen(new Date(a + k * 60000), it)) { ok = false; break; }
      const clash = ok && S.busy.some(([x, y]) => a < y && b > x);
      if (past) continue;
      const lbl = CZ.localTime(t);
      html += `<button data-t="${t.toISOString()}" ${ok && !clash ? '' : 'disabled'} class="${S.start === t.toISOString() ? 'on' : ''} ${!ok ? 'past' : ''}" title="${clash ? 'Занято' : !ok ? 'Клуб закрыт' : 'Свободно'}">${lbl}</button>`;
      if (ok && !clash) free++;
    }
    box.innerHTML = html || '<div class="slots-empty">На эту дату время уже прошло — выберите другой день.</div>';
    if (html && !free) box.insertAdjacentHTML('afterbegin', '<div class="slots-empty">Свободного времени на эту дату нет. Выберите другую дату или другое оборудование.</div>');
    if (S.start && !$$('#slots button:not(:disabled)').some(b => b.dataset.t === S.start)) S.start = null;
    box.onclick = e => { const b = e.target.closest('button[data-t]'); if (!b || b.disabled) return; S.start = b.dataset.t; $$('#slots button').forEach(x => x.classList.toggle('on', x === b)); requote(); };
    requote();
  }

  function renderNight() {
    const box = $('#nightBox'); if (!box) return;
    const n = DATA.settings.night; let night = false;
    if (S.start) for (let k = 0; k < S.dur; k += 30) if (inNight(new Date(new Date(S.start).getTime() + k * 60000))) { night = true; break; }
    const keep = $('#age') && $('#age').checked;
    box.innerHTML = night ? `<div class="note">🌙 <b>Ночное бронирование.</b> ${esc(n.rules || '')}${n.prepay ? `<br>Предоплата: <b>${rub(n.prepay)}</b>, остальное — на месте.` : ''}</div>
      <label class="check"><input type="checkbox" id="age" ${keep ? 'checked' : ''}> Мне есть ${n.min_age || 18} лет, с правилами ночного бронирования согласен</label>` : '';
    const a = $('#age'); if (a) a.onchange = validate;
    S.night = night;
  }

  function requote() {
    renderNight(); validate();
    const box = $('#sumBox'); if (!box) return;
    if (!S.start) { box.innerHTML = ''; S.quote = null; validate(); return; }
    clearTimeout(S.qTimer);
    S.qTimer = setTimeout(async () => {
      const req = { equipment_id: S.id, starts_at: S.start, paid_minutes: S.dur, people: S.people, is_student: S.student };
      try {
        const q = await rpc('quote_booking', req); if (S.start !== req.starts_at || S.id !== req.equipment_id) return;
        S.quote = q; box.innerHTML = sumHTML(q); validate();
      } catch (e) { box.innerHTML = `<div class="form-err">${esc(e.message)}</div>`; }
    }, 150);
  }
  function sumHTML(q) {
    const lines = q.lines.map(l => `<div class="ln"><span>${esc(l.label)} · ${CZ.fmtDur(l.minutes)} × ${rub(l.rate)}/ч</span><span>${rub(Math.round(l.rate * l.minutes / 60))}</span></div>`).join('');
    return `<div class="sum">
      <div class="ln"><span>${CZ.fmtDate(q.starts_at)} · начало <b>${CZ.localTime(q.starts_at)}</b> · окончание <b>${CZ.localTime(q.ends_at)}</b></span></div>
      ${lines}
      ${q.extra_sum ? `<div class="ln"><span>Доп. гости: ${q.extra_people} × ${rub(q.extra_person_price)}/ч</span><span>${rub(q.extra_sum)}</span></div>` : ''}
      ${q.discount_sum ? `<div class="ln bonus"><span>${esc(q.discount_label)} −${q.discount_percent}%</span><span>−${rub(q.discount_sum)}</span></div>` : ''}
      ${q.bonus_minutes ? `<div class="ln bonus"><span>🎁 ${esc(q.bonus_label || 'Бонус')}</span><span>+${CZ.fmtDur(q.bonus_minutes)}</span></div>` : ''}
      <div class="ln tot"><span>Итого</span><b>${rub(q.total)}</b></div>
      ${q.due_now !== q.total ? `<div class="ln"><span>Предоплата сейчас</span><span>${rub(q.due_now)}</span></div>` : ''}
    </div>`;
  }
  function validate() {
    const btn = $('#bkSubmit'); if (!btn) return;
    const nm = ($('#nm') || {}).value || '', ph = (($('#ph') || {}).value || '').replace(/\D/g, '');
    let msg = '';
    if (needAcc() && !CLIENT) { btn.disabled = false; btn.textContent = 'Зарегистрируйтесь в личном кабинете'; return; }
    if (!S.start) msg = 'Выберите время';
    else if (!S.quote) msg = 'Считаю стоимость…';
    else if (nm.trim().length < 2) msg = 'Введите имя';
    else if (ph.length < 11) msg = 'Введите телефон';
    else if (S.night && !($('#age') || {}).checked) msg = 'Подтвердите возраст';
    else if (S.pay === 'balance' && $('#payCh') && !CLIENT) msg = 'Войдите, чтобы оплатить с баланса';
    else if (S.pay === 'balance' && $('#payCh') && avail() < S.quote.total) msg = 'Недостаточно средств на балансе';
    if ($('#payCh')) payNote();
    btn.disabled = !!msg; btn.textContent = msg || (S.pay === 'balance' && $('#payCh') ? `Отправить заявку · с баланса ${rub(S.quote.total)}` : `Отправить заявку · ${rub(S.quote.total)}`);
  }

  async function submit(it) {
    const btn = $('#bkSubmit'); const err = $('#bkErr'); err.textContent = '';
    if (needAcc() && !CLIENT) return goAccount(it.id);
    btn.disabled = true; btn.textContent = 'Оформляю…';
    const name = $('#nm').value.trim(), phone = $('#ph').value;
    try {
      const b = await rpc('create_booking', { equipment_id: it.id, starts_at: S.start, paid_minutes: S.dur, people: S.people, is_student: S.student,
        name, phone, age_confirmed: !!($('#age') && $('#age').checked),
        ...(ctoken() ? { ctoken: ctoken() } : {}), pay_method: S.pay === 'balance' && $('#payCh') ? 'balance' : 'transfer' });
      try { localStorage.setItem('cz_name', name); localStorage.setItem('cz_phone', phone); } catch (e) {}
      CZ.saveMyBooking(b);
      location.href = `/booking?c=${encodeURIComponent(b.code)}#t=${b.token}`;
    } catch (e) {
      err.textContent = e.message; btn.disabled = false; validate();
      if (e.code === 'SLOT_TAKEN') { S.start = null; loadAvailability(); }
      if (e.code === 'INSUFFICIENT_FUNDS') { err.innerHTML = `${esc(e.message)} <a href="/account"><b>Пополнить баланс →</b></a>`; loadClient(true).then(validate); }
      if (e.code === 'CLIENT_AUTH_REQUIRED' || e.code === 'ACCOUNT_REQUIRED') { CLIENT = null; try { localStorage.removeItem('cz_ctoken'); } catch (x) {} if (needAcc()) return goAccount(it.id); validate(); }
    }
  }

  // адаптивные размеры фото клуба
  const ss = u => /^\/img\/[\w-]+\.webp$/.test(u || '') ? ` srcset="${u.replace('.webp', '-640.webp')} 640w, ${u} 1200w" sizes="(max-width:760px) 92vw, 300px" decoding="async"` : '';
  // ---------- развлечения ----------
  async function renderFun(statusOnly) {
    if (!DATA) return;
    const g = $('#funGrid');
    if (statusOnly && g.children.length) {
      $$('[data-st-for]', g).forEach(el => { const s = statusMap[el.dataset.stFor] || 'free'; el.className = 'st-badge ' + (s === 'free' ? '' : s); el.textContent = s === 'off' ? 'Недоступно' : s === 'busy' ? 'Занято' : 'Свободно'; });
      $$('[data-pc]', g).forEach(el => el.dataset.st = statusMap[el.dataset.pc] || 'free');
      return;
    }
    const eq = DATA.equipment.filter(e => !['tv', 'room'].includes(e.kind));
    const pcs = eq.filter(e => e.kind === 'pc'), rest = eq.filter(e => e.kind !== 'pc');
    let html = '';
    if (pcs.length) {
      const p0 = pcs[0]; const prices = [...new Set(pcs.map(p => p.price_per_hour))];
      html += `<article class="fun rv"><div class="ph"><img src="${esc(p0.photo_url || '/img/pcs.webp')}"${ss(p0.photo_url || '/img/pcs.webp')} alt="Игровые компьютеры" loading="lazy"><span class="chip tag">🖥️ ${pcs.length} компьютеров</span></div>
        <div class="body"><h3>Игровые компьютеры</h3><p>${esc(p0.description)}</p>
        <div class="room-quick" style="flex-wrap:wrap;padding:6px 0">${pcs.map(p => `<button data-pick="${p.id}" data-pc="${p.id}" data-st="${statusMap[p.id] || 'free'}"><i></i>${esc(p.name)}</button>`).join('')}</div>
        <div class="foot"><span class="price">${prices.length === 1 ? CZP.priceLabel(p0) : 'от ' + rub(Math.min(...prices.filter(x => x != null)))}</span><button class="btn btn-sm btn-neon" data-pick="${p0.id}">Выбрать</button></div></div></article>`;
    }
    for (const e of rest) {
      html += `<article class="fun rv"><div class="ph" data-ph="${e.id}">${e.photo_url ? `<img src="${esc(e.photo_url)}"${ss(e.photo_url)} alt="${esc(e.name)}" loading="lazy">` : CZP.artHTML(e)}<span class="chip tag">${CZ.KIND_ICON[e.kind] || ''} <span data-st-for="${e.id}" class="st-badge ${statusMap[e.id] === 'free' ? '' : statusMap[e.id] || ''}">${statusMap[e.id] === 'busy' ? 'Занято' : statusMap[e.id] === 'off' ? 'Недоступно' : 'Свободно'}</span></span></div>
        <div class="body"><h3>${esc(e.name)}</h3><p>${esc(e.description)}</p>${e.max_players ? `<span class="ppl-max sm">👥 Максимум ${CZ.people(e.max_players)}</span>` : ''}
        <div class="foot"><span class="price">${CZP.priceLabel(e)}</span><button class="btn btn-sm ${e.price_per_hour != null ? 'btn-neon' : ''}" data-pick="${e.id}">Выбрать</button></div></div></article>`;
    }
    g.innerHTML = html;
    // загруженные админом фото
    eq.filter(e => e.has_photo).forEach(async e => { const s = await CZP.photoSrc(e); const ph = $(`[data-ph="${e.id}"]`, g); if (s && ph) { const im = ph.querySelector('img,.ph-art'); if (im) im.outerHTML = `<img src="${s}" alt="${esc(e.name)}">`; } });
    const r = DATA.equipment.find(e => e.kind === 'room');
    if (r) { $('#roomCtaPrice').textContent = r.price_per_hour != null ? rub(r.price_per_hour) : 'Цена скоро'; const rs = DATA.settings.room; $('#roomCtaText').textContent = r.description + (rs ? ((rs.max_people || 20) > (rs.base_people || 5) ? ` До ${rs.base_people} человек в базовой цене, каждый следующий — ${rub(rs.extra_person_price)}/час.` : ` Максимум ${CZ.people(rs.max_people)}.`) : ''); }
    else $('#roomCta').remove();
    CZ.reveal();
  }
  function renderPromos() { $('#promoGrid').innerHTML = CZP.promoCards((DATA.promotions || []).slice(0, 3)); }
  function renderContacts() { $('#contactsBox').innerHTML = CZP.contactsBlock(DATA.settings.contacts); }

  addEventListener('resize', () => placeCam());
  addEventListener('cz-intro-done', () => { try { hero.intro(); } catch (e) {} });
  const mob = $('#mobCta'); let roomVis = false;
  new IntersectionObserver(es => { roomVis = es[0].isIntersecting; onScroll(); }, { threshold: .25 }).observe($('#roomWrap'));
  const onScroll = () => { if (!S.id) mob.classList.toggle('hide', roomVis || scrollY < innerHeight * 0.8 || (document.querySelector('.site-footer') && document.querySelector('.site-footer').getBoundingClientRect().top < innerHeight)); };
  addEventListener('scroll', onScroll, { passive: true }); onScroll();
  load();
})();
