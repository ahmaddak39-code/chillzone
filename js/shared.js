/* Общие блоки страниц: контакты, акции, фото оборудования */
(function () {
  const { esc, rub, telHref, mapsUrl, routeUrl } = CZ;

  function contactsBlock(c) {
    c = c || CZ.DEFAULT_CONTACTS;
    const mapSrc = 'https://yandex.ru/map-widget/v1/?text=' + encodeURIComponent('Хасавюрт, улица Тотурбиева, 137') + '&z=17&l=map';
    return `<div class="card contact-card">
        <div class="it"><div class="ic">📍</div><div><small>Адрес</small><div class="big">${esc(c.address)}</div></div></div>
        <div class="it"><div class="ic">📞</div><div><small>Телефон</small><a class="big" href="tel:${telHref(c.phone)}">${esc(c.phone)}</a></div></div>
        <div class="it"><div class="ic">📸</div><div><small>Instagram</small><a class="big" href="https://www.instagram.com/${esc(c.instagram)}/" target="_blank" rel="noopener">@${esc(c.instagram)}</a></div></div>
        <div class="stack" style="margin-top:18px">
          <a class="btn btn-neon btn-wide" href="${routeUrl(c.address)}" target="_blank" rel="noopener">Построить маршрут</a>
          <div class="row2"><a class="btn" href="tel:${telHref(c.phone)}">Позвонить</a><a class="btn" href="https://www.instagram.com/${esc(c.instagram)}/" target="_blank" rel="noopener">Instagram</a></div>
        </div>
      </div>
      <div class="map"><iframe src="${mapSrc}" title="Карта: ${esc(c.address)}" loading="lazy" allowfullscreen></iframe></div>`;
  }

  // карточка «Ночной пакет» (контакты, цены)
  function nightCard(s) {
    const np = s && s.night_package; if (!np || !np.enabled) return '';
    return `<div class="night-pkg night-card"><div class="np-k">🌙 Ночной пакет CHILL ZONE</div>
      <div class="np-t">${esc(np.start)}–${esc(np.end)}</div>
      <div class="np-d">Вся игровая комната только для вашей компании — всю ночь</div>
      <div class="np-grid"><div><small>Время</small><b>${esc(np.start)}–${esc(np.end)}</b></div><div><small>Стоимость</small><b>${rub(np.price)}</b></div>
        <div><small>Возраст</small><b>строго ${np.min_age || 18}+</b></div><div><small>Условие</small><b>вся комната</b></div></div>
      <a class="btn btn-neon btn-sm" href="/#book=room&night=1" style="margin-top:14px">Забронировать ночь</a></div>`;
  }

  const PROMO_ICON = { bonus_time: '⏱️ Бонусное время', discount: '💸 Скидка', giveaway: '🎁 Розыгрыш', student: '🎓 Студентам', group: '👥 Для компаний', info: '⚡ Предложение' };
  function promoCards(list) {
    if (!list || !list.length) return `<div class="empty-state" style="grid-column:1/-1"><h3>Скоро новые акции</h3><p class="muted">Следите за бонусами, скидками и розыгрышами в нашем Instagram.</p><a class="btn btn-neon" href="https://www.instagram.com/chill.zone.game/" target="_blank" rel="noopener">@chill.zone.game</a></div>`;
    return list.map(p => {
      let extra = '';
      if (p.type === 'bonus_time' && p.config && p.config.tiers) extra = '<p>' + p.config.tiers.map(t => `Бронируешь ${CZ.fmtDur(t.min_minutes)} — получаешь <b>${CZ.fmtDur(t.bonus_minutes)} бесплатно</b>`).join('<br>') + '</p>';
      if (p.type === 'discount' && p.config && p.config.percent) extra = `<p><b style="font-family:var(--f-display);font-size:30px">−${p.config.percent}%</b></p>`;
      const dates = p.ends_on ? `<p class="dim" style="position:relative;font-size:13px">До ${CZ.fmtDateStr(p.ends_on)}</p>` : '';
      return `<div class="promo rv"><span class="chip">${PROMO_ICON[p.type] || PROMO_ICON.info}</span><h3>${esc(p.title)}</h3><p>${esc(p.description)}</p>${extra}${dates}</div>`;
    }).join('');
  }

  const photoCache = {};
  async function photoSrc(it) {
    if (it.has_photo) {
      if (photoCache[it.id]) return photoCache[it.id];
      try { const r = await CZ.rpc('get_equipment_photo', { id: it.id }); if (r && r.src) return (photoCache[it.id] = r.src); } catch (e) {}
    }
    return it.photo_url || null;
  }
  function artHTML(it) {
    const t = { vr: 'VR', foosball: 'GOAL', tennis: 'PING', wheel: 'RACE', ps: 'PLAY', pc: 'PC', room: 'ZONE', airhockey: 'HOCKEY', tv: '75″' }[it.kind] || 'GAME';
    return `<div class="ph-art"><span>${t}</span></div>`;
  }
  function priceLabel(it, room) {
    if (it.price_per_hour == null) return '<span class="soon">Цена скоро</span>';
    return `${rub(it.price_per_hour)}<small> / час</small>`;
  }
  window.CZP = { contactsBlock, promoCards, photoSrc, artHTML, priceLabel, nightCard };
})();
