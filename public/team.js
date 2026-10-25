/* Team: the agent roster read from System/Agents/*.md, drawn around a small brain glyph and
   joined to it by vein lines in veins.js's own style (the same random-walk filament, the same
   soft additive orb, the same cyan/teal/warm palette). Heads the roster in the Team area (it
   lived at the top of Runs until the command centre build). A node whose agent holds a live
   claim in the lock ledger carries the "holding" class and pulses.

   Motion is driven only by real events app.js hands to Team.event() after it has actually seen
   them in /api/state or in chat: a run logging, an approval's status changing, a new vault
   commit, a Brain reply landing. Nothing in this file invents activity on its own; the ambient
   idle drift on a node is a CSS animation, not a synthetic "still working" signal, and it stops
   under prefers-reduced-motion the same way the rest of the page does.

   Public API: window.Team.mount(opts), .render(agents), .replay(events), .event(evt).
   opts.onAgentClick(agent) is called when a node (canvas or the static-list fallback) is
   activated by click or keyboard. */
(function () {
  "use strict";
  var reducedQuery = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
  var reduced = !!(reducedQuery && reducedQuery.matches);
  var PHONE_WIDTH = 480; // matches the tightest breakpoint already used elsewhere on this page

  var stage, cv, ctx, nodesHost, staticHost, emptyEl;
  var replayWrap, replayRange, replayTicks, replayEvent, replayCount, liveEl;
  var w = 0, h = 0, dpr = 1, phone = false;
  var agents = [], byId = {};
  var veins = {};      // agent id -> [[x,y], ...] path from its node to the brain, in canvas px
  var pulses = [];      // travelling dots: { path, t, speed, colour, onArrive }
  var running = false, rafId = 0, lastT = 0;
  var brainGlow = 0, brainTint = [69, 208, 232]; // decays back to resting cyan
  var onAgentClick = function () {};
  var events = [];       // the last 24h, for the replay strip
  var scrubAt = null;    // Date currently shown by the scrub handle, or null = live (now)

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function debounce(fn, ms) { var t; return function () { clearTimeout(t); var a = arguments; t = setTimeout(function () { fn.apply(null, a); }, ms); }; }

  // ---------- a tiny seeded PRNG, string-seeded, the same shape veins.js uses, so a given
  // node's vein always draws the same way between one render and the next ----------
  function rng(seed) {
    var s = 0;
    for (var i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
    s = s || 1;
    return function () { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
  }

  // one filament between two points: not a straight line, a gentle seeded S-curve, so the
  // canvas keeps reading as the same fibrous style as the brain hero and the page background
  function buildVein(x0, y0, x1, y1, seed) {
    var r = rng(seed);
    var steps = 16, pts = [];
    var dx = x1 - x0, dy = y1 - y0, len = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = -dy / len, ny = dx / len;
    var amp = Math.min(w, h) * (0.018 + r() * 0.022);
    var freq = 1.1 + r() * 1.3, phase = r() * 6.283;
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var bx = x0 + dx * t, by = y0 + dy * t;
      var wob = Math.sin(t * Math.PI) * Math.sin(t * freq * 6.283 + phase) * amp;
      pts.push([bx + nx * wob, by + ny * wob]);
    }
    return pts;
  }

  // where along a path a fraction t lands (same shape as veins.js's own at())
  function at(path, t) {
    var n = path.length - 1, f = clamp(t, 0, 1) * n, i = Math.min(n - 1, Math.floor(f)), u = f - i;
    var a = path[i], b = path[i + 1];
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  }

  // one soft additive orb: white core, quick fade, wide faint halo (veins.js's own orb())
  function orb(x, y, r, c, a) {
    if (a <= 0.003 || !ctx) return;
    var g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(255,255,255," + Math.min(1, a).toFixed(3) + ")");
    g.addColorStop(0.25, "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + (a * 0.7).toFixed(3) + ")");
    g.addColorStop(0.6, "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + (a * 0.15).toFixed(3) + ")");
    g.addColorStop(1, "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
  }

  function hexToRgb(hex) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return [69, 208, 232];
    var h6 = m[1].length === 3 ? m[1].split("").map(function (c) { return c + c; }).join("") : m[1];
    var n = parseInt(h6, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // ---------- layout: agents evenly spaced on a ring around the centre ----------
  function layout() {
    var cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.36, n = agents.length;
    veins = {};
    agents.forEach(function (a, i) {
      var ang = -Math.PI / 2 + (n ? (i / n) * Math.PI * 2 : 0);
      a._x = cx + Math.cos(ang) * r;
      a._y = cy + Math.sin(ang) * r;
      veins[a.id] = buildVein(a._x, a._y, cx, cy, "v:" + a.id);
      positionNode(a);
    });
  }

  function positionNode(a) {
    var el = a._el; if (!el || !w || !h) return;
    el.style.left = ((a._x / w) * 100).toFixed(2) + "%";
    el.style.top = ((a._y / h) * 100).toFixed(2) + "%";
  }

  // ---------- DOM nodes ----------
  function rebuildNodes() {
    nodesHost.innerHTML = "";
    byId = {};
    agents.forEach(function (a, i) {
      byId[a.id] = a;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "team-node";
      btn.id = "teamNode-" + a.id;
      btn.setAttribute("role", "listitem");
      btn.style.setProperty("--agent-colour", a.colour || "#3DDC84");
      btn.style.setProperty("--drift-delay", (i * 0.6) + "s");
      btn.style.setProperty("--drift-dur", (7 + (i % 4) * 1.3) + "s");
      btn.setAttribute("aria-label", a.name + (a.roleText ? ". " + a.roleText : ""));
      btn.innerHTML = '<span class="team-node-dot"></span><span class="team-node-label"><b>' + esc(a.name) + '</b><small>' + esc(a.statusText || "") + "</small></span>";
      btn.classList.toggle("holding", !!a.live); // holds a live claim in the lock ledger
      btn.addEventListener("click", function () { onAgentClick(a); });
      nodesHost.appendChild(btn);
      a._el = btn;
    });
  }

  function updateNodeText() {
    agents.forEach(function (a) {
      if (!a._el) return;
      var small = a._el.querySelector("small");
      if (small) small.textContent = a.statusText || "";
      a._el.classList.toggle("holding", !!a.live);
      a._el.setAttribute("aria-label", a.name + (a.roleText ? ". " + a.roleText : ""));
    });
  }

  // ---------- static (phone-width / no-canvas) fallback: the same roster, no motion ----------
  function renderStatic() {
    staticHost.innerHTML = agents.map(function (a) {
      return '<li class="team-static-row" tabindex="0" role="listitem" data-id="' + esc(a.id) + '" style="--agent-colour:' + esc(a.colour || "#3DDC84") + '">'
        + '<span class="team-node-dot"></span><span class="team-static-text"><b>' + esc(a.name) + "</b><small>" + esc(a.statusText || "") + "</small></span></li>";
    }).join("");
    Array.prototype.forEach.call(staticHost.querySelectorAll(".team-static-row"), function (row) {
      var a = byId[row.dataset.id];
      if (!a) return;
      row.addEventListener("click", function () { onAgentClick(a); });
      row.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onAgentClick(a); } });
    });
  }

  // ---------- pulses ----------
  function spawnPulse(agentId, tint, onArrive) {
    var path = veins[agentId]; if (!path) return;
    pulses.push({ path: path, t: 0, speed: 0.42 + Math.random() * 0.12, colour: tint, onArrive: onArrive });
  }
  function spawnHandover(fromId, toId) {
    var a = byId[fromId], b = byId[toId]; if (!a || !b) return;
    var path = buildVein(a._x, a._y, b._x, b._y, "h:" + fromId + ":" + toId + ":" + Date.now());
    pulses.push({ path: path, t: 0, speed: 0.34, colour: hexToRgb(b.colour), toNode: b });
  }
  function nodeFlash(agent) {
    if (!agent || !agent._el) return;
    agent._el.classList.add("just-ran");
    clearTimeout(agent._flashTimer);
    agent._flashTimer = setTimeout(function () { if (agent._el) agent._el.classList.remove("just-ran"); }, 2600);
  }

  // ---------- frame ----------
  function frame(now) {
    if (!running) return;
    var dt = Math.min(0.05, (now - lastT) / 1000 || 0.016); lastT = now;
    draw(dt);
    rafId = requestAnimationFrame(frame);
  }
  function draw(dt) {
    if (!ctx || !w || !h) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // static filaments
    ctx.lineCap = "round";
    Object.keys(veins).forEach(function (id) {
      var a = byId[id]; if (!a) return;
      var p = veins[id], c = hexToRgb(a.colour);
      var recent = a._el && a._el.classList.contains("just-ran");
      ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]);
      for (var i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
      ctx.strokeStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + (recent ? 0.4 : 0.16) + ")";
      ctx.lineWidth = recent ? 1.6 : 1;
      ctx.stroke();
    });
    // the brain: a warm core with a thin cyan ring, brighter when something has just landed
    brainGlow = Math.max(0, brainGlow - dt * 0.5);
    var cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.09;
    ctx.globalCompositeOperation = "lighter";
    orb(cx, cy, r * (2.1 + brainGlow * 0.6), [255, 140, 70], 0.08 + brainGlow * 0.22);
    orb(cx, cy, r * (0.85 + brainGlow * 0.3), brainTint, 0.22 + brainGlow * 0.5);
    ctx.globalCompositeOperation = "source-over";
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.283);
    ctx.strokeStyle = "rgba(69,208,232," + (0.32 + brainGlow * 0.35).toFixed(3) + ")";
    ctx.lineWidth = 1.3; ctx.stroke();
    // pulses
    if (!reduced) {
      ctx.globalCompositeOperation = "lighter";
      for (var k = pulses.length - 1; k >= 0; k--) {
        var q = pulses[k]; q.t += dt * q.speed;
        if (q.t >= 1) {
          if (q.onArrive) q.onArrive();
          if (q.toNode) nodeFlash(q.toNode);
          pulses.splice(k, 1);
          continue;
        }
        var fade = Math.sin(q.t * Math.PI);
        for (var tr = 0; tr < 5; tr++) {
          var tt = clamp(q.t - tr * 0.025, 0, 1);
          var pt = at(q.path, tt);
          orb(pt[0], pt[1], 7 * (tr === 0 ? 1 : 0.65), q.colour, fade * (tr === 0 ? 1 : 0.4 / tr));
        }
      }
      ctx.globalCompositeOperation = "source-over";
    }
  }
  function startLoop() {
    if (running || reduced || !ctx) { if (reduced && ctx) draw(0); return; }
    running = true; lastT = performance.now();
    rafId = requestAnimationFrame(frame);
  }
  function stopLoop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // ---------- sizing ----------
  function checkPhone() { phone = window.innerWidth < PHONE_WIDTH; }
  function resize() {
    if (!stage) return;
    checkPhone();
    stage.hidden = phone;
    nodesHost.hidden = phone;
    staticHost.hidden = !phone;
    if (phone) { renderStatic(); return; }
    var rect = stage.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = Math.round(rect.width); h = Math.round(rect.height);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = w + "px"; cv.style.height = h + "px";
    layout();
    if (!running) draw(0);
  }

  // ---------- replay strip: last 24h, built fresh from real timestamped data each render ----------
  function paintReplay() {
    var now = Date.now(), since = now - 24 * 3600000;
    var recent = events.filter(function (e) { return e.at && e.at.getTime() >= since; });
    replayWrap.hidden = recent.length === 0;
    if (!recent.length) return;
    replayCount.textContent = recent.length + (recent.length === 1 ? " event" : " events");
    replayTicks.innerHTML = recent.map(function (e, i) {
      var pct = clamp(((e.at.getTime() - since) / (now - since)) * 100, 0, 100);
      return '<span class="team-replay-tick ' + e.type + '" style="left:' + pct.toFixed(2) + '%" data-i="' + i + '" title="' + esc(e.label) + '"></span>';
    }).join("");
    replayEvents = recent;
    if (scrubAt == null) showScrubLabel(recent[recent.length - 1]);
  }
  var replayEvents = [];
  function nearestEvent(t) {
    if (!replayEvents.length) return null;
    var best = replayEvents[0], bestD = Math.abs(replayEvents[0].at.getTime() - t);
    for (var i = 1; i < replayEvents.length; i++) {
      var d = Math.abs(replayEvents[i].at.getTime() - t);
      if (d < bestD) { best = replayEvents[i]; bestD = d; }
    }
    return best;
  }
  function agoLabel(d) {
    var m = Math.round((Date.now() - d.getTime()) / 60000);
    if (m < 1) return "just now"; if (m < 60) return m + " min ago";
    var hh = Math.round(m / 60); return hh < 36 ? hh + " h ago" : Math.round(hh / 24) + " d ago";
  }
  function showScrubLabel(e) {
    if (!e) { replayEvent.textContent = "Nothing in the last 24 hours yet."; return; }
    replayEvent.textContent = agoLabel(e.at) + ": " + e.label;
    (e.agentIds || []).forEach(function (id) {
      var a = byId[id]; if (!a || !a._el) return;
      a._el.classList.add("scrub-highlight");
      clearTimeout(a._scrubTimer);
      a._scrubTimer = setTimeout(function () { if (a._el) a._el.classList.remove("scrub-highlight"); }, 1800);
    });
  }
  function onScrub() {
    if (!replayEvents.length) return;
    var now = Date.now(), since = now - 24 * 3600000;
    var frac = Number(replayRange.value) / Number(replayRange.max);
    var t = since + frac * (now - since);
    scrubAt = t;
    showScrubLabel(nearestEvent(t));
  }

  // ---------- public events ----------
  function pushEvent(evt) {
    if (!evt || !evt.type) return;
    var at = evt.at instanceof Date ? evt.at : (evt.at ? new Date(evt.at) : new Date());
    if (isNaN(at.getTime())) at = new Date();
    var e = { type: evt.type, at: at, label: evt.label || "", agentIds: evt.agentIds || [] };
    events.push(e);
    if (events.length > 400) events.splice(0, events.length - 400);
    paintReplay();
    if (reduced) {
      // a state change still shows, just without a travelling pulse: a brief highlight instead
      (e.agentIds || []).forEach(function (id) { nodeFlash(byId[id]); });
      if (e.type !== "handover") brainGlow = Math.min(1, brainGlow + 0.5);
      draw(0);
      return;
    }
    if (e.type === "run") {
      (e.agentIds || []).forEach(function (id) {
        nodeFlash(byId[id]); // the node itself brightens as its pulse sets off
        spawnPulse(id, hexToRgb(byId[id] && byId[id].colour), function () { brainGlow = Math.min(1, brainGlow + 0.55); });
      });
    } else if (e.type === "handover" && e.agentIds.length === 2) {
      spawnHandover(e.agentIds[0], e.agentIds[1]);
    } else if (e.type === "approval") {
      brainTintPulse([224, 138, 92]);
    } else if (e.type === "chat" || e.type === "commit") {
      brainTintPulse([230, 245, 250]);
    }
  }
  function brainTintPulse(c) {
    brainTint = c; brainGlow = Math.min(1, brainGlow + 0.6);
    setTimeout(function () { brainTint = [69, 208, 232]; }, 1200);
  }

  // ---------- public: set/refresh the roster ----------
  function setAgents(list) {
    list = list || [];
    var sameSet = list.length === agents.length && list.every(function (a, i) { return agents[i] && agents[i].id === a.id; });
    if (sameSet) {
      // data-only refresh: keep the DOM nodes (and any mid-flight pulse or focus) in place
      list.forEach(function (a, i) { var prev = agents[i]; a._el = prev._el; a._x = prev._x; a._y = prev._y; });
      agents = list; byId = {}; agents.forEach(function (a) { byId[a.id] = a; });
      updateNodeText();
      if (phone) renderStatic();
      return;
    }
    agents = list;
    emptyEl.hidden = agents.length > 0;
    if (!agents.length) { nodesHost.innerHTML = ""; staticHost.innerHTML = ""; return; }
    rebuildNodes();
    if (phone) renderStatic();
    resize();
  }

  var Team = {
    mount: function (opts) {
      if (stage) return Team; // singleton: the Team page mounts this once
      stage = $("teamStage"); cv = $("teamCanvas"); nodesHost = $("teamNodes");
      staticHost = $("teamStatic"); emptyEl = $("teamEmpty");
      replayWrap = $("teamReplay"); replayRange = $("teamReplayRange");
      replayTicks = $("teamReplayTicks"); replayEvent = $("teamReplayEvent"); replayCount = $("teamReplayCount");
      liveEl = $("teamLive");
      if (!stage || !cv) return Team;
      ctx = cv.getContext("2d");
      onAgentClick = (opts && opts.onAgentClick) || function () {};
      window.addEventListener("resize", debounce(resize, 150));
      if (window.ResizeObserver) { try { new ResizeObserver(debounce(resize, 120)).observe(stage); } catch (e) {} }
      [50, 300, 900].forEach(function (ms) { setTimeout(resize, ms); });
      if (replayRange) replayRange.addEventListener("input", onScrub);
      if (reducedQuery && reducedQuery.addEventListener) reducedQuery.addEventListener("change", function (e) { reduced = e.matches; if (reduced) stopLoop(); else startLoop(); });
      document.addEventListener("visibilitychange", function () {
        if (document.hidden) { stopLoop(); if (liveEl) liveEl.textContent = ""; }
        else { startLoop(); if (liveEl) liveEl.textContent = "polling"; }
      });
      resize();
      startLoop();
      return Team;
    },
    render: function (list) { setAgents(list); },
    replay: function (list) { events = (list || []).slice(); paintReplay(); },
    event: function (evt) { pushEvent(evt); },
    setLive: function (on) { if (liveEl) liveEl.textContent = on ? "polling" : ""; },
    isPhone: function () { return phone; },
    // The stage sits inside the Team view, [hidden] until navigated to, and measures 0x0 until
    // then; a ResizeObserver on it catches that on its own (the same belt-and-braces brain.js
    // uses for its own hero), and this is the direct call route() makes for good measure.
    resize: function () { resize(); }
  };
  window.Team = Team;
})();
