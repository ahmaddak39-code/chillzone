/* CHILL ZONE — заставка открытия сайта. Показывается один раз за сессию на главной странице.
   Подключается сразу после <body>, чтобы заставка была на экране с первого кадра. */
(function () {
  var html = document.documentElement;
  if (!html.classList.contains('intro-on')) return;
  var lite = !!window.CZ_LITE;
  var rnd = function (a, b) { return a + Math.random() * (b - a); };

  function letters(word, start) {
    return word.split('').map(function (ch, k) {
      var i = start + k, sh = '';
      [['s1', -1], ['s2', 1], ['s3', -1]].forEach(function (s, j) {
        var dx = Math.round(rnd(.5, 1.3) * s[1] * (j === 1 ? 1 : -1) * 120 * (i % 2 ? 1 : -1)) + 'px';
        var dy = Math.round(rnd(-60, 60)) + 'px';
        sh += '<i class="sh ' + s[0] + '" style="--dx:' + dx + ';--dy:' + dy + '">' + ch + '</i>';
      });
      return '<span class="L" style="--i:' + i + '">' + ch +
        '<i class="ext">' + ch + '</i>' + sh + '<i class="ab ac">' + ch + '</i><i class="ab ap">' + ch + '</i><i class="rim">' + ch + '</i></span>';
    }).join('');
  }
  var el = document.createElement('div'); el.id = 'intro'; el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="in-bg"></div><canvas></canvas><div class="in-slit"></div><div class="in-line"></div>' +
    '<div class="in-stage"><div class="in-mark"><svg viewBox="0 0 64 64"><defs><linearGradient id="ing" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22e3ff"/><stop offset=".5" stop-color="#7b5cff"/><stop offset="1" stop-color="#ff3fb4"/></linearGradient></defs>' +
    '<path d="M32 3 57 17.5v29L32 61 7 46.5v-29Z" fill="none" stroke="url(#ing)" stroke-width="3.4" stroke-linejoin="round" pathLength="100"/>' +
    '<path class="zz" d="M21 22h22L23 42h20" fill="none" stroke="url(#ing)" stroke-width="5.4" stroke-linecap="round" stroke-linejoin="round" pathLength="100"/></svg></div>' +
    '<div class="in-word" aria-label="CHILL ZONE"><div class="in-row">' + letters('CHILL', 0) + '</div><div class="in-row">' + letters('ZONE', 5) + '</div></div>' +
    '<div class="in-slogan">Твоя игровая вселенная</div></div><div class="in-flash"></div><button class="in-skip" type="button">Пропустить</button>';
  document.body.prepend(el);

  // ---------- частицы и электрические разряды ----------
  var cv = el.querySelector('canvas'), ctx = cv.getContext('2d'), dpr = lite ? 1 : Math.min(2, window.devicePixelRatio || 1);
  var W, H, P = [], arcs = [], t0 = 0, raf = 0, running = true;
  var COLS = ['#46ecff', '#8b5cff', '#19f0c4', '#3d6bff', '#ff3fb4'];
  function size() { W = innerWidth; H = innerHeight; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
  size(); addEventListener('resize', size);
  var N = lite ? 28 : 70;
  for (var i = 0; i < N; i++) P.push({ x: rnd(0, 1), y: rnd(0, 1), r: rnd(.6, 2.4), v: rnd(.02, .07), c: COLS[i % 5], ph: rnd(0, 6) });
  function bolt(x1, y1, x2, y2, segs) {
    var pts = [[x1, y1]]; for (var k = 1; k < segs; k++) { var f = k / segs; pts.push([x1 + (x2 - x1) * f + rnd(-18, 18), y1 + (y2 - y1) * f + rnd(-18, 18)]); } pts.push([x2, y2]); return pts;
  }
  function frame(ts) {
    if (!running) return;
    if (!t0) t0 = ts; var t = (ts - t0) / 1000;
    ctx.clearRect(0, 0, W, H);
    var a = Math.min(1, Math.max(0, (t - .5) / .8));
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < P.length; i++) {
      var p = P[i], y = ((p.y - t * p.v) % 1 + 1) % 1, tw = .5 + .5 * Math.sin(t * 3 + p.ph);
      ctx.globalAlpha = a * (.25 + .55 * tw); ctx.fillStyle = p.c;
      ctx.beginPath(); ctx.arc(p.x * W, y * H, p.r, 0, 6.283); ctx.fill();
    }
    // разряды вокруг логотипа в момент сборки
    if (t > 1.45 && t < 2.5) {
      if (!arcs.length || Math.random() < (lite ? .08 : .22)) {
        var cx = W / 2, cy = H / 2, rx = Math.min(W * .46, 620), ry = Math.min(H * .3, 320), an = rnd(0, 6.283), an2 = an + rnd(.4, 1.1);
        arcs.push({ pts: bolt(cx + Math.cos(an) * rx, cy + Math.sin(an) * ry, cx + Math.cos(an2) * rx * .8, cy + Math.sin(an2) * ry * .8, 9), life: 1, c: COLS[(Math.random() * 3) | 0] });
        if (arcs.length > (lite ? 2 : 6)) arcs.shift();
      }
    }
    for (var j = 0; j < arcs.length; j++) {
      var b = arcs[j]; b.life -= .06; if (b.life <= 0) continue;
      ctx.globalAlpha = b.life * .9; ctx.strokeStyle = b.c; ctx.lineWidth = 1.6;
      if (!lite) { ctx.shadowColor = b.c; ctx.shadowBlur = 12; }
      ctx.beginPath(); ctx.moveTo(b.pts[0][0], b.pts[0][1]); for (var k = 1; k < b.pts.length; k++) ctx.lineTo(b.pts[k][0], b.pts[k][1]); ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    raf = requestAnimationFrame(frame);
  }

  // ---------- старт после загрузки шрифта (максимум 1.1 с ожидания) ----------
  var started = false, ended = false, timers = [];
  function start() {
    if (started) return; started = true;
    el.classList.add('go'); raf = requestAnimationFrame(frame);
    timers.push(setTimeout(finish, 3250));
  }
  function finish() {
    if (ended) return; ended = true; timers.forEach(clearTimeout);
    if (!started) { el.classList.add('go'); }
    el.classList.add('out');
    try { sessionStorage.setItem('cz_intro', '1'); } catch (e) {}
    setTimeout(function () {
      running = false; cancelAnimationFrame(raf);
      html.classList.remove('intro-on'); el.remove();
      window.dispatchEvent(new Event('cz-intro-done'));
    }, 950);
  }
  el.querySelector('.in-skip').addEventListener('click', function (e) { e.stopPropagation(); finish(); });
  el.addEventListener('click', function () { if (started) finish(); });
  addEventListener('keydown', function (e) { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') finish(); });
  var fontReady = document.fonts && document.fonts.load ? document.fonts.load('900 100px "CZ Display"') : Promise.resolve();
  Promise.race([fontReady, new Promise(function (r) { setTimeout(r, 1100); })]).then(start, start);
  setTimeout(finish, 6500); // страховка
})();
