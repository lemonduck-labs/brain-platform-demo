/* Background veins. The same filaments as the brain on the home page, drawn in 2D and zoomed
   right in, so every other page reads as a different part of the same brain. Seeded by route,
   so each page keeps its own view. The filaments are painted once to an offscreen layer; on top
   of it, pulses travel along them the way they do on the brain, a few at a time, more when the
   platform does something. Public API: window.Veins.start(), .setRoute(name), .fire(n). */
(function () {
  "use strict";
  var cv, ctx, layer, lctx, route = "", w = 0, h = 0, dpr = 1;
  var paths = [], pulses = [], running = false, last = 0, spawnAcc = 0;
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // the brain's own palette
  var TEAL = [15, 158, 77], CYAN = [92, 255, 143];   // green, to match the brain
  var MAX_PULSES = 22, AMBIENT = 2.2;   // pulses per second at rest

  function rng(seed) {
    var s = 0;
    for (var i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
    s = s || 1;
    return function () { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
  }

  // one filament, and its fork: returns the points so pulses can run along them later
  function stroke(r, x, y, ang, len, width, alpha, depth) {
    var steps = 16 + Math.floor(r() * 16), seg = len / steps, curl = (r() - 0.5) * 0.16, mix = r();
    var col = [Math.round(TEAL[0] + (CYAN[0] - TEAL[0]) * mix), Math.round(TEAL[1] + (CYAN[1] - TEAL[1]) * mix), Math.round(TEAL[2] + (CYAN[2] - TEAL[2]) * mix)];
    var pts = [[x, y]], nodes = [];
    for (var i = 0; i < steps; i++) {
      ang += curl + (r() - 0.5) * 0.10;
      x += Math.cos(ang) * seg; y += Math.sin(ang) * seg;
      pts.push([x, y]);
      if (r() > 0.94) nodes.push([x, y]);
    }
    paths.push({ pts: pts, nodes: nodes, col: col, width: width, alpha: alpha });
    if (depth < 2 && r() > 0.45) stroke(r, x, y, ang + (r() - 0.5) * 1.5, len * (0.4 + r() * 0.3), width * 0.72, alpha * 0.85, depth + 1);
  }

  function build() {
    paths = []; pulses = [];
    var r = rng(route || "brain");
    var originX = w * (-0.35 + r() * 1.7), originY = h * (-0.3 + r() * 1.6);
    var spread = 0.6 + r() * 2.2, base = 0.5 + r() * 0.6;
    for (var i = 0; i < 78; i++) {
      var ang = r() * 6.283;
      stroke(r, originX + Math.cos(ang) * w * 0.06 * r(), originY + Math.sin(ang) * h * 0.06 * r(), ang * spread,
        (0.35 + r() * 0.95) * Math.max(w, h) * base, 0.6 + r() * 1.0, 0.16 + r() * 0.16, 0);
    }
  }

  // the still layer: every filament and its nodes, painted once
  function paintLayer() {
    layer.width = cv.width; layer.height = cv.height;
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lctx.clearRect(0, 0, w, h);
    lctx.lineCap = "round";
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i], c = p.col;
      lctx.beginPath(); lctx.moveTo(p.pts[0][0], p.pts[0][1]);
      for (var k = 1; k < p.pts.length; k++) lctx.lineTo(p.pts[k][0], p.pts[k][1]);
      lctx.strokeStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + p.alpha.toFixed(3) + ")";
      lctx.lineWidth = p.width; lctx.stroke();
      lctx.fillStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + Math.min(0.9, p.alpha * 2.8).toFixed(3) + ")";
      for (var n = 0; n < p.nodes.length; n++) { lctx.beginPath(); lctx.arc(p.nodes[n][0], p.nodes[n][1], p.width * 0.95, 0, 6.283); lctx.fill(); }
    }
  }

  // the brain's pulse colours: cyan-white for most, the warm one for a few, as on the stem
  var CW = [178, 255, 199], OW = [255, 255, 255];
  var TRAIL = 6;
  function spawn() {
    if (!paths.length || pulses.length >= MAX_PULSES) return;
    var p = paths[Math.floor(Math.random() * paths.length)];
    pulses.push({ p: p, t: 0, speed: 0.18 + Math.random() * 0.26, back: Math.random() < 0.3, warm: Math.random() < 0.15, size: 0.85 + Math.random() * 0.5 });
  }

  // one soft orb, the same falloff as the sprite the brain uses: white core, quick fade, wide faint halo
  function orb(x, y, r, c, a) {
    if (a <= 0.003) return;
    var g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(255,255,255," + Math.min(1, a).toFixed(3) + ")");
    g.addColorStop(0.25, "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + (a * 0.7).toFixed(3) + ")");
    g.addColorStop(0.6, "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + (a * 0.15).toFixed(3) + ")");
    g.addColorStop(1, "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
  }

  // where along a path a fraction t lands
  function at(p, t) {
    var n = p.pts.length - 1, f = t * n, i = Math.min(n - 1, Math.floor(f)), u = f - i;
    var a = p.pts[i], b = p.pts[i + 1];
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  }

  function frame(now) {
    if (!running) return;
    var dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now;
    spawnAcc += dt * AMBIENT;
    while (spawnAcc >= 1) { spawn(); spawnAcc -= 1; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(layer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // pulses add light on top of one another, as the brain's additive sprites do
    ctx.globalCompositeOperation = "lighter";
    for (var i = pulses.length - 1; i >= 0; i--) {
      var q = pulses[i]; q.t += dt * q.speed;
      if (q.t >= 1) { pulses.splice(i, 1); continue; }
      var c = q.warm ? OW : CW;
      var fade = Math.sin(q.t * Math.PI);                    // in, bright, out: the brain's envelope
      var base = 9 * q.size * Math.max(0.8, q.p.width);
      for (var k = 0; k < TRAIL; k++) {
        var tk = Math.max(0, Math.min(1, q.t - k * 0.02)), tt = q.back ? 1 - tk : tk;
        var pt = at(q.p, tt);
        var strength = fade * (k === 0 ? 1.0 : 0.55 / k);
        orb(pt[0], pt[1], base * (k === 0 ? 1.0 : 0.72), c, strength);
      }
      // the wide halo that bloom gives the head on the brain
      var hp = at(q.p, q.back ? 1 - q.t : q.t);
      orb(hp[0], hp[1], base * 3.2, c, fade * 0.14);
    }
    ctx.globalCompositeOperation = "source-over";
    requestAnimationFrame(frame);
  }

  function paintStill() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(layer, 0, 0);
  }

  function rebuild() { build(); paintLayer(); if (!running) paintStill(); }

  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth; h = window.innerHeight;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = w + "px"; cv.style.height = h + "px";
    rebuild();
  }

  function run() { if (running || reduced) return; running = true; last = performance.now(); requestAnimationFrame(frame); }
  function stop() { running = false; }

  var Veins = {
    start: function () {
      if (cv) return Veins;
      cv = document.createElement("canvas"); cv.id = "veins"; cv.setAttribute("aria-hidden", "true");
      document.body.insertBefore(cv, document.body.firstChild);
      ctx = cv.getContext("2d");
      layer = document.createElement("canvas"); lctx = layer.getContext("2d");
      size();
      var t;
      window.addEventListener("resize", function () { clearTimeout(t); t = setTimeout(size, 160); });
      document.addEventListener("visibilitychange", function () { if (document.hidden) stop(); else run(); });
      run();
      return Veins;
    },
    setRoute: function (name) {
      if (name === route) return;
      route = name || "brain";
      rebuild();
    },
    // called when the platform does something: a burst of pulses, the same cue as the brain
    fire: function (n) { for (var i = 0; i < (n || 6); i++) spawn(); }
  };
  window.Veins = Veins;
})();
