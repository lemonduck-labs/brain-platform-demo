/* The Brain: a procedural 3D fibre-tract brain, frontal view, modelled on the reference render.
   Green tracts on black, a white core and stem, bloom, a resting breathe, and pulses that
   travel along fibres when the platform does something. Public API: window.Brain.
   Requires three.min.js and three-extras.js (EffectComposer, UnrealBloomPass, OrbitControls). */
(function () {
  "use strict";
  var T = window.THREE;
  if (!T) { console.warn("three.js missing"); return; }

  // ---------- tuning knobs ----------
  var FIBRES = 1400, SAMPLES = 48, MAX_PULSES = 420, TRAIL = 6;   // 1000 until 18 Sep; denser reads clearer straight on
  var SEED = 160926;                 // the same brain on every visit; change it for a different one
  var MIX = [                        // share of fibres per tract system, in order
    ["cortical", 0.32], ["projection", 0.26], ["callosal", 0.13], ["association", 0.08],
    ["radiation", 0.06], ["cerebellum", 0.07], ["core", 0.03], ["stem", 0.05]
  ];
  var BLOOM = { strength: 1.16, radius: 0.6, threshold: 0.2 };
  // green and white: the names are the original roles (outer tract, inner tract, core, core highlight)
  var CYAN = [0.36, 1.0, 0.56], TEAL = [0.06, 0.62, 0.3], ORANGE = [0.82, 0.94, 0.86], HOT = [1.0, 1.0, 1.0];
  // hemisphere shape: a superellipsoid per side, +x lateral, flattened against the midline
  var H = { cx: 0.3, cy: 0.08, ax: 0.74, ayUp: 0.84, ayDown: 0.8, az: 1.04, p: 2.5, fissure: 0.022 };
  var FIT = { halfW: 1.2, halfH: 1.14, centreY: -0.1 };

  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;

  var scene, camera, renderer, composer, controls, root, bloomPass;
  var fibrePts = [], fibreKind = [];
  var pulses = [], pulseGeo, pulsePos, pulseCol;
  var ambientRate = 7, activity = 0.25;
  var clock, running = false, container, tPrev = 0, spawnAcc = 0;
  var matPts, matLines, halos = [];

  // ---------- helpers ----------
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 0x100000000; }; }
  var rng = mulberry32(SEED);
  var rand = function (a, b) { return a + rng() * (b - a); };
  var randn = function () { var u = 1 - rng(), v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var clamp = function (x, a, b) { return Math.max(a, Math.min(b, x)); };
  var V = function (x, y, z) { return new T.Vector3(x, y, z); };
  function unit() { var x = randn(), y = randn(), z = randn(), l = Math.sqrt(x * x + y * y + z * z) || 1; return [x / l, y / l, z / l]; }
  function norm(v) { var l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
  function tangentOf(u) { var r = unit(), d = r[0] * u[0] + r[1] * u[1] + r[2] * u[2]; return norm([r[0] - d * u[0], r[1] - d * u[1], r[2] - d * u[2]]); }

  function softSprite(size) {
    var c = document.createElement("canvas"); c.width = c.height = size;
    var g = c.getContext("2d");
    var grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.25, "rgba(255,255,255,0.7)");
    grd.addColorStop(0.6, "rgba(255,255,255,0.15)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd; g.fillRect(0, 0, size, size);
    var tex = new T.CanvasTexture(c); tex.needsUpdate = true; return tex;
  }

  // gyral relief: a few plane waves over the unit sphere, so there is no pole to pinch
  var GY = [];
  for (var gi = 0; gi < 10; gi++) { var gd = unit(); GY.push({ d: gd, f: gi < 6 ? rand(3.4, 6) : rand(9, 14), p: rand(0, 6.283), a: gi < 6 ? 0.014 : 0.006 }); }
  function gyri(ux, uy, uz) { var s = 0; for (var i = 0; i < GY.length; i++) { var g = GY[i]; s += g.a * Math.sin((ux * g.d[0] + uy * g.d[1] + uz * g.d[2]) * g.f + g.p); } return s; }

  // A point on one hemisphere's cortex along unit direction u (hemisphere-local, +x lateral).
  function hemi(side, ux, uy, uz, inset) {
    var ay = uy >= 0 ? H.ayUp : H.ayDown;
    var s = Math.pow(Math.pow(Math.abs(ux) / H.ax, H.p) + Math.pow(Math.abs(uy) / ay, H.p) + Math.pow(Math.abs(uz) / H.az, H.p), -1 / H.p);
    s *= (1 + gyri(ux * side, uy, uz)) * (inset || 1);
    var x = H.cx + ux * s, y = H.cy + uy * s, z = uz * s;
    // medial wall sits against the longitudinal fissure
    if (x < H.fissure) x = H.fissure + (H.fissure - x) * 0.04;
    // the superior margin rounds into the fissure
    var m = clamp(1 - (x - H.fissure) / 0.22, 0, 1), hi = clamp((y - H.cy - 0.32) / 0.5, 0, 1);
    y -= 0.13 * m * m * hi;
    // underside: temporal lobes hang lower than the frontal base
    if (y < H.cy) {
      var depth = 0.52 + 0.48 * Math.exp(-Math.pow((x - 0.64) / 0.27, 2));
      y = H.cy + (y - H.cy) * depth;
      if (y < -0.5) y = -0.5 - (-0.5 - y) * 0.55;
    }
    // lateral face: a shallow Sylvian notch over the temporal lobe
    var lat = clamp((x - 0.52) / 0.5, 0, 1);
    x -= 0.045 * lat * Math.exp(-Math.pow((y - (H.cy - 0.1)) / 0.07, 2));
    x += 0.075 * lat * Math.exp(-Math.pow((y - (H.cy - 0.34)) / 0.17, 2));
    return V(side * x, y, z);
  }
  function cortex(side, accept) {
    for (var tries = 0; tries < 80; tries++) {
      var u = unit();
      if (accept && !accept(u)) continue;
      var p = hemi(side, u[0], u[1], u[2], 1);
      if (Math.abs(p.x) < 0.07 && rng() > 0.12) continue;   // keep the flat medial wall sparse
      if (u[1] < -0.78 && rng() > 0.5) continue;             // and the underside
      return { u: u, p: p };
    }
    return { u: [1, 0, 0], p: hemi(side, 1, 0, 0, 1) };
  }
  function along(side, u, t, amount, inset) { var v = norm([u[0] + t[0] * amount, u[1] + t[1] * amount, u[2] + t[2] * amount]); return hemi(side, v[0], v[1], v[2], inset); }

  // ---------- tract systems ----------
  function buildFibre(kind) {
    var side = rng() < 0.5 ? -1 : 1, pts, noise = 0.02, c, u, t, k;
    if (kind === "cortical") {
      // short U-fibres under the cortex: they draw the silhouette and the gyri
      c = cortex(side); u = c.u; t = tangentOf(u);
      var len = rand(0.16, 0.5); pts = [];
      for (k = 0; k <= 4; k++) pts.push(along(side, u, t, len * (k / 4 - 0.5), (1 - 0.075 * Math.sin(Math.PI * k / 4)) * rand(0.99, 1.005)));
      noise = 0.008;
    } else if (kind === "projection") {
      // corona radiata: brainstem, cerebral peduncle, internal capsule, then a fan onto the cortex
      c = cortex(side, function (v) { return v[1] > -0.2; }); u = c.u; t = tangentOf(u);
      var sz = rand(-0.08, 0.08), end = hemi(side, u[0], u[1], u[2], 0.975);
      pts = [];
      if (rng() < 0.45) pts.push(V(rand(-0.075, 0.075), rand(-1.12, -0.95), sz * 0.6 - 0.02), V(rand(-0.08, 0.08), rand(-0.78, -0.68), sz + 0.06));
      pts.push(V(side * rand(0.03, 0.1), rand(-0.5, -0.4), sz + 0.03));
      var cap = V(side * rand(0.13, 0.25), rand(-0.28, -0.1), end.z * 0.22 + sz);
      pts.push(cap);
      var mid = new T.Vector3().lerpVectors(cap, end, rand(0.45, 0.6)); mid.x += side * rand(0.0, 0.1); mid.y += rand(0.02, 0.1);
      pts.push(mid, end, along(side, u, t, rand(0.06, 0.14), 1));
      noise = 0.02;
    } else if (kind === "callosal") {
      // corpus callosum: cortex to cortex across the midline, low at the centre
      c = cortex(-1, function (v) { return v[1] > -0.05 && v[0] > -0.3; }); u = c.u;
      var pL = c.p, uR = norm([u[0] + rand(-0.14, 0.14), u[1] + rand(-0.12, 0.12), u[2] + rand(-0.16, 0.16)]), pR = hemi(1, uR[0], uR[1], uR[2], 1);
      var zm = (pL.z + pR.z) * 0.35, ym = rand(0.1, 0.26);
      pts = [pL, V(pL.x * 0.55, lerp(pL.y, ym + 0.07, 0.62), lerp(pL.z, zm, 0.5)), V(-0.15, ym + 0.02, zm), V(0, ym, zm), V(0.15, ym + 0.02, zm), V(pR.x * 0.55, lerp(pR.y, ym + 0.07, 0.62), lerp(pR.z, zm, 0.5)), pR];
      side = 0; noise = 0.016;
    } else if (kind === "association") {
      var pick = rng();
      if (pick < 0.35) {
        // inferior longitudinal and uncinate fibres: front to back through the temporal lobe
        var tj = rand(-0.08, 0.08), tdirs = [[0.62, -0.5 + tj, 0.7], [0.88, -0.42 + tj, 0.25], [0.86, -0.36 + tj, -0.3], [0.55, -0.3 + tj, -0.85]];
        var tins = rand(0.8, 0.92);
        pts = tdirs.map(function (d) { var v = norm([d[0] + rand(-0.05, 0.05), d[1] + rand(-0.05, 0.05), d[2] + rand(-0.06, 0.06)]); return hemi(side, v[0], v[1], v[2], tins); });
      } else if (pick < 0.55) {
        // cingulum: front to back above the callosum, close to the midline
        var cx = side * rand(0.06, 0.15), cy0 = rand(0.3, 0.44);
        pts = [V(cx, cy0 - 0.2, rand(0.62, 0.78)), V(cx, cy0 + 0.02, 0.3), V(cx * 1.1, cy0 + 0.05, -0.15), V(cx, cy0 - 0.05, -0.62), V(cx * 0.9, cy0 - 0.34, -0.72)];
      } else {
        // arcuate and superior longitudinal fibres: an arc round the lateral sulcus into the temporal lobe
        var ins = rand(0.78, 0.9), jy = rand(-0.12, 0.14), dirs = [[0.5, 0.3 + jy, 0.8], [0.85, 0.42 + jy, 0.15], [0.62, 0.22 + jy, -0.75], [0.8, -0.3, -0.5], [0.72, -0.5, 0.45]];
        pts = dirs.map(function (d) { var v = norm([d[0] + rand(-0.06, 0.06), d[1] + rand(-0.05, 0.05), d[2] + rand(-0.08, 0.08)]); return hemi(side, v[0], v[1], v[2], ins); });
      }
      noise = 0.018;
    } else if (kind === "radiation") {
      // thalamic and optic radiations: from the thalamus out to the temporal and occipital cortex
      c = cortex(side, function (v) { return v[1] < 0.2 && (v[0] > 0.25 || v[2] < -0.35); }); u = c.u;
      var th = V(side * rand(0.07, 0.16), rand(-0.2, -0.05), rand(-0.12, 0.08)), en = hemi(side, u[0], u[1], u[2], 0.97);
      var md = new T.Vector3().lerpVectors(th, en, 0.5); md.x += side * rand(0.05, 0.14); md.y += rand(-0.06, 0.04);
      pts = [th, md, en];
      noise = 0.02;
    } else if (kind === "cerebellum") {
      var ccx = side * 0.31, ccy = -0.8, ccz = -0.6, rx = 0.33, ry = 0.19, rz = 0.27;
      if (rng() < 0.2) {
        // middle cerebellar peduncle, into the pons
        pts = [V(side * rand(0.06, 0.12), rand(-0.8, -0.68), rand(-0.08, 0.04)), V(side * rand(0.18, 0.24), -0.78, -0.3), V(ccx, ccy + rand(-0.05, 0.08), ccz + 0.12)];
      } else {
        // arbor vitae: white matter branching from the peduncle out into the folia
        var lo = rand(-2.2, 1.6), la2 = rand(-0.75, 0.65), cl2 = Math.sqrt(1 - la2 * la2);
        var tip = V(ccx + side * rx * cl2 * Math.cos(lo), ccy + ry * la2, ccz + rz * cl2 * Math.sin(lo));
        var root0 = V(side * rand(0.12, 0.18), ccy + rand(-0.03, 0.05), ccz + 0.25);
        var bend = new T.Vector3().lerpVectors(root0, tip, 0.55); bend.y += rand(-0.05, 0.05);
        var lo2 = lo + rand(-0.35, 0.35), la3 = clamp(la2 + rand(-0.15, 0.15), -0.9, 0.9), cl3 = Math.sqrt(1 - la3 * la3);
        pts = [root0, bend, tip, V(ccx + side * rx * cl3 * Math.cos(lo2) * 0.98, ccy + ry * la3, ccz + rz * cl3 * Math.sin(lo2) * 0.98)];
      }
      noise = 0.01;
    } else if (kind === "core") {
      // thalamus and basal ganglia: short curved bundles that make the warm core glow
      var a0 = rand(0, 6.283), sweep = rand(2.0, 3.2), rr = rand(0.1, 0.2), ccy2 = rand(-0.24, -0.1), ccx2 = side * rand(0.08, 0.16), ccz2 = rand(-0.1, 0.1); pts = [];
      for (k = 0; k <= 6; k++) { var aa = a0 + (k / 6) * sweep; pts.push(V(ccx2 + side * Math.cos(aa) * rr * 0.75, ccy2 + Math.sin(aa) * rr * 0.55, ccz2 + Math.sin(aa) * rr * 0.9)); }
      noise = 0.005;
    } else {
      // brainstem: one column (medulla, pons, midbrain) that splits into the peduncles at the top
      var sx = rand(-0.1, 0.1), sz2 = rand(-0.06, 0.1);
      pts = [V(sx * 0.7, -1.15, sz2 * 0.5 - 0.04), V(sx * 0.9, -0.96, sz2), V(sx * 1.25, -0.75, sz2 + 0.07), V(sx * 0.95, -0.55, sz2), V((sx >= 0 ? 1 : -1) * rand(0.06, 0.16), rand(-0.4, -0.26), sz2 * 0.5)];
      noise = 0.012;
    }
    var curve = new T.CatmullRomCurve3(pts, false, "catmullrom", 0.5);
    var arr = new Float32Array(SAMPLES * 3), wobble = rand(2, 6), phase = rand(0, 6.28), p = new T.Vector3();
    for (var i = 0; i < SAMPLES; i++) {
      var tt = i / (SAMPLES - 1);
      curve.getPoint(tt, p);
      var w = Math.sin(tt * wobble + phase) * noise * (1 - Math.abs(tt - 0.5) * 1.6);
      arr[i * 3] = p.x + w + randn() * noise * 0.18;
      arr[i * 3 + 1] = p.y + randn() * noise * 0.18;
      arr[i * 3 + 2] = p.z + w * 0.6 + randn() * noise * 0.18;
    }
    return arr;
  }

  // warm at the core and stem, teal through the white matter, cyan at the cortex
  function warmth(x, y, z, kind) {
    if (kind === "stem") return 0.9;
    if (kind === "cerebellum") return 0;
    if (kind === "core") return 0.85;
    var ax = Math.abs(x), dy = y > -0.08 ? (y + 0.08) / 0.24 : 0;
    var d = Math.sqrt((ax / 0.42) * (ax / 0.42) + dy * dy + (z / 0.5) * (z / 0.5) * 0.6);
    if (y < -0.4) d *= 0.6;
    return clamp(1 - d, 0, 1);
  }
  function colourFor(kind, x, y, z, fb, out) {
    var dc = Math.sqrt(x * x + (y + 0.2) * (y + 0.2) + z * z * 0.5);
    var far = clamp((dc - 0.3) / 0.7, 0, 1);
    var r = lerp(TEAL[0], CYAN[0], far), g = lerp(TEAL[1], CYAN[1], far), b = lerp(TEAL[2], CYAN[2], far);
    var w = warmth(x, y, z, kind), w1 = Math.pow(w, 1.2), w3 = Math.pow(w, 3);
    r = lerp(r, ORANGE[0], w1); g = lerp(g, ORANGE[1], w1); b = lerp(b, ORANGE[2], w1);
    r = lerp(r, HOT[0], w3); g = lerp(g, HOT[1], w3); b = lerp(b, HOT[2], w3);
    var bright = fb * (0.62 + 0.38 * far) * (kind === "stem" ? 0.58 : kind === "core" ? 0.62 : w > 0.5 ? 0.7 : 1) * (kind === "cerebellum" ? 0.62 : 1);
    if (kind === "callosal") bright *= 0.55 + 0.45 * clamp(Math.abs(x) / 0.35, 0, 1);
    if (kind === "association") bright *= 0.72;
    out[0] = r * bright; out[1] = g * bright; out[2] = b * bright;
  }

  function buildGeometry() {
    var kinds = [], acc = 0, mi = 0;
    for (var i = 0; i < FIBRES; i++) {
      while (mi < MIX.length - 1 && i >= Math.round((acc + MIX[mi][1]) * FIBRES)) { acc += MIX[mi][1]; mi++; }
      kinds.push(MIX[mi][0]);
    }
    var ptsPos = new Float32Array(FIBRES * SAMPLES * 3), ptsCol = new Float32Array(FIBRES * SAMPLES * 3);
    var linePos = new Float32Array(FIBRES * (SAMPLES - 1) * 6), lineCol = new Float32Array(FIBRES * (SAMPLES - 1) * 6);
    var col = [0, 0, 0], lp = 0;
    for (var f = 0; f < FIBRES; f++) {
      var arr = buildFibre(kinds[f]), fb = rand(0.55, 1.0);
      fibrePts.push(arr); fibreKind.push(kinds[f]);
      for (var s = 0; s < SAMPLES; s++) {
        var o = (f * SAMPLES + s) * 3;
        ptsPos[o] = arr[s * 3]; ptsPos[o + 1] = arr[s * 3 + 1]; ptsPos[o + 2] = arr[s * 3 + 2];
        colourFor(kinds[f], arr[s * 3], arr[s * 3 + 1], arr[s * 3 + 2], fb, col);
        ptsCol[o] = col[0]; ptsCol[o + 1] = col[1]; ptsCol[o + 2] = col[2];
        if (s < SAMPLES - 1) {
          for (var q = 0; q < 3; q++) { linePos[lp + q] = arr[s * 3 + q]; linePos[lp + 3 + q] = arr[s * 3 + 3 + q]; lineCol[lp + q] = col[q]; lineCol[lp + 3 + q] = col[q]; }
          lp += 6;
        }
      }
    }
    var pg = new T.BufferGeometry();
    pg.setAttribute("position", new T.BufferAttribute(ptsPos, 3));
    pg.setAttribute("color", new T.BufferAttribute(ptsCol, 3));
    matPts = new T.PointsMaterial({ size: 0.016, map: softSprite(64), vertexColors: true, transparent: true, opacity: 0.52, depthWrite: false, blending: T.AdditiveBlending, sizeAttenuation: true });
    var lg = new T.BufferGeometry();
    lg.setAttribute("position", new T.BufferAttribute(linePos, 3));
    lg.setAttribute("color", new T.BufferAttribute(lineCol, 3));
    matLines = new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.33, depthWrite: false, blending: T.AdditiveBlending });
    root = new T.Group();
    root.add(new T.LineSegments(lg, matLines)); root.add(new T.Points(pg, matPts));
    // a soft warm glow behind the core and the stem
    var haloTex = softSprite(128);
    [[0, -0.2, 0, 1.0, 0.13], [0, -0.78, 0, 0.6, 0.08]].forEach(function (hh) {
      var sp = new T.Sprite(new T.SpriteMaterial({ map: haloTex, color: new T.Color(0.8, 1.0, 0.86), transparent: true, opacity: hh[4], depthWrite: false, blending: T.AdditiveBlending }));
      sp.position.set(hh[0], hh[1], hh[2]); sp.scale.set(hh[3], hh[3], 1); sp.userData.base = hh[4];
      halos.push(sp); root.add(sp);
    });

    pulseGeo = new T.BufferGeometry();
    pulsePos = new Float32Array(MAX_PULSES * TRAIL * 3); pulseCol = new Float32Array(MAX_PULSES * TRAIL * 3);
    pulseGeo.setAttribute("position", new T.BufferAttribute(pulsePos, 3));
    pulseGeo.setAttribute("color", new T.BufferAttribute(pulseCol, 3));
    var pp = new T.Points(pulseGeo, new T.PointsMaterial({ size: 0.085, map: softSprite(64), vertexColors: true, transparent: true, opacity: 1, depthWrite: false, blending: T.AdditiveBlending }));
    pp.frustumCulled = false;
    root.add(pp);
    for (var k = 0; k < MAX_PULSES * TRAIL; k++) pulsePos[k * 3 + 1] = 99;
    scene.add(root);
  }

  // ---------- pulses ----------
  var REGION = { stem: { stem: 1, projection: 1, core: 1 }, cortex: { projection: 1, association: 1, radiation: 1, cortical: 1 }, cross: { callosal: 1 } };
  function spawn(opts) {
    if (pulses.length >= MAX_PULSES) return;
    var region = opts.region || "all", want = REGION[region], f, tries = 0;
    do { f = Math.floor(Math.random() * FIBRES); tries++; } while (want && !want[fibreKind[f]] && tries < 30);
    var kind = fibreKind[f];
    var back = kind === "callosal" ? Math.random() < 0.5 : kind === "cortical" ? Math.random() < 0.5 : Math.random() < 0.18;
    var v = (kind === "cortical" ? 1.6 : 1) * (0.32 + Math.random() * 0.55) * (opts.speed || 1);
    pulses.push({ f: f, t: 0, v: v, back: back, tint: opts.tint || "auto" });
  }
  var CW = [0.7, 1.0, 0.78], OW = [1.0, 1.0, 1.0], WW = [0.95, 1.0, 0.97];
  function step(dt, time) {
    var rate = reduced ? 0 : ambientRate * (0.4 + activity * 2.2);
    spawnAcc += rate * dt;
    while (spawnAcc >= 1) { spawn({ region: Math.random() < 0.35 ? "stem" : "all" }); spawnAcc -= 1; }
    activity = Math.max(0.25, activity - dt * 0.12);
    var alive = 0;
    for (var i = 0; i < pulses.length; i++) {
      var p = pulses[i];
      p.t += p.v * dt;
      if (p.t >= 1) continue;
      var arr = fibrePts[p.f], fade = Math.sin(p.t * Math.PI), c = null;
      for (var q = 0; q < TRAIL; q++) {
        // head first, then a short tail behind it along the fibre
        var tq = clamp(p.t - q * 0.02, 0, 1), tt = p.back ? 1 - tq : tq;
        var s = tt * (SAMPLES - 1), i0 = Math.floor(s), i1 = Math.min(SAMPLES - 1, i0 + 1), fr = s - i0, o = (alive * TRAIL + q) * 3;
        var x = lerp(arr[i0 * 3], arr[i1 * 3], fr), y = lerp(arr[i0 * 3 + 1], arr[i1 * 3 + 1], fr), z = lerp(arr[i0 * 3 + 2], arr[i1 * 3 + 2], fr);
        pulsePos[o] = x; pulsePos[o + 1] = y; pulsePos[o + 2] = z;
        if (!c) {
          if (p.tint === "orange") c = OW; else if (p.tint === "white") c = WW;
          else { var w = warmth(x, y, z, fibreKind[p.f]); c = [lerp(CW[0], OW[0], w), lerp(CW[1], OW[1], w), lerp(CW[2], OW[2], w)]; }
        }
        var k2 = fade * (q === 0 ? 1.7 : 0.75 / q);
        pulseCol[o] = c[0] * k2; pulseCol[o + 1] = c[1] * k2; pulseCol[o + 2] = c[2] * k2;
      }
      pulses[alive] = p; alive++;
    }
    for (var j = alive * TRAIL; j < MAX_PULSES * TRAIL; j++) pulsePos[j * 3 + 1] = 99;
    pulses.length = alive;
    pulseGeo.attributes.position.needsUpdate = true;
    pulseGeo.attributes.color.needsUpdate = true;

    root.scale.setScalar(1 + 0.012 * Math.sin(time * 0.9));
    if (!reduced) { root.rotation.y = Math.sin(time * 0.11) * 0.16; root.rotation.x = Math.sin(time * 0.07) * 0.03; }
    // information moving through the vault lifts the whole brain, then it settles back to rest
    var surge = activity - 0.25;
    matPts.opacity = 0.56 + 0.06 * Math.sin(time * 0.9) + surge * 0.16;
    matLines.opacity = 0.36 + 0.04 * Math.sin(time * 0.9 + 1) + surge * 0.09;
    if (bloomPass) bloomPass.strength = BLOOM.strength + surge * 0.38;
    for (var hq = 0; hq < halos.length; hq++) halos[hq].material.opacity = halos[hq].userData.base * (0.9 + 0.15 * Math.sin(time * 0.9) + surge * 0.8);
  }

  function frame() {
    if (!running) return;
    requestAnimationFrame(frame);
    var t = clock.getElapsedTime(), dt = Math.min(0.05, t - tPrev); tPrev = t;
    step(dt, t);
    if (controls) controls.update();
    if (composer) composer.render(); else renderer.render(scene, camera);
  }

  // keep the whole brain in frame at any aspect; on tall screens it sits lower, under the headline
  function fit(w, h) {
    var aspect = w / h, tanV = Math.tan((camera.fov / 2) * Math.PI / 180);
    var dist = Math.max(FIT.halfH / tanV, FIT.halfW / (tanV * aspect)) * 1.10;
    var ty = FIT.centreY + (aspect < 1 ? dist * tanV * 0.2 : dist * tanV * 0.045);
    var target = controls ? controls.target : new T.Vector3();
    var dir = camera.position.clone().sub(target); if (dir.lengthSq() < 1e-6) dir.set(0, 0.02, 1);
    target.set(0, ty, 0);
    camera.position.copy(target).add(dir.normalize().multiplyScalar(dist));
    camera.lookAt(target);
  }
  // The canvas is mounted while the gate is still up, so the container can measure zero and
  // the renderer would sit at 1x1 forever: window resize never fires on its own afterwards.
  // A ResizeObserver catches the moment the hero actually gets a size, and every change after.
  var lastW = 0, lastH = 0;
  function resize() {
    if (!container) return;
    var w = Math.round(container.clientWidth), h = Math.round(container.clientHeight);
    if (w < 8 || h < 8) return;
    if (w === lastW && h === lastH) return;
    lastW = w; lastH = h;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    fit(w, h);
    renderer.setSize(w, h, false);
    if (composer) composer.setSize(w, h);
    if (bloomPass && bloomPass.setSize) bloomPass.setSize(w, h);
  }

  var Brain = {
    mount: function (el) {
      container = el;
      scene = new T.Scene(); scene.background = new T.Color(0x000000);
      camera = new T.PerspectiveCamera(36, 1, 0.1, 60);
      camera.position.set(0, -0.08, 3.7);
      renderer = new T.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
      renderer.setClearColor(0x000000, 1);
      var canvas = renderer.domElement; canvas.setAttribute("aria-hidden", "true");
      el.appendChild(canvas);
      buildGeometry();
      if (T.EffectComposer && T.RenderPass && T.UnrealBloomPass) {
        composer = new T.EffectComposer(renderer);
        composer.addPass(new T.RenderPass(scene, camera));
        bloomPass = new T.UnrealBloomPass(new T.Vector2(el.clientWidth || 1, el.clientHeight || 1), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
        composer.addPass(bloomPass);
      }
      if (T.OrbitControls) {
        controls = new T.OrbitControls(camera, canvas);
        controls.enableZoom = false; controls.enablePan = false; controls.enableDamping = true; controls.dampingFactor = 0.06;
        controls.minPolarAngle = Math.PI * 0.3; controls.maxPolarAngle = Math.PI * 0.7;
        controls.minAzimuthAngle = -0.9; controls.maxAzimuthAngle = 0.9;
        controls.rotateSpeed = 0.5;
        // on touch screens a vertical swipe still scrolls the page; a sideways drag turns the brain
        if (coarse) canvas.style.touchAction = "pan-y";
      }
      clock = new T.Clock();
      resize();
      window.addEventListener("resize", resize);
      if (window.ResizeObserver) { try { new ResizeObserver(resize).observe(el); } catch (e) {} }
      // belt and braces for browsers that fire the observer before layout settles
      [50, 250, 800, 2000].forEach(function (ms) { setTimeout(resize, ms); });
      document.addEventListener("visibilitychange", function () { if (document.hidden) { running = false; } else if (!running) { running = true; tPrev = clock.getElapsedTime(); frame(); } });
      running = true; frame();
      return Brain;
    },
    fire: function (opts) {
      opts = opts || {};
      var n = opts.count || 20;
      activity = Math.min(1, activity + (opts.boost || 0.35));
      for (var i = 0; i < n; i++) spawn(opts);
    },
    setActivity: function (v) { activity = clamp(v, 0, 1); },
    stats: function () { return { fibres: FIBRES, pulses: pulses.length, activity: activity }; }
  };
  window.Brain = Brain;
})();
