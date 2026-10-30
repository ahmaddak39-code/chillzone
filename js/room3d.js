/* CHILL ZONE — интерактивная 3D-комната на CSS 3D (без внешних библиотек) */
(function () {
  const FW = 1000, FD = 700, WALL_H = 230;

  function shade(hex, k) {
    const n = parseInt(hex.slice(1), 16); let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    r = Math.max(0, Math.min(255, Math.round(r * k))); g = Math.max(0, Math.min(255, Math.round(g * k))); b = Math.max(0, Math.min(255, Math.round(b * k)));
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }
  function face(parent, w, h, tf, bg, cls) {
    const f = document.createElement('div'); f.className = 'r3-face' + (cls ? ' ' + cls : '');
    f.style.width = w + 'px'; f.style.height = h + 'px'; f.style.transform = tf; if (bg) f.style.background = bg;
    parent.appendChild(f); return f;
  }
  // Короб: x,y — левый верхний угол в плане, z — высота основания
  function box(parent, o) {
    const { x = 0, y = 0, z = 0, w, d, h, c = '#2a2f66' } = o;
    const g = document.createElement('div'); g.className = 'r3-obj-part'; g.style.cssText = `position:absolute;left:0;top:0;transform-style:preserve-3d;transform:translate3d(${x}px,${y}px,${z}px)`;
    const top = face(g, w, d, `translate3d(0,0,${h}px)`, o.top || c, o.topCls);
    const s = face(g, w, h, `translate3d(0,${d}px,${h}px) rotateX(-90deg)`, o.south || shade(c, .78), o.southCls);
    const e = face(g, d, h, `translate3d(${w}px,0,${h}px) rotateZ(90deg) rotateX(-90deg)`, o.east || shade(c, .62), o.eastCls);
    const n = face(g, w, h, `translate3d(0,0,${h}px) rotateX(-90deg)`, o.north || shade(c, .5), o.northCls);
    const wst = face(g, d, h, `translate3d(0,0,${h}px) rotateZ(90deg) rotateX(-90deg)`, o.west || shade(c, .7), o.westCls);
    if (o.round) [top, s, e, n, wst].forEach(f => f.style.borderRadius = o.round + 'px');
    parent.appendChild(g); return { g, top, s, e, n, w: wst };
  }
  function flat(parent, o) { // плоская деталь (диск, ковер)
    const f = face(parent, o.w, o.d, `translate3d(${o.x}px,${o.y}px,${o.z || 0.5}px)`, o.bg, o.cls);
    if (o.round) f.style.borderRadius = o.round; return f;
  }

  // ---------- Модели оборудования (координаты относительно центра объекта) ----------
  const MODELS = {
    pc(g) {
      box(g, { x: -40, y: -24, z: 0, w: 3, d: 44, h: 34, c: '#141633' });
      box(g, { x: 37, y: -24, z: 0, w: 3, d: 44, h: 34, c: '#141633' });
      box(g, { x: -42, y: -26, z: 34, w: 84, d: 48, h: 4, c: '#1d2150', southCls: 'rgb' });
      box(g, { x: -4, y: -20, z: 38, w: 8, d: 6, h: 6, c: '#0c0e24' });
      const m = box(g, { x: -29, y: -22, z: 44, w: 58, d: 4, h: 34, c: '#0b0d22' }); m.s.classList.add('screen', 'glowy');
      box(g, { x: -19, y: -4, z: 38, w: 34, d: 10, h: 1.5, c: '#2b2f6e', topCls: 'rgb' });
      const t = box(g, { x: 26, y: -18, z: 38.5, w: 12, d: 26, h: 30, c: '#0f1230' }); t.s.classList.add('rgb'); t.w.classList.add('rgb');
      box(g, { x: -3, y: 30, z: 0, w: 6, d: 6, h: 18, c: '#0d0d1a' });
      box(g, { x: -15, y: 20, z: 18, w: 30, d: 26, h: 7, c: '#23182f', topCls: 'chair-top' });
      box(g, { x: -15, y: 44, z: 22, w: 30, d: 6, h: 40, c: '#1c1426', southCls: 'chair-back' });
      return { pad: [-50, -34, 100, 92], labelZ: 96 };
    },
    tv(g) {
      const scr = box(g, { x: -78, y: 0, z: 70, w: 156, d: 5, h: 88, c: '#06070f' }); scr.s.classList.add('screen', 'glowy');
      box(g, { x: -55, y: 4, z: 26, w: 110, d: 18, h: 8, c: '#14102a', southCls: 'rgb' });
      box(g, { x: -8, y: 6, z: 34, w: 16, d: 12, h: 20, c: '#e9ecff' });
      box(g, { x: -100, y: 6, z: 0, w: 4, d: 4, h: 150, c: '#ff4060', south: '#ff3d3d', east: '#ff6a3d' }).s.classList.add('glowy');
      box(g, { x: 96, y: 6, z: 0, w: 4, d: 4, h: 150, c: '#ff4060', south: '#ff3d3d', east: '#ff6a3d' }).s.classList.add('glowy');
      return { pad: [-90, 0, 180, 30], labelZ: 175 };
    },
    ps(g) {
      flat(g, { x: -90, y: -70, w: 180, d: 150, bg: 'radial-gradient(closest-side,rgba(255,63,180,.25),rgba(80,20,90,.4))', round: '18px' });
      box(g, { x: -30, y: -30, z: 0, w: 60, d: 32, h: 16, c: '#1a1236' });
      box(g, { x: -14, y: -22, z: 16, w: 10, d: 6, h: 2, c: '#f2f4ff' }); box(g, { x: 4, y: -22, z: 16, w: 10, d: 6, h: 2, c: '#111' });
      box(g, { x: -85, y: 30, z: 0, w: 170, d: 40, h: 20, c: '#4a2a6b' });
      box(g, { x: -85, y: 62, z: 20, w: 170, d: 12, h: 30, c: '#3c2259' });
      box(g, { x: -95, y: 26, z: 0, w: 12, d: 48, h: 30, c: '#3c2259' });
      box(g, { x: 83, y: 26, z: 0, w: 12, d: 48, h: 30, c: '#3c2259' });
      return { pad: [-100, -80, 200, 165], labelZ: 80 };
    },
    wheel(g) {
      box(g, { x: -32, y: -60, z: 0, w: 64, d: 118, h: 6, c: '#15151f', southCls: 'rgb' });
      box(g, { x: -20, y: 6, z: 6, w: 40, d: 36, h: 18, c: '#4a1426' });
      box(g, { x: -20, y: 38, z: 6, w: 40, d: 10, h: 56, c: '#3a0f1f', north: '#2a0a17' });
      box(g, { x: -4, y: -36, z: 6, w: 8, d: 8, h: 34, c: '#222' });
      const wh = face(g, 32, 32, 'translate3d(-16px,-30px,56px) rotateX(-90deg)', 'transparent'); wh.style.cssText += ';border-radius:50%;border:5px solid #1b1b28;box-shadow:0 0 0 2px #ff3fb4,0 0 14px #ff3fb4';
      box(g, { x: -16, y: -54, z: 6, w: 32, d: 10, h: 5, c: '#333' });
      const m = box(g, { x: -46, y: -66, z: 34, w: 92, d: 4, h: 46, c: '#07080f' }); m.s.classList.add('screen', 'glowy');
      box(g, { x: -50, y: -64, z: 34, w: 10, d: 10, h: 14, c: '#1a1a24', topCls: 'rgb' }); box(g, { x: 40, y: -64, z: 34, w: 10, d: 10, h: 14, c: '#1a1a24', topCls: 'rgb' });
      return { pad: [-55, -75, 110, 135], labelZ: 112 };
    },
    vr(g) {
      flat(g, { x: -60, y: -60, w: 120, d: 120, cls: 'vr-disc', round: '50%' });
      box(g, { x: -3, y: -3, z: 0, w: 6, d: 6, h: 46, c: '#22e3ff' });
      const h = box(g, { x: -15, y: -10, z: 50, w: 30, d: 18, h: 14, c: '#f1f3ff' }); h.s.classList.add('screen');
      const ring = face(g, 90, 90, 'translate3d(-45px,-45px,80px)', 'transparent', 'vr-ring'); ring.style.borderRadius = '50%';
      return { pad: [-62, -62, 124, 124], labelZ: 120 };
    },
    tennis(g) {
      [[-72, -38], [66, -38], [-72, 32], [66, 32]].forEach(([x, y]) => box(g, { x, y, z: 0, w: 5, d: 5, h: 36, c: '#d9dcf5' }));
      box(g, { x: -78, y: -44, z: 36, w: 156, d: 88, h: 4, c: '#1c2f8f', top: 'linear-gradient(90deg,transparent 49.4%,#fff 49.4% 50.6%,transparent 50.6%),linear-gradient(transparent 49%,rgba(255,255,255,.7) 49% 51%,transparent 51%),#2343b8', south: '#eef', east: '#eef' });
      box(g, { x: -1, y: -50, z: 40, w: 2, d: 100, h: 10, c: '#ffffff', south: 'rgba(255,255,255,.5)', east: 'rgba(255,255,255,.6)' });
      return { pad: [-90, -56, 180, 112], labelZ: 70 };
    },
    airhockey(g) {
      [[-62, -34], [57, -34], [-62, 29], [57, 29]].forEach(([x, y]) => box(g, { x, y, z: 0, w: 5, d: 5, h: 30, c: '#222' }));
      box(g, { x: -68, y: -40, z: 30, w: 136, d: 80, h: 8, c: '#7d3cff', top: 'radial-gradient(circle at 50% 50%,transparent 9px,#111 9px 11px,transparent 11px),linear-gradient(90deg,transparent 49.5%,#111 49.5% 50.5%,transparent 50.5%),linear-gradient(135deg,#d8a3ff,#a35cff)', southCls: 'neon-edge', eastCls: 'neon-edge' });
      box(g, { x: -3, y: -42, z: 38, w: 6, d: 4, h: 36, c: '#c0c6d8' }); box(g, { x: -3, y: 38, z: 38, w: 6, d: 4, h: 36, c: '#c0c6d8' });
      const sb = box(g, { x: -6, y: -42, z: 74, w: 12, d: 84, h: 10, c: '#c0c6d8' }); sb.e.style.background = '#200'; sb.e.innerHTML = '<span class="score">00:00</span>';
      return { pad: [-78, -52, 156, 104], labelZ: 104 };
    },
    foosball(g) {
      [[-50, -28], [44, -28], [-50, 22], [44, 22]].forEach(([x, y]) => box(g, { x, y, z: 0, w: 6, d: 6, h: 30, c: '#2a1a12' }));
      box(g, { x: -55, y: -32, z: 30, w: 110, d: 64, h: 20, c: '#6b4528', top: 'linear-gradient(90deg,transparent 49.5%,#fff 49.5% 50.5%,transparent 50.5%),radial-gradient(circle,transparent 10px,#fff 10px 12px,transparent 12px),#1f9a4a' });
      for (let i = 0; i < 8; i++) box(g, { x: -44 + i * 12.5, y: -42, z: 50, w: 2, d: 84, h: 2, c: '#d6dae8' });
      return { pad: [-64, -46, 128, 92], labelZ: 80 };
    },
    other(g) {
      box(g, { x: -30, y: -30, z: 0, w: 60, d: 60, h: 40, c: '#3d3a8a', topCls: 'rgb' });
      return { pad: [-40, -40, 80, 80], labelZ: 70 };
    }
  };

  class Room3D {
    constructor(el, opts = {}) {
      this.el = el; this.o = opts; this.items = []; this.objs = {}; this.sel = null;
      this.cam = { rx: 56, rz: -30, z: 1, cx: FW / 2, cy: FD / 2 + 20 };
      el.classList.add('room3d');
      el.innerHTML = '<div class="cam"><div class="r3-floor"></div></div>';
      this.camEl = el.querySelector('.cam'); this.floor = el.querySelector('.r3-floor');
      this.buildShell();
      if (opts.interactive !== false) this.bindGestures();
      this.fit(); this.apply(true);
      this.ro = new ResizeObserver(() => { const keep = this.sel; this.fit(); if (keep) this.focus(keep, true); else this.apply(); });
      this.ro.observe(el);
      // пауза отрисовки вне экрана
      this.io = new IntersectionObserver(es => es.forEach(e => this.camEl.style.visibility = e.isIntersecting ? 'visible' : 'hidden'), { rootMargin: '100px' });
      this.io.observe(el);
    }
    buildShell() {
      const f = this.floor;
      // стены
      const nw = face(f, FW, WALL_H, `translate3d(0,0,${WALL_H}px) rotateX(-90deg)`, null); nw.className = 'r3-wall';
      nw.innerHTML = `<div class="neon-strip" style="bottom:12px"></div><div class="neon-sign" style="left:430px;top:60px;font-size:34px">CHILL ZONE</div><div class="neon-sign" style="left:250px;top:110px;font-size:18px;text-shadow:0 0 8px #22e3ff,0 0 24px #22e3ff,0 0 44px #3d6bff">PLAY</div><div class="neon-sign" style="left:820px;top:36px;font-size:16px">GAME ON</div>`;
      const ww = face(f, FD, WALL_H, `translate3d(0,0,${WALL_H}px) rotateZ(90deg) rotateX(-90deg)`, null); ww.className = 'r3-wall';
      ww.innerHTML = `<div class="neon-strip" style="bottom:12px"></div><div class="neon-sign" style="left:300px;top:50px;font-size:22px;text-shadow:0 0 8px #19f0c4,0 0 24px #19f0c4,0 0 44px #22e3ff">◢ LEVEL UP ◣</div>`;
      // колонна
      box(f, { x: 640, y: 320, z: 0, w: 30, d: 30, h: WALL_H, c: '#2a2560', southCls: 'pillar', eastCls: 'pillar' });
      // кондиционеры
      box(f, { x: 700, y: 2, z: 180, w: 80, d: 16, h: 22, c: '#e7e9ff' });
      box(f, { x: 2, y: 380, z: 180, w: 16, d: 80, h: 22, c: '#e7e9ff' });
    }
    setItems(items) {
      // удаляем старые
      Object.values(this.objs).forEach(o => o.el.remove()); this.objs = {};
      this.items = items;
      items.forEach(it => {
        if (it.kind === 'room') return this.addRoomMarker(it);
        const model = MODELS[it.model || it.kind] || MODELS[it.kind] || MODELS.other; const sc = Math.max(.4, Math.min(2.5, +it.map_scale || 1));
        const el = document.createElement('div'); el.className = 'r3-obj'; el.dataset.id = it.id; el.dataset.st = 'free';
        el.style.transform = `translate3d(${it.map_x}px,${it.map_y}px,0) rotateZ(${it.map_rot || 0}deg) scale3d(${sc},${sc},${sc})`;
        el.style.setProperty('--or', (+it.map_rot || 0) + 'deg'); el.setAttribute('role', 'button'); el.setAttribute('aria-label', it.name);
        const g = document.createElement('div'); g.style.cssText = 'position:absolute;left:0;top:0;transform-style:preserve-3d';
        const info = model(g);
        const pad = document.createElement('div'); pad.className = 'pad';
        const [px, py, pw, pd] = info.pad; pad.style.cssText = `left:${px}px;top:${py}px;width:${pw}px;height:${pd}px;transform:translateZ(.6px)`;
        el.appendChild(pad); el.appendChild(g);
        if (this.o.labels !== false) {
          const lb = document.createElement('div'); lb.className = 'r3-label'; lb.style.transform = `translate3d(0,0,${info.labelZ}px)`;
          lb.innerHTML = `<div>${String(it.label || it.name).replace(/</g, '&lt;')}</div>`; el.appendChild(lb);
        }
        this.floor.appendChild(el);
        this.objs[it.id] = { el, it, info };
      });
    }
    addRoomMarker(it) {
      const el = document.createElement('div'); el.className = 'r3-obj r3-roommark'; el.dataset.id = it.id; el.dataset.st = 'free';
      el.style.transform = `translate3d(0,0,0)`;
      const pad = document.createElement('div'); pad.className = 'pad room-pad'; pad.style.cssText = 'left:6px;top:6px;width:988px;height:688px;transform:translateZ(.4px)';
      el.appendChild(pad);
      if (this.o.labels !== false) {
        const lb = document.createElement('div'); lb.className = 'r3-label room-label'; lb.style.transform = `translate3d(${FW / 2 - 60}px,0px,${WALL_H + 70}px)`;
        lb.innerHTML = `<div>🌐 ${it.name.replace(/</g, '&lt;')}</div>`; el.appendChild(lb);
      }
      this.floor.appendChild(el); this.objs[it.id] = { el, it, info: { labelZ: 0 } };
    }
    setStatus(map) { // id -> free|busy|off
      Object.entries(this.objs).forEach(([id, o]) => { if (o.el.classList.contains('selected')) return; o.el.dataset.st = map[id] || 'free'; o.st = map[id] || 'free'; });
    }
    fit() {
      const W = this.el.clientWidth || 800, H = this.el.clientHeight || 600;
      this.base = Math.max(.32, Math.min(1.25, Math.min(W / 1180, H / 760) * (W < 700 ? 1.32 : 1.12)));
      this.home = { cx: FW / 2 + (W < 700 ? 70 : 0), cy: FD / 2 + 20 };
      if (!this.sel) { this.cam.z = this.base; Object.assign(this.cam, this.home); }
    }
    apply(instant) {
      const c = this.cam;
      if (instant) { this.camEl.style.transition = 'none'; requestAnimationFrame(() => requestAnimationFrame(() => this.camEl.style.transition = '')); }
      this.el.style.setProperty('--rx', c.rx + 'deg'); this.el.style.setProperty('--rz', c.rz + 'deg');
      const off = this.offset || [0, 0];
      this.camEl.style.left = `calc(50% + ${off[0]}px)`; this.camEl.style.top = `calc(52% + ${off[1]}px)`;
      this.camEl.style.transform = `scale(${c.z}) rotateX(${c.rx}deg) rotateZ(${c.rz}deg) translate3d(${-c.cx}px,${-c.cy}px,${this.sel && this.sel !== 'room' ? -40 : -60}px)`;
    }
    setOffset(x, y) { this.offset = [x, y]; this.apply(); }
    focus(id, silent) {
      const o = this.objs[id]; if (!o) return;
      Object.values(this.objs).forEach(x => x.el.classList.remove('selected'));
      this.sel = id; this.el.classList.add('has-sel');
      o.el.classList.add('selected'); o.el.dataset.st = 'sel';
      Object.values(this.objs).forEach(x => { if (x !== o) x.el.dataset.st = x.st || 'free'; });
      if (id === 'room') { this.el.classList.remove('has-sel'); Object.assign(this.cam, this.home, { z: this.base * 1.05, rx: 52, rz: -24 }); }
      else {
        const it = o.it; const k = it.kind === 'pc' ? 2.5 : it.kind === 'tv' || it.kind === 'ps' ? 1.9 : 2.1;
        Object.assign(this.cam, { cx: +it.map_x, cy: +it.map_y + (it.kind === 'tv' ? 40 : 10), z: Math.min(this.base * k, 2.6), rx: it.kind === 'tv' ? 62 : 58, rz: it.kind === 'tv' ? -12 : this.cam.rz > 0 ? 18 : -22 });
      }
      this.apply();
      if (!silent && this.o.onSelect) this.o.onSelect(id);
    }
    reset() {
      Object.values(this.objs).forEach(x => { x.el.classList.remove('selected'); x.el.dataset.st = x.st || 'free'; });
      this.sel = null; this.el.classList.remove('has-sel');
      Object.assign(this.cam, this.home, { z: this.base, rx: 56, rz: -30 });
      this.apply();
    }
    zoomBy(k) { this.cam.z = Math.max(this.base * .6, Math.min(4, this.cam.z * k)); this.apply(); }
    intro() {
      Object.assign(this.cam, { rz: -75, rx: 72, z: this.base * .55 }); this.apply(true);
      setTimeout(() => { Object.assign(this.cam, { rz: -30, rx: 56, z: this.base }); this.camEl.style.transition = 'transform 2.4s cubic-bezier(.2,.8,.2,1)'; this.apply(); setTimeout(() => this.camEl.style.transition = '', 2500); }, 150);
    }
    autoOrbit() {
      let t = 0; this.orbit = setInterval(() => { if (this.sel) return; t += 1; this.cam.rz = -30 + Math.sin(t / 2) * 16; this.cam.rx = 56 + Math.cos(t / 3) * 4; this.camEl.style.transition = 'transform 4s ease-in-out'; this.apply(); }, 4000);
    }
    bindGestures() {
      const el = this.el; const pts = new Map(); let start = null, moved = false, pinch0 = 0, z0 = 1;
      el.addEventListener('pointerdown', e => {
        if (e.target.closest('.room-tools,.room-zoom,.bk-panel,.room-legend')) return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pts.size === 1) { start = { x: e.clientX, y: e.clientY, rz: this.cam.rz, rx: this.cam.rx, target: e.target }; moved = false; }
        if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); z0 = this.cam.z; el.classList.add('pinching'); moved = true; }
      });
      el.addEventListener('pointermove', e => {
        if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); this.cam.z = Math.max(this.base * .6, Math.min(4, z0 * d / pinch0)); this.apply(); return; }
        if (!start) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (!moved && Math.hypot(dx, dy) > 7) { moved = true; el.classList.add('dragging'); try { el.setPointerCapture(e.pointerId); } catch (x) {} }
        if (moved) { this.cam.rz = start.rz + dx * .3; if (e.pointerType === 'mouse') this.cam.rx = Math.max(32, Math.min(74, start.rx - dy * .2)); this.apply(); this.hideHint(); }
      });
      const up = e => {
        if (!pts.has(e.pointerId)) return; pts.delete(e.pointerId);
        if (pts.size === 0) {
          el.classList.remove('dragging', 'pinching');
          if (!moved && start) {
            const t = document.elementFromPoint(e.clientX, e.clientY) || start.target;
            const ob = t && t.closest && t.closest('.r3-obj');
            if (ob && !(ob.classList.contains('r3-roommark') && !t.closest('.r3-label'))) { this.hideHint(); this.focus(ob.dataset.id); }
          }
          start = null;
        }
      };
      el.addEventListener('pointerup', up); el.addEventListener('pointercancel', e => { pts.delete(e.pointerId); el.classList.remove('dragging', 'pinching'); start = null; });
      el.addEventListener('wheel', e => { if (!e.ctrlKey) return; e.preventDefault(); this.zoomBy(e.deltaY < 0 ? 1.08 : .92); }, { passive: false });
    }
    hideHint() { const h = this.el.parentElement && this.el.parentElement.querySelector('.room-hint'); if (h) h.style.opacity = 0; }
  }
  window.Room3D = Room3D;
})();
