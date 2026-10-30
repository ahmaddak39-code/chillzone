/* Страницы: цены, акции, контакты, мои брони */
(function () {
  const { $, esc, rub, rpc } = CZ;
  const page = document.body.dataset.page;
  CZ.header({ prices: '/prices', promo: '/promo', contacts: '/contacts' }[page] || '');
  let D = null;
  (async () => {
    if (page !== 'my') { try { D = await rpc('get_public_data', {}); CZ.setTz(D.settings.timezone); } catch (e) { CZ.toast(e.message, 'err'); } }
    CZ.footer(D && D.settings.contacts);
    if (page === 'prices') prices();
    if (page === 'promo') $('#content').innerHTML = CZP.promoCards(D ? D.promotions : []);
    if (page === 'contacts') $('#content').innerHTML = CZP.contactsBlock(D ? D.settings.contacts : null);
    if (page === 'my') my();
    CZ.reveal();
  })();

  const DAYS = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
  function prices() {
    if (!D) return;
    const s = D.settings, eq = D.equipment.filter(e => e.kind !== 'tv');
    const room = eq.find(e => e.kind === 'room');
    const pcs = eq.filter(e => e.kind === 'pc');
    const rows = [];
    if (room) rows.push([`🌐 ${esc(room.name)}, ${(s.room.max_people || 20) > s.room.base_people ? 'до ' + CZ.people(s.room.base_people) : 'максимум ' + CZ.people(s.room.max_people)}`, room.price_per_hour != null ? rub(room.price_per_hour) + ' / час' : null]);
    if (room && s.room.extra_person_price && (s.room.max_people || 20) > s.room.base_people) rows.push(['👥 Дополнительный человек', rub(s.room.extra_person_price) + ' / час']);
    const pp = [...new Set(pcs.map(p => p.price_per_hour))];
    if (pcs.length) rows.push([`🖥️ Игровой компьютер (${pcs.map(p => esc(p.name)).join(', ')})`, pp.length === 1 && pp[0] != null ? rub(pp[0]) + ' / час' : pp.some(x => x != null) ? 'от ' + rub(Math.min(...pp.filter(x => x != null))) + ' / час' : null]);
    eq.filter(e => !['room', 'pc'].includes(e.kind)).forEach(e => rows.push([`${CZ.KIND_ICON[e.kind] || ''} ${esc(e.name)}${e.max_players > 1 ? ' · максимум ' + CZ.people(e.max_players) : ''}`, e.price_per_hour != null ? rub(e.price_per_hour) + ' / час' : null]));
    const tariffs = (D.tariffs || []).map(t => {
      const when = [t.days && t.days.length ? t.days.map(d => DAYS[d]).join(', ') : '', t.dates && t.dates.length ? t.dates.map(CZ.fmtDateStr).join(', ') : '', t.time_from && t.time_to ? `${t.time_from.slice(0, 5)}–${t.time_to.slice(0, 5)}` : ''].filter(Boolean).join(' · ');
      const what = t.applies_to === 'all' ? 'всё оборудование' : t.applies_to.startsWith('kind:') ? ({ pc: 'компьютеры', ps: 'PlayStation', room: 'вся комната' }[t.applies_to.slice(5)] || t.applies_to.slice(5)) : (D.equipment.find(e => 'id:' + e.id === t.applies_to) || {}).name || '';
      return [`${esc(t.name)} <span class="dim" style="font-weight:600">· ${esc(what)}${when ? ' · ' + esc(when) : ''}</span>`, t.mode === 'price' ? rub(t.value) + ' / час' : `−${t.value}%`];
    });
    const n = s.night;
    $('#content').innerHTML = `
      <table class="price-table rv d2"><tbody>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b || '<span class="soon">Цена скоро</span>'}</td></tr>`).join('')}</tbody></table>
      ${tariffs.length ? `<h2 style="margin-top:40px;font-size:24px">Специальные тарифы</h2><table class="price-table"><tbody>${tariffs.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</tbody></table>` : ''}
      ${+s.student_discount_percent > 0 ? `<div class="note info" style="margin-top:20px">🎓 Студентам — скидка ${s.student_discount_percent}% при предъявлении студенческого билета.</div>` : ''}
      ${n && n.enabled ? `<div class="card" style="padding:24px;margin-top:30px"><h3 style="font-size:20px">🌙 Ночное бронирование</h3><p class="muted">${esc(n.rules || '')}</p><p>Время: <b>${esc(n.start)}–${esc(n.end)}</b> · Предоплата: <b>${rub(n.prepay)}</b> · Возраст: <b>от ${n.min_age} лет</b></p></div>` : ''}
      <p class="muted" style="margin-top:24px">Оплата переводом на Т-Банк после оформления заявки на сайте. Бронирование подтверждается после проверки оплаты администратором.</p>
      <a class="btn btn-neon" href="/#room" style="margin-top:10px">Забронировать</a>`;
  }

  async function my() {
    const list = CZ.myBookings(); const box = $('#content');
    if (!list.length) { box.innerHTML = '<div class="empty-state"><h3>Пока нет броней</h3><p class="muted">Брони, оформленные на этом устройстве, появятся здесь.</p><a class="btn btn-neon" href="/#room">Забронировать</a></div>'; return; }
    box.innerHTML = '<p class="muted">Загружаю…</p>';
    const rows = await Promise.all(list.map(async b => { try { return await rpc('get_booking', { code: b.code, token: b.token }); } catch (e) { return null; } }));
    box.innerHTML = rows.map((b, i) => b ? `<a class="card" style="padding:18px;display:block" href="/booking?c=${encodeURIComponent(b.code)}#t=${list[i].token}">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><b style="font-family:var(--f-display)">${esc(b.code)}</b><span class="chip">${esc(b.status_ru)}</span></div>
      <p class="muted" style="margin:8px 0 0">${esc(b.equipment_name)} · ${CZ.fmtRange(b.starts_at, b.ends_at)} · ${rub(b.total)}</p></a>` : '').join('') || '<p class="muted">Брони не найдены.</p>';
  }
})();
