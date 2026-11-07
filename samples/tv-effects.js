/* =====================================================================================
   MUESTRA (fase 1) — Efectos de fondo de la TV: nieve (navidad) y murciélagos (halloween).
   Pensado para trasladarse a index.html en la fase 2 tal cual.

   - Un solo <canvas> por TV y un único bucle requestAnimationFrame: sin nodos DOM por partícula.
   - Solo arranca si el tema lo pide ('navidad' -> nieve, 'halloween' -> murciélagos). Cualquier otro
     tema (o 'none') no crea nada: coste cero.
   - prefers-reduced-motion: reduce -> no anima (y se detiene si el usuario lo activa en caliente).
   - El navegador pausa requestAnimationFrame con la pestaña oculta; además el paso se limita para
     que una pausa larga no produzca saltos.

   Uso:  const stop = PQThemeFx.start(canvas, 'navidad');   ...   stop();
   ===================================================================================== */
(function (global) {
  const reduceMotion = () => global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function fitCanvas(canvas, ctx) {
    const dpr = Math.min(global.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  // ---- Nieve: copos de 3 tamaños (parallax), deriva lateral suave ----
  function snow(size) {
    const count = Math.round(Math.min(160, (size.w * size.h) / 9000));
    const flakes = Array.from({ length: count }, () => newFlake(size, true));
    function newFlake(s, anywhere) {
      const depth = Math.random();             // 0 = lejos (pequeño, lento), 1 = cerca
      return {
        x: Math.random() * s.w,
        y: anywhere ? Math.random() * s.h : -10,
        r: 0.8 + depth * 2.6,
        vy: 12 + depth * 38,                    // px/s
        sway: 8 + Math.random() * 18,
        phase: Math.random() * Math.PI * 2,
        a: 0.35 + depth * 0.55,
      };
    }
    return {
      step(ctx, s, dt, t) {
        ctx.clearRect(0, 0, s.w, s.h);
        ctx.fillStyle = '#ffffff';
        for (const f of flakes) {
          f.y += f.vy * dt;
          const x = f.x + Math.sin(t * 0.6 + f.phase) * f.sway;
          if (f.y - f.r > s.h) Object.assign(f, newFlake(s, false));
          ctx.globalAlpha = f.a;
          ctx.beginPath();
          ctx.arc(x, f.y, f.r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      },
      resize(s) { for (const f of flakes) { f.x = Math.random() * s.w; } },
    };
  }

  // ---- Murciélagos: pocos (4-6), cruzan despacio por la parte alta, aleteo ----
  function bats(size) {
    const count = size.w > 900 ? 6 : 4;
    const list = Array.from({ length: count }, (_, i) => newBat(size, i * (size.w / count)));
    function newBat(s, startX) {
      const dir = Math.random() < 0.5 ? 1 : -1;
      const scale = 0.6 + Math.random() * 0.9;
      return {
        dir, scale,
        x: startX !== undefined ? startX : (dir > 0 ? -60 : s.w + 60),
        baseY: s.h * (0.06 + Math.random() * 0.42),
        vx: (40 + Math.random() * 50) * scale,  // px/s
        bob: 10 + Math.random() * 20,
        flap: 7 + Math.random() * 4,            // aleteos por segundo (rad/s ~ x2π)
        phase: Math.random() * Math.PI * 2,
      };
    }
    function drawBat(ctx, x, y, sc, wing, dir) {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(sc * dir, sc);
      const lift = wing * 10;                   // -10..10: alas arriba/abajo
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(-10, -6 - lift, -24, -2 - lift * 1.4);
      ctx.quadraticCurveTo(-19, 2, -14, 1);
      ctx.quadraticCurveTo(-11, 5, -7, 3);
      ctx.quadraticCurveTo(-4, 6, 0, 4);
      ctx.quadraticCurveTo(4, 6, 7, 3);
      ctx.quadraticCurveTo(11, 5, 14, 1);
      ctx.quadraticCurveTo(19, 2, 24, -2 - lift * 1.4);
      ctx.quadraticCurveTo(10, -6 - lift, 0, 0);
      ctx.fill();
      ctx.beginPath();                          // cabeza con orejas
      ctx.moveTo(-3, -1); ctx.lineTo(-3, -6); ctx.lineTo(-1, -3); ctx.lineTo(1, -3); ctx.lineTo(3, -6); ctx.lineTo(3, -1);
      ctx.fill();
      ctx.restore();
    }
    return {
      step(ctx, s, dt, t) {
        ctx.clearRect(0, 0, s.w, s.h);
        ctx.fillStyle = 'rgba(8, 3, 14, 0.92)';
        ctx.shadowColor = 'rgba(255, 140, 40, 0.35)'; // leve contraluz naranja para que se vean en lo oscuro
        ctx.shadowBlur = 6;
        for (let i = 0; i < list.length; i++) {
          const b = list[i];
          b.x += b.vx * b.dir * dt;
          const y = b.baseY + Math.sin(t * 1.3 + b.phase) * b.bob;
          drawBat(ctx, b.x, y, b.scale * 1.3, Math.sin(t * b.flap + b.phase), b.dir);
          if ((b.dir > 0 && b.x > s.w + 80) || (b.dir < 0 && b.x < -80)) list[i] = newBat(s);
        }
        ctx.shadowBlur = 0;
      },
      resize() {},
    };
  }

  const EFFECTS = { navidad: snow, halloween: bats };

  function start(canvas, theme) {
    const make = EFFECTS[theme];
    if (!canvas || !make) return () => {};                  // tema sin efecto: no se crea nada
    const ctx = canvas.getContext('2d');
    let size = fitCanvas(canvas, ctx);
    const fx = make(size);
    let raf = 0, last = 0, running = false;
    const mq = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : null;

    function frame(now) {
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 0); // máx. 50 ms por paso
      last = now;
      fx.step(ctx, size, dt, now / 1000);
      raf = global.requestAnimationFrame(frame);
    }
    function play() { if (running || reduceMotion()) return; running = true; last = 0; raf = global.requestAnimationFrame(frame); }
    function pause() { running = false; global.cancelAnimationFrame(raf); ctx.clearRect(0, 0, size.w, size.h); }
    const onMotion = () => (reduceMotion() ? pause() : play());
    const ro = global.ResizeObserver ? new ResizeObserver(() => { size = fitCanvas(canvas, ctx); fx.resize(size); }) : null;

    if (ro) ro.observe(canvas);
    if (mq && mq.addEventListener) mq.addEventListener('change', onMotion);
    play();
    return function stop() {
      pause();
      if (ro) ro.disconnect();
      if (mq && mq.removeEventListener) mq.removeEventListener('change', onMotion);
    };
  }

  global.PQThemeFx = { start };
})(window);
