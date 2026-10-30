/* CHILL ZONE — выбор уровня графики до первой отрисовки.
   lite: телефоны, слабые устройства, «уменьшение движения» — облегчённые эффекты.
   full: компьютеры и планшеты; если реальная частота кадров низкая — автоматически переключаемся на lite. */
(function () {
  var d = document.documentElement, n = navigator, lite = false;
  try {
    var coarse = matchMedia('(pointer:coarse)').matches;
    var small = Math.min(screen.width, screen.height) < 820;
    if (coarse && small) lite = true;
    if (n.deviceMemory && n.deviceMemory <= 4) lite = true;
    if (n.hardwareConcurrency && n.hardwareConcurrency <= 4) lite = true;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) lite = true;
    var saved = localStorage.getItem('cz_gfx');
    if (saved === 'lite') lite = true;
    if (/[?&]gfx=full/.test(location.search)) lite = false;
    if (/[?&]gfx=lite/.test(location.search)) lite = true;
  } catch (e) {}
  d.classList.add(lite ? 'lite' : 'full');
  window.CZ_LITE = lite;
  // Сторож частоты кадров: если на «полной» графике стабильно < 40 FPS — включаем облегчённую
  window.CZ_watchFps = function (onLite) {
    if (window.CZ_LITE) return;
    var frames = 0, start = 0, worst = 0, last = 0, done = false;
    function tick(ts) {
      if (done) return;
      if (!start) { start = last = ts; }
      frames++; worst = Math.max(worst, ts - last); last = ts;
      if (ts - start >= 2500) {
        done = true;
        var fps = frames * 1000 / (ts - start);
        if (fps < 40 && !document.hidden) {
          window.CZ_LITE = true; d.classList.remove('full'); d.classList.add('lite');
          try { localStorage.setItem('cz_gfx', 'lite'); } catch (e) {}
          if (onLite) onLite(fps);
        }
        return;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  };
})();
