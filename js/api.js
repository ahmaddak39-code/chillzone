/* CHILL ZONE — общие функции: API, форматирование, логотип, шапка/подвал */
(function () {
  const C = window.CZ_CONFIG || {};
  const TZ_DEFAULT = 'Europe/Moscow';

  const ERR = {
    SLOT_TAKEN: 'Это время уже занято. Выберите другое время или другое оборудование.',
    TIME_IN_PAST: 'Это время уже прошло.',
    TOO_FAR: 'Бронирование доступно только на ближайшие дни.',
    CLOSED_HOURS: 'В это время клуб закрыт.',
    BAD_DURATION: 'Такая продолжительность недоступна.',
    BAD_TIME: 'Неверное время начала.',
    BAD_NAME: 'Введите имя (от 2 символов).',
    BAD_PHONE: 'Введите корректный номер телефона.',
    BAD_PEOPLE: 'Неверное количество человек.',
    PRICE_NOT_SET: 'Стоимость пока не установлена — позвоните нам, и мы всё организуем.',
    AGE_REQUIRED: 'Ночное бронирование доступно только с 18 лет — подтвердите возраст.',
    EQUIPMENT_UNAVAILABLE: 'Это оборудование временно недоступно.',
    EQUIPMENT_NOT_FOUND: 'Оборудование не найдено.',
    TOO_MANY_PENDING: 'У вас уже есть неоплаченные заявки. Оплатите или дождитесь их окончания.',
    RATE_LIMIT: 'Слишком много заявок. Попробуйте через несколько минут.',
    BOOKING_NOT_FOUND: 'Заявка не найдена.',
    BAD_STATUS: 'Действие недоступно для текущего статуса заявки.',
    BAD_FILE: 'Файл не подходит. Загрузите фото (JPG/PNG) или PDF до 5 МБ.',
    TOO_MANY_FILES: 'Загружено максимальное количество файлов.',
    AUTH_REQUIRED: 'Сессия истекла. Войдите снова.',
    BAD_PASSWORD: 'Неверный пароль.',
    TOO_MANY_ATTEMPTS: 'Слишком много попыток. Подождите 15 минут.',
    PASSWORD_TOO_SHORT: 'Пароль должен быть не короче 10 символов.',
    PAYMENT_NOT_VERIFIED: 'Сначала подтвердите, что проверили поступление денег.',
    ATTEST_REQUIRED: 'Подтвердите, что проверили поступление денег.',
    CANNOT_DELETE_ROOM: 'Всю комнату удалить нельзя.',
    BAD_INPUT: 'Проверьте введённые данные.',
    NETWORK: 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.',
    NOT_CONFIGURED: 'Сайт ещё не подключён к базе данных.'
  };

  async function rpc(fn, p = {}) {
    const base = (C.SUPABASE_URL || '').replace(/\/$/, '');
    const headers = { 'content-type': 'application/json' };
    if (C.SUPABASE_ANON_KEY) { headers.apikey = C.SUPABASE_ANON_KEY; if (!/^sb_/.test(C.SUPABASE_ANON_KEY)) headers.authorization = 'Bearer ' + C.SUPABASE_ANON_KEY; }
    let res;
    try {
      res = await fetch(base + '/rest/v1/rpc/' + fn, { method: 'POST', headers, body: JSON.stringify({ p }) });
    } catch (e) { throw mkErr('NETWORK'); }
    const txt = await res.text();
    let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
    if (!res.ok) {
      const code = (data && (data.message || data.error)) || 'NETWORK';
      throw mkErr(String(code).trim());
    }
    return data;
  }
  function mkErr(code) { const e = new Error(ERR[code] || code); e.code = code; return e; }

  // ---------- Время (часовой пояс клуба) ----------
  let TZ = TZ_DEFAULT;
  function setTz(tz) { if (tz) TZ = tz; }
  function parts(d) {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' });
    const o = {}; f.formatToParts(d).forEach(p => o[p.type] = p.value);
    return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second, wd: o.weekday };
  }
  function tzOffsetMin(d) { const p = parts(d); return (Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(d.getTime() / 1000) * 1000) / 60000; }
  // "2026-10-31", "18:30" (время клуба) -> Date
  function zoned(dateStr, timeStr) {
    const [y, m, d] = dateStr.split('-').map(Number); const [h, mi] = (timeStr || '00:00').split(':').map(Number);
    const guess = new Date(Date.UTC(y, m - 1, d, h, mi));
    const off = tzOffsetMin(guess);
    const t = new Date(guess.getTime() - off * 60000);
    const off2 = tzOffsetMin(t);
    return off2 === off ? t : new Date(guess.getTime() - off2 * 60000);
  }
  const pad = n => String(n).padStart(2, '0');
  function localDateStr(d) { const p = parts(d); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; }
  function localTime(d) { const p = parts(new Date(d)); return `${pad(p.h)}:${pad(p.mi)}`; }
  function addDays(dateStr, n) { const [y, m, d] = dateStr.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); }
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  function fmtDate(d) { const p = parts(new Date(d)); return `${p.d} ${MONTHS[p.m - 1]}`; }
  function fmtDateStr(s) { const [y, m, d] = s.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; }
  function wdOf(s) { const [y, m, d] = s.split('-').map(Number); return WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; }
  function fmtRange(a, b) {
    const da = localDateStr(new Date(a)), db = localDateStr(new Date(b));
    return `${fmtDate(a)}, ${localTime(a)}–${localTime(b)}${da !== db ? ' (до ' + fmtDate(b) + ')' : ''}`;
  }
  function fmtDur(min) { const h = Math.floor(min / 60), m = min % 60; return (h ? h + ' ч' : '') + (h && m ? ' ' : '') + (m ? m + ' мин' : ''); }
  const rub = n => (n == null ? '—' : Number(n).toLocaleString('ru-RU') + ' ₽');

  // ---------- Мелочи ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function toast(msg, type = '') {
    let box = $('#toasts'); if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
    const t = document.createElement('div'); t.className = 'toast ' + type; t.textContent = msg; box.appendChild(t);
    setTimeout(() => t.classList.add('out'), 4200); setTimeout(() => t.remove(), 4800);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (x) {} ta.remove(); return ok; }
  }
  // Сжатие изображения перед загрузкой
  function fileToPayload(file, maxSide = 1600, quality = 0.82) {
    return new Promise((resolve, reject) => {
      if (file.type === 'application/pdf') {
        if (file.size > 5 * 1024 * 1024) return reject(mkErr('BAD_FILE'));
        const r = new FileReader(); r.onload = () => resolve({ mime: 'application/pdf', data: String(r.result).split(',')[1] }); r.onerror = () => reject(mkErr('BAD_FILE')); r.readAsDataURL(file); return;
      }
      const url = URL.createObjectURL(file); const img = new Image();
      img.onload = () => {
        const k = Math.min(1, maxSide / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        const du = c.toDataURL('image/jpeg', quality); resolve({ mime: 'image/jpeg', data: du.split(',')[1], preview: du });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(mkErr('BAD_FILE')); };
      img.src = url;
    });
  }

  // ---------- Логотип ----------
  function logoSVG(cls = '') {
    return `<svg class="cz-logo ${cls}" viewBox="0 0 64 64" aria-hidden="true">
      <defs><linearGradient id="czg${cls}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22e3ff"/><stop offset=".5" stop-color="#7b5cff"/><stop offset="1" stop-color="#ff3fb4"/></linearGradient></defs>
      <path class="lg-hex" d="M32 3 57 17.5v29L32 61 7 46.5v-29Z" fill="none" stroke="url(#czg${cls})" stroke-width="3.2" stroke-linejoin="round"/>
      <path class="lg-hex2" d="M32 11 50 21.5v21L32 53 14 42.5v-21Z" fill="none" stroke="url(#czg${cls})" stroke-width="1.2" opacity=".55"/>
      <path class="lg-z" d="M21 22h22L23 42h20" fill="none" stroke="url(#czg${cls})" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
      <circle class="lg-dot" cx="32" cy="32" r="2.4" fill="#fff"/>
    </svg>`;
  }
  function brand(href = '/') {
    return `<a class="brand" href="${href}" aria-label="CHILL ZONE — на главную">${logoSVG('sm')}<span class="brand-word"><b>CHILL</b><i>ZONE</i></span></a>`;
  }

  // ---------- Шапка и подвал ----------
  const NAV = [['/#room', 'Игровая зона'], ['/#fun', 'Развлечения'], ['/prices', 'Цены'], ['/promo', 'Акции'], ['/contacts', 'Контакты']];
  function header(active) {
    const el = document.createElement('header'); el.className = 'site-header';
    el.innerHTML = `<div class="wrap hdr">${brand()}<nav class="nav">${NAV.map(([h, t]) => `<a href="${h}" class="${active === h ? 'on' : ''}">${t}</a>`).join('')}</nav>
      <a class="btn btn-neon btn-sm hdr-cta" href="/#room">Забронировать</a>
      <button class="burger" aria-label="Меню" aria-expanded="false"><span></span><span></span><span></span></button></div>
      <div class="mnav">${NAV.map(([h, t]) => `<a href="${h}">${t}</a>`).join('')}<a class="btn btn-neon" href="/#room">Забронировать</a><a href="/my">Мои брони</a></div>`;
    document.body.prepend(el);
    const b = $('.burger', el);
    b.onclick = () => { const o = el.classList.toggle('open'); b.setAttribute('aria-expanded', o); };
    $$('.mnav a', el).forEach(a => a.onclick = () => el.classList.remove('open'));
    addEventListener('scroll', () => el.classList.toggle('scrolled', scrollY > 20), { passive: true });
  }
  function footer(contacts) {
    const c = contacts || DEFAULT_CONTACTS;
    const el = document.createElement('footer'); el.className = 'site-footer';
    el.innerHTML = `<div class="wrap ftr">
      <div>${brand()}<p class="muted">Игровое пространство в Хасавюрте. Играй. Соревнуйся. Отдыхай.</p></div>
      <div><h4>Контакты</h4>
        <p><a href="${mapsUrl(c.address)}" target="_blank" rel="noopener">${esc(c.address)}</a></p>
        <p><a href="tel:${telHref(c.phone)}">${esc(c.phone)}</a></p>
        <p><a href="https://www.instagram.com/${esc(c.instagram)}/" target="_blank" rel="noopener">Instagram @${esc(c.instagram)}</a></p></div>
      <div><h4>Разделы</h4>${NAV.map(([h, t]) => `<p><a href="${h}">${t}</a></p>`).join('')}<p><a href="/my">Мои брони</a></p></div>
    </div><div class="wrap ftr-bottom"><span>© ${new Date().getFullYear()} CHILL ZONE</span><span>Хасавюрт</span></div>`;
    document.body.appendChild(el);
  }
  const DEFAULT_CONTACTS = { address: 'г. Хасавюрт, ул. Тотурбиева, 137', phone: '+7 928 553-52-52', instagram: 'chill.zone.game' };
  const telHref = p => '+' + String(p || '').replace(/\D/g, '').replace(/^8/, '7');
  const mapsUrl = a => 'https://yandex.ru/maps/?text=' + encodeURIComponent(a || DEFAULT_CONTACTS.address);
  const routeUrl = a => 'https://yandex.ru/maps/?rtext=~' + encodeURIComponent(a || DEFAULT_CONTACTS.address) + '&rtt=auto';

  // Появление элементов при прокрутке
  function reveal() {
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .12 });
    $$('.rv:not(.in)').forEach(el => io.observe(el));
  }

  // Мои брони (на этом устройстве)
  function saveMyBooking(b) {
    try { const l = JSON.parse(localStorage.getItem('cz_my') || '[]').filter(x => x.code !== b.code); l.unshift({ code: b.code, token: b.token, name: b.equipment_name, at: b.starts_at }); localStorage.setItem('cz_my', JSON.stringify(l.slice(0, 20))); } catch (e) {}
  }
  function myBookings() { try { return JSON.parse(localStorage.getItem('cz_my') || '[]'); } catch (e) { return []; } }

  const KIND_ICON = { pc: '🖥️', ps: '🎮', wheel: '🏎️', vr: '🥽', tennis: '🏓', airhockey: '🏒', foosball: '⚽', tv: '📺', room: '🌐', other: '🕹️' };

  window.CZ = { rpc, ERR, setTz, get TZ() { return TZ; }, zoned, localDateStr, localTime, addDays, fmtDate, fmtDateStr, wdOf, fmtRange, fmtDur, rub, $, $$, esc, toast, copy,
    fileToPayload, logoSVG, brand, header, footer, reveal, telHref, mapsUrl, routeUrl, DEFAULT_CONTACTS, saveMyBooking, myBookings, KIND_ICON, parts, pad };
})();
