/* build: 2026-09-18b estimates + settled */
/* The Brain platform: front end. Vanilla JS, hash routes, one state object from /api/state. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var state = null, key = null, currentNote = null, taskFilter = "all", showDone = false, taskQuery = "", brain = null, refreshTimer = null, showAllSettled = false, showSnoozed = false;
  var noteIndex = {}; // lower-case name/title/alias -> path
  var notesByPath = {}; // path -> the note object from state.notes (title, excerpt, links)

  // ---------- api ----------
  async function sha256(s) {
    var buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }
  async function api(path, opts) {
    opts = opts || {};
    var res = await fetch("/api/" + path, {
      method: opts.method || "GET",
      headers: Object.assign({ "x-brain-key": key || "", "content-type": "application/json" }, runIsLive() ? { "x-brain-running": "1" } : {}, opts.headers || {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      // keepalive lets a write sent as the page closes (see settleAll) finish after it has gone.
      keepalive: !!opts.keepalive,
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = { error: "Bad response from the server" }; }
    if (res.status === 401) { lock(true); throw new Error("unauthorised"); }
    if (!res.ok) { var err = new Error(data.error || ("HTTP " + res.status)); err.data = data; err.status = res.status; throw err; }
    return data;
  }

  // ---------- ui helpers ----------
  var toastTimer;
  function toast(msg, bad) {
    var t = $("toast"); t.textContent = msg; t.classList.toggle("bad", !!bad); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, bad ? 6000 : 3200);
  }
  function setSync(status, text) { $("syncDot").className = "sync-dot " + status; if (text) $("syncText").textContent = text; }
  // A badge count is shown in more than one place now (the sidebar and, on a phone, the bottom
  // tab bar), so it is set once here rather than repeated at every call site.
  function setBadge(id, n) { var el = $(id); if (el) { el.hidden = !n; el.textContent = n; } }
  // Runs this week, from the run log data already in state.runs: Monday to now, in the browser's
  // own local time, matching how every other date on this page reads.
  function runsWeekLabel() {
    var runs = (state && state.runs) || [];
    var now = new Date();
    var monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    var n = runs.filter(function (r) { var d = parseWhen(r.when); return d && d >= monday; }).length;
    return n + (n === 1 ? " run this week" : " runs this week");
  }
  // ---------- versioned static assets: quietly reload once a newer build lands ----------
  // index.html carries the deploy's commit reference in a meta tag (see scripts/build.mjs);
  // /api/state carries the same reference, baked into the function at build time (see
  // build-info.mts and api.mts's BUILD_REF). When they differ, a newer build has been deployed
  // since this tab loaded. Three guards keep this from ever looping the way it did on 23 Sep,
  // when the server side of this always answered "dev":
  //   1. "dev" is never treated as a real build: api.mts only ever returns it when build-info
  //      hasn't been stamped (a local run), so it can never look "newer" than the page's own.
  //   2. an open note edit is left alone: reloading under someone mid-edit would throw the
  //      edit away, so that one waits for the next check instead.
  //   3. a sessionStorage flag, one per build id, means this tab reloads for a given build at
  //      most once: the flag is set before the reload fires, so even a poll that lands again a
  //      few seconds later (checkRun runs every 12s) sees it and does nothing.
  var OWN_BUILD = (function () { var m = document.querySelector('meta[name="brain-build"]'); return (m && m.content) || ""; })();
  function checkBuild(s) {
    if (!s || !s.build || !OWN_BUILD) return;
    var build = s.build;
    if (build === "dev" || build === OWN_BUILD) return;
    if ($("noteEditor") && !$("noteEditor").hidden) return;
    // 4. an approve, decline or tick still in its undo window, or still being written, is settled
    //    first and the check runs again once it has; a failed write on screen waits for Dismiss.
    //    The flag in guard 3 still decides whether this tab reloads at all, so this cannot loop.
    if (undoErrors.length) return;
    if (pending.length || committing.size) {
      if (!buildWait) { buildWait = true; settleAll(true).then(function () { buildWait = false; checkBuild(s); }); }
      return;
    }
    var seenKey = "brainBuildSeen:" + build;
    try {
      if (sessionStorage.getItem(seenKey)) return;
      sessionStorage.setItem(seenKey, "1");
    } catch (e) { /* private mode or storage blocked: still reload once below, no loop guard that time */ }
    location.reload();
  }

  // ---------- undo window ----------
  // Approve, decline and task ticks are genuinely optimistic: the change shows at once, and a
  // toast holds it open for 8 seconds with Undo before the real write happens. Undo reverts the
  // optimistic change and never calls the API. Several approvals queued inside the window still
  // start one run between them (see approvalBatchStart/End below), not one run each.
  //
  // Approvals that stick (27 Sep): a choice held in the window used to live only in this page, so
  // a refresh, an app switch or the build reload in the window dropped it without a word. Now:
  //   - pagehide, and visibilitychange to hidden, settle every held item at once, each write sent
  //     with keepalive so it survives the page closing (settleAll);
  //   - each choice is kept by row id or task id until its write has settled and a little after,
  //     and reapplied to the new state after every load() (reapplyChoices), so a refresh inside
  //     the window never shows the old status;
  //   - a failed write puts the row back and stays on screen until dismissed (undoErrors).
  var UNDO_MS = 8000, undoSeq = 0, pending = [], buildWait = false;
  var choices = {};          // "approval:<id>" or "task:<id>" -> { reapply: fn(state), until: ms or 0 }
  var committing = new Set(); // commit promises not yet settled
  var undoErrors = [];       // failed writes, shown until dismissed
  var CHOICE_GRACE_MS = 30000; // how long a settled or flushed choice is still reapplied over a fresh read
  function undoRender() {
    var host = $("undoStack"); if (!host) return;
    host.innerHTML = "";
    pending.forEach(function (item) {
      var row = document.createElement("div"); row.className = "undo-row";
      row.innerHTML = '<span class="undo-label">' + esc(item.label) + '</span><span class="undo-time mono">' + item.remaining + 's</span><button type="button">Undo</button>';
      row.querySelector("button").addEventListener("click", function () { cancelUndo(item); });
      host.appendChild(row);
    });
    undoErrors.forEach(function (er) {
      var row = document.createElement("div"); row.className = "undo-row undo-error"; row.setAttribute("role", "alert");
      row.style.borderColor = "var(--crit)";
      row.innerHTML = '<span class="undo-label" style="white-space: normal; color: var(--crit)">' + esc(er.text) + '</span><button type="button">Dismiss</button>';
      row.querySelector("button").addEventListener("click", function () { undoErrors = undoErrors.filter(function (x) { return x !== er; }); undoRender(); });
      host.appendChild(row);
    });
  }
  // A failed write: the caller has already put the row back; this keeps the reason on screen.
  function undoFail(label, e) {
    undoErrors.push({ text: label.replace(/^\w+ing: /, "") + ": not saved. " + ((e && e.message) || "The write failed.") + " It is back as it was." });
    undoRender();
  }
  // A choice as data ({ kind, id, value }), so it can be written to sessionStorage as the page
  // closes and rebuilt on the next page load: an approval's new status, or a task's done flag.
  function makeReapply(kind, id, value) {
    if (kind === "approval") return function (st) { var x = (st.approvals || []).find(function (y) { return y.id === id; }); if (x) x.status = value; };
    return function (st) { var x = (st.tasks || []).find(function (y) { return y.id === id; }); if (x) setTaskDoneLocally(x, value); };
  }
  // Choices flushed on pagehide or hidden survive the refresh for CHOICE_GRACE_MS in
  // sessionStorage (this tab only), so the first load() after it shows them as chosen even if
  // the write has not landed in the vault yet. Every access is wrapped: storage can be blocked.
  var CHOICE_STORE = "brainChoices";
  function storedChoices() {
    try { var v = JSON.parse(sessionStorage.getItem(CHOICE_STORE) || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function saveStoredChoices(list) {
    try { if (list.length) sessionStorage.setItem(CHOICE_STORE, JSON.stringify(list)); else sessionStorage.removeItem(CHOICE_STORE); } catch (e) { /* blocked: the choice lives in this page only */ }
  }
  function storeChoice(key, p) {
    var now = Date.now();
    var list = storedChoices().filter(function (c) { return c && c.key !== key && now - c.at < CHOICE_GRACE_MS; });
    list.push({ key: key, kind: p.kind, id: p.id, value: p.value, at: now });
    saveStoredChoices(list);
  }
  function unstoreChoice(key) {
    var list = storedChoices(), kept = list.filter(function (c) { return c && c.key !== key; });
    if (kept.length !== list.length) saveStoredChoices(kept);
  }
  function restoreChoices() {
    var now = Date.now();
    var live = storedChoices().filter(function (c) { return c && c.key && (c.kind === "approval" || c.kind === "task") && typeof c.at === "number" && now - c.at < CHOICE_GRACE_MS; });
    live.forEach(function (c) { choices[c.key] = { reapply: makeReapply(c.kind, c.id, c.value), until: c.at + CHOICE_GRACE_MS, item: null }; });
    saveStoredChoices(live); // expired entries are dropped
  }
  function reapplyChoices() {
    if (!state) return;
    var now = Date.now();
    Object.keys(choices).forEach(function (k) {
      var c = choices[k];
      if (c.until && c.until < now) { delete choices[k]; return; }
      try { c.reapply(state); } catch (e) { /* the row is gone from the new state: nothing to reapply */ }
    });
  }
  function track(p) {
    committing.add(p);
    var done = function () { committing.delete(p); };
    p.then(done, done);
    return p;
  }
  function cancelUndo(item) {
    clearInterval(item.timer);
    pending = pending.filter(function (p) { return p.id !== item.id; });
    if (item.key && choices[item.key] && choices[item.key].item === item) delete choices[item.key];
    undoRender();
    item.revert();
  }
  async function settleUndo(item) {
    pending = pending.filter(function (p) { return p.id !== item.id; });
    undoRender();
    await track(item.commit({}));
  }
  // Settle everything still in its window at once. keepalive: the page may be closing. The last
  // approve in the batch asks the server to start Claude itself, since a watcher call made after
  // the writes return may never be sent from a page that has gone.
  function settleAll(keepalive) {
    var items = pending.slice();
    pending = [];
    undoRender();
    var lastApprove = items.filter(function (i) { return i.approve; }).pop();
    items.forEach(function (item) {
      clearInterval(item.timer);
      if (keepalive && item.key && item.persist) storeChoice(item.key, item.persist);
      track(item.commit({ flushed: true, keepalive: !!keepalive, fireWatcher: item === lastApprove }));
    });
    return Promise.all(Array.from(committing).map(function (p) { return p.catch(function () {}); }));
  }
  restoreChoices();
  window.addEventListener("pagehide", function () { if (pending.length) settleAll(true); });
  document.addEventListener("visibilitychange", function () { if (document.hidden && pending.length) settleAll(true); });
  // opts: { label, key ("approval:<id>" or "task:<id>"), persist: { kind, id, value } (the choice
  // as data: reapplied to every freshly loaded state, and stored if the page closes), approve (true for an approve), commit: async fn(o) (does the real
  // write; o.keepalive and o.flushed when settled by settleAll; reverts the optimistic change
  // itself on failure and calls endChoice), revert: fn (undoes the optimistic change; never
  // calls the API) }
  function queueUndo(opts) {
    var item = { id: ++undoSeq, label: opts.label, remaining: Math.round(UNDO_MS / 1000), commit: opts.commit, revert: opts.revert, key: opts.key, approve: !!opts.approve, persist: opts.persist };
    var reapply = opts.reapply || (opts.persist && makeReapply(opts.persist.kind, opts.persist.id, opts.persist.value));
    if (opts.key && reapply) choices[opts.key] = { reapply: reapply, until: 0, item: item };
    pending.push(item);
    undoRender();
    item.timer = setInterval(function () {
      item.remaining--;
      if (item.remaining <= 0) { clearInterval(item.timer); settleUndo(item); }
      else undoRender();
    }, 1000);
    return item;
  }
  // After the write: on success the choice is still reapplied for a short grace, on failure it is
  // dropped at once so the row can show its old status.
  function endChoice(item, ok) {
    if (!ok && item.key) unstoreChoice(item.key);
    var c = item.key && choices[item.key];
    if (!c || c.item !== item) return;
    if (ok) c.until = Date.now() + CHOICE_GRACE_MS; else delete choices[item.key];
  }
  function afterSettle() { if (!pending.length) load(false); }
  function ago(iso) {
    if (!iso) return "";
    var m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (isNaN(m)) return "";
    if (m < 1) return "just now"; if (m < 60) return m + " min ago";
    var h = Math.round(m / 60); if (h < 36) return h + " h ago";
    return Math.round(h / 24) + " d ago";
  }
  function fire(o) { if (window.Brain && brain) window.Brain.fire(o); if (window.Veins) window.Veins.fire(Math.min(10, Math.round(((o && o.count) || 20) / 4))); }
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function longDate(weekday, ymd) { var p = String(ymd || "").split("-"); return p.length === 3 ? weekday + " " + (+p[2]) + " " + MONTHS[+p[1] - 1] : weekday + " " + ymd; }
  function shortWhen(when, todayYmd) {
    var m = String(when || "").match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}:\d{2})/);
    if (!m) return when || "";
    return (m[1] + "-" + m[2] + "-" + m[3]) === todayYmd ? m[4] : (+m[3]) + " " + MONTHS[+m[2] - 1].slice(0, 3) + " " + m[4];
  }
  function pretty(t) { return String(t || "").replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, function (_, a, __, b) { return b || a; }).replace(/\*\*/g, "").replace(/`/g, ""); }
  // A row of small facts (From, Cost, Asked, and the like): built once here rather than
  // concatenated by hand at each call site, so every one of them separates its fields the same
  // way. Cards get their spacing from .meta's flex gap, but this same markup is also reused in
  // the approvals inbox detail pane, which sits outside .card and so never got that gap: two
  // spans there used to run straight into each other with no separator at all ("From Now, added
  // by the operatorCost Nothing outside the vault"). Joining with a real space fixes that everywhere
  // this is used, whatever sits around it, rather than patching the one place it was noticed.
  function metaRow(spans) {
    var items = spans.filter(Boolean);
    return items.length ? '<div class="meta">' + items.join(" ") + "</div>" : "";
  }

  // ---------- markdown ----------
  function mdToHtml(md, emptyMsg) {
    if (!md || !String(md).trim()) return '<p class="empty">' + esc(emptyMsg || "Nothing here yet.") + "</p>";
    // callouts: > [!type] Title
    md = md.replace(/^> \[!(\w+)\]\s*(.*)$/gm, function (_, type, title) { return "> **" + esc(title || type) + "** <!--callout:" + type.toLowerCase() + "-->"; });
    // wikilinks
    md = md.replace(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, function (_, target, alias) {
      var t = target.trim(); var p = noteIndex[t.toLowerCase()];
      var label = alias || t;
      if (p) return "[" + label + "](#/notes/" + encodeURIComponent(p) + "){.wiki}";
      return "<span class=\"wiki-missing\">" + esc(label) + "</span>";
    });
    var html;
    try { html = window.marked ? window.marked.parse(md, { gfm: true, breaks: false, mangle: false, headerIds: false }) : "<pre>" + esc(md) + "</pre>"; }
    catch (e) { html = "<pre>" + esc(md) + "</pre>"; }
    html = html.replace(/<a href="(#\/notes\/[^"]+)">([^<]*)<\/a>\{\.wiki\}/g, '<a class="wiki" href="$1">$2</a>');
    html = html.replace(/<blockquote>\s*<p><strong>([^<]*)<\/strong> <!--callout:(\w+)-->/g, '<blockquote class="callout-$2"><p><strong>$1</strong>');
    return html;
  }

  // ---------- webauthn (passkey) ----------
  // No vendored library: the WebAuthn JSON shapes @simplewebauthn/server expects
  // and returns are a published spec, small enough to encode and decode by hand,
  // and every script this page loads stays first-party (see the security review).
  function b64urlToBuf(s) {
    var pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : s.length % 4 === 1 ? "===" : "";
    var bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
    var buf = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }
  function bufToB64url(buf) {
    var bytes = new Uint8Array(buf), bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function credentialToJSON(cred) {
    var r = cred.response, isReg = typeof r.attestationObject !== "undefined";
    var out = {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      response: isReg
        ? { clientDataJSON: bufToB64url(r.clientDataJSON), attestationObject: bufToB64url(r.attestationObject), transports: (r.getTransports && r.getTransports()) || [] }
        : { clientDataJSON: bufToB64url(r.clientDataJSON), authenticatorData: bufToB64url(r.authenticatorData), signature: bufToB64url(r.signature), userHandle: r.userHandle ? bufToB64url(r.userHandle) : undefined },
    };
    if (cred.authenticatorAttachment) out.authenticatorAttachment = cred.authenticatorAttachment;
    return out;
  }
  async function passkeyRegister(options) {
    var publicKey = Object.assign({}, options, {
      challenge: b64urlToBuf(options.challenge),
      user: Object.assign({}, options.user, { id: b64urlToBuf(options.user.id) }),
      excludeCredentials: (options.excludeCredentials || []).map(function (c) { return Object.assign({}, c, { id: b64urlToBuf(c.id) }); }),
    });
    var cred = await navigator.credentials.create({ publicKey: publicKey });
    return credentialToJSON(cred);
  }
  async function passkeyAssert(options) {
    var publicKey = Object.assign({}, options, {
      challenge: b64urlToBuf(options.challenge),
      allowCredentials: (options.allowCredentials || []).map(function (c) { return Object.assign({}, c, { id: b64urlToBuf(c.id) }); }),
    });
    var cred = await navigator.credentials.get({ publicKey: publicKey });
    return credentialToJSON(cred);
  }
  async function setUpPasskey(trigger) {
    if (trigger) { trigger.disabled = true; trigger.dataset.was = trigger.textContent; trigger.textContent = "Confirm on this device..."; }
    $("pkMsg").textContent = $("pkPanel").hidden ? "" : "Confirm on this device...";
    try {
      var options = await api("auth/webauthn/register-options", { method: "POST" });
      var response = await passkeyRegister(options);
      await api("auth/webauthn/register-verify", { method: "POST", body: { response: response, label: passkeyDefaultLabel() } });
      $("pkNudge").hidden = true;
      $("pkMsg").textContent = "";
      toast("Passkey added.");
      if (!$("pkPanel").hidden) await renderPasskeys();
    } catch (err) {
      var msg = err && err.name === "NotAllowedError" ? "Cancelled." : ("Could not add that passkey: " + (err && err.message || err));
      $("pkMsg").textContent = msg;
      toast(msg, true);
    } finally {
      if (trigger) { trigger.disabled = false; trigger.textContent = trigger.dataset.was; }
    }
  }
  function passkeyDefaultLabel() {
    var ua = navigator.userAgent || "";
    var platform = /iPhone|iPad/.test(ua) ? "iPhone or iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "This device";
    return platform + ", added " + new Date().toISOString().slice(0, 10);
  }
  async function renderPasskeys() {
    var list = $("pkList"); list.innerHTML = "<li>Loading...</li>";
    try {
      var d = await api("auth/passkeys");
      list.innerHTML = "";
      if (!d.passkeys.length) { list.innerHTML = "<li>No passkeys registered yet. The passphrase alone signs you in.</li>"; return; }
      d.passkeys.forEach(function (p) {
        var li = document.createElement("li");
        var label = document.createElement("span"); label.textContent = p.label;
        var rm = document.createElement("button"); rm.type = "button"; rm.textContent = "Remove";
        rm.addEventListener("click", async function () {
          if (!confirm("Remove the passkey \"" + p.label + "\"? You will need another registered passkey, or BRAIN_PASSKEY_RESET set in Netlify, to sign in again.")) return;
          await api("auth/webauthn/remove", { method: "POST", body: { label: p.label } });
          await renderPasskeys();
        });
        li.appendChild(label); li.appendChild(rm); list.appendChild(li);
      });
    } catch (err) { list.innerHTML = "<li>Could not load passkeys: " + esc(err.message) + "</li>"; }
  }
  if ($("pkManageBtn")) $("pkManageBtn").addEventListener("click", function () { $("pkPanel").hidden = false; renderPasskeys(); });
  if ($("pkClose")) $("pkClose").addEventListener("click", function () { $("pkPanel").hidden = true; });
  if ($("pkAdd")) $("pkAdd").addEventListener("click", function () { setUpPasskey($("pkAdd")); });
  if ($("pkNudgeSetup")) $("pkNudgeSetup").addEventListener("click", function () { setUpPasskey($("pkNudgeSetup")); });
  if ($("pkNudgeDismiss")) $("pkNudgeDismiss").addEventListener("click", function () { $("pkNudge").hidden = true; });

  // ---------- demo mode ----------
  // /api/health says whether the server runs on a bundled demo vault. In demo mode the gate has
  // one button and no passphrase, passkeys are hidden, a banner says changes stay in this visit,
  // and the page's clock is pinned to the demo's "today" (the time of day stays real), so every
  // "today", "this week" and "days ago" on the page agrees with the server's pinned date.
  var demoMode = false;
  function pinClock(ymd) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || "")) return;
    var RealDate = Date, realNow = Date.now.bind(Date), n = new RealDate();
    var local = n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0") + "-" + String(n.getDate()).padStart(2, "0");
    var offset = RealDate.parse(ymd + "T00:00:00Z") - RealDate.parse(local + "T00:00:00Z");
    if (!offset) return;
    // keep the wall-clock time when the pinned day and today sit on different sides of a clock change
    offset += (new RealDate(realNow() + offset).getTimezoneOffset() - n.getTimezoneOffset()) * 60000;
    function PinnedDate() {
      if (!(this instanceof PinnedDate)) return new RealDate(realNow() + offset).toString();
      if (!arguments.length) return new RealDate(realNow() + offset);
      return new (Function.prototype.bind.apply(RealDate, [null].concat(Array.prototype.slice.call(arguments))))();
    }
    PinnedDate.prototype = RealDate.prototype;
    PinnedDate.now = function () { return realNow() + offset; };
    PinnedDate.parse = RealDate.parse; PinnedDate.UTC = RealDate.UTC;
    window.Date = PinnedDate;
  }
  async function checkDemo() {
    try {
      var res = await fetch("/api/health", { headers: { "cache-control": "no-cache" } });
      var h = await res.json();
      if (!h || !h.demo) return;
      demoMode = true;
      pinClock(h.today);
      document.body.classList.add("demo");
      var banner = $("demoBanner"); if (h.notice) banner.textContent = h.notice; banner.hidden = false;
      $("gateIntro").textContent = "This is a demo of the platform on a fictional vault. There is no passphrase: anything you change stays in this visit only, and nothing is saved anywhere.";
      $("passphrase").hidden = true; $("passLabel").hidden = true; $("gateBtn").hidden = true; $("demoBtn").hidden = false;
      if ($("pkManageBtn")) $("pkManageBtn").hidden = true;
      $("pkNudge").hidden = true;
    } catch (e) { /* no health answer: carry on as the live site */ }
  }
  $("demoBtn").addEventListener("click", async function () {
    var b = $("demoBtn"); b.disabled = true; $("gateMsg").textContent = "";
    try {
      var data = await authFetch("auth/demo", {});
      key = data.token;
      try { localStorage.setItem("brainKey", key); } catch (err) {}
      $("gate").hidden = true; document.body.classList.remove("locked");
      await load(true);
      if (!refreshTimer) refreshTimer = setInterval(function () { if (!document.hidden && key) load(false); }, 5 * 60 * 1000);
    } catch (err) {
      $("gateMsg").textContent = "Cannot open the demo: " + (err && err.message || err);
    } finally { b.disabled = false; }
  });

  // ---------- gate ----------
  function lock(show) {
    if (show) { $("gate").hidden = false; document.body.classList.add("locked"); (demoMode ? $("demoBtn") : $("passphrase")).focus(); }
  }
  async function authFetch(path, body) {
    var res = await fetch("/api/" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    var data = null;
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) { var err = new Error(data.error || ("HTTP " + res.status)); err.status = res.status; err.data = data; throw err; }
    return data;
  }
  $("gateForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var pass = $("passphrase").value;
    if (!pass) return;
    $("gateBtn").disabled = true; $("gateMsg").textContent = "";
    try {
      var hash = await sha256(pass);
      var data = await authFetch("auth/passphrase", { hash: hash });
      if (data.requireWebauthn) {
        $("gateMsg").textContent = "Confirm with your passkey...";
        var response = await passkeyAssert(data.options);
        data = await authFetch("auth/webauthn/login-verify", { response: response });
      }
      key = data.token;
      try { localStorage.setItem("brainKey", key); } catch (err) {}
      $("gate").hidden = true; document.body.classList.remove("locked"); $("passphrase").value = "";
      if (data.needsPasskeySetup) $("pkNudge").hidden = false;
      await load(true);
    } catch (err) {
      if (err && err.status === 429) $("gateMsg").textContent = "Too many wrong guesses. Locked for 15 minutes.";
      else if (err && err.name === "NotAllowedError") $("gateMsg").textContent = "Passkey confirmation was cancelled or timed out.";
      else if (err && err.status === 401) $("gateMsg").textContent = "That passphrase is not right.";
      else $("gateMsg").textContent = "Cannot reach the vault: " + (err && err.message || err);
      $("gate").hidden = false;
    } finally { $("gateBtn").disabled = false; }
  });
  $("lockBtn").addEventListener("click", function () {
    var revoke = key;
    try { localStorage.removeItem("brainKey"); } catch (e) {}
    key = null; lock(true);
    if (revoke) fetch("/api/auth/logout", { method: "POST", headers: { "x-brain-key": revoke, "content-type": "application/json" } }).catch(function () {});
  });

  // ---------- load ----------
  async function load(first) {
    setSync("busy", "syncing");
    try {
      var s = await api("state");
      checkBuild(s);
      var prevState = state;
      state = s;
      reapplyChoices(); // a choice still in its undo window, or still being written, wins over the fresh read
      noteIndex = {}; notesByPath = {};
      s.notes.forEach(function (n) {
        noteIndex[n.name.toLowerCase()] = n.path;
        if (n.title) noteIndex[n.title.toLowerCase()] = n.path;
        (n.aliases || []).forEach(function (a) { if (a && !noteIndex[a.toLowerCase()]) noteIndex[a.toLowerCase()] = n.path; });
        notesByPath[n.path] = n;
      });
      renderAll();
      teamDiff(prevState, s);
      loadChat(true);
      lastRefresh = Date.now();
      setSync("ok", "");
      paintRefreshed();
      fire({ count: first ? 90 : 30, boost: first ? 0.9 : 0.45, region: "all" });
      if (s.counts.approvalsPending) setTimeout(function () { fire({ count: 12, tint: "orange", region: "stem" }); }, 600);
    } catch (e) {
      if (e.message !== "unauthorised") { setSync("bad", "Refresh failed"); toast(e.message, true); }
    }
  }
  $("refreshBtn").addEventListener("click", async function () {
    var b = $("refreshBtn"); if (b.disabled) return;
    b.disabled = true; b.classList.add("spinning");
    try { await load(false); } finally { b.disabled = false; b.classList.remove("spinning"); }
  });
  var lastRefresh = 0;
  function hm(d) { return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
  function paintRefreshed() {
    if (!lastRefresh || !state) return;
    var mins = Math.floor((Date.now() - lastRefresh) / 60000);
    var when = mins < 1 ? "just now" : mins < 60 ? mins + " min ago" : hm(new Date(lastRefresh));
    $("syncText").textContent = "Refreshed " + when;
    var vault = state.repo.committedAt ? new Date(state.repo.committedAt) : null;
    $("syncVault").textContent = vault && !isNaN(vault) ? "Vault changed " + ago(state.repo.committedAt) : "";
    $("syncStatus").title = "Refreshed at " + hm(new Date(lastRefresh)) + (vault && !isNaN(vault) ? ". Last vault change " + hm(vault) + " (commit " + state.repo.commit + ": " + state.repo.message + ")" : "") + ". Refreshes itself every 5 minutes while open.";
  }
  setInterval(paintRefreshed, 30000);

  // ---------- Claude is working ----------
  // A cloud run takes two to four minutes and only shows up here once it has pushed to the vault, so
  // a tap with nothing on screen reads as a dead button. This keeps a live bar at the top from the tap
  // until the vault moves, and says what landed. It also stops a burst of taps starting four runs.
  var RUN_KEY = "brainRun", RUN_MAX = 15 * 60000, runState = null, runPoll = null;
  try { runState = JSON.parse(localStorage.getItem(RUN_KEY) || "null"); } catch (e) { runState = null; }
  // a start older than two hours is history: the vault and the Runs page already say what happened
  if (runState && Date.now() - runState.at > 2 * 3600000) { runState = null; try { localStorage.removeItem(RUN_KEY); } catch (e) {} }
  function runSave() { try { runState ? localStorage.setItem(RUN_KEY, JSON.stringify(runState)) : localStorage.removeItem(RUN_KEY); } catch (e) {} }
  function runIsLive() { return Boolean(runState && !runState.endedAt && Date.now() - runState.at < RUN_MAX); }
  function startRun(from) {
    runState = { at: Date.now(), from: from || "", base: state && state.repo ? state.repo.commit : "", hidden: false };
    runSave(); paintRun();
    if (runPoll) clearInterval(runPoll);
    runPoll = setInterval(checkRun, 12000);
    setTimeout(checkRun, 6000);
  }
  function endRun(msg) {
    if (!runState) return;
    runState.endedAt = Date.now(); runState.note = msg || ""; runSave();
    if (runPoll) { clearInterval(runPoll); runPoll = null; }
    paintRun();
    // A run this page itself started, finishing: worth a notification if they asked for one.
    // Never asked for on its own, only ever fired after the explicit tap wired to notifyBtn.
    try {
      if (window.Notification && Notification.permission === "granted") {
        new Notification("The Brain", { body: (msg || "Claude finished.").replace(/\s+/g, " ").trim() });
      }
    } catch (e) {}
  }
  function runElapsed() {
    var s = Math.round((Date.now() - runState.at) / 1000);
    return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
  }
  function paintRun() {
    var bar = $("runBar"); if (!bar) return;
    if (!runState || runState.hidden) { bar.hidden = true; return; }
    if (runIsLive()) {
      bar.hidden = false; bar.classList.remove("done");
      $("runBarText").textContent = "Claude is working" + (runState.from ? " on " + runState.from : "") + ". Started at "
        + hm(new Date(runState.at)) + ", " + runElapsed() + " so far. This page updates itself when it lands.";
      return;
    }
    if (runState.endedAt) {
      if (Date.now() - runState.endedAt > 6 * 60000) { bar.hidden = true; return; }
      bar.hidden = false; bar.classList.add("done");
      $("runBarText").textContent = runState.note || "Claude finished.";
      return;
    }
    // past the usual window but still being checked: say so, without a clock that climbs for hours
    bar.hidden = false; bar.classList.remove("done");
    $("runBarText").textContent = "Claude is taking longer than usual. Still checking the vault; this clears itself when the run logs.";
  }
  setInterval(function () { if (runState && !runState.hidden) paintRun(); }, 5000);
  async function checkRun() {
    if (!runState || runState.endedAt) { if (runPoll) { clearInterval(runPoll); runPoll = null; } paintRun(); return; }
    try {
      var s = await api("state");
      if (!s || !s.repo) return;
      checkBuild(s);
      if (s.repo.commit !== runState.base) {   // the vault moved: show it, whoever moved it
        state = s; renderAll(); lastRefresh = Date.now(); paintRefreshed();
        runState.base = s.repo.commit; runSave();
      }
      // finished means a run logged its own line after the start, not just any commit landing
      var run = (s.runs || [])[0], at = run && parseWhen(run.when);
      if (at && at.getTime() >= runState.at - 60000) {
        endRun("Claude finished at " + hm(at) + ". " + trimTo(pretty(run.note), 190));
        fire({ count: 60, region: "all", boost: 0.8 });
        return;
      }
      if (Date.now() - runState.at > 30 * 60000) {
        endRun("No run was logged in the 30 minutes after Claude was started. Runs shows the last one; if it is not there, start Claude again.");
      } else paintRun();
    } catch (e) { /* a failed poll is not worth a toast; the next one tries again */ }
  }
  function trimTo(text, n) {
    var t = String(text || "").trim();
    if (!t) return "The vault has changed and everything below is up to date.";
    if (t.length <= n) return /[.!?]$/.test(t) ? t : t + ".";
    var cut = t.lastIndexOf(". ", n);
    return cut > 60 ? t.slice(0, cut + 1) + " Open Runs for the rest." : t.slice(0, t.lastIndexOf(" ", n)) + "... Open Runs for the rest.";
  }
  if ($("runBarHide")) $("runBarHide").addEventListener("click", function () { if (runState) { runState.hidden = true; runSave(); } paintRun(); });
  if (runState && !runState.endedAt) { runPoll = setInterval(checkRun, 12000); setTimeout(checkRun, 2000); }
  document.addEventListener("visibilitychange", function () { if (!document.hidden && runState && !runState.endedAt) checkRun(); });
  paintRun();

  // ---------- render ----------
  function renderAll() {
    var s = state;
    // hud
    $("hudDate").textContent = longDate(s.today.weekday, s.today.ymd);
    var one = "";
    var m = (s.journal.plan || "").match(/^\s*1\.\s*(.+)$/m) || (s.now.week || "").match(/^\s*1\.\s*\*\*([^*]+)\*\*/m);
    if (m) { one = pretty(m[1]).replace(/^the one thing( today)?( is)?\s*[:,]\s*/i, "").trim(); one = one.charAt(0).toUpperCase() + one.slice(1); }
    var top = s.priorities ? s.priorities.day.items.filter(function (x) { return !x.done && x.kind !== "missing"; })[0] : null;
    $("hudOne").textContent = top ? cap(pretty(top.text)) : (one || "No plan written yet today");
    $("hudSub").textContent = top ? "Top of today's priorities" : s.journal.exists ? "From today's plan" : "The morning job writes the plan on weekdays";
    paintHeadlineClamp();
    // Open tasks: every open task outside "Claude needs from you" (that count is its own tile
    // and its own sidebar badge). Next up is the same list narrowed to #next, which is what the
    // Tasks nav count shows too, so the tile and the sidebar never name two different numbers
    // without saying so.
    var openTasksCount = s.tasks.filter(function (t) { return !t.done && t.file !== NEEDS_FILE; }).length;
    var nextUpCount = s.tasks.filter(function (t) { return !t.done && t.file !== NEEDS_FILE && t.tag === "next"; }).length;
    $("tTasks").innerHTML = String(openTasksCount) + (nextUpCount !== openTasksCount ? '<small class="tile-sub">' + nextUpCount + ' next up</small>' : "");
    $("tApprovals").textContent = s.counts.approvalsPending; $("tScout").textContent = s.counts.scoutNew; $("tNotes").textContent = s.counts.notes;
    var navCount = $("navTasksCount");
    if (navCount) { navCount.hidden = false; navCount.textContent = nextUpCount; navCount.title = nextUpCount + " open, tagged next" + (nextUpCount !== openTasksCount ? " (" + openTasksCount + " open in total)" : ""); }
    $("hudRepo").textContent = s.repo.name + " @ " + s.repo.commit + " · " + s.repo.message.slice(0, 48);
    var tick = $("ticker"); tick.innerHTML = "";
    s.runs.slice(0, 4).forEach(function (r, i) {
      var li = document.createElement("li"); if (i === 0) li.className = "new";
      var what = r.job + (r.result && r.result !== "OK" ? " (" + r.result + ")" : "") + ": " + pretty(r.note || r.result);
      li.innerHTML = '<span class="when">' + esc(shortWhen(r.when, s.today.ymd)) + '</span><span class="what" title="' + esc(what) + '">' + esc(what) + "</span>"; tick.appendChild(li);
    });
    setBadge("badgeApprovals", s.counts.approvalsPending); setBadge("badgeApprovalsTab", s.counts.approvalsPending);
    setBadge("badgeScout", s.counts.scoutNew); setBadge("badgeScoutTab", s.counts.scoutNew);
    var rw = $("runsWeekLine"); if (rw) rw.textContent = runsWeekLabel();

    renderHomeTabs();
    renderSinceCard();
    renderForYouToday();

    buildPrioIndex(); renderPriorities();
    renderNeeds(); renderTasks(); renderWork(); renderApprovals(); renderNotesTree(); renderJournal(); renderScout(); renderRuns(); renderTeam(); renderCommand(); renderLeads();
    maybeOpenLastNote();
  }

  // Never cut mid word: -webkit-line-clamp breaks at the last full word that fits and
  // ellipsises there. #hudOneMore only appears once the text is actually taller than its
  // three-line box, and toggles .expanded to show the rest in place.
  function paintHeadlineClamp() {
    var el = $("hudOne"), btn = $("hudOneMore");
    if (!el || !btn) return;
    el.classList.remove("expanded"); btn.textContent = "More"; btn.hidden = true;
    requestAnimationFrame(function () {
      if (el.scrollHeight > el.clientHeight + 1) btn.hidden = false;
    });
  }
  if ($("hudOneMore")) $("hudOneMore").addEventListener("click", function () {
    var el = $("hudOne"), btn = $("hudOneMore");
    btn.textContent = el.classList.toggle("expanded") ? "Less" : "More";
  });

  // ---------- This week, Today's plan and Direction: three tabs in one panel, the last one
  // opened remembered per device ----------
  var HOME_TAB_KEY = "brainHomeTab", HOME_TABS = ["week", "plan", "direction"], homeTab = "week";
  (function () { try { var t = localStorage.getItem(HOME_TAB_KEY); if (HOME_TABS.indexOf(t) > -1) homeTab = t; } catch (e) {} })();
  var homeOutdate = {};
  function plainDate(ymd) {
    var m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? (+m[3]) + " " + MONTHS[+m[2] - 1].slice(0, 3) : "";
  }
  // A week number named in the text (e.g. "Week 38"), or in a Journal/Weekly file's own name
  // (2026-W38.md). Only ever compared against today's own ISO week within the same year, which
  // is the case this flag exists for (This week still reading week 38 well into week 39).
  function weekFromText(t) { var m = String(t || "").match(/\bweek\s*(\d{1,2})\b/i); return m ? +m[1] : null; }
  function weekFromPath(p) { var m = String(p || "").match(/W(\d{1,2})/); return m ? +m[1] : null; }
  function computeHomeOutdate(s) {
    var out = {}, todayWeek = s.today && s.today.week;
    if (todayWeek) {
      var wn = weekFromText(s.now.week);
      if (wn && wn < todayWeek) out.week = { date: s.now.updated };
      var dm = s.directionMeta || {};
      var dwn = dm.path ? weekFromPath(dm.path) : null;
      if (dwn && dwn < todayWeek) out.direction = { date: dm.updated };
    }
    return out;
  }
  function paintHomeTabFlag() {
    var el = $("homeTabFlag"); if (!el) return;
    var f = homeOutdate[homeTab];
    if (!f) { el.hidden = true; return; }
    var d = plainDate(f.date);
    el.hidden = false;
    el.textContent = "Out of date" + (d ? ", written " + d : "");
  }
  function setHomeTab(tab) {
    if (HOME_TABS.indexOf(tab) < 0) return;
    homeTab = tab;
    try { localStorage.setItem(HOME_TAB_KEY, tab); } catch (e) {}
    document.querySelectorAll(".tab-btn").forEach(function (b) {
      var on = b.dataset.tab === tab;
      b.classList.toggle("active", on); b.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll(".tab-panel").forEach(function (p) { p.hidden = p.dataset.tab !== tab; });
    paintHomeTabFlag();
  }
  document.querySelectorAll(".tab-btn").forEach(function (b) { b.addEventListener("click", function () { setHomeTab(b.dataset.tab); }); });
  function renderHomeTabs() {
    var s = state;
    $("tabWeek").innerHTML = mdToHtml(s.now.week);
    $("tabPlan").innerHTML = mdToHtml(s.journal.plan, "No plan yet today. The morning job writes it on weekdays.");
    $("tabDirection").innerHTML = mdToHtml(s.direction);
    homeOutdate = computeHomeOutdate(s);
    setHomeTab(homeTab);
  }

  // ---------- since you were last here: built on the page from state already in /api/state
  // (run log lines, rows changed to pending or done, notes changed), against a last-visit time
  // kept per device in localStorage. No model call. Dismissable: dismissing moves the baseline
  // to now, so the next visit only shows what changed after that. ----------
  var LAST_VISIT_KEY = "brainLastVisit";
  function renderSinceCard() {
    var card = $("sinceCard"), list = $("sinceList");
    if (!card || !list) return;
    var raw;
    try { raw = localStorage.getItem(LAST_VISIT_KEY); } catch (e) { raw = null; }
    if (!raw) {
      // First time this device has been seen: nothing to compare against yet. Set the
      // baseline quietly so the next visit has something to measure from.
      try { localStorage.setItem(LAST_VISIT_KEY, new Date().toISOString()); } catch (e) {}
      card.hidden = true;
      return;
    }
    var since = Date.parse(raw);
    if (isNaN(since)) { card.hidden = true; return; }
    var items = [];
    var runsN = (state.runs || []).filter(function (r) { var d = parseWhen(r.when); return d && d.getTime() > since; }).length;
    if (runsN) items.push(runsN + (runsN === 1 ? " run finished" : " runs finished"));
    var pendingN = (state.approvals || []).filter(function (a) { var st = (a.status || "").toLowerCase(), d = parseWhen(a.requested); return st === "pending" && d && d.getTime() > since; }).length;
    if (pendingN) items.push(pendingN + (pendingN === 1 ? " row moved to pending" : " rows moved to pending"));
    var doneN = (state.approvals || []).filter(function (a) { var st = (a.status || "").toLowerCase(), d = parseWhen(a.decided); return st === "done" && d && d.getTime() > since; }).length;
    if (doneN) items.push(doneN + (doneN === 1 ? " row marked done" : " rows marked done"));
    var notesN = (state.notes || []).filter(function (n) { var d = parseWhen(n.updated); return d && d.getTime() > since; }).length;
    if (notesN) items.push(notesN + (notesN === 1 ? " note changed" : " notes changed"));
    if (!items.length) { card.hidden = true; return; }
    list.innerHTML = items.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("");
    card.hidden = false;
  }
  if ($("sinceDismiss")) $("sinceDismiss").addEventListener("click", function () {
    try { localStorage.setItem(LAST_VISIT_KEY, new Date().toISOString()); } catch (e) {}
    $("sinceCard").hidden = true;
  });

  // ---------- for you today: one line each, a count and one button to the right place ----------
  function renderForYouToday() {
    var host = $("foryouList"); if (!host) return;
    var s = state;
    var needsCount = s.tasks.filter(function (t) { return t.file === NEEDS_FILE && !t.done; }).length;
    var prioCount = s.priorities ? s.priorities.day.items.filter(function (x) { return !x.done && x.kind !== "missing"; }).length : 0;
    var runsSince = 0;
    try {
      var raw = localStorage.getItem(LAST_VISIT_KEY);
      if (raw) { var since = Date.parse(raw); if (!isNaN(since)) runsSince = (s.runs || []).filter(function (r) { var d = parseWhen(r.when); return d && d.getTime() > since; }).length; }
    } catch (e) {}
    var rows = [
      { label: "Approvals waiting", count: s.counts.approvalsPending, href: "#/approvals" },
      { label: "Claude needs from you", count: needsCount, href: "#/tasks" },
      { label: "Today's priorities", count: prioCount, href: "#/tasks" },
      { label: "Runs finished since your last visit", count: runsSince, href: "#/runs" }
    ];
    host.innerHTML = rows.map(function (r) {
      return '<div class="foryou-row"><span class="foryou-label">' + esc(r.label) + '</span><span class="foryou-count mono">' + r.count
        + '</span><a class="foryou-btn" href="' + r.href + '">Open</a></div>';
    }).join("");
  }

  // priorities: today's and this week's lists from the journal notes, with the brain's suggestions under each.
  // A task line ticks the task where it lives; a one-off ticks itself.
  var PRIO_NAME = { day: "today's priorities", week: "this week's priorities" };
  var prioIdx = { day: {}, week: {}, sug: { day: {}, week: {} } }, taskMap = {};
  function buildPrioIndex() {
    prioIdx = { day: {}, week: {}, sug: { day: {}, week: {} } }; taskMap = {};
    state.tasks.forEach(function (t) { taskMap[t.id] = t; });
    var P = state.priorities; if (!P) return;
    ["day", "week"].forEach(function (sc) {
      P[sc].items.forEach(function (it) { if (it.kind === "task") prioIdx[sc][it.taskId] = it; });
      P[sc].suggested.forEach(function (it) { if (it.kind === "task" && !it.added && !prioIdx[sc][it.taskId]) prioIdx.sug[sc][it.taskId] = it; });
    });
  }
  async function prioCall(scope, body, message, btn) {
    if (btn) btn.disabled = true;
    try {
      var r = await api("priority", { method: "POST", body: Object.assign({ scope: scope, key: state.priorities[scope].key }, body) });
      toast(typeof message === "function" ? message(r) : message);
      fire({ count: 16, region: "cortex", boost: 0.3 });
      await load(false);
      return true;
    } catch (err) {
      toast(err.message, true);
      if (btn) btn.disabled = false;
      if (err.data && err.data.conflict) load(false);
      return false;
    }
  }
  function addToPrio(scope, t, btn) {
    return prioCall(scope, { action: "add", file: t.file, text: t.text, line: t.line }, function (r) { return (r.already ? "Already in " : "Added to ") + PRIO_NAME[scope]; }, btn);
  }
  function removeFromPrio(scope, it, btn) {
    return prioCall(scope, { action: "remove", line: it.line, raw: it.raw }, "Taken off " + PRIO_NAME[scope] + ". The task itself is unchanged.", btn);
  }
  function prioMeta(it) {
    if (it.kind === "task") return esc(it.source || "");
    if (it.kind === "missing") return '<span class="warn">Not found in ' + esc(it.source) + ": renamed, moved or deleted?</span>";
    return "One-off";
  }
  function prioItem(scope, it, i, count, compact) {
    var li = document.createElement("li"); li.className = "prio-item " + it.kind + (it.done ? " done" : "");
    var t = it.kind === "task" ? taskMap[it.taskId] : null;
    var tickable = it.kind === "own" || !!t;
    li.innerHTML = (tickable ? '<input type="checkbox"' + (it.done ? " checked" : "") + ' aria-label="Done">' : '<span class="prio-gap" aria-hidden="true"></span>')
      + '<span class="pt">' + esc(pretty(it.text)) + "<small>" + prioMeta(it) + "</small>"
      + (!compact && (it.notes || []).length ? '<span class="prio-notes">' + it.notes.map(function (n) { return "<span>" + richText(n) + "</span>"; }).join("") + "</span>" : "") + "</span>"
      + (compact ? "" : '<span class="pacts"><button type="button" class="up" aria-label="Move up"' + (i === 0 ? " disabled" : "") + ">&#8593;</button>"
        + '<button type="button" class="down" aria-label="Move down"' + (i === count - 1 ? " disabled" : "") + ">&#8595;</button>"
        + '<button type="button" class="remove" aria-label="Take off ' + PRIO_NAME[scope] + '" title="Take off the list (the task stays as it is)">&#215;</button></span>');
    var box = li.querySelector("input");
    if (box) box.addEventListener("change", async function (e) {
      var done = e.target.checked;
      if (t) return toggleTask(t, done, e.target);
      var okd = await prioCall(scope, { action: "toggle", line: it.line, raw: it.raw, done: done }, done ? "Ticked" : "Reopened", e.target);
      if (!okd) e.target.checked = !done;
    });
    if (!compact) {
      li.querySelector(".up").addEventListener("click", function (e) { prioCall(scope, { action: "move", line: it.line, raw: it.raw, dir: -1 }, "Moved up", e.currentTarget); });
      li.querySelector(".down").addEventListener("click", function (e) { prioCall(scope, { action: "move", line: it.line, raw: it.raw, dir: 1 }, "Moved down", e.currentTarget); });
      li.querySelector(".remove").addEventListener("click", function (e) { removeFromPrio(scope, it, e.currentTarget); });
    }
    return li;
  }
  function prioColumn(host, scope, compact) {
    var p = state.priorities[scope];
    host.innerHTML = "";
    var done = p.items.filter(function (x) { return x.done; }).length;
    var head = document.createElement("div"); head.className = "prio-col-head";
    head.innerHTML = "<h3>" + (scope === "day" ? "Today" : "This week") + ' <span class="prio-when">' + esc(p.label) + "</span></h3>"
      + (p.items.length ? '<span class="prio-count mono">' + done + " of " + p.items.length + " done</span>" : "");
    host.appendChild(head);
    if (p.items.length) {
      var ol = document.createElement("ol"); ol.className = "prio-list";
      p.items.forEach(function (it, i) { ol.appendChild(prioItem(scope, it, i, p.items.length, compact)); });
      host.appendChild(ol);
    } else {
      host.insertAdjacentHTML("beforeend", '<p class="prio-empty">' + (scope === "day" ? "Nothing picked for today yet." : "Nothing picked for this week yet.")
        + (compact ? "" : " Press " + (scope === "day" ? "Today" : "Week") + " on any task below, or add a suggestion.") + "</p>");
    }
    var waiting = p.suggested.filter(function (x) { return !x.added && x.kind !== "missing"; });
    if (compact) {
      var foot = document.createElement("p"); foot.className = "prio-foot";
      foot.innerHTML = (waiting.length ? '<a href="#/tasks">' + waiting.length + (waiting.length === 1 ? " suggestion" : " suggestions") + " from the brain</a>" : "") + '<a href="#/tasks">' + (p.items.length ? "Change the list" : "Pick in Tasks") + "</a>";
      host.appendChild(foot);
      return;
    }
    var form = document.createElement("form"); form.className = "prio-add";
    form.innerHTML = '<input type="text" placeholder="' + (scope === "day" ? "Add a one-off for today" : "Add a one-off for this week") + '" aria-label="Add a one-off to ' + PRIO_NAME[scope] + '"><button type="submit">Add</button>';
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      var input = form.querySelector("input"), text = input.value.trim(); if (!text) return;
      if (await prioCall(scope, { action: "add", text: text }, function (r) { return r.already ? "That one-off is already on the list" : "Added to " + PRIO_NAME[scope]; }, form.querySelector("button"))) input.value = "";
    });
    host.appendChild(form);
    var sug = document.createElement("div"); sug.className = "prio-sug";
    var open = p.suggested.filter(function (x) { return !x.added; });
    if (!p.suggested.length) {
      sug.innerHTML = '<p class="prio-sug-none">' + (scope === "day" ? "No suggestions from the brain yet today. The morning plan adds them on weekdays." : "No suggestions for this week yet. The Sunday review adds them for the week ahead.") + "</p>";
    } else if (!open.length) {
      sug.innerHTML = '<p class="prio-sug-none">All ' + p.suggested.length + " of the brain's suggestions are on the list.</p>";
    } else {
      sug.innerHTML = '<div class="prio-sug-head"><span>Suggested by the brain</span>' + (waiting.length > 1 ? '<button type="button" class="add-all">Add all ' + waiting.length + "</button>" : "") + "</div>";
      var ul = document.createElement("ul");
      open.forEach(function (x) {
        var li = document.createElement("li"); li.className = "prio-sug-item " + x.kind;
        li.innerHTML = '<span class="pt">' + esc(pretty(x.text)) + "<small>" + prioMeta(x) + (x.why ? '<span class="why"> · ' + esc(x.why) + "</span>" : "") + "</small></span>"
          + (x.kind === "missing" ? "" : '<button type="button" class="sug-btn" title="Add to ' + PRIO_NAME[scope] + '">+ Suggested</button>');
        var b = li.querySelector(".sug-btn");
        if (b) b.addEventListener("click", function () { prioCall(scope, { action: "suggested", raw: x.raw }, function (r) { return r.added ? "Added to " + PRIO_NAME[scope] : "Already in " + PRIO_NAME[scope]; }, b); });
        ul.appendChild(li);
      });
      sug.appendChild(ul);
      var all = sug.querySelector(".add-all");
      if (all) all.addEventListener("click", function () {
        prioCall(scope, { action: "suggested" }, function (r) { return (r.added ? "Added " + r.added + " to " + PRIO_NAME[scope] : "Nothing new to add") + (r.skipped ? ". " + r.skipped + " could not be matched to a task." : ""); }, all);
      });
    }
    host.appendChild(sug);
  }
  function renderPriorities() {
    if (!state.priorities) return;
    prioColumn($("prioDay"), "day", false); prioColumn($("prioWeek"), "week", false);
    prioColumn($("homePrioDay"), "day", true); prioColumn($("homePrioWeek"), "week", true);
  }

  // ---------- detail panel: a row from Tasks, Fernmoor or Claude needs from you. Right-hand
  // sheet on desktop, full width on a phone (see the constraint that gave it that shape). Opened
  // by a click on a row, Enter on a focused one, or a tap on a phone; Escape closes it, J and K
  // move to the next or previous row in the same list the row was opened from. ----------
  var detailNav = null; // { ids: [taskId,...], index } or null when closed
  function detailCurrentTask() {
    if (!detailNav) return null;
    return state.tasks.find(function (t) { return t.id === detailNav.ids[detailNav.index]; }) || null;
  }
  function openDetail(ids, index) {
    if (!ids || !ids.length) return;
    detailNav = { ids: ids.slice(), index: Math.max(0, Math.min(ids.length - 1, index)) };
    renderDetail();
    $("detailOverlay").hidden = false;
  }
  function closeDetail() {
    if (!detailNav) return;
    detailNav = null;
    $("detailOverlay").hidden = true;
  }
  function detailMove(dir) {
    if (!detailNav) return;
    var next = detailNav.index + dir;
    if (next < 0 || next >= detailNav.ids.length) return;
    detailNav.index = next;
    renderDetail();
  }
  function detailPanelShortcut(e) {
    if (!detailNav) return false;
    if (e.key === "Escape") { closeDetail(); return true; }
    if (e.key === "j" || e.key === "J") { detailMove(1); return true; }
    if (e.key === "k" || e.key === "K") { detailMove(-1); return true; }
    return false;
  }
  if ($("detailClose")) $("detailClose").addEventListener("click", closeDetail);
  if ($("detailOverlay")) $("detailOverlay").addEventListener("click", function (e) { if (e.target === $("detailOverlay")) closeDetail(); });
  if ($("detailPrev")) $("detailPrev").addEventListener("click", function () { detailMove(-1); });
  if ($("detailNext")) $("detailNext").addEventListener("click", function () { detailMove(1); });

  function detailTaskHtml(t) {
    var ap = t.approval, apStatus = ap ? String(ap.status || "").toLowerCase() : "";
    var canSend = !t.done && (!ap || apStatus === "declined" || apStatus === "done" || apStatus === "missing");
    var inDay = prioIdx.day[t.id], inWeek = prioIdx.week[t.id];
    var notes = (t.notes || []).slice().reverse();
    return '<div class="t">' + esc(pretty(t.text)) + "</div>"
      + metaRow([
          t.project ? "<span>In <b>" + esc(t.project) + "</b></span>" : "",
          t.section ? "<span>Under <b>" + esc(t.section) + "</b></span>" : "",
          ap ? '<span class="sent ' + esc(apStatus.replace(/\s+/g, "-")) + '"><a href="#/approvals">' + esc(APPROVAL_LABEL[apStatus] || apStatus) + "</a></span>" : ""
        ])
      + '<div class="row"><span class="tag ' + esc(t.tag) + '">' + esc(t.tag) + '</span>'
      + '<label class="detail-done"><input type="checkbox" class="detail-tick"' + (t.done ? " checked" : "") + '> Done</label>'
      + '<button type="button" class="pin-btn" data-scope="day" aria-pressed="' + (inDay ? "true" : "false") + '">Today</button>'
      + '<button type="button" class="pin-btn" data-scope="week" aria-pressed="' + (inWeek ? "true" : "false") + '">Week</button>'
      + '<button type="button" class="detail-edit">Edit</button>'
      + (canSend ? '<button type="button" class="detail-send">Send for approval</button>' : "")
      + (!t.done ? '<button type="button" class="detail-dismiss" title="Not needed: take it off every list">Dismiss</button>' : "")
      + "</div>"
      + '<div class="detail-section"><h3>Notes</h3><ul class="detail-trail">' + (notes.length ? notes.map(noteItem).join("") : '<li class="empty">No notes yet. Add the question, the options, or what Claude should change once you approve it.</li>') + "</ul>"
      + '<form class="detail-form detail-reply"><input type="text" placeholder="Add a note" aria-label="Add a note"><button type="submit">Reply</button></form>' + uploadForm + "</div>";
  }
  function detailNeedHtml(t) {
    var why = "", steps = [], guides = [], other = [];
    (t.notes || []).forEach(function (n) {
      var m;
      if ((m = n.match(/^Why:\s*(.+)$/i))) why = m[1];
      else if ((m = n.match(/^Step\s*\d+[:.)]\s*(.+)$/i))) steps.push(m[1]);
      else if ((m = n.match(/^(Guide|Plan):\s*\[\[([^\]|]+)(?:\|[^\]]+)?\]\]\s*$/i))) guides.push({ kind: m[1], name: m[2].trim() });
      else other.push(n);
    });
    var guideBtns = guides.map(function (g) {
      var p = noteIndex[g.name.toLowerCase()];
      return p ? '<a class="guide-btn" href="#/notes/' + encodeURIComponent(p) + '">' + (/plan/i.test(g.kind) ? "Open the plan" : "Open the guide") + ": " + esc(g.name) + "</a>" : '<span class="guide-missing">' + esc(g.name) + "</span>";
    }).join("");
    var trail = other.slice().reverse();
    return '<div class="need-top"><span class="need-kind">' + (t.tag === "decision" ? "Decision" : "To do") + '</span><div class="need-title">' + esc(pretty(t.text)) + "</div></div>"
      + (why ? '<div class="need-why">' + richText(cap(why)) + "</div>" : "")
      + (steps.length ? '<ol class="need-steps">' + steps.map(function (x) { return "<li>" + richText(cap(x)) + "</li>"; }).join("") + "</ol>" : "")
      + (guideBtns ? '<div class="need-guides">' + guideBtns + "</div>" : "")
      + '<div class="detail-section"><h3>Notes</h3><ul class="detail-trail">' + (trail.length ? trail.map(noteItem).join("") : '<li class="empty">Nothing yet.</li>') + "</ul></div>"
      + '<div class="need-actions"><button type="button" class="primary detail-need-continue" title="Your part is done: Claude carries on now">Continue</button><button type="button" class="detail-need-complete" title="All finished: reviewed at the next scheduled run, nothing starts now">Complete</button>' + snoozeMenuHtml() + uploadForm
      + '<form class="need-reply detail-reply"><input type="text" placeholder="Reply to Claude" aria-label="Reply to Claude"><button type="submit">Reply</button></form></div>';
  }
  function renderDetailEditForm(t) {
    var body = $("detailBody");
    body.innerHTML = '<form class="detail-edit-form">'
      + '<textarea rows="3" required>' + esc(t.text) + "</textarea>"
      + '<select><option' + (t.tag === "next" ? " selected" : "") + '>next</option><option' + (t.tag === "blocked" ? " selected" : "") + '>blocked</option><option' + (t.tag === "decision" ? " selected" : "") + ">decision</option></select>"
      + '<div class="row"><button type="submit" class="primary">Save</button><button type="button" class="cancel">Cancel</button></div>'
      + "</form>";
    var form = body.querySelector("form");
    form.querySelector(".cancel").addEventListener("click", renderDetail);
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      var text = form.querySelector("textarea").value, tag = form.querySelector("select").value;
      var btn = form.querySelector("button[type=submit]"); btn.disabled = true;
      try { await api("task/edit", { method: "POST", body: { file: t.file, line: t.line, raw: t.raw, text: text, tag: tag } }); toast("Saved"); fire({ count: 10, region: "cortex" }); await load(false); renderDetail(); }
      catch (err) { toast(err.message, true); btn.disabled = false; }
    });
    form.querySelector("textarea").focus();
  }
  function wireDetailBody(t) {
    var body = $("detailBody");
    var tick = body.querySelector(".detail-tick");
    if (tick) tick.addEventListener("change", function (e) { toggleTask(t, e.target.checked); });
    body.querySelectorAll(".pin-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        var sc = b.dataset.scope, item = prioIdx[sc][t.id];
        (item ? removeFromPrio(sc, item, b) : addToPrio(sc, t, b)).then(renderDetail);
      });
    });
    var editBtn = body.querySelector(".detail-edit");
    if (editBtn) editBtn.addEventListener("click", function () { renderDetailEditForm(t); });
    var sendBtn = body.querySelector(".detail-send");
    if (sendBtn) sendBtn.addEventListener("click", function () { sendForApproval(t, sendBtn); });
    var dBtn = body.querySelector(".detail-dismiss");
    if (dBtn) dBtn.addEventListener("click", function () { dismissTask(t, dBtn, closeDetail); });
    body.querySelectorAll(".detail-need-continue, .detail-need-complete").forEach(function (b) {
      b.addEventListener("click", function () {
        needDone(t, b.classList.contains("detail-need-complete") ? "complete" : "continue", body.querySelectorAll(".detail-need-continue, .detail-need-complete"), closeDetail);
      });
    });
    var replyForm = body.querySelector(".detail-reply");
    if (replyForm) replyForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      var input = replyForm.querySelector("input"), text = input.value.trim(); if (!text) return;
      var btn = replyForm.querySelector("button"); btn.disabled = true;
      try {
        await api("task/note", { method: "POST", body: { file: t.file, line: t.line, raw: t.raw, text: text } });
        toast(t.file === NEEDS_FILE ? "Reply saved. " + nextRunLine("Claude reads it at ") : "Note added. " + nextRunLine("Claude picks it up at "));
        fire({ count: 10, region: "cortex", boost: 0.2 });
        input.value = "";
        await load(false); renderDetail();
      } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
    });
    var uploadEl = body.querySelector(".note-upload");
    if (uploadEl) wireUpload(uploadEl, t, function () { load(false).then(renderDetail); });
    wireSnoozeMenu(body, t.id, function () { load(false).then(renderDetail); });
  }
  function renderDetail() {
    var t = detailCurrentTask();
    if (!t) { closeDetail(); return; }
    if ($("detailPrev")) $("detailPrev").disabled = detailNav.index <= 0;
    if ($("detailNext")) $("detailNext").disabled = detailNav.index >= detailNav.ids.length - 1;
    $("detailBody").innerHTML = t.file === NEEDS_FILE ? detailNeedHtml(t) : detailTaskHtml(t);
    wireDetailBody(t);
  }

  // tasks: one row renderer shared by the Tasks and Fernmoor areas. One line each: the
  // checkbox, the title (ellipsised) with its status badges right after it, then the named
  // actions on hover or keyboard focus, with a menu for anything beyond them (currently only the
  // brain's own suggestions). Clicking the row, or Enter while it has focus, opens the detail
  // panel; a phone has no hover, so .acts is hidden there and a tap opens the row instead.
  var APPROVAL_LABEL = { requested: "Requested, Claude is scoping it", pending: "In Approvals, waiting for your yes", approved: "Approved, Claude is on it", "in progress": "Approved, Claude is on it", done: "Done by Claude", declined: "Declined in Approvals", missing: "Its Approvals row is gone" };
  function taskRow(t, rerender, navIds) {
    var wrap = document.createElement("div"); wrap.className = "task-wrap";
    var row = document.createElement("div"); row.className = "task" + (t.done ? " done" : ""); row.dataset.id = t.id;
    row.tabIndex = 0; row.setAttribute("role", "button"); row.setAttribute("aria-haspopup", "dialog"); row.setAttribute("aria-label", "Open detail for " + pretty(t.text));
    var ap = t.approval, apStatus = ap ? String(ap.status || "").toLowerCase() : "";
    var canSend = !t.done && (!ap || apStatus === "declined" || apStatus === "done" || apStatus === "missing");
    var inDay = prioIdx.day[t.id], inWeek = prioIdx.week[t.id], sugDay = !t.done && !inDay && prioIdx.sug.day[t.id], sugWeek = !t.done && !inWeek && prioIdx.sug.week[t.id];
    var pinBtn = function (scope, item) {
      if (t.done && !item) return "";
      return '<button type="button" class="pin-btn" data-scope="' + scope + '" aria-pressed="' + (item ? "true" : "false") + '" title="' + (item ? "Take off " : "Add to ") + PRIO_NAME[scope] + '">' + (scope === "day" ? "Today" : "Week") + "</button>";
    };
    var badges = (isSnoozed(t.id) ? '<span class="age-chip" title="Snoozed">' + esc(snoozeReturnsLabel(t.id)) + "</span>" : "")
      + (ap ? '<a class="sent ' + esc(apStatus.replace(/\s+/g, "-")) + '" href="#/approvals" title="' + esc(ap.id) + '">' + esc(APPROVAL_LABEL[apStatus] || apStatus) + "</a>" : "");
    var moreOpts = (sugDay ? '<button type="button" data-scope="day" class="sug-menu">+ Suggested for today</button>' : "")
      + (sugWeek ? '<button type="button" data-scope="week" class="sug-menu">+ Suggested for this week</button>' : "");
    row.innerHTML = '<input type="checkbox"' + (t.done ? " checked" : "") + ' aria-label="Done">'
      + '<span class="tt"><span class="tt-text">' + esc(pretty(t.text)) + '</span><span class="tt-badges">' + badges + '<span class="tag ' + esc(t.tag) + '">' + esc(t.tag) + "</span></span></span>"
      + '<span class="acts">' + pinBtn("day", inDay) + pinBtn("week", inWeek)
      + '<button class="notes-btn" type="button" title="Open notes">Notes' + ((t.notes || []).length ? " " + t.notes.length : "") + '</button>'
      + '<button class="edit" type="button">Edit</button>'
      + (canSend ? '<button class="send" type="button" title="Send this task and its notes to Approvals for Claude">Send for approval</button>' : "")
      + (!t.done ? '<button class="dismiss" type="button" title="Not needed: take it off every list. The line stays in its note, marked dismissed">Dismiss</button>' : "")
      + (moreOpts ? '<details class="more-menu"><summary aria-label="More actions">&#8943;</summary><div class="more-opts">' + moreOpts + "</div></details>" : "")
      + "</span>";
    row.querySelector("input").addEventListener("change", function (e) { e.stopPropagation(); toggleTask(t, e.target.checked, e.target); });
    row.querySelector("input").addEventListener("click", function (e) { e.stopPropagation(); });
    row.querySelector(".edit").addEventListener("click", function (e) { e.stopPropagation(); editTaskInline(row, t, rerender); });
    row.querySelector(".notes-btn").addEventListener("click", function (e) { e.stopPropagation(); openDetail(navIds, navIds.indexOf(t.id)); });
    var sendBtn = row.querySelector(".send");
    if (sendBtn) sendBtn.addEventListener("click", function (e) { e.stopPropagation(); sendForApproval(t, sendBtn); });
    var dismissBtn = row.querySelector(".dismiss");
    if (dismissBtn) dismissBtn.addEventListener("click", function (e) { e.stopPropagation(); dismissTask(t, dismissBtn); });
    row.querySelectorAll(".pin-btn").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); var sc = b.dataset.scope, item = prioIdx[sc][t.id]; if (item) removeFromPrio(sc, item, b); else addToPrio(sc, t, b); });
    });
    row.querySelectorAll(".sug-menu").forEach(function (b) { b.addEventListener("click", function (e) { e.stopPropagation(); addToPrio(b.dataset.scope, t, b); }); });
    row.addEventListener("click", function (e) {
      if (e.target.closest("input, button, a, select, details")) return;
      openDetail(navIds, navIds.indexOf(t.id));
    });
    row.addEventListener("keydown", function (e) {
      if (e.target !== row) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(navIds, navIds.indexOf(t.id)); }
    });
    wrap.appendChild(row);
    return wrap;
  }
  // a note line with its wikilinks and web links made clickable, everything else escaped
  function richText(x) {
    var out = "", re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]|(https?:\/\/[^\s<>"')]+)/g, last = 0, m;
    x = String(x == null ? "" : x).replace(/\*\*/g, "").replace(/`/g, "");
    while ((m = re.exec(x))) {
      out += esc(x.slice(last, m.index));
      if (m[3]) out += '<a href="' + esc(m[3]) + '" target="_blank" rel="noopener">' + esc(m[3].replace(/^https?:\/\//, "")) + "</a>";
      else { var p = noteIndex[m[1].trim().toLowerCase()], label = m[2] || m[1].trim(); out += p ? '<a class="wiki" href="#/notes/' + encodeURIComponent(p) + '">' + esc(label) + "</a>" : esc(label); }
      last = m.index + m[0].length;
    }
    return out + esc(x.slice(last));
  }
  function noteItem(x) {
    var m = String(x).match(/^Sent for approval as (a-[\w-]+) on (\d{4})-(\d{2})-(\d{2}) (\d{1,2}:\d{2})$/);
    if (m) return '<li class="link-note" title="' + esc(m[1]) + '">Sent for approval on ' + (+m[4]) + " " + MONTHS[+m[3] - 1].slice(0, 3) + ", " + m[5] + "</li>";
    return "<li>" + richText(x) + "</li>";
  }
  function renderTaskGroups(host, list, rerender) {
    var navIds = list.map(function (t) { return t.id; }); // the order J/K moves through in the detail panel
    var groups = {};
    list.forEach(function (t) { (groups[t.project] = groups[t.project] || []).push(t); });
    var names = Object.keys(groups).sort(function (a, b) { return a === "Now" ? -1 : b === "Now" ? 1 : a.localeCompare(b); });
    names.forEach(function (name) {
      var g = document.createElement("div"); g.className = "task-group";
      var items = groups[name];
      g.innerHTML = "<h3><span>" + esc(name) + '</span><span class="count">' + items.filter(function (t) { return !t.done; }).length + " open</span></h3>";
      items.forEach(function (t) { g.appendChild(taskRow(t, rerender, navIds)); });
      host.appendChild(g);
    });
  }
  function renderTasks() {
    var list = state.tasks.filter(function (t) {
      if (t.file === NEEDS_FILE) return false;
      if (!showDone && t.done) return false;
      if (taskFilter !== "all" && t.tag !== taskFilter) return false;
      if (taskQuery && (t.text + " " + t.project + " " + t.section + " " + (t.notes || []).join(" ")).toLowerCase().indexOf(taskQuery) < 0) return false;
      return true;
    });
    var host = $("taskList"); host.innerHTML = "";
    if (!list.length) { host.innerHTML = '<div class="empty">Nothing matches.</div>'; return; }
    renderTaskGroups(host, list, renderTasks);
  }
  // what Claude needs from the operator: System/Needs from the operator.md, shown above the task list with its steps
  var NEEDS_FILE = "System/Needs from the operator.md", GUIDES_PREFIX = "System/Guides/";
  var cap = function (x) { x = String(x || ""); return x.charAt(0).toUpperCase() + x.slice(1); };
  // The newest clause on a needs row: the last of its own (non Why/Step/Guide) notes, since
  // notes are appended oldest first, or the why line when there is nothing else yet.
  function needNewestClause(t) {
    var why = "", other = [];
    (t.notes || []).forEach(function (n) {
      var m;
      if ((m = n.match(/^Why:\s*(.+)$/i))) why = m[1];
      else if (/^Step\s*\d+[:.)]\s*/i.test(n) || /^(Guide|Plan):\s*\[\[/i.test(n)) return;
      else other.push(n);
    });
    return other.length ? pretty(other[other.length - 1]) : cap(why);
  }
  // The two ways to finish a "Claude needs from you" item. Continue: their part is done, the work goes back
  // to Approvals as in progress and a run starts now (presses within two minutes share one run, and one
  // already going picks it up). Complete: the whole thing is finished; it is ticked and closed, and the
  // next scheduled run reviews it, with nothing started now.
  async function needDone(t, mode, btns, after) {
    btns.forEach(function (b) { b.disabled = true; });
    try {
      var r = await api("task/toggle", { method: "POST", body: { file: t.file, line: t.line, raw: t.raw, done: true, mode: mode } });
      if (mode === "complete") {
        toast("Complete. " + nextRunLine("The next scheduled run reviews it at "));
        fire({ count: 20, region: "stem", tint: "white", boost: 0.3 });
      } else {
        var w = r.watcher || {};
        if (w.fired) { toast("Back in the queue. Claude has started on it."); startRun("continuing your item"); }
        else if (w.why === "already going" || w.why === "already started moments ago") toast("Back in the queue. Claude is already running and picks this up too.");
        else toast("Back in the queue. " + nextRunLine("Claude carries on at "));
        fire({ count: 24, region: "stem", boost: 0.4 });
      }
      if (after) after();
      await load(false);
    } catch (err) {
      toast(err.message, true);
      btns.forEach(function (b) { b.disabled = false; });
      if (err.data && err.data.conflict) load(false);
    }
  }
  function renderNeeds() {
    var items = state.tasks.filter(function (t) { return t.file === NEEDS_FILE && !t.done; });
    setBadge("badgeNeeds", items.length); setBadge("badgeNeedsTab", items.length);
    $("needsCount").textContent = items.length ? String(items.length) : "";
    var host = $("needsList"); host.innerHTML = "";
    var navIds = items.map(function (t) { return t.id; });
    if (!items.length) host.innerHTML = '<div class="empty">Nothing needed from you right now.</div>';
    items.forEach(function (t) {
      // A div, not a button: it holds its own Done button, and a button cannot nest another one.
      var row = document.createElement("div"); row.className = "need-row"; row.tabIndex = 0;
      row.setAttribute("role", "button"); row.setAttribute("aria-label", "Open detail for " + pretty(t.text));
      row.innerHTML = '<span class="need-kind-dot" title="' + (t.tag === "decision" ? "Decision" : "To do") + '"></span>'
        + '<span class="need-row-title">' + esc(pretty(t.text)) + "</span>"
        + '<span class="need-row-clause">' + esc(needNewestClause(t)) + "</span>"
        + (isSnoozed(t.id) ? '<span class="age-chip">' + esc(snoozeReturnsLabel(t.id)) + "</span>" : "")
        + '<span class="need-row-btns"><button type="button" class="need-row-done need-row-continue" title="Your part is done: Claude carries on now">Continue</button>'
        + '<button type="button" class="need-row-done need-row-complete" title="All finished: reviewed at the next scheduled run, nothing starts now">Complete</button></span>';
      row.addEventListener("click", function (e) { if (e.target.closest(".need-row-done")) return; openDetail(navIds, navIds.indexOf(t.id)); });
      row.addEventListener("keydown", function (e) {
        if (e.target !== row) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(navIds, navIds.indexOf(t.id)); }
      });
      row.querySelectorAll(".need-row-done").forEach(function (b) {
        b.addEventListener("click", function (e) {
          e.stopPropagation();
          needDone(t, b.classList.contains("need-row-complete") ? "complete" : "continue", row.querySelectorAll(".need-row-done"));
        });
      });
      host.appendChild(row);
    });
    var guidesAll = state.notes.filter(function (n) { return n.path.indexOf(GUIDES_PREFIX) === 0; }).sort(function (a, b) { return a.title.localeCompare(b.title); });
    $("guidesRow").innerHTML = guidesAll.length ? '<span class="guides-label">Guides</span>' + guidesAll.map(function (n) { return '<a class="chip guide-chip" href="#/notes/' + encodeURIComponent(n.path) + '">' + esc(n.title) + "</a>"; }).join("") : "";
  }
  // Keeps a ticked task's strikethrough and its priority rows in step everywhere it is drawn,
  // without waiting for the vault to confirm the tick. it.done on a priority line is its own
  // flag, separate from the task's, so it is patched alongside t.done.
  function setTaskDoneLocally(t, done) {
    t.done = done;
    if (state && state.priorities) {
      ["day", "week"].forEach(function (sc) {
        state.priorities[sc].items.forEach(function (it) { if (it.kind === "task" && it.taskId === t.id) it.done = done; });
      });
    }
  }
  function refreshTaskViews() { renderTasks(); renderWork(); renderNeeds(); renderPriorities(); if (detailNav) renderDetail(); }
  function toggleTask(t, done) {
    var was = t.done;
    setTaskDoneLocally(t, done);
    refreshTaskViews();
    // The task as the current state holds it: after a load() that is a new object, not t.
    var live = function () { return (state && state.tasks || []).find(function (x) { return x.id === t.id; }) || t; };
    var label = (done ? "Ticking: " : "Reopening: ") + pretty(t.text).slice(0, 60);
    var item = queueUndo({
      label: label,
      key: "task:" + t.id,
      persist: { kind: "task", id: t.id, value: done },
      commit: async function (o) {
        o = o || {};
        try {
          await api("task/toggle", { method: "POST", body: { file: t.file, line: t.line, raw: t.raw, done: done }, keepalive: o.keepalive });
          endChoice(item, true);
          fire({ count: 18, region: "stem", tint: done ? "auto" : "orange", boost: 0.3 });
          toast(done ? "Ticked in " + t.file : "Reopened in " + t.file);
        } catch (e) {
          endChoice(item, false);
          setTaskDoneLocally(live(), was); refreshTaskViews();
          undoFail(label, e);
        } finally { afterSettle(); }
      },
      revert: function () { setTaskDoneLocally(live(), was); refreshTaskViews(); }
    });
  }
  // Dismiss asks once on the button itself (no browser dialog): the first press turns it into
  // "Dismiss?" for four seconds, the second press does it.
  async function dismissTask(t, btn, after) {
    if (!btn.classList.contains("confirm")) {
      btn.classList.add("confirm"); btn.textContent = "Dismiss?";
      setTimeout(function () { if (btn.isConnected && btn.classList.contains("confirm")) { btn.classList.remove("confirm"); btn.textContent = "Dismiss"; } }, 4000);
      return;
    }
    btn.disabled = true;
    try {
      await api("task/dismiss", { method: "POST", body: { file: t.file, line: t.line, raw: t.raw } });
      toast("Dismissed. It stays in " + (t.project || "its note") + ", marked [-].");
      fire({ count: 12, region: "cortex" });
      if (after) after();
      await load(false);
    } catch (err) { toast(err.message, true); btn.disabled = false; if (err.data && err.data.conflict) load(false); }
  }
  async function sendForApproval(t, btn) {
    btn.disabled = true;
    try {
      var r = await api("task/request", { method: "POST", body: { file: t.file, line: t.line, raw: t.raw } });
      if (r.linked === false) toast("Sent to Approvals as " + r.id + ", but the task could not be marked. Do not send it again.", true);
      else toast("Sent to Approvals as " + r.id + ". " + (r.watcher && r.watcher.fired ? "Claude is scoping it now; nothing runs before your yes." : "Claude scopes it before anything runs."));
      fire({ count: 30, region: "stem", tint: "orange", boost: 0.5 });
      await load(false);
    } catch (err) { toast(err.message, true); btn.disabled = false; if (err.data && err.data.conflict) load(false); }
  }
  function editTaskInline(row, t, rerender) {
    var form = document.createElement("form"); form.className = "task-edit-row";
    form.innerHTML = '<input type="text" value="' + esc(t.text) + '" required><select><option' + (t.tag === "next" ? " selected" : "") + '>next</option><option' + (t.tag === "blocked" ? " selected" : "") + '>blocked</option><option' + (t.tag === "decision" ? " selected" : "") + '>decision</option></select><button class="primary" type="submit">Save</button><button type="button" class="cancel">Cancel</button>';
    row.replaceWith(form);
    form.querySelector(".cancel").addEventListener("click", function () { rerender(); });
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      var text = form.querySelector("input").value, tag = form.querySelector("select").value;
      try { await api("task/edit", { method: "POST", body: { file: t.file, line: t.line, raw: t.raw, text: text, tag: tag } }); toast("Saved"); fire({ count: 10, region: "cortex" }); await load(false); }
      catch (err) { toast(err.message, true); }
    });
    form.querySelector("input").focus();
  }
  // Shared with the command palette's "Add as a task": one call, one toast, one reload.
  async function submitTask(text, tag, project) {
    await api("task/add", { method: "POST", body: { text: text, tag: tag || "next", project: project || "" } });
    toast("Added to Now"); fire({ count: 24, region: "cortex", boost: 0.4 }); await load(false);
  }
  $("addTask").addEventListener("submit", async function (e) {
    e.preventDefault();
    var text = $("newTaskText").value.trim(); if (!text) return;
    var btn = e.target.querySelector("button"); btn.disabled = true;
    try {
      await submitTask(text, $("newTaskTag").value, $("newTaskProject").value.trim());
      $("newTaskText").value = ""; $("newTaskProject").value = "";
    } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
  });
  document.querySelectorAll("#view-tasks .chip").forEach(function (c) {
    c.addEventListener("click", function () { document.querySelectorAll("#view-tasks .chip").forEach(function (x) { x.setAttribute("aria-pressed", "false"); }); c.setAttribute("aria-pressed", "true"); taskFilter = c.dataset.f; renderTasks(); });
  });
  $("showDone").addEventListener("change", function (e) { showDone = e.target.checked; renderTasks(); });
  $("taskSearch").addEventListener("input", function (e) { taskQuery = e.target.value.trim().toLowerCase(); renderTasks(); });

  // fernmoor: the group's work, apart from the operator's own ventures
  // Three brands plus the group-wide work (the Hub, the CRM, the director report). Group is
  // where anything lands that names no one brand.
  var BRANDS = ["Fernmoor Heating", "Ridgeby Roofing", "Warmstead", "Group"];
  var workFilter = "all", workShowDone = false;
  var WORK_WORDS = /\b(fernmoor hub|fernmoor|ridgeby|warmstead)\b/i;
  function brandIn(text) {
    return /\bridgeby\b/i.test(text) ? BRANDS[1] : /\bwarmstead\b/i.test(text) ? BRANDS[2] : /\bfernmoor heating\b/i.test(text) ? BRANDS[0] : "";
  }
  function brandOf(t) {
    if (t.file === "Now.md") {
      if (!WORK_WORDS.test(t.text)) return null;
      return brandIn(t.text) || BRANDS[3];
    }
    if (t.file.indexOf("Wiki/Fernmoor/") !== 0) return null;
    var f = t.file.toLowerCase(), sec = (t.section || "").toLowerCase();
    if (/fernmoor tasks\.md$/.test(f)) return brandIn(sec) || BRANDS[3];
    return brandIn(f.split("/").pop()) || BRANDS[3];
  }
  function renderWork() {
    var host = $("workList"); host.innerHTML = "";
    var all = state.tasks.filter(function (t) { return brandOf(t); });
    var list = all.filter(function (t) { return (workShowDone || !t.done) && (workFilter === "all" || t.tag === workFilter); });
    $("workCount").textContent = all.filter(function (t) { return !t.done; }).length + " open across the group.";
    BRANDS.forEach(function (brand) {
      var items = list.filter(function (t) { return brandOf(t) === brand; });
      var sec = document.createElement("section"); sec.className = "brand-block";
      sec.innerHTML = '<h2 class="brand-head"><span>' + esc(brand) + '</span><span class="count">' + items.filter(function (t) { return !t.done; }).length + " open</span></h2>";
      if (!items.length) sec.insertAdjacentHTML("beforeend", '<div class="empty">Nothing here' + (workFilter === "all" ? "" : " with this filter") + ".</div>");
      else renderTaskGroups(sec, items, renderWork);
      host.appendChild(sec);
    });
  }
  $("addWork").addEventListener("submit", async function (e) {
    e.preventDefault();
    var text = $("workText").value.trim(); if (!text) return;
    var btn = e.target.querySelector("button"); btn.disabled = true;
    try {
      await api("task/add", { method: "POST", body: { area: "fernmoor", text: text, tag: $("workTag").value, brand: $("workBrand").value } });
      $("workText").value = "";
      toast("Added to Fernmoor tasks"); fire({ count: 24, region: "cortex", boost: 0.4 }); await load(false);
    } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
  });
  document.querySelectorAll("#view-fernmoor .chip").forEach(function (c) {
    c.addEventListener("click", function () { document.querySelectorAll("#view-fernmoor .chip").forEach(function (x) { x.setAttribute("aria-pressed", "false"); }); c.setAttribute("aria-pressed", "true"); workFilter = c.dataset.f; renderWork(); });
  });
  $("workShowDone").addEventListener("change", function (e) { workShowDone = e.target.checked; renderWork(); });

  // Attach a file to a task or a needs item: it lands beside the note, or in Inbox for System notes,
  // and the task gets a note naming it, so Claude picks it up like any other note.
  function wireUpload(form, t, onDone) {
    var input = form.querySelector("input[type=file]"), btn = form.querySelector("button");
    input.addEventListener("change", async function () {
      var file = input.files && input.files[0]; if (!file) return;
      if (file.size > 4500000) { toast("That file is " + (file.size / 1000000).toFixed(1) + " MB. The limit here is 4.5 MB.", true); input.value = ""; return; }
      btn.disabled = true; var label = btn.textContent; btn.textContent = "Sending…";
      try {
        var data = await new Promise(function (res, rej) {
          var r = new FileReader();
          r.onload = function () { res(String(r.result).split(",")[1] || ""); };
          r.onerror = function () { rej(new Error("The file could not be read.")); };
          r.readAsDataURL(file);
        });
        var out = await api("task/upload", { method: "POST", body: { file: t.file, line: t.line, raw: t.raw, name: file.name, data: data } });
        toast("Saved to " + out.path + ". " + nextRunLine("Claude picks it up at "));
        fire({ count: 14, region: "stem", tint: "auto", boost: 0.3 });
        if (onDone) onDone();
      } catch (err) { toast(err.message, true); if (err.data && err.data.conflict) load(false); }
      finally { btn.disabled = false; btn.textContent = label; input.value = ""; }
    });
    btn.addEventListener("click", function () { input.click(); });
  }
  var uploadForm = '<form class="note-upload" onsubmit="return false"><input type="file" hidden><button type="button" class="attach">Attach a file</button></form>';

  // The cloud routines run on UTC times, so the wait is worked out in UTC and shown in local time.
  var RUNS_UTC = [[8, 0, "the approvals watcher"], [11, 0, "the approvals watcher"], [14, 0, "the approvals watcher"], [17, 30, "the evening review"]];
  // Every job, as the cloud routines are set. Times are UTC, so they read correctly either side of the clock change.
  var JOBS = [
    { name: "MORNING", label: "Morning plan", times: [[6, 0]], days: "weekdays", note: "Writes the day's plan before you sit down" },
    { name: "APPROVALS WATCHER", label: "Approvals watcher", times: [[8, 0], [11, 0], [14, 0]], days: "weekdays", note: "Carries out what you approve and reads the notes you write" },
    { name: "EVENING", label: "Evening review", times: [[17, 30]], days: "weekdays", note: "Closes the day and sweeps the queue" },
    { name: "WEEKLY", label: "Weekly direction", times: [[17, 0]], days: "sunday", note: "Sets the week and runs Scout" },
    { name: "TIDY", label: "Monthly tidy", times: [[6, 30]], days: "first", note: "Tidies the vault on the first of the month" }
  ];
  function nextFor(job) {
    var now = new Date();
    for (var d = 0; d < 40; d++) {
      for (var i = 0; i < job.times.length; i++) {
        var t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + d, job.times[i][0], job.times[i][1], 0));
        if (t <= now) continue;
        var day = t.getUTCDay(), dom = t.getUTCDate();
        if (job.days === "weekdays" && (day === 0 || day === 6)) continue;
        if (job.days === "sunday" && day !== 0) continue;
        if (job.days === "first" && dom !== 1) continue;
        return t;
      }
    }
    return null;
  }
  function whenWords(t) {
    if (!t) return "";
    var now = new Date(), hm = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    var tom = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    if (t.toDateString() === now.toDateString()) return hm + " today, " + inWords(t - now) + " from now";
    if (t.toDateString() === tom.toDateString()) return hm + " tomorrow";
    return hm + " on " + t.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
  }
  function nextRun() {
    var now = new Date();
    for (var d = 0; d < 7; d++) {
      for (var i = 0; i < RUNS_UTC.length; i++) {
        var t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + d, RUNS_UTC[i][0], RUNS_UTC[i][1], 0));
        var day = t.getUTCDay();
        if (day === 0 || day === 6) continue;
        if (t > now) return { at: t, job: RUNS_UTC[i][2] };
      }
    }
    return null;
  }
  function inWords(ms) {
    var m = Math.max(1, Math.round(ms / 60000));
    if (m < 60) return "about " + m + (m === 1 ? " minute" : " minutes");
    var h = Math.floor(m / 60), r = m % 60;
    return "about " + h + (h === 1 ? " hour" : " hours") + (r >= 10 ? " " + r + " minutes" : "");
  }
  function nextRunLine(prefix) {
    var n = nextRun();
    if (!n) return "";
    var now = new Date(), wait = n.at - now;
    var hm = n.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    var tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    var when = n.at.toDateString() === now.toDateString() ? hm + " today"
      : n.at.toDateString() === tomorrow.toDateString() ? hm + " tomorrow"
      : hm + " on " + n.at.toLocaleDateString([], { weekday: "long" });
    return (prefix || "Claude picks this up at ") + when
      + (wait < 12 * 3600 * 1000 ? ", " + inWords(wait) + " from now" : "") + ", on " + n.job + ".";
  }

  // ---------- snooze: an approval or a needs row, hidden until a chosen time ----------
  // Stored in Netlify Blobs by row id (see /api/snooze), never in the vault: the row itself is
  // untouched. The four options are worked out here, in the browser's own local time, and sent
  // up as a plain ISO timestamp; the server only ever stores and returns what it is given.
  var SNOOZE_OPTIONS = [
    { key: "later-today", label: "Later today (17:00)" },
    { key: "tomorrow", label: "Tomorrow 09:00" },
    { key: "monday", label: "Monday 09:00" }
  ];
  function snoozeTargetFor(key) {
    var now = new Date();
    if (key === "later-today") {
      var d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 17, 0, 0, 0);
      if (d <= now) d.setDate(d.getDate() + 1);
      return d;
    }
    if (key === "tomorrow") return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0);
    if (key === "monday") {
      var add = (8 - now.getDay()) % 7; if (!add) add = 7;
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() + add, 9, 0, 0, 0);
    }
    return null;
  }
  function isSnoozed(id) {
    var iso = state.snoozes && state.snoozes[id];
    return Boolean(iso && Date.parse(iso) > Date.now());
  }
  function snoozeReturnsLabel(id) {
    var iso = state.snoozes && state.snoozes[id];
    if (!iso) return "";
    var d = new Date(iso), now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    return "Returns " + (sameDay ? "today " : d.getDate() + " " + MONTHS[d.getMonth()].slice(0, 3) + " ") + hm(d);
  }
  async function snoozeSet(id, untilDateOrNull) {
    var r = await api("snooze", { method: "POST", body: { id: id, until: untilDateOrNull ? untilDateOrNull.toISOString() : "" } });
    state.snoozes = r.snoozes || state.snoozes || {};
    return r;
  }
  // A native <details> disclosure, not a positioned popover: it opens and closes with the
  // keyboard for free, needs no click-outside handling, and reads correctly on a phone.
  function snoozeMenuHtml(extraClass) {
    return '<details class="snooze-menu' + (extraClass ? " " + extraClass : "") + '"><summary>Snooze</summary><div class="snooze-opts">'
      + SNOOZE_OPTIONS.map(function (o) { return '<button type="button" data-k="' + o.key + '">' + esc(o.label) + "</button>"; }).join("")
      + '<div class="snooze-pick"><input type="date" aria-label="Pick a date"><button type="button" data-k="pick">Snooze to this date</button></div>'
      + "</div></details>";
  }
  // Wires a snoozeMenuHtml() element for one row: onDone runs after a successful snooze (or
  // unsnooze), so the caller can re-render or close whatever it needs to.
  function wireSnoozeMenu(root, id, onDone) {
    var det = root.querySelector(".snooze-menu"); if (!det) return;
    det.querySelectorAll("button[data-k]").forEach(function (b) {
      b.addEventListener("click", async function (e) {
        e.preventDefault();
        var k = b.dataset.k, target;
        if (k === "pick") {
          var val = det.querySelector('input[type="date"]').value;
          if (!val) return;
          target = new Date(val + "T09:00:00");
        } else target = snoozeTargetFor(k);
        if (!target) return;
        b.disabled = true;
        try { await snoozeSet(id, target); toast("Snoozed. " + snoozeReturnsLabel(id) + "."); fire({ count: 10, region: "stem", boost: 0.2 }); if (onDone) onDone(); }
        catch (err) { undoFail("Snooze", err); } finally { b.disabled = false; }
      });
    });
  }

  // approvals: waiting for their yes, their requests being scoped, in progress, settled
  // ---------- approvals: estimates, waiting-on, and how long something took ----------
  function estOf(note) { var m = String(note || "").match(/\bEst:\s*([^|]+)$/i); return m ? m[1].trim().replace(/\s*$/, "") : ""; }
  function waitOf(note) { var m = String(note || "").match(/^(Waiting on[^.]*\.?)/i); return m ? m[1].trim() : ""; }
  // A row's note is appended to, never overwritten (Approvals rule, 18 Sep): each change adds a
  // dated clause after "; ". The vault keeps them oldest first so the trail reads in order; here
  // the newest clause leads, because what moved last is what the card is for.
  var DATED = /^.{0,60}?\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b|^.{0,60}?\b\d{4}-\d{2}-\d{2}\b/;
  function newestFirst(note) {
    var t = String(note || "").trim();
    if (!t) return t;
    var parts = t.split(/;\s+(?=[A-Z0-9])/), clauses = [parts[0]];
    for (var i = 1; i < parts.length; i++) {
      if (DATED.test(parts[i])) clauses.push(parts[i]); else clauses[clauses.length - 1] += "; " + parts[i];
    }
    if (clauses.length < 2) return t;
    return clauses.reverse().map(function (c) { return c.replace(/[.;\s]+$/, ""); }).join(". ") + ".";
  }
  function noteRest(note, frag) {
    var t = String(note || "").trim();
    if (frag) t = t.replace(frag, "");
    t = t.replace(/\bEst:\s*$/i, "").replace(/^[;,.\s]+/, "").trim();
    return newestFirst(t);
  }
  function parseWhen(s) {
    var m = String(s || "").match(/(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 12, m[5] ? +m[5] : 0);
  }
  function whenShort(s) {
    var d = parseWhen(s); if (!d) return String(s || "");
    var hasTime = /\d{1,2}:\d{2}/.test(String(s));
    return d.getDate() + " " + MONTHS[d.getMonth()].slice(0, 3) + (hasTime ? " " + hm(d) : "");
  }
  // How long a row has been waiting for their yes: a quiet chip on every pending row, tinted
  // orange once it has waited more than five days, so an old ask stands out from a fresh one
  // without needing to open it.
  function ageDays(requested) {
    var d = parseWhen(requested); if (!d) return null;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }
  function ageChip(requested) {
    var n = ageDays(requested);
    if (n === null || n < 1) return "";
    return '<span class="age-chip' + (n > 5 ? " old" : "") + '" title="Asked ' + esc(whenShort(requested)) + '">' + n + (n === 1 ? " day" : " days") + "</span>";
  }
  function took(req, dec) {
    var a = parseWhen(req), b = parseWhen(dec);
    if (!a || !b) return "";
    var mins = Math.round((b - a) / 60000);
    if (mins < 5) return "";
    if (mins < 90) return mins + " min";
    if (mins < 36 * 60) return Math.round(mins / 60) + " h";
    var days = Math.round(mins / 1440);
    return days + (days === 1 ? " day" : " days");
  }

  // Pull a plain duration out of an estimate so the card can lead with "40 min" or "4 h"
  // instead of a paragraph. Everything else folds away behind a Detail toggle.
  var WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  function durationOf(text) {
    // Only the opening clause counts. "Est: 2 hours; pull the last 30 days of Meta data"
    // must read as 2 h, never 30 days, so anything after the first semicolon is ignored,
    // and a window like "last 30 days" or "next 7 days" is not a duration at all.
    var head = String(text || "").split(/[;\u2014]|\. /)[0].slice(0, 90).toLowerCase();
    var t = " " + head.replace(/\b(?:last|past|next|previous|first)\s+\d+\s+\w+/g, " ") + " ";
    var m;
    if (/\bhalf a day\b/.test(t)) return "4 h";
    if (/\ba (?:full|whole) day\b/.test(t)) return "1 day";
    if ((m = t.match(/\b(\d+)\s*(?:to|-|\u2013)\s*(\d+)\s*(?:min|minute)s?\b/))) return m[1] + "-" + m[2] + " min";
    if ((m = t.match(/\b(\d+)\s*(?:to|-|\u2013)\s*(\d+)\s*(?:h|hr|hour)s?\b/))) return m[1] + "-" + m[2] + " h";
    if ((m = t.match(/\b(\d+(?:\.\d+)?)\s*(?:min|minute)s?\b/))) return m[1] + " min";
    if ((m = t.match(/\b(\d+(?:\.\d+)?)\s*(?:h|hr|hour)s?\b/))) return m[1] + " h";
    if ((m = t.match(/\b(\d+)\s*days?\b/))) return m[1] + (m[1] === "1" ? " day" : " days");
    if ((m = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:min|minute)s?\b/))) return WORD_NUM[m[1]] + " min";
    if ((m = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hour|hr)s?\b/))) return WORD_NUM[m[1]] + " h";
    if (/\ban hour\b/.test(t)) return "1 h";
    if (/\bthis session\b|\bin this session\b/.test(t)) return "This session";
    if (/\bnext run\b|\bthe next run\b/.test(t)) return "Next run";
    return "";
  }

  // An Est. or Waiting block: the number up front, the words behind a toggle.
  function estBlock(kind, label, text) {
    var body = String(text || "").trim();
    var cls = "est" + (kind === "waiting" ? " waiting" : kind === "none" ? " none" : "");
    // Always one short value on the row, never a paragraph: a card whose estimate ran to five
    // lines pushed everything under it out of line with the cards beside it.
    var dur = kind === "waiting" ? "You" : (durationOf(body) || (body ? "See detail" : "Not set"));
    if (!body) return '<div class="' + cls + '"><span class="est-k">' + esc(label) + '</span><span class="est-v">' + esc(dur) + "</span></div>";
    return '<details class="' + cls + '"><summary><span class="est-k">' + esc(label) + '</span><span class="est-v">' + esc(dur)
      + '</span><span class="est-hint">Detail</span></summary><div class="est-body">' + esc(newestFirst(body)) + "</div></details>";
  }

  // Long detail text: lead sentence visible, the rest folded away.
  function detailBlock(text, cls) {
    var t = String(text || "").trim();
    if (!t) return "";
    cls = cls || "d";
    if (t.length <= 200) return '<div class="' + cls + '">' + esc(t) + "</div>";
    var cut = -1, from = 90;
    var stops = [". ", "? ", "! "];
    for (var i = 0; i < stops.length; i++) {
      var k = t.indexOf(stops[i], from);
      if (k > -1 && (cut === -1 || k < cut)) cut = k + 1;
    }
    if (cut === -1 || cut > 320) cut = t.lastIndexOf(" ", 220);
    if (cut < 60) cut = 200;
    var head = t.slice(0, cut).trim(), rest = t.slice(cut).trim();
    if (!rest) return '<div class="' + cls + '">' + esc(head) + "</div>";
    return '<details class="' + cls + ' fold"><summary><span>' + esc(head) + '</span><span class="fold-hint">More</span></summary>'
      + '<div class="fold-body">' + esc(rest) + "</div></details>";
  }

  function approvalCard(a, kind) {
    if (kind === "settled") return settledCard(a);
    if (kind === "snoozed") return snoozedCard(a);
    var d = document.createElement("div"); d.className = "card " + kind;
    var est = estOf(a.note), wait = waitOf(a.note), rest = noteRest(a.note, est || wait);
    var meta = metaRow([
      a.source ? "<span>From <b>" + esc(a.source) + "</b></span>" : "",
      a.cost ? "<span>Cost <b>" + esc(a.cost) + "</b></span>" : "",
      a.reversible ? "<span>Reversible <b>" + esc(a.reversible) + "</b></span>" : "",
      '<span class="mono">Asked ' + esc(whenShort(a.requested)) + "</span>"
    ]);
    var estLine = est ? estBlock("est", "Est.", est)
      : wait ? estBlock("waiting", "Waiting", wait.replace(/^Waiting on[:\s]*/i, ""))
      : kind === "active" ? estBlock("none", "Est.", "") : "";
    var row;
    if (kind === "pending") row = '<div class="row"><button class="approve" type="button">Approve</button><button class="decline" type="button">Decline</button>' + snoozeMenuHtml() + '<span class="why">' + (state.watcher && state.watcher.configured ? "Claude starts on it as soon as you approve" : "Picked up by the next job or an open chat") + "</span></div>";
    else if (kind === "requested") row = '<div class="row"><span class="pill requested">requested</span><button class="decline withdraw" type="button">Withdraw</button></div><div class="why-line">Claude turns this into a proposal with the cost and what will change, then it waits for your yes</div>';
    else row = '<div class="row"><span class="pill ' + esc(a.status) + '">' + esc(a.status) + "</span>" + (rest ? '<span class="why">' + esc(rest) + "</span>" : "") + "</div>"
      + (kind === "active" ? '<div class="why-line">' + esc((a.status || "").toLowerCase() === "approved" ? nextRunLine() : nextRunLine("Next update at ")) + "</div>" : "");
    d.innerHTML = '<div class="t">' + esc(pretty(a.title)) + (kind === "pending" ? ageChip(a.requested) : "") + "</div>" + detailBlock(pretty(a.detail)) + estLine + meta + row;
    if (kind === "pending") {
      d.querySelector(".approve").addEventListener("click", function () { decide(a, "approved"); });
      d.querySelector(".decline").addEventListener("click", function () { decide(a, "declined"); });
      wireSnoozeMenu(d, a.id, function () { renderApprovals(); });
    }
    if (kind === "requested") d.querySelector(".withdraw").addEventListener("click", function () { decide(a, "declined"); });
    return d;
  }

  // A snoozed row: title, when it returns, and the one way back, Unsnooze. Everything else
  // about the row (its status, its detail) is exactly as it was; only the timing changed here.
  function snoozedCard(a) {
    var d = document.createElement("div"); d.className = "card snoozed";
    d.innerHTML = '<div class="t">' + esc(pretty(a.title)) + "</div>"
      + '<div class="row"><span class="pill snoozed-pill">' + esc(snoozeReturnsLabel(a.id)) + '</span><button type="button" class="unsnooze">Unsnooze</button></div>';
    d.querySelector(".unsnooze").addEventListener("click", async function (e) {
      e.target.disabled = true;
      try { await snoozeSet(a.id, null); toast("Back in the queue."); renderApprovals(); }
      catch (err) { undoFail("Unsnooze " + pretty(a.title).slice(0, 60), err); e.target.disabled = false; }
    });
    return d;
  }

  // Settled: what it was, what came of it, when it finished and how long it took.
  function settledCard(a) {
    var d = document.createElement("div"); d.className = "card settled";
    var st = (a.status || "").toLowerCase();
    var t = took(a.requested, a.decided);
    var when = a.decided ? whenShort(a.decided) : "";
    d.innerHTML = '<div class="settled-top"><span class="pill ' + esc(st) + '">' + esc(a.status) + "</span>"
      + '<div class="t">' + esc(pretty(a.title)) + "</div></div>"
      + detailBlock(newestFirst(pretty(a.note)) || (st === "declined" ? "Declined. It is not asked again." : "No outcome was written."), "settled-out")
      + '<div class="settled-when">' + (when ? "<span><b>" + esc(st === "declined" ? "Declined" : "Completed") + "</b> " + esc(when) + "</span>" : '<span class="dim">No completion date recorded</span>')
      + (t ? "<span>Took <b>" + esc(t) + "</b></span>" : "")
      + '<span class="dim">Asked ' + esc(whenShort(a.requested)) + "</span></div>";
    return d;
  }

  // Several approvals inside the same undo window must start one run between them, not one
  // each: approvalBatchStart/End count how many approve actions are currently open (queued or
  // committing), and only the one that brings the count back to zero calls the watcher route.
  var approvalsInFlight = 0;
  function approvalBatchStart() { approvalsInFlight++; }
  // A cancelled approve (Undo pressed) leaves the queue: it must still drop off the count, but
  // never itself counts as the one that starts the run.
  function approvalBatchCancel() { approvalsInFlight = Math.max(0, approvalsInFlight - 1); }
  function approvalBatchEnd() {
    approvalsInFlight = Math.max(0, approvalsInFlight - 1);
    if (approvalsInFlight > 0) return;
    api("watcher", { method: "POST", body: {} }).then(function (w) {
      toast(approvedText(w));
      if (w.fired) { startRun("approvals"); fire({ count: 40, region: "all", boost: 0.6 }); }
    }).catch(function () {});
  }
  function decide(a, status) {
    var was = a.status;
    var label = (was === "requested" ? "Withdrawing: " : status === "approved" ? "Approving: " : "Declining: ") + pretty(a.title).slice(0, 60);
    a.status = status; // optimistic: the card moves to its new group at once
    renderApprovals();
    if (status === "approved") approvalBatchStart();
    // The row as the current state holds it: after a load() that is a new object, not a.
    var live = function () { return (state && state.approvals || []).find(function (x) { return x.id === a.id; }) || a; };
    var item = queueUndo({
      label: label,
      key: "approval:" + a.id,
      approve: status === "approved",
      persist: { kind: "approval", id: a.id, value: status },
      commit: async function (o) {
        o = o || {};
        var fireWatcher = status === "approved" && o.fireWatcher;
        try {
          var r = await api("approval", { method: "POST", body: { id: a.id, status: status, skipWatcher: status === "approved" && !fireWatcher }, keepalive: o.keepalive });
          endChoice(item, true);
          toast(fireWatcher && r && r.watcher ? approvedText(r.watcher) : was === "requested" ? "Withdrawn." : status === "approved" ? "Approved." : "Declined. It will not be asked again.");
          if (fireWatcher && r && r.watcher && r.watcher.fired) startRun("approvals");
          fire({ count: 40, region: status === "approved" ? "all" : "stem", tint: status === "approved" ? "white" : "orange", boost: 0.6 });
        } catch (e) {
          endChoice(item, false);
          live().status = was; renderApprovals();
          undoFail(label, e);
        } finally {
          // Settled together by settleAll, the batch's last approve has already asked the server
          // to start Claude, so these only leave the count and never call the watcher again.
          if (status === "approved") { if (o.flushed) approvalBatchCancel(); else approvalBatchEnd(); }
          afterSettle();
        }
      },
      revert: function () { live().status = was; renderApprovals(); if (status === "approved") approvalBatchCancel(); }
    });
  }
  function approvedText(w) {
    if (w && w.fired) return "Approved. Claude has started on it.";
    if (w && (w.why === "already started moments ago" || w.why === "already going")) return "Approved. Claude is already running and picks this up too.";
    if (w && w.why && w.why !== "not set up") return "Approved, but Claude could not be started (" + w.why + "). The evening run or an open chat picks it up.";
    return "Approved. The next job or an open chat picks it up.";
  }
  function watcherLine() {
    var on = state.watcher && state.watcher.configured;
    var n = nextRun();
    $("watcherLine").textContent = (on ? "Claude starts on its own when you approve something or send a request. " : "Claude picks approvals up at the next scheduled run. ")
      + (n ? "Next scheduled run: " + whenWords(n.at) + ", " + n.job + "." : "");
    $("watcherRun").hidden = !on;
  }
  function noteCard(n) {
    var d = document.createElement("div"); d.className = "card active";
    var waiting = (n.status || "").toLowerCase() === "new";
    d.innerHTML = '<div class="t">' + esc(n.note) + "</div>"
      + '<div class="d">On: ' + esc(n.task || "a task") + "</div>"
      + metaRow(["<span>Written <b>" + esc(n.added || "") + "</b></span>", n.file ? "<span>In <b>" + esc(n.file) + "</b></span>" : ""])
      + '<div class="row"><span class="pill ' + (waiting ? "approved" : "done") + '">' + (waiting ? "waiting" : esc(n.status)) + "</span>"
      + (n.outcome ? '<span class="why">' + esc(n.outcome) + "</span>" : "") + "</div>"
      + (waiting ? '<div class="why-line">' + esc(nextRunLine()) + " Claude reads it as approved work: it changes the task, does it, or asks you if it needs a yes.</div>" : "");
    return d;
  }
  // Shared by the card list and the desktop inbox, so both read the queue the same way. A
  // pending row that is currently snoozed moves to its own group instead of "waiting for your
  // yes": the row is untouched, only hidden from the queue until the time picked.
  function groupApprovals() {
    var g = { pending: [], requested: [], active: [], settled: [], snoozed: [] };
    state.approvals.forEach(function (a) {
      var st = (a.status || "").toLowerCase();
      if (st === "pending") { if (isSnoozed(a.id)) g.snoozed.push(a); else g.pending.push(a); }
      else if (st === "requested") g.requested.push(a);
      else if (st === "approved" || st === "in progress") g.active.push(a);
      else g.settled.push(a);
    });
    g.settled.sort(function (x, y) {
      var a = parseWhen(y.decided) || parseWhen(y.requested) || 0, b = parseWhen(x.decided) || parseWhen(x.requested) || 0;
      return a - b;
    });
    g.snoozed.sort(function (x, y) { return Date.parse(state.snoozes[x.id]) - Date.parse(state.snoozes[y.id]); });
    return g;
  }
  function renderApprovals() {
    watcherLine();
    var g = groupApprovals();
    var fill = function (id, items, kind, empty) {
      var host = $(id); host.innerHTML = "";
      if (!items.length) { host.innerHTML = '<div class="empty">' + esc(empty) + "</div>"; return; }
      items.forEach(function (a) { host.appendChild(approvalCard(a, kind)); });
    };
    fill("approvalsPending", g.pending, "pending", "Nothing waiting for your yes.");
    fill("approvalsRequested", g.requested, "requested", "No requests being scoped. Write one above, or send a task from Tasks.");
    var notesHost = $("approvalsNotes");
    if (!notesHost) {
      var anchor = $("approvalsActive");
      if (anchor && anchor.parentNode) {
        var h = document.createElement("h2"); h.className = "sub-head"; h.textContent = "Notes you have written, waiting to be picked up";
        notesHost = document.createElement("div"); notesHost.className = "cards"; notesHost.id = "approvalsNotes";
        var head = anchor.previousElementSibling && anchor.previousElementSibling.classList.contains("sub-head") ? anchor.previousElementSibling : anchor;
        anchor.parentNode.insertBefore(h, head); anchor.parentNode.insertBefore(notesHost, head);
      }
    }
    if (notesHost) {
      var queued = (state.noteQueue || []).filter(function (n) { return (n.status || "").toLowerCase() === "new"; });
      notesHost.innerHTML = "";
      if (!queued.length) notesHost.innerHTML = '<div class="empty">No notes waiting. A note you write on a task lands here and is picked up on the next run.</div>';
      else queued.forEach(function (n) { notesHost.appendChild(noteCard(n)); });
    }
    fill("approvalsActive", g.active, "active", "Nothing in progress.");
    fill("approvalsSettled", showAllSettled ? g.settled : g.settled.slice(0, 8), "settled", "No decisions yet.");
    var more = $("settledMore");
    if (more) {
      more.hidden = g.settled.length <= 8;
      more.textContent = showAllSettled ? "Show fewer" : "Show all " + g.settled.length;
    }
    var snoozedToggle = $("snoozedToggle"), snoozedHead = $("snoozedHead"), snoozedHost = $("approvalsSnoozed");
    if (snoozedHead) snoozedHead.hidden = !g.snoozed.length;
    if (snoozedToggle) snoozedToggle.textContent = (showSnoozed ? "Hide " : "Show ") + g.snoozed.length;
    if (snoozedHost) { snoozedHost.innerHTML = ""; if (showSnoozed) g.snoozed.forEach(function (a) { snoozedHost.appendChild(approvalCard(a, "snoozed")); }); }
    renderApprovalsInbox(g);
    renderReview();
    renderApprovalPriorities();
  }

  // ---------- done for review: rows finished in the last 7 days, waiting on Accept, Redo or Later.
  // Accept and Later only ever change the platform's own review state (Blobs, never the vault); a
  // row is only really settled once they accept it or 7 days pass since it was decided. Redo is the
  // one action that changes the row itself: it goes back to "approved" with their note appended, so
  // it is rebuilt to what they actually asked for. ----------
  function doneReviewRows() {
    var cutoff = Date.now() - 7 * 86400000;
    return (state.approvals || []).filter(function (a) {
      if ((a.status || "").toLowerCase() !== "done") return false;
      var d = parseWhen(a.decided);
      if (!d || d.getTime() < cutoff) return false;
      var rs = (state.reviewState || {})[a.id];
      return !(rs && rs.status === "settled");
    }).sort(function (x, y) {
      var rx = (state.reviewState || {})[x.id], ry = (state.reviewState || {})[y.id];
      var lx = rx && rx.status === "later" ? 1 : 0, ly = ry && ry.status === "later" ? 1 : 0;
      if (lx !== ly) return lx - ly; // put off rows sink to the bottom, everything else stays newest first
      var dx = parseWhen(x.decided), dy = parseWhen(y.decided);
      return (dy ? dy.getTime() : 0) - (dx ? dx.getTime() : 0);
    });
  }
  function reviewCard(a) {
    var d = document.createElement("div"); d.className = "card review-row";
    var when = a.decided ? whenShort(a.decided) : "";
    var rs = (state.reviewState || {})[a.id];
    d.innerHTML = '<div class="t">' + esc(pretty(a.title)) + "</div>"
      + detailBlock(newestFirst(pretty(a.note)) || "No outcome was written.", "settled-out")
      + metaRow([
          when ? "<span>Finished <b>" + esc(when) + "</b></span>" : "",
          a.source ? "<span>From <b>" + esc(a.source) + "</b></span>" : "",
          rs && rs.status === "later" ? '<span class="dim">Put off ' + esc(whenShort(rs.at)) + "</span>" : "",
        ])
      + '<div class="row review-actions"><button type="button" class="primary accept">Accept</button><button type="button" class="redo">Redo with a note</button><button type="button" class="ghost later">Later</button></div>'
      + '<form class="redo-form panel" hidden><textarea rows="2" placeholder="What still needs to change, in your own words" required></textarea>'
      + '<div class="request-row"><span class="why">Sent back to approved with this note added, so it is rebuilt to what was actually asked.</span><button type="submit" class="primary">Send back</button></div></form>';
    var accept = d.querySelector(".accept"), later = d.querySelector(".later"), redoBtn = d.querySelector(".redo"), form = d.querySelector(".redo-form");
    var setBusy = function (on) { accept.disabled = on; later.disabled = on; redoBtn.disabled = on; };
    accept.addEventListener("click", async function () {
      setBusy(true);
      try {
        var r = await api("review", { method: "POST", body: { id: a.id, action: "accept" } });
        state.reviewState = r.reviewState || state.reviewState;
        toast("Accepted.");
        fire({ count: 16, region: "cortex", boost: 0.3 });
        renderReview();
      } catch (e) { undoFail("Accept " + pretty(a.title).slice(0, 60), e); setBusy(false); }
    });
    later.addEventListener("click", async function () {
      setBusy(true);
      try {
        var r2 = await api("review", { method: "POST", body: { id: a.id, action: "later" } });
        state.reviewState = r2.reviewState || state.reviewState;
        toast("Left for later. Still here until you accept it or 7 days pass.");
        renderReview();
      } catch (e) { undoFail("Later on " + pretty(a.title).slice(0, 60), e); setBusy(false); }
    });
    redoBtn.addEventListener("click", function () {
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector("textarea").focus();
    });
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      var note = form.querySelector("textarea").value.trim(); if (!note) return;
      var btn = form.querySelector('button[type="submit"]'); btn.disabled = true;
      try {
        await api("review", { method: "POST", body: { id: a.id, action: "redo", note: note } });
        toast("Sent back to approved with your note.");
        fire({ count: 24, region: "stem", boost: 0.4 });
        await load(false);
      } catch (err) { toast(err.message, true); btn.disabled = false; }
    });
    return d;
  }
  function renderReview() {
    var section = $("approvalsReview"), host = $("reviewList"); if (!section || !host) return;
    var list = doneReviewRows();
    section.hidden = !list.length;
    var count = $("reviewCount"); if (count) { count.hidden = !list.length; count.textContent = String(list.length); }
    host.innerHTML = "";
    list.forEach(function (a) { host.appendChild(reviewCard(a)); });
  }

  // ---------- priorities: the ranked order a run works approved and requested rows in, P1 first,
  // reorderable by drag or by Alt+ArrowUp/Alt+ArrowDown on a focused row. Written to the vault as
  // a priority cell on the row (see POST /api/approval/priority); only approved and requested
  // rows are ever ranked, since those are the two statuses a run actually picks work up from. ----------
  function priorityRows() {
    var list = (state.approvals || []).filter(function (a) {
      var st = (a.status || "").toLowerCase();
      return st === "approved" || st === "requested";
    });
    list.sort(function (a, b) {
      var pa = parseInt(String(a.priority || "").replace(/^P/i, ""), 10), pb = parseInt(String(b.priority || "").replace(/^P/i, ""), 10);
      var ra = isNaN(pa) ? Infinity : pa, rb = isNaN(pb) ? Infinity : pb;
      if (ra !== rb) return ra - rb;
      var da = parseWhen(a.requested), db = parseWhen(b.requested);
      return (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
    });
    return list;
  }
  // Relabels state.approvals in place (P1, P2...) for the given id order, optimistically, before
  // the write lands, so a drag or an Alt+arrow reads back at once. Reverted on a failed write.
  function applyPriorityOrder(orderIds) {
    var byId = {};
    (state.approvals || []).forEach(function (a) { byId[a.id] = a; });
    orderIds.forEach(function (id, i) { if (byId[id]) byId[id].priority = "P" + (i + 1); });
  }
  function commitPriorityOrder(orderIds, snapshot) {
    api("approval/priority", { method: "POST", body: { order: orderIds } }).catch(function (e) {
      snapshot.forEach(function (p) {
        var a = (state.approvals || []).filter(function (x) { return x.id === p.id; })[0];
        if (a) a.priority = p.priority;
      });
      renderApprovalPriorities();
      toast(e.message, true);
    });
  }
  function snapshotPriority(list) { return list.map(function (a) { return { id: a.id, priority: a.priority }; }); }
  function reorderPriority(fromId, toIndex) {
    var list = priorityRows(), ids = list.map(function (a) { return a.id; });
    var snapshot = snapshotPriority(list);
    var from = ids.indexOf(fromId);
    if (from < 0 || from === toIndex) return;
    ids.splice(from, 1);
    ids.splice(from < toIndex ? toIndex - 1 : toIndex, 0, fromId);
    applyPriorityOrder(ids);
    renderApprovalPriorities();
    fire({ count: 8, region: "cortex" });
    commitPriorityOrder(ids, snapshot);
  }
  function movePriority(id, dir) {
    var list = priorityRows(), ids = list.map(function (a) { return a.id; });
    var idx = ids.indexOf(id), other = idx + dir;
    if (idx < 0 || other < 0 || other >= ids.length) return;
    var snapshot = snapshotPriority(list);
    ids[idx] = ids[other]; ids[other] = id;
    applyPriorityOrder(ids);
    renderApprovalPriorities();
    fire({ count: 8, region: "cortex" });
    commitPriorityOrder(ids, snapshot);
    var row = document.querySelector('.priority-row[data-id="' + id + '"]');
    if (row) row.focus();
  }
  function renderApprovalPriorities() {
    var host = $("priorityList"); if (!host) return;
    var list = priorityRows();
    host.innerHTML = "";
    if (!list.length) { host.innerHTML = '<li class="empty">Nothing approved or being scoped yet.</li>'; return; }
    list.forEach(function (a, i) {
      var li = document.createElement("li");
      li.className = "priority-row"; li.draggable = true; li.tabIndex = 0; li.dataset.id = a.id;
      li.setAttribute("aria-label", "Priority " + (i + 1) + " of " + list.length + ": " + pretty(a.title));
      li.innerHTML = '<span class="priority-handle" aria-hidden="true">&#8942;&#8942;</span>'
        + '<span class="priority-rank mono">P' + (i + 1) + '</span>'
        + '<span class="priority-t">' + esc(pretty(a.title)) + '</span>'
        + '<span class="pill ' + esc((a.status || "").toLowerCase()) + '">' + esc(a.status) + '</span>'
        + '<span class="priority-moves">'
        + '<button type="button" class="icon-btn up" aria-label="Move up"' + (i === 0 ? " disabled" : "") + '>&#8593;</button>'
        + '<button type="button" class="icon-btn down" aria-label="Move down"' + (i === list.length - 1 ? " disabled" : "") + '>&#8595;</button>'
        + "</span>";
      li.addEventListener("dragstart", function (e) { e.dataTransfer.setData("text/plain", a.id); e.dataTransfer.effectAllowed = "move"; li.classList.add("dragging"); });
      li.addEventListener("dragend", function () { li.classList.remove("dragging"); document.querySelectorAll(".priority-row.drag-over").forEach(function (r) { r.classList.remove("drag-over"); }); });
      li.addEventListener("dragover", function (e) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; li.classList.add("drag-over"); });
      li.addEventListener("dragleave", function () { li.classList.remove("drag-over"); });
      li.addEventListener("drop", function (e) {
        e.preventDefault(); li.classList.remove("drag-over");
        var fromId = e.dataTransfer.getData("text/plain");
        if (!fromId || fromId === a.id) return;
        var ids = priorityRows().map(function (x) { return x.id; });
        reorderPriority(fromId, ids.indexOf(a.id));
      });
      li.addEventListener("keydown", function (e) {
        if (!e.altKey) return;
        if (e.key === "ArrowUp") { e.preventDefault(); movePriority(a.id, -1); }
        else if (e.key === "ArrowDown") { e.preventDefault(); movePriority(a.id, 1); }
      });
      li.querySelector(".up").addEventListener("click", function () { movePriority(a.id, -1); });
      li.querySelector(".down").addEventListener("click", function () { movePriority(a.id, 1); });
      host.appendChild(li);
    });
  }

  // ---------- approvals inbox: a desktop triage layout, queue on the left, detail on the right ----------
  var selectedApprovalId = null, inboxFilter = "queue"; // "queue" | "snoozed"
  function inboxRow(a, isSelected, snoozedRow) {
    var st = (a.status || "").toLowerCase();
    var li = document.createElement("li");
    li.className = "inbox-row" + (isSelected ? " selected" : "");
    li.innerHTML = '<span class="pill ' + esc(snoozedRow ? "snoozed-pill" : st === "in progress" ? "progress" : st) + '">' + esc(snoozedRow ? "snoozed" : st) + "</span>"
      + '<span class="inbox-title">' + esc(pretty(a.title)) + "</span>"
      + (snoozedRow ? "" : st === "pending" ? ageChip(a.requested) : "")
      + '<span class="inbox-when mono">' + esc(snoozedRow ? snoozeReturnsLabel(a.id) : whenShort(a.decided || a.requested)) + "</span>";
    li.addEventListener("click", function () { selectedApprovalId = a.id; renderApprovalsInbox(); });
    return li;
  }
  function renderInboxDetail(a, snoozedRow) {
    var detail = $("approvalsInboxDetail"); if (!detail) return;
    if (!a) { detail.innerHTML = '<p class="empty">Nothing to show.</p>'; return; }
    var st = (a.status || "").toLowerCase();
    var est = estOf(a.note), wait = waitOf(a.note);
    var trail = newestFirst(pretty(a.note));
    var actions;
    if (snoozedRow) actions = '<div class="row"><span class="pill snoozed-pill">' + esc(snoozeReturnsLabel(a.id)) + '</span><button class="unsnooze" type="button">Unsnooze</button></div>';
    else if (st === "pending") actions = '<div class="row"><button class="approve" type="button">Approve<span class="key-hint">A</span></button><button class="decline" type="button">Decline<span class="key-hint">D</span></button>' + snoozeMenuHtml() + "</div>";
    else if (st === "requested") actions = '<div class="row"><span class="pill requested">requested</span><button class="decline withdraw" type="button">Withdraw<span class="key-hint">D</span></button></div>';
    else actions = '<div class="row"><span class="pill ' + esc(a.status) + '">' + esc(a.status) + "</span></div>";
    detail.innerHTML = '<div class="t">' + esc(pretty(a.title)) + (!snoozedRow && st === "pending" ? ageChip(a.requested) : "") + "</div>"
      + (a.detail ? '<div class="d">' + esc(pretty(a.detail)) + "</div>" : "")
      + (est ? estBlock("est", "Est.", est) : wait ? estBlock("waiting", "Waiting", wait.replace(/^Waiting on[:\s]*/i, "")) : "")
      + metaRow([
          a.source ? "<span>From <b>" + esc(a.source) + "</b></span>" : "",
          a.cost ? "<span>Cost <b>" + esc(a.cost) + "</b></span>" : "",
          a.reversible ? "<span>Reversible <b>" + esc(a.reversible) + "</b></span>" : "",
          '<span class="mono">Asked ' + esc(whenShort(a.requested)) + "</span>",
          a.decided ? '<span class="mono">Decided ' + esc(whenShort(a.decided)) + "</span>" : ""
        ])
      + actions
      + (trail ? '<div class="inbox-trail"><h3>Notes</h3><p>' + esc(trail) + "</p></div>" : "");
    var ap = detail.querySelector(".approve"); if (ap) ap.addEventListener("click", function () { decide(a, "approved"); });
    var de = detail.querySelector(".decline"); if (de) de.addEventListener("click", function () { decide(a, "declined"); });
    var un = detail.querySelector(".unsnooze");
    if (un) un.addEventListener("click", async function () {
      un.disabled = true;
      try { await snoozeSet(a.id, null); toast("Back in the queue."); inboxFilter = "queue"; renderApprovals(); }
      catch (err) { undoFail("Unsnooze " + pretty(a.title).slice(0, 60), err); un.disabled = false; }
    });
    wireSnoozeMenu(detail, a.id, function () { renderApprovals(); });
  }
  function inboxList(g) { return (g.pending || []).concat(g.requested, g.active, g.settled); }
  function renderApprovalsInbox(g) {
    var host = $("approvalsInboxList"); if (!host) return;
    g = g || groupApprovals();
    var qBtn = $("inboxFilterQueue"), sBtn = $("inboxFilterSnoozed"), title = $("inboxQueueTitle");
    if (sBtn) { sBtn.hidden = !g.snoozed.length; if (!g.snoozed.length) inboxFilter = "queue"; }
    if (qBtn) qBtn.setAttribute("aria-pressed", inboxFilter === "queue" ? "true" : "false");
    if (sBtn) sBtn.setAttribute("aria-pressed", inboxFilter === "snoozed" ? "true" : "false");
    if (title) title.textContent = inboxFilter === "snoozed" ? "Snoozed" : "Queue";
    var snoozedRow = inboxFilter === "snoozed";
    var list = snoozedRow ? g.snoozed : inboxList(g);
    if (!list.length) {
      host.innerHTML = '<li class="empty">' + (snoozedRow ? "Nothing snoozed." : "Nothing in the queue.") + "</li>";
      renderInboxDetail(null);
      return;
    }
    if (!selectedApprovalId || !list.some(function (a) { return a.id === selectedApprovalId; })) selectedApprovalId = list[0].id;
    host.innerHTML = "";
    list.forEach(function (a) { host.appendChild(inboxRow(a, a.id === selectedApprovalId, snoozedRow)); });
    renderInboxDetail(list.filter(function (a) { return a.id === selectedApprovalId; })[0], snoozedRow);
  }
  if ($("inboxFilterQueue")) $("inboxFilterQueue").addEventListener("click", function () { inboxFilter = "queue"; selectedApprovalId = null; renderApprovalsInbox(); });
  if ($("inboxFilterSnoozed")) $("inboxFilterSnoozed").addEventListener("click", function () { inboxFilter = "snoozed"; selectedApprovalId = null; renderApprovalsInbox(); });
  // A to approve, D to decline, S to snooze, J and K to move: only while the inbox pane is
  // showing (roughly 900px+, the card list stands in below that) and never while typing in a
  // text field.
  function approvalsInboxShortcut(e) {
    if (!window.matchMedia("(min-width: 900px)").matches) return false;
    if (location.hash.replace(/^#\/?/, "").split("/")[0] !== "approvals") return false;
    var g = groupApprovals(), list = inboxFilter === "snoozed" ? g.snoozed : inboxList(g);
    if (!list.length) return false;
    var idx = list.findIndex(function (a) { return a.id === selectedApprovalId; });
    if (idx < 0) idx = 0;
    if (e.key === "j" || e.key === "J") { selectedApprovalId = list[Math.min(list.length - 1, idx + 1)].id; renderApprovalsInbox(g); return true; }
    if (e.key === "k" || e.key === "K") { selectedApprovalId = list[Math.max(0, idx - 1)].id; renderApprovalsInbox(g); return true; }
    if (e.key === "a" || e.key === "A") { var cur = list[idx]; if (cur && (cur.status || "").toLowerCase() === "pending") decide(cur, "approved"); return true; }
    if (e.key === "d" || e.key === "D") { var st = list[idx] && (list[idx].status || "").toLowerCase(); if (list[idx] && (st === "pending" || st === "requested")) decide(list[idx], "declined"); return true; }
    if ((e.key === "s" || e.key === "S") && inboxFilter === "queue") {
      var cur2 = list[idx], st2 = cur2 && (cur2.status || "").toLowerCase();
      if (cur2 && st2 === "pending") { var det = $("approvalsInboxDetail").querySelector(".snooze-menu"); if (det) { det.open = true; var first = det.querySelector("button[data-k]"); if (first) first.focus(); } }
      return true;
    }
    return false;
  }
  var _sm = $("settledMore");
  if (_sm) _sm.addEventListener("click", function () { showAllSettled = !showAllSettled; renderApprovals(); });
  var _sz = $("snoozedToggle");
  if (_sz) _sz.addEventListener("click", function () { showSnoozed = !showSnoozed; renderApprovals(); });

  // Shared with the command palette's "Send to Claude as a request".
  // department: a registry id from System/Departments.md, or blank for Unassigned (the default).
  async function submitRequest(title, detail, department) {
    var r = await api("request", { method: "POST", body: { title: title, detail: detail || "", department: department || "" } });
    toast("Request " + r.id + " added. " + (r.watcher && r.watcher.fired ? "Claude is scoping it now; nothing runs before your yes." : "Claude scopes it before anything runs."));
    if (r.watcher && r.watcher.fired) startRun("scoping your request");
    fire({ count: 30, region: "all", boost: 0.5 }); await load(false);
    return r;
  }
  // The form folds behind a New request button so the Approvals page opens on the queue, not a
  // form: openRequestForm shows it and moves focus in; closeRequestForm folds it away again,
  // clearing anything half-typed so the next open starts blank.
  function openRequestForm() {
    fillDeptPicker();
    $("requestForm").hidden = false;
    $("newRequestBtn").hidden = true;
    $("reqTitle").focus();
  }
  function closeRequestForm() {
    $("requestForm").hidden = true;
    $("newRequestBtn").hidden = false;
    $("reqTitle").value = ""; $("reqDetail").value = "";
    if ($("reqDept")) $("reqDept").value = "";
  }
  // The department picker lists the lanes in System/Departments.md (state.team.departments), so
  // a new department is a new row there and nothing here changes. Unassigned writes no 12th cell.
  function fillDeptPicker() {
    var sel = $("reqDept"); if (!sel) return;
    var keep = sel.value;
    var deps = (state && state.team && state.team.departments) || [];
    sel.innerHTML = '<option value="">Unassigned</option>' + deps.map(function (d) { return '<option value="' + esc(d.id) + '">' + esc(d.name) + "</option>"; }).join("");
    sel.value = deps.some(function (d) { return d.id === keep; }) ? keep : "";
  }
  if ($("newRequestBtn")) $("newRequestBtn").addEventListener("click", openRequestForm);
  if ($("requestFormClose")) $("requestFormClose").addEventListener("click", closeRequestForm);
  $("requestForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var title = $("reqTitle").value.trim(), detail = $("reqDetail").value.trim(); if (!title) return;
    var btn = e.target.querySelector("button"); btn.disabled = true;
    try { await submitRequest(title, detail, $("reqDept") ? $("reqDept").value : ""); closeRequestForm(); }
    catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
  });

  $("watcherRun").addEventListener("click", function () {
    runClaudeNow($("watcherRun"));
  });

  // notes
  // Recent: the last ten notes opened, this device only (never read back by Claude, see the
  // localStorage note in artifact-capabilities), most recently opened first.
  var NOTE_RECENT_KEY = "brainNoteRecent", NOTE_LAST_KEY = "brainNoteLast", NOTE_RECENT_MAX = 10;
  function noteRecentGet() { try { return JSON.parse(localStorage.getItem(NOTE_RECENT_KEY) || "[]"); } catch (e) { return []; } }
  function noteRecentPush(path) {
    try {
      var list = noteRecentGet().filter(function (p) { return p !== path; });
      list.unshift(path);
      localStorage.setItem(NOTE_RECENT_KEY, JSON.stringify(list.slice(0, NOTE_RECENT_MAX)));
    } catch (e) {}
  }
  function renderNoteRecent() {
    var host = $("noteRecent"); if (!host) return;
    var items = noteRecentGet().map(function (p) { return notesByPath[p]; }).filter(Boolean);
    if (!items.length) { host.innerHTML = ""; return; }
    host.innerHTML = '<div class="note-recent-label">Recent</div>' + items.map(function (n) {
      return '<a href="#/notes/' + encodeURIComponent(n.path) + '"' + (currentNote && currentNote.path === n.path ? ' class="active"' : "") + ">" + esc(n.title) + "</a>";
    }).join("");
  }
  // With a search query, the tree becomes a flat list of hits with a one-line snippet (the
  // excerpt buildState already computed server side, so no extra fetch per hit); with none,
  // Recent sits above the folder tree, which opens collapsed except for the folder holding
  // whatever note is currently open.
  function renderNotesTree(filter) {
    var host = $("noteTree"); host.innerHTML = "";
    var q = (filter || "").toLowerCase();
    if ($("noteRecent")) { if (q) $("noteRecent").innerHTML = ""; else renderNoteRecent(); }
    if (q) {
      var hits = state.notes.filter(function (n) { return (n.title + " " + n.path).toLowerCase().indexOf(q) > -1; })
        .sort(function (a, b) { return a.title.localeCompare(b.title); });
      if (!hits.length) { host.innerHTML = '<div class="empty">Nothing matches.</div>'; return; }
      var wrap = document.createElement("div"); wrap.className = "note-hits";
      hits.forEach(function (n) {
        var a = document.createElement("a"); a.className = "note-hit" + (currentNote && currentNote.path === n.path ? " active" : "");
        a.href = "#/notes/" + encodeURIComponent(n.path);
        a.innerHTML = '<span class="note-hit-title">' + esc(n.title) + '</span><span class="note-hit-path mono">' + esc(n.path) + "</span>"
          + (n.excerpt ? '<span class="note-hit-snippet">' + esc(n.excerpt) + "</span>" : "");
        wrap.appendChild(a);
      });
      host.appendChild(wrap);
      return;
    }
    var groups = {};
    state.notes.forEach(function (n) {
      var parts = n.path.split("/"); var folder = parts.length > 1 ? parts.slice(0, -1).join(" / ") : "Root";
      (groups[folder] = groups[folder] || []).push(n);
    });
    var order = Object.keys(groups).sort(function (a, b) { if (a === "Root") return -1; if (b === "Root") return 1; return a.localeCompare(b); });
    order.forEach(function (folder) {
      var det = document.createElement("details"); det.open = false;
      det.innerHTML = "<summary>" + esc(folder) + " <span class=\"mono\">" + groups[folder].length + "</span></summary>";
      groups[folder].sort(function (a, b) { return a.title.localeCompare(b.title); }).forEach(function (n) {
        var a = document.createElement("a"); a.href = "#/notes/" + encodeURIComponent(n.path); a.textContent = n.title; a.dataset.path = n.path;
        if (currentNote && currentNote.path === n.path) { a.className = "active"; det.open = true; }
        det.appendChild(a);
      });
      host.appendChild(det);
    });
  }
  $("noteSearch").addEventListener("input", function (e) { renderNotesTree(e.target.value.trim()); });

  // Linked from: every other note whose own outgoing links (computed server side in buildState,
  // so no per-note fetch is needed) name this one.
  function renderLinkedFrom(path) {
    var host = $("noteLinkedFrom"); if (!host) return;
    var back = state.notes.filter(function (n) { return (n.links || []).indexOf(path) > -1; });
    if (!back.length) { host.innerHTML = ""; return; }
    host.innerHTML = "<h3>Linked from</h3><ul>" + back.map(function (n) {
      return '<li><a href="#/notes/' + encodeURIComponent(n.path) + '">' + esc(n.title) + "</a></li>";
    }).join("") + "</ul>";
  }

  // A small preview on hovering a wikilink: the target note's title and its opening text
  // (the same excerpt Notes search uses), so a link can be judged without following it.
  var wikiPreviewTimer = null;
  function positionWikiPreview(el) {
    var host = $("wikiPreview"); if (!host) return;
    var r = el.getBoundingClientRect();
    host.style.top = Math.max(8, Math.min(r.bottom + 8, window.innerHeight - 90)) + "px";
    host.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 296)) + "px";
  }
  function showWikiPreview(el) {
    var host = $("wikiPreview"); if (!host) return;
    var m = (el.getAttribute("href") || "").match(/^#\/notes\/(.+)$/);
    if (!m) return;
    var n = notesByPath[decodeURIComponent(m[1])];
    if (!n) return;
    host.innerHTML = '<div class="wp-title">' + esc(n.title) + "</div>" + (n.excerpt ? '<div class="wp-body">' + esc(n.excerpt) + "</div>" : "");
    positionWikiPreview(el);
    host.hidden = false;
  }
  function hideWikiPreview() { var host = $("wikiPreview"); if (host) host.hidden = true; }
  document.addEventListener("mouseover", function (e) {
    var a = e.target.closest && e.target.closest("a.wiki");
    if (!a) return;
    clearTimeout(wikiPreviewTimer);
    wikiPreviewTimer = setTimeout(function () { showWikiPreview(a); }, 220);
  });
  document.addEventListener("mouseout", function (e) {
    if (!(e.target.closest && e.target.closest("a.wiki"))) return;
    clearTimeout(wikiPreviewTimer);
    hideWikiPreview();
  });
  document.addEventListener("scroll", hideWikiPreview, true);

  // The reader opens the last note read (this device) rather than "Pick a note", the first
  // time Notes is reached with no note already open and no path named in the hash: the hash
  // is set to that note's own address, so the redirect leaves a normal, addressable entry
  // rather than silently painting content the URL does not name.
  function maybeOpenLastNote() {
    if (currentNote) return;
    var parts = location.hash.replace(/^#\/?/, "").split("/");
    if (parts[0] !== "notes" || parts[1]) return;
    var last = null;
    try { last = localStorage.getItem(NOTE_LAST_KEY); } catch (e) {}
    if (last && notesByPath[last]) location.hash = "#/notes/" + encodeURIComponent(last);
  }

  var noteSeq = 0;
  function addCopyButtons(host) {
    host.querySelectorAll("pre").forEach(function (pre) {
      var text = (pre.querySelector("code") || pre).textContent;
      var b = document.createElement("button"); b.type = "button"; b.className = "copy-btn"; b.textContent = "Copy";
      b.addEventListener("click", async function () {
        try { await navigator.clipboard.writeText(text); b.textContent = "Copied"; }
        catch (e) { var r = document.createRange(); r.selectNodeContents(pre.querySelector("code") || pre); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); b.textContent = "Selected, press copy"; }
        setTimeout(function () { b.textContent = "Copy"; }, 2200);
      });
      pre.classList.add("has-copy"); pre.appendChild(b);
    });
  }
  async function openNote(path) {
    var seq = ++noteSeq;
    $("noteMsg").hidden = true;
    $("notePath").textContent = path;
    $("noteView").innerHTML = '<p class="empty">Loading</p>';
    $("noteEditor").hidden = true; $("noteView").hidden = false; $("noteSave").hidden = true; $("noteCancel").hidden = true; $("noteEdit").hidden = false;
    try {
      var n = await api("note?path=" + encodeURIComponent(path));
      if (seq !== noteSeq) return; // a newer note was opened while this one loaded
      currentNote = n;
      var body = n.content.replace(/^---[\s\S]*?\n---\n?/, "");
      $("noteView").innerHTML = mdToHtml(body);
      addCopyButtons($("noteView"));
      renderLinkedFrom(path);
      try { localStorage.setItem(NOTE_LAST_KEY, path); } catch (e) {}
      noteRecentPush(path);
      renderNotesTree($("noteSearch").value.trim());
      fire({ count: 8, region: "cortex", boost: 0.1 });
    } catch (e) { if (seq === noteSeq) $("noteView").innerHTML = '<p class="empty">' + esc(e.message) + "</p>"; }
  }
  $("noteEdit").addEventListener("click", function () {
    if (!currentNote) return;
    $("noteEditor").value = currentNote.content; $("noteEditor").hidden = false; $("noteView").hidden = true;
    $("noteEdit").hidden = true; $("noteSave").hidden = false; $("noteCancel").hidden = false; $("noteEditor").focus();
  });
  $("noteCancel").addEventListener("click", function () { openNote(currentNote.path); });
  $("noteSave").addEventListener("click", async function () {
    if (!currentNote) return;
    var content = $("noteEditor").value;
    if (/\u2014/.test(content)) { toast("The vault does not allow em dashes. Replace them first.", true); return; }
    $("noteSave").disabled = true;
    try {
      var r = await api("note", { method: "PUT", body: { path: currentNote.path, content: content, sha: currentNote.sha } });
      toast("Saved to the vault (" + r.commit.slice(0, 7) + ")"); fire({ count: 30, region: "all", tint: "white", boost: 0.5 });
      await openNote(currentNote.path); load(false);
    } catch (e) {
      var msg = $("noteMsg"); msg.hidden = false; msg.className = "inline-msg bad";
      msg.textContent = e.data && e.data.conflict ? "This note changed in the vault while you were editing. Copy your changes, cancel, reopen it, and paste them in." : e.message;
    } finally { $("noteSave").disabled = false; }
  });

  // journal
  var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  function weekdayOf(ymd) {
    var m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? WEEKDAYS[new Date(+m[1], +m[2] - 1, +m[3]).getDay()] : "";
  }
  function ymdAdd(ymd, delta) {
    var m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return ymd;
    var d = new Date(+m[1], +m[2] - 1, +m[3]); d.setDate(d.getDate() + delta);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  // Mirrors the server's own section(): the text between "## Heading" and the next "## ", so a
  // day read through /api/note (any day but today) splits into the same five panels today's
  // own state.journal already arrives pre-split into.
  function mdSection(text, heading) {
    var lines = String(text || "").split("\n"), start = -1;
    for (var i = 0; i < lines.length; i++) { if (lines[i].trim().toLowerCase() === ("## " + heading).toLowerCase()) { start = i; break; } }
    if (start < 0) return "";
    var out = [];
    for (var j = start + 1; j < lines.length; j++) { if (/^## /.test(lines[j])) break; out.push(lines[j]); }
    return out.join("\n").trim();
  }
  // A panel whose section has nothing in it shrinks to one line (the heading and the empty
  // message run together) rather than holding the same height as a panel with real content.
  function journalPanelSet(id, md, emptyMsg) {
    var el = $(id); if (!el) return;
    el.innerHTML = mdToHtml(md, emptyMsg);
    var panel = el.closest(".panel");
    if (panel) panel.classList.toggle("j-empty", !md || !String(md).trim());
  }
  var journalDate = null, journalLoadSeq = 0; // null = today; else the "YYYY-MM-DD" being viewed
  function setJournalDay(ymd) {
    journalDate = (!ymd || ymd === state.today.ymd) ? null : ymd;
    renderJournal();
  }
  function journalStep(delta) { setJournalDay(ymdAdd(journalDate || state.today.ymd, delta)); }
  async function renderJournal() {
    var seq = ++journalLoadSeq;
    var isToday = !journalDate || journalDate === state.today.ymd;
    if ($("journalToday")) $("journalToday").hidden = isToday;
    if ($("logForm")) $("logForm").hidden = !isToday;
    if (isToday) {
      var j = state.journal;
      $("journalTitle").textContent = "Journal: " + longDate(state.today.weekday, state.today.ymd);
      if ($("journalSub")) $("journalSub").textContent = "Today's note. The brain writes the plan and the review; the log is yours.";
      journalPanelSet("jPlan", j.plan, "The morning job writes the plan on weekdays.");
      journalPanelSet("jLog", j.exists ? j.log : "", "No note for today yet. Your first log line creates it.");
      journalPanelSet("jSessions", j.sessions, "No sessions logged today.");
      journalPanelSet("jReview", j.review, "The evening job writes the review.");
      journalPanelSet("jCarry", j.carry, "Nothing carried forward yet.");
    } else {
      $("journalTitle").textContent = "Journal: " + longDate(weekdayOf(journalDate), journalDate);
      if ($("journalSub")) $("journalSub").textContent = "A past day, read only here. Today to add a log line.";
      var path = "Journal/Daily/" + journalDate + ".md";
      if (!state.notes.some(function (n) { return n.path === path; })) {
        ["jPlan", "jLog", "jSessions", "jReview", "jCarry"].forEach(function (id) { journalPanelSet(id, "", "No note for this day."); });
      } else {
        try {
          var n = await api("note?path=" + encodeURIComponent(path));
          if (seq !== journalLoadSeq) return;
          var body = n.content.replace(/^---[\s\S]*?\n---\n?/, "");
          journalPanelSet("jPlan", mdSection(body, "Plan"), "No plan written.");
          journalPanelSet("jLog", mdSection(body, "Log"), "No log written.");
          journalPanelSet("jSessions", mdSection(body, "Sessions"), "No sessions logged.");
          journalPanelSet("jReview", mdSection(body, "Review"), "No review written.");
          journalPanelSet("jCarry", mdSection(body, "Carry forward"), "Nothing carried forward.");
        } catch (e) {
          if (seq !== journalLoadSeq) return;
          ["jPlan", "jLog", "jSessions", "jReview", "jCarry"].forEach(function (id) { journalPanelSet(id, "", "Could not load this day."); });
        }
      }
    }
    var days = state.notes.filter(function (n) { return n.path.indexOf("Journal/Daily/") === 0; }).sort(function (a, b) { return b.name.localeCompare(a.name); }).slice(0, 14);
    var ul = $("jDays"); ul.innerHTML = "";
    days.forEach(function (n) { var li = document.createElement("li"); li.innerHTML = '<a href="#" data-ymd="' + esc(n.name) + '">' + esc(n.name) + "</a>"; ul.appendChild(li); });
    ul.querySelectorAll("a[data-ymd]").forEach(function (a) { a.addEventListener("click", function (e) { e.preventDefault(); setJournalDay(a.dataset.ymd); }); });
    var weeks = state.notes.filter(function (n) { return n.path.indexOf("Journal/Weekly/") === 0; }).sort(function (a, b) { return b.name.localeCompare(a.name); }).slice(0, 4);
    weeks.forEach(function (n) { var li = document.createElement("li"); li.innerHTML = '<a href="#/notes/' + encodeURIComponent(n.path) + '">Week ' + esc(n.name) + "</a>"; ul.appendChild(li); });
  }
  if ($("journalPrev")) $("journalPrev").addEventListener("click", function () { journalStep(-1); });
  if ($("journalNext")) $("journalNext").addEventListener("click", function () { journalStep(1); });
  if ($("journalToday")) $("journalToday").addEventListener("click", function () { setJournalDay(state.today.ymd); });
  $("logForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var text = $("logText").value.trim(); if (!text) return;
    var btn = e.target.querySelector("button"); btn.disabled = true;
    try { await api("journal", { method: "POST", body: { text: text } }); $("logText").value = ""; toast("Logged"); fire({ count: 26, region: "cross", boost: 0.4 }); await load(false); }
    catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
  });

  // scout
  function scoutCard(s, isNew) {
    var d = document.createElement("div"); d.className = "card" + (isNew ? " pending" : "");
    // The url cell holds a web address, or a wikilink to a note in the vault ([[Note]]): the
    // first opens in a new tab, the second opens the note here, and anything else is not linked.
    var source = "", sourceWord = "Source", url = String(s.url || "").trim(), titleHtml = esc(s.title);
    var wl = url.match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]$/);
    if (wl) {
      var notePath = noteIndex[wl[1].trim().toLowerCase()];
      if (notePath) titleHtml = '<a class="wiki" href="#/notes/' + encodeURIComponent(notePath) + '">' + esc(s.title) + "</a>";
      source = (wl[2] || wl[1]).trim(); sourceWord = "Note";
    } else if (/^https?:\/\//i.test(url)) {
      try { source = String(new URL(url).hostname).replace(/^www\./, ""); } catch (e) {}
      titleHtml = '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(s.title) + "</a>";
    }
    d.innerHTML = '<div class="t">' + titleHtml + "</div>"
      + '<div class="d">' + esc(s.summary) + "</div>"
      + metaRow([source ? "<span>" + sourceWord + " <b>" + esc(source) + "</b></span>" : "", '<span class="mono">' + esc(s.sourceDate) + "</span>", s.project ? "<span>" + esc(s.project) + "</span>" : "", s.found ? "<span>found " + esc(s.found) + "</span>" : ""])
      + (isNew ? '<div class="row"><button class="approve keep" type="button">Keep</button><button class="decline" type="button">Dismiss</button></div>' : '<div class="row"><span class="pill ' + esc(s.status) + '">' + esc(s.status) + "</span></div>");
    if (isNew) {
      d.querySelector(".keep").addEventListener("click", function () { scoutDecide(s, "kept", d); });
      d.querySelector(".decline").addEventListener("click", function () { scoutDecide(s, "dismissed", d); });
    }
    return d;
  }
  async function scoutDecide(s, status, card) {
    card.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
    try { await api("scout", { method: "POST", body: { id: s.id, status: status } }); fire({ count: 20, region: "cortex", boost: 0.3 }); toast(status === "kept" ? "Kept. Sunday weaves it into the project note." : "Dismissed for good."); await load(false); }
    catch (e) { toast(e.message, true); card.querySelectorAll("button").forEach(function (b) { b.disabled = false; }); }
  }
  // When Scout last ran: a dedicated SCOUT run line if the log has one, else the last WEEKLY
  // run (Scout runs inside it on Sundays), else "not yet". Read straight off state.runs, the
  // same run log the Runs page already shows, so nothing new is fetched for this.
  function scoutLastRanLabel() {
    var runs = state.runs || [];
    var own = runs.find(function (r) { return /^SCOUT\b/i.test(r.job || ""); });
    if (own) return "Scout last ran " + whenShort(own.when) + (own.result && own.result !== "OK" ? " (" + own.result + ")." : ".");
    var weekly = runs.find(function (r) { return /^WEEKLY\b/i.test(r.job || ""); });
    if (weekly) return "Scout runs inside the Sunday weekly review. Last weekly run " + whenShort(weekly.when) + ".";
    return "Scout has not run yet.";
  }
  function renderScout() {
    var n = $("scoutNew"), k = $("scoutKept"); n.innerHTML = ""; k.innerHTML = "";
    var news = state.scout.filter(function (s) { return s.status === "new"; }), kept = state.scout.filter(function (s) { return s.status === "kept"; });
    if (!news.length) n.innerHTML = '<div class="empty">Nothing new. Scout runs inside the Sunday job and on demand ("run SCOUT").</div>';
    news.forEach(function (s) { n.appendChild(scoutCard(s, true)); });
    if (!kept.length) k.innerHTML = '<div class="empty">Nothing kept yet.</div>';
    kept.forEach(function (s) { k.appendChild(scoutCard(s, false)); });
    var lr = $("scoutLastRan"); if (lr) lr.textContent = scoutLastRanLabel();
  }
  if ($("scoutRunNow")) $("scoutRunNow").addEventListener("click", async function (e) {
    var btn = e.currentTarget; btn.disabled = true;
    try { await submitRequest("Run Scout now", "Filed from the Scout page in the platform."); }
    catch (err) { toast(err.message, true); }
    finally { btn.disabled = false; }
  });

  // runs
  function renderJobs() {
    var host = $("jobCards");
    if (!host) {
      var wrap = $("runsToolbar");
      var table = $("runsTable");
      if (!wrap && table) wrap = table.closest(".table-wrap") || table;
      if (!wrap) return;
      host = document.createElement("div"); host.id = "jobCards"; host.className = "job-cards";
      var h = document.createElement("h2"); h.className = "sub-head"; h.textContent = "The jobs, and when each one next runs";
      wrap.parentNode.insertBefore(h, wrap); wrap.parentNode.insertBefore(host, wrap);
      var h2 = document.createElement("h2"); h2.className = "sub-head"; h2.textContent = "Every run, newest first";
      wrap.parentNode.insertBefore(h2, wrap);
    }
    host.innerHTML = JOBS.map(function (job) {
      var last = (state.runs || []).filter(function (r) { return String(r.job || "").toUpperCase().indexOf(job.name) === 0; })[0];
      var cls = !last ? "none" : last.result === "OK" ? "ok" : last.result === "MISSED" ? "miss" : "fail";
      return '<div class="job-card">'
        + '<div class="job-top"><span class="dot ' + cls + '"></span><b>' + esc(job.label) + "</b></div>"
        + '<div class="job-note">' + esc(job.note) + "</div>"
        + '<div class="job-line"><span>Last run</span><b>' + (last ? esc(last.when) + ", " + esc(last.result) : "not yet") + "</b></div>"
        + (last && last.note ? '<div class="job-last">' + esc(String(last.note).slice(0, 170)) + "</div>" : "")
        + '<div class="job-line"><span>Next run</span><b>' + esc(whenWords(nextFor(job))) + "</b></div>"
        + "</div>";
    }).join("");
  }
  // Four tiles above the job cards: runs this week (Monday to now, matching the sidebar's own
  // count), and OK, failed or missed in the last seven days. "Failed" is anything logged that
  // is neither OK nor MISSED, the same three-way split the run dot and the job cards already use.
  function renderRunTiles() {
    var host = $("runTiles"); if (!host) return;
    var runs = state.runs || [];
    var monday = new Date(); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    var thisWeek = runs.filter(function (r) { var d = parseWhen(r.when); return d && d >= monday; }).length;
    var since = Date.now() - 7 * 86400000;
    var recent = runs.filter(function (r) { var d = parseWhen(r.when); return d && d.getTime() >= since; });
    var ok = recent.filter(function (r) { return r.result === "OK"; }).length;
    var missed = recent.filter(function (r) { return r.result === "MISSED"; }).length;
    var failed = recent.filter(function (r) { return r.result && r.result !== "OK" && r.result !== "MISSED"; }).length;
    var tiles = [
      { k: "Runs this week", v: thisWeek, cls: "" },
      { k: "OK, last 7 days", v: ok, cls: "ok" },
      { k: "Failed, last 7 days", v: failed, cls: "fail" },
      { k: "Missed, last 7 days", v: missed, cls: "miss" }
    ];
    host.innerHTML = tiles.map(function (t) { return '<div class="stat-tile ' + t.cls + '"><div class="k">' + esc(t.k) + '</div><div class="v mono">' + t.v + "</div></div>"; }).join("");
  }
  var runsJobFilter = "";
  function renderRunsFilter() {
    var sel = $("runsJobFilter"); if (!sel) return;
    var names = [];
    (state.runs || []).forEach(function (r) { if (r.job && names.indexOf(r.job) < 0) names.push(r.job); });
    names.sort();
    sel.innerHTML = '<option value="">All jobs</option>' + names.map(function (n) { return '<option value="' + esc(n) + '"' + (n === runsJobFilter ? " selected" : "") + ">" + esc(n) + "</option>"; }).join("");
  }
  if ($("runsJobFilter")) $("runsJobFilter").addEventListener("change", function (e) { runsJobFilter = e.target.value; renderRuns(); });
  // The note is one line, clamped, and expands in place on a click anywhere in that cell; a
  // single delegated listener on the table survives every re-render, so it is wired once here
  // rather than inside renderRuns.
  if ($("runsTable")) $("runsTable").addEventListener("click", function (e) {
    var span = e.target.closest(".runs-note");
    if (span) span.classList.toggle("expanded");
  });
  function renderRuns() {
    renderJobs();
    renderRunTiles();
    renderRunsFilter();
    var tb = $("runsTable").querySelector("tbody"); tb.innerHTML = "";
    var rows = runsJobFilter ? state.runs.filter(function (r) { return r.job === runsJobFilter; }) : state.runs;
    if (!rows.length) { tb.innerHTML = '<tr><td colspan="6" class="empty">' + (runsJobFilter ? "No runs for this job." : "No runs logged yet.") + "</td></tr>"; return; }
    rows.forEach(function (r) {
      var cls = r.result === "OK" ? "ok" : r.result === "MISSED" ? "miss" : "fail";
      var tr = document.createElement("tr");
      tr.innerHTML = '<td><span class="dot ' + cls + '"></span></td><td class="when">' + esc(r.when) + '</td><td class="job">' + esc(r.job) + "</td><td>" + esc(r.surface) + "</td><td>" + esc(r.result)
        + '</td><td class="note"><span class="runs-note">' + esc(r.note) + "</span></td>";
      tb.appendChild(tr);
    });
  }

  // ---------- Team: the agent roster from System/Agents/*.md, drawn at the top of Runs and fed
  // by the same /api/state this page already refreshes. See public/team.js for the visual; this
  // half turns state into the plain data it draws, and turns real changes between one load and
  // the next into the events it animates. Nothing here invents an event: every one traces to a
  // run log row, an approval's own status column, the repo's own commit, or a chat reply. ----------
  var teamJobIndex = {}; // normalised job name -> agent id, rebuilt from state.agents on every render
  function teamNormaliseJob(j) { return String(j || "").trim().toUpperCase(); }
  function teamAgentIdForJob(job) {
    var j = teamNormaliseJob(job);
    if (!j) return null;
    if (teamJobIndex[j]) return teamJobIndex[j];
    for (var key in teamJobIndex) { if (j.indexOf(key) === 0 || key.indexOf(j) === 0) return teamJobIndex[key]; }
    return null;
  }
  // The schedule an agent's job runs to, read from the same JOBS list the job cards above
  // already use, so the platform never states a time twice over.
  function teamJobSchedule(job) {
    var j = teamNormaliseJob(job);
    var hit = null;
    for (var i = 0; i < JOBS.length; i++) { if (j.indexOf(JOBS[i].name) === 0 || JOBS[i].name.indexOf(j) === 0) { hit = JOBS[i]; break; } }
    if (!hit) return "";
    var times = hit.times.map(function (t) { return String(t[0]).padStart(2, "0") + ":" + String(t[1]).padStart(2, "0"); }).join(", ");
    var days = hit.days === "weekdays" ? "weekdays" : hit.days === "sunday" ? "Sundays" : hit.days === "first" ? "the 1st of the month" : hit.days;
    return times + ", " + days;
  }
  function teamAgo(d) {
    if (!d) return "";
    var m = Math.round((Date.now() - d.getTime()) / 60000);
    if (m < 1) return "just now"; if (m < 60) return m + " min ago";
    var hh = Math.round(m / 60); return hh < 36 ? hh + " h ago" : Math.round(hh / 24) + " d ago";
  }
  function renderTeam() {
    if (!window.Team || !state) return;
    teamJobIndex = {};
    (state.agents || []).forEach(function (a) { (a.jobs || []).forEach(function (j) { teamJobIndex[teamNormaliseJob(j)] = a.id; }); });
    // Nodes are named by role (Director, Developer...) from each file's own frontmatter, and an
    // agent holding a live claim in the lock ledger (state.team) pulses and says what it is on.
    var rosterByPath = {};
    ((state.team && state.team.views && state.team.views.all && state.team.views.all.roster) || []).forEach(function (r) { rosterByPath[r.path] = r; });
    var list = (state.agents || []).map(function (a) {
      var lr = a.lastRun, lrDate = lr ? parseWhen(lr.when) : null;
      var ro = rosterByPath[a.path];
      var statusText = ro && ro.live ? "On " + ccTrim(pretty(ro.now[0].title || ro.now[0].id), 40)
        : lr ? (lrDate ? teamAgo(lrDate) : lr.when) + (lr.result ? ", " + lr.result : "") : "No run logged yet";
      return {
        id: a.id, name: a.roleName || a.name, colour: a.colour, statusText: statusText, roleText: a.role ? pretty(a.role) : "", live: !!(ro && ro.live),
        jobs: a.jobs || [], tools: a.tools || [], goals: a.goals || [], path: a.path,
        lastRun: a.lastRun, recentRuns: a.recentRuns || []
      };
    });
    window.Team.render(list);
    window.Team.replay(teamReplayEvents());
  }
  // The last 24 hours, rebuilt fresh from timestamped fields already in state and in the chat
  // thread each time this runs, rather than accumulated: correct immediately on a fresh page
  // load, not only after live polling has had a day to build it up.
  function teamReplayEvents() {
    var since = Date.now() - 24 * 3600000, out = [];
    (state.runs || []).forEach(function (r) {
      var d = parseWhen(r.when); if (!d || d.getTime() < since) return;
      var id = teamAgentIdForJob(r.job), note = r.note ? ": " + trimTo(pretty(r.note), 90) : "";
      out.push({ type: "run", at: d, label: (r.job || "A job") + " ran (" + r.result + ")" + note, agentIds: id ? [id] : [] });
    });
    (state.approvals || []).forEach(function (a) {
      var rd = parseWhen(a.requested);
      if (rd && rd.getTime() >= since) out.push({ type: "approval", at: rd, label: "Requested: " + pretty(a.title) });
      var dd = parseWhen(a.decided);
      if (dd && dd.getTime() >= since && a.status) out.push({ type: "approval", at: dd, label: pretty(a.title) + ", now " + a.status });
    });
    if (state.repo && state.repo.committedAt) {
      var cd = new Date(state.repo.committedAt);
      if (!isNaN(cd) && cd.getTime() >= since) out.push({ type: "commit", at: cd, label: "Vault updated: " + pretty(state.repo.message) });
    }
    (chat.messages || []).forEach(function (m) {
      if (m.who !== "Brain") return;
      var d = parseWhen(m.at); if (!d || d.getTime() < since) return;
      out.push({ type: "chat", at: d, label: "Brain replied in chat: " + trimTo(pretty(m.text), 80) });
    });
    return out;
  }
  // Live motion: only what changed between the previous state and this one. teamSeen holds the
  // last poll's own facts (the newest run's own "when", the approvals' own statuses, the repo's
  // own commit); nothing here is a guess about what is happening right now, only a record of
  // what /api/state has already reported as having happened.
  var teamSeen = null;
  function teamDiff(prev, curr) {
    if (!window.Team || !curr) return;
    var runs = curr.runs || [];
    if (!teamSeen) {
      teamSeen = { runWhen: runs[0] ? runs[0].when : null, commit: curr.repo && curr.repo.commit, approvalStatus: {} };
      (curr.approvals || []).forEach(function (a) { teamSeen.approvalStatus[a.id] = a.status; });
      return;
    }
    var fresh = [];
    for (var i = 0; i < runs.length; i++) { if (runs[i].when === teamSeen.runWhen) break; fresh.push(runs[i]); }
    fresh.slice().reverse().forEach(function (r) {
      var id = teamAgentIdForJob(r.job);
      if (id) window.Team.event({ type: "run", at: parseWhen(r.when), agentIds: [id], label: r.job + " ran (" + r.result + ")" });
    });
    if (runs[0]) teamSeen.runWhen = runs[0].when;

    var approvalChanged = false;
    (curr.approvals || []).forEach(function (a) {
      var was = teamSeen.approvalStatus[a.id];
      if (was !== undefined && was !== a.status) {
        approvalChanged = true;
        window.Team.event({ type: "approval", at: new Date(), agentIds: [], label: pretty(a.title) + ": " + was + " to " + a.status });
      }
      teamSeen.approvalStatus[a.id] = a.status;
    });

    if (curr.repo && teamSeen.commit && curr.repo.commit !== teamSeen.commit) {
      window.Team.event({ type: "commit", at: new Date(), agentIds: [], label: "Vault updated: " + pretty(curr.repo.message) });
    }
    if (curr.repo) teamSeen.commit = curr.repo.commit;

    // A handover between two agents is not a field the vault writes anywhere, so this is read
    // from two real signals landing in the same diff: an approval actually changed status, and
    // the two most recently completed runs belong to two different agents. The earlier of the
    // two is drawn passing its row on to the one that ran after it. An approximation, noted as
    // such in the PR this shipped in.
    if (approvalChanged && runs[0] && runs[1]) {
      var from = teamAgentIdForJob(runs[1].job), to = teamAgentIdForJob(runs[0].job);
      if (from && to && from !== to) window.Team.event({ type: "handover", at: parseWhen(runs[0].when) || new Date(), agentIds: [from, to], label: "Handed over" });
    }
  }
  // A Brain reply landing in chat, whichever page it was fetched from: loadChat() already polls
  // while Chat is open, and the Team poll below calls it too so the cue reaches Runs.
  var teamChatSeen = null;
  function teamChatDiff() {
    if (!window.Team) return;
    var msgs = chat.messages || [];
    if (teamChatSeen === null) { teamChatSeen = msgs.length; return; }
    if (msgs.length > teamChatSeen) {
      msgs.slice(teamChatSeen).forEach(function (m) {
        if (m.who === "Brain") window.Team.event({ type: "chat", at: parseWhen(m.at) || new Date(), agentIds: [], label: "Brain replied in chat: " + trimTo(pretty(m.text), 80) });
      });
    }
    teamChatSeen = msgs.length;
  }
  // Team's own poll: /api/state again, 25s while the Runs page is open and the tab is visible
  // (paused otherwise, see the route() and visibilitychange wiring below), on top of the 5
  // minute ambient refresh every page already gets. load() itself calls loadChat(), which is
  // what feeds teamChatDiff() above.
  var teamTimer = null;
  function teamPoll() { if (!document.hidden) load(false); }
  function agentDetailHtml(a) {
    var schedule = (a.jobs || []).length
      ? a.jobs.map(function (j) { var s = teamJobSchedule(j); return esc(j) + (s ? " " + esc(s) : " (schedule not listed)"); }).join("<br>")
      : "No jobs listed in its frontmatter.";
    var lr = a.lastRun;
    var lastRunLine = lr ? esc(lr.job) + " · " + esc(lr.when) + " · " + esc(lr.result) + (lr.note ? ": " + esc(pretty(lr.note)) : "") : "No run logged yet for its jobs.";
    var tools = a.tools.length ? a.tools.map(esc).join(", ") : "None listed.";
    var goals = a.goals.length ? a.goals.map(function (g) { return "<li>" + esc(pretty(g)) + "</li>"; }).join("") : '<li class="empty">None listed.</li>';
    var recent = (a.recentRuns || []).slice(0, 6).map(function (r) {
      return "<li>" + esc(r.when) + " · " + esc(r.job) + " · " + esc(r.result) + (r.note ? ": " + esc(trimTo(pretty(r.note), 140)) : "") + "</li>";
    }).join("") || '<li class="empty">Nothing recent.</li>';
    return '<div class="t">' + esc(a.name) + "</div>"
      + (a.roleText ? '<p class="detail-role">' + esc(a.roleText) + "</p>" : "")
      + '<div class="detail-section"><h3>Schedule</h3><p>' + schedule + "</p></div>"
      + '<div class="detail-section"><h3>Last run</h3><p>' + lastRunLine + "</p></div>"
      + '<div class="detail-section"><h3>Tools</h3><p>' + tools + "</p></div>"
      + '<div class="detail-section"><h3>Goals it serves</h3><ul class="detail-trail">' + goals + "</ul></div>"
      + '<div class="detail-section"><h3>Recent work</h3><ul class="detail-trail">' + recent + "</ul></div>"
      + '<p class="meta"><a href="#/notes/' + encodeURIComponent(a.path) + '">Open its note</a></p>';
  }
  function openAgentDetail(a) {
    if (!a || !$("agentOverlay")) return;
    $("agentBody").innerHTML = agentDetailHtml(a);
    $("agentOverlay").hidden = false;
  }
  function closeAgentDetail() { if ($("agentOverlay")) $("agentOverlay").hidden = true; }
  if ($("agentClose")) $("agentClose").addEventListener("click", closeAgentDetail);
  if ($("agentOverlay")) $("agentOverlay").addEventListener("click", function (e) { if (e.target === $("agentOverlay")) closeAgentDetail(); });
  function agentPanelShortcut(e) {
    if (!$("agentOverlay") || $("agentOverlay").hidden) return false;
    if (e.key === "Escape") { closeAgentDetail(); return true; }
    return false;
  }

  // ---------- Team: the agent command centre. Draws state.team (lib/team.mts) and nothing else:
  // the top strip, the Director panel, one lane per department (a click filters everything
  // below it), the roster, demand against capacity, throughput and quality, usage, and What we
  // need more of. A null figure has no source and says "No data yet"; a zero is only shown when
  // its source exists and counts zero. Department colours come from the registry and follow the
  // department, never its position, so a filter never repaints a survivor. ----------
  var CC_FILTER_KEY = "brainTeamFilter";
  var ccFilter = "all", ccStripOpen = "", ccTables = {};
  try { ccFilter = localStorage.getItem(CC_FILTER_KEY) || "all"; } catch (e) {}
  var CC_NEUTRAL = { unassigned: "#5D6873", shared: "#8C99A6", untagged: "#3A4652" };
  var CC_BLOCKS = [["decision", "Your decision"], ["mac", "Mac session"], ["cowork", "Cowork session"], ["repo", "Repo access"], ["credentials", "Someone else's credentials"], ["other", "Other"]];
  function ccNoData(why) { return '<span class="cc-nodata" title="' + esc(why || "") + '">No data yet</span>'; }
  function ccDept(id) {
    var T = state.team, d = (T.departments || []).find(function (x) { return x.id === id; });
    if (d) return { id: d.id, name: d.name, colour: d.colour || CC_NEUTRAL.unassigned };
    if (id === "unassigned") return { id: id, name: "Unassigned", colour: CC_NEUTRAL.unassigned };
    if (id === "shared") return { id: id, name: "Several departments", colour: CC_NEUTRAL.shared };
    if (id === "untagged") return { id: id, name: "Runs with no department tag", colour: CC_NEUTRAL.untagged };
    return { id: id, name: id, colour: CC_NEUTRAL.unassigned };
  }
  function ccSwatch(colour) { return '<span class="cc-swatch" style="background:' + esc(colour) + '"></span>'; }
  function ccRowsTitle(rows) { return (rows || []).map(function (r) { return r.id + (r.title ? ": " + pretty(r.title) : ""); }).join("\n"); }
  function ccAge(days) { return days == null ? "" : days < 1 ? "under a day" : (Math.round(days * 10) / 10) + (days === 1 ? " day" : " days"); }
  function ccMins(m) { return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + (m % 60) + " min"; }
  function ccTrim(t, n) { t = String(t || "").trim(); return t.length <= n ? t : t.slice(0, Math.max(0, t.lastIndexOf(" ", n - 1))) + "..."; }
  function ccView() { var T = state.team; return (T.views && (T.views[ccFilter] || T.views.all)) || null; }

  function renderCommand() {
    if (!state || !$("view-team")) return;
    var T = state.team;
    var working = T && T.views && T.views.all && T.views.all.strip.working.value;
    setBadge("badgeTeam", working || 0);
    if (!T) { $("teamStrip").innerHTML = '<p class="empty">No Team data in this response. Refresh once the new build is live.</p>'; return; }
    if (!T.views[ccFilter]) ccFilter = "all";
    renderCCStrip(); renderCCDirector(); renderCCLanes(); renderCCRoster(); renderCCDemand(); renderCCThroughput(); renderCCUsage(); renderCCNeeds();
  }

  function renderCCStrip() {
    var s = state.team.views.all.strip;
    var tiles = [
      { id: "working", k: "Agents working now", v: s.working.value, why: s.working.why || "Live claims on queue rows in the lock ledger: no release, under 90 minutes old.", rows: s.working.rows },
      { id: "waiting", k: "Rows waiting", v: s.waiting.value, why: "Queue rows at requested, pending, approved or in progress, every department.", rows: s.waiting.rows },
      { id: "runs", k: "Runs today", v: s.runsToday.value, vText: s.runsToday.value == null ? null : s.runsToday.value + (s.runsToday.cap != null ? " of " + s.runsToday.cap : ""), why: s.runsToday.why || ("Cloud lines in the run log today" + (s.runsToday.cap != null ? ", against the cap of " + s.runsToday.cap + " routine runs a day in Tools (a research preview, so the cap can change)" : ", no cap found in Tools") + ". Runs, not tokens.") },
      { id: "done", k: "Finished this week", v: s.doneWeek.value, why: "Rows set to done since Monday, the live queue and the archive together.", rows: s.doneWeek.rows }
    ];
    $("teamStrip").innerHTML = tiles.map(function (t) {
      var val = t.v == null ? ccNoData(t.why) : '<span class="mono">' + esc(t.vText || String(t.v)) + "</span>";
      return '<button type="button" class="stat-tile lead-tile" data-tile="' + t.id + '" aria-pressed="' + (ccStripOpen === t.id) + '" title="' + esc(t.why) + '"' + (t.rows ? "" : " disabled") + '>'
        + '<div class="k">' + esc(t.k) + '</div><div class="v">' + val + "</div></button>";
    }).join("");
    $("teamStrip").querySelectorAll(".lead-tile").forEach(function (b) {
      b.addEventListener("click", function () { ccStripOpen = ccStripOpen === b.dataset.tile ? "" : b.dataset.tile; renderCCStrip(); });
    });
    var open = tiles.find(function (t) { return t.id === ccStripOpen && t.rows; }), box = $("teamStripRows");
    box.hidden = !open;
    if (!open) { box.innerHTML = ""; return; }
    box.innerHTML = '<div class="lead-strip-why">' + esc(open.k) + ": " + esc(open.why) + "</div>"
      + (open.rows.length ? '<ul class="lead-mini">' + open.rows.map(function (r) { return "<li>" + esc(pretty(r.title || r.id)) + ' <span class="mono faint">' + esc(r.id) + "</span></li>"; }).join("") + "</ul>" : '<p class="empty">None right now.</p>');
  }

  function directorNext() {
    var job = JOBS.find(function (j) { return j.name === "APPROVALS WATCHER"; });
    return job ? whenWords(nextFor(job)) : "";
  }
  function renderCCDirector() {
    var d = state.team.views.all.director, next = directorNext();
    var nextLine = '<p class="cc-line"><span class="k">Next run</span> ' + (next ? esc(next) + ' <span class="faint">(the Director runs inside the approvals watcher, plus any start from the platform)</span>' : ccNoData("No schedule found")) + "</p>";
    if (!d) {
      $("teamDirector").innerHTML = '<p class="cc-line"><span class="k">Last run</span> ' + ccNoData() + ' <span class="faint">No DIRECTOR line in the run log yet. The Director is not live until the LOCK paragraph and the MANAGE pointer are in the watcher routine.</span></p>' + nextLine;
      return;
    }
    var tree = d.tree.length ? '<ul class="cc-tree">' + d.tree.map(function (r) {
      return '<li><span class="cc-tree-row">' + esc(pretty(r.title || r.id)) + ' <span class="mono faint">' + esc(r.id) + "</span>" + (r.status ? ' <span class="lead-status">' + esc(r.status) + "</span>" : "") + "</span>"
        + (r.agents.length ? '<ol class="cc-tree-agents">' + r.agents.map(function (a) { return "<li>" + esc(a) + "</li>"; }).join("") + "</ol>" : '<div class="faint">No agents named for this row.</div>') + "</li>";
    }).join("") + "</ul>" : '<p class="faint">' + (d.last.tagged ? "The tag names no rows." : "This line has no tag, so it counts as a run with no breakdown.") + "</p>";
    var c = d.counts;
    $("teamDirector").innerHTML = '<p class="cc-line"><span class="k">Last run</span> <span class="mono">' + esc(d.last.when) + "</span>, " + esc(d.last.result)
      + (c ? ' <span class="faint">done ' + (c.done == null ? "not given" : c.done) + ", moved " + (c.moved == null ? "not given" : c.moved) + ", blocked " + (c.blocked == null ? "not given" : c.blocked) + "</span>" : "") + "</p>"
      + (d.last.note ? '<p class="cc-note">' + esc(ccTrim(pretty(d.last.note), 260)) + "</p>" : "") + nextLine
      + '<div class="cc-director-grid"><div><h3>Assigned in that run</h3>' + tree + "</div>"
      + "<div><h3>Back to a specialist after review</h3>" + (d.back ? (d.back.length ? '<ul class="plain-list">' + d.back.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>" : '<p class="faint">Nothing went back.</p>') : "<p>" + ccNoData() + ' <span class="faint">The DIRECTOR tag has no field for this yet.</span></p>')
      + "<h3>Passed to you</h3>" + (d.passed.length ? '<ul class="plain-list">' + d.passed.map(function (r) { return "<li>" + esc(pretty(r.title || r.id)) + ' <span class="mono faint">' + esc(r.id) + "</span></li>"; }).join("") + "</ul>" : '<p class="faint">None of that run\'s rows is waiting on you now.</p>') + "</div></div>";
  }

  function renderCCLanes() {
    var T = state.team;
    $("teamLanes").innerHTML = T.lanes.map(function (l) {
      var dep = ccDept(l.id), on = ccFilter === l.id;
      var statuses = ["requested", "pending", "approved", "in progress"].filter(function (s) { return l.statusCounts[s]; })
        .map(function (s) { return '<span class="cc-pill">' + esc(s) + ' <b class="mono">' + l.statusCounts[s] + "</b></span>"; }).join("");
      var blocks = CC_BLOCKS.filter(function (b) { return l.blocks[b[0]] && l.blocks[b[0]].length; })
        .map(function (b) { return '<span class="cc-pill block-' + b[0] + '" title="' + esc(ccRowsTitle(l.blocks[b[0]])) + '">' + esc(b[1]) + ' <b class="mono">' + l.blocks[b[0]].length + "</b></span>"; }).join("");
      var live = l.live.length ? l.live.map(function (c) { return '<div class="cc-live"><span class="cc-pulse" aria-hidden="true"></span>' + esc(pretty(c.title || c.key)) + ' <span class="faint">' + esc(c.agent || "agent not named in the claim") + ", " + esc(ccMins(c.ageMin)) + "</span></div>"; }).join("")
        : '<div class="faint">' + (T.sources.ledgerRows ? "Nothing live." : "No claims in the lock ledger yet.") + "</div>";
      var body = l.rowsTotal ? live
        + (l.stale.length ? '<div class="cc-stale" title="' + esc(l.stale.map(function (c) { return c.key + " (" + c.run + ")"; }).join("\n")) + '">' + l.stale.length + " stale claim" + (l.stale.length === 1 ? "" : "s") + ", no release after 90 minutes</div>" : "")
        + '<div class="cc-lane-line"><span class="k">Queue</span> ' + (statuses || '<span class="faint">no open rows</span>') + "</div>"
        + '<div class="cc-lane-line"><span class="k">Oldest</span> ' + (l.oldest ? esc(ccTrim(pretty(l.oldest.title), 44)) + ' <span class="mono faint">' + esc(ccAge(l.oldest.ageDays)) + "</span>" : '<span class="faint">none waiting</span>') + "</div>"
        + '<div class="cc-lane-line"><span class="k">Blocks</span> ' + (blocks || '<span class="faint">none</span>') + "</div>"
        + '<div class="cc-lane-line"><span class="k">Done this week</span> <b class="mono" title="' + esc(ccRowsTitle(l.doneWeek)) + '">' + l.doneWeek.length + "</b></div>"
        : live + '<p class="faint">No rows in this department yet.' + (l.id === "unassigned" ? "" : " A row joins it through its 12th cell in Approvals.") + "</p>";
      return '<button type="button" class="cc-lane' + (on ? " on" : "") + '" data-lane="' + esc(l.id) + '" aria-pressed="' + on + '" style="--dept:' + esc(dep.colour) + '">'
        + '<div class="cc-lane-head">' + ccSwatch(dep.colour) + "<b>" + esc(dep.name) + '</b><span class="mono faint">' + l.open.length + " open</span></div>"
        + body + '<div class="cc-lane-line faint"><span class="k">Next run</span> ' + esc(directorNext() || "not scheduled") + "</div></button>";
    }).join("");
    $("teamLanes").querySelectorAll(".cc-lane").forEach(function (b) {
      b.addEventListener("click", function () {
        ccFilter = ccFilter === b.dataset.lane ? "all" : b.dataset.lane;
        try { localStorage.setItem(CC_FILTER_KEY, ccFilter); } catch (e) {}
        renderCommand();
      });
    });
    var fl = $("teamFilterLine");
    fl.hidden = ccFilter === "all";
    fl.innerHTML = ccFilter === "all" ? "" : "Showing " + esc(ccDept(ccFilter).name) + ' only, below this line. <button type="button" class="ghost small" id="ccClear">Show every department</button>';
    if ($("ccClear")) $("ccClear").addEventListener("click", function () { ccFilter = "all"; try { localStorage.setItem(CC_FILTER_KEY, "all"); } catch (e) {} renderCommand(); });
  }

  function renderCCRoster() {
    var v = ccView();
    var rows = v.roster.map(function (r) {
      var depts = Object.keys(r.depts || {});
      return "<tr" + (r.live ? ' class="live"' : "") + ">"
        + "<td>" + ccSwatch(r.colour || "#8C99A6") + "<b>" + esc(r.role) + "</b>" + (r.name !== r.role ? ' <span class="faint">' + esc(r.name) + "</span>" : "") + '<div class="faint mono">' + esc(r.model || "model not set") + "</div></td>"
        + "<td>" + (r.weekRuns == null ? ccNoData("No DIRECTOR lines yet") : (depts.length ? depts.map(function (d) { var x = ccDept(d); return '<span class="cc-pill">' + ccSwatch(x.colour) + esc(x.name) + ' <b class="mono">' + r.depts[d] + "</b></span>"; }).join(" ") : '<span class="faint">none this week</span>')) + "</td>"
        + '<td class="mono">' + (r.rowsTouched == null ? ccNoData("No DIRECTOR lines yet") : '<span title="' + esc(ccRowsTitle(r.rowsTouched)) + '">' + r.rowsTouched.length + "</span>") + "</td>"
        + "<td>" + (r.lastRun ? '<span class="mono">' + esc(r.lastRun.when) + "</span> " + esc(r.lastRun.job) + ", " + esc(r.lastRun.result) : '<span class="faint">No run logged yet</span>') + "</td>"
        + "<td>" + (r.now.length ? r.now.map(function (n) { return '<span class="cc-pulse" aria-hidden="true"></span>' + esc(ccTrim(pretty(n.title || n.id), 40)) + ' <span class="faint">' + esc(ccMins(n.ageMin)) + "</span>"; }).join("<br>") : '<span class="faint">Not on anything</span>') + "</td></tr>";
    }).join("");
    $("teamRoster").innerHTML = '<table class="runs cc-table"><thead><tr><th>Role</th><th>Department work this week</th><th>Rows touched</th><th>Last run</th><th>On now</th></tr></thead><tbody>'
      + (rows || '<tr><td colspan="5" class="empty">No agent files found under System/Agents/.</td></tr>') + "</tbody></table>";
  }

  // A small horizontal bar chart: one bar per department, its registry colour, value labelled
  // at the end of the bar, and a table view. null values draw no bar and say No data yet.
  function ccBars(id, title, items, unit) {
    var max = Math.max(1, Math.max.apply(null, items.map(function (i) { return i.value || 0; })));
    var rowH = 26, labelW = 104, W = 460, barW = W - labelW - 40, H = items.length * rowH + 6;
    var svg = '<svg class="cc-svg" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(title) + '">'
      + items.map(function (it, i) {
        var y = 4 + i * rowH, dep = ccDept(it.dept), w = it.value ? Math.max(3, (it.value / max) * barW) : 0;
        return '<g><title>' + esc(dep.name + ": " + (it.value == null ? "no data yet" : it.value + " " + unit) + (it.hover ? "\n" + it.hover : "")) + "</title>"
          + '<rect x="0" y="' + y + '" width="' + W + '" height="' + (rowH - 2) + '" fill="transparent"/>'
          + '<text x="0" y="' + (y + 16) + '" class="cc-axis">' + esc(ccTrim(dep.name, 15)) + "</text>"
          + (it.value == null ? '<text x="' + labelW + '" y="' + (y + 16) + '" class="cc-axis faint">No data yet</text>'
            : '<rect x="' + labelW + '" y="' + (y + 5) + '" width="' + w + '" height="12" rx="3" fill="' + esc(dep.colour) + '"/>'
            + '<text x="' + (labelW + w + 6) + '" y="' + (y + 16) + '" class="cc-val">' + it.value + "</text>") + "</g>";
      }).join("") + "</svg>";
    return svg;
  }
  function ccTable(key, head, rows) {
    var open = !!ccTables[key];
    return '<button type="button" class="ghost small cc-table-toggle" data-table="' + esc(key) + '">' + (open ? "Hide table" : "Show table") + "</button>"
      + (open ? '<table class="runs cc-table"><thead><tr>' + head.map(function (h) { return "<th>" + esc(h) + "</th>"; }).join("") + "</tr></thead><tbody>" + rows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + c + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table>" : "");
  }
  function wireTableToggles(host, rerender) {
    host.querySelectorAll(".cc-table-toggle").forEach(function (b) { b.addEventListener("click", function () { ccTables[b.dataset.table] = !ccTables[b.dataset.table]; rerender(); }); });
  }
  function ccLegend(ids) {
    return '<div class="cc-legend">' + ids.map(function (id) { var d = ccDept(id); return '<span>' + ccSwatch(d.colour) + esc(d.name) + "</span>"; }).join("") + "</div>";
  }

  function renderCCDemand() {
    var v = ccView(), items = v.demand;
    var host = $("teamDemand");
    host.innerHTML = '<div class="panel cc-chart"><h3>Rows waiting</h3>' + ccBars("wait", "Rows waiting by department", items.map(function (d) { return { dept: d.dept, value: d.waiting, hover: ccRowsTitle(d.rows) }; }), "rows") + "</div>"
      + '<div class="panel cc-chart"><h3>Runs spent this week</h3>' + ccBars("runs", "DIRECTOR runs this week by department", items.map(function (d) { return { dept: d.dept, value: d.runsWeek }; }), "runs")
      + (items.every(function (d) { return d.runsWeek == null; }) ? '<p class="faint small-print">Counted from DIRECTOR lines; there are none yet.</p>' : "") + "</div>"
      + '<div class="cc-chart-foot">' + (items.length > 1 ? ccLegend(items.map(function (d) { return d.dept; })) : "")
      + ccTable("demand", ["Department", "Rows waiting", "Runs this week", "Median wait"], items.map(function (d) {
        return [esc(ccDept(d.dept).name), '<span class="mono">' + d.waiting + "</span>", d.runsWeek == null ? ccNoData() : '<span class="mono">' + d.runsWeek + "</span>", d.medianWaitDays == null ? '<span class="faint">no open rows</span>' : '<span class="mono">' + esc(ccAge(d.medianWaitDays)) + "</span>"];
      })) + "</div>";
    wireTableToggles(host, renderCCDemand);
  }

  function renderCCThroughput() {
    var v = ccView(), host = $("teamThroughput"), t = v.throughput;
    var pct = function (x) { return x == null ? ccNoData("Nothing done or redone this week") : '<span class="mono">' + x + "%</span>"; };
    var ratio = function (x, rows) { return x == null ? ccNoData("No done row this week has both an Est: figure and times to measure") : '<span class="mono" title="' + esc((rows || []).map(function (r) { return r.id + ": " + r.ratio + "x"; }).join("\n")) + '">' + x + "x</span>"; };
    var dept = '<table class="runs cc-table"><thead><tr><th>Department</th><th>Rows done</th><th>Redo rate</th><th>Failed runs</th><th>Actual against estimate</th></tr></thead><tbody>'
      + t.byDept.map(function (d) {
        var dep = ccDept(d.dept);
        return "<tr><td>" + ccSwatch(dep.colour) + esc(dep.name) + '</td><td class="mono" title="' + esc(ccRowsTitle(d.doneRows)) + '">' + d.done + '</td><td title="' + esc(ccRowsTitle(d.redoRows)) + '">' + pct(d.redoRate) + (d.redos ? ' <span class="faint">(' + d.redos + " redo" + (d.redos === 1 ? "" : "s") + ")</span>" : "") + "</td><td>"
          + (d.failed == null ? ccNoData("Counted from DIRECTOR lines; there are none yet") : '<span class="mono" title="' + esc(d.failedRuns.join("\n")) + '">' + d.failed + "</span>") + "</td><td>" + ratio(d.estRatio, d.estRows) + "</td></tr>";
      }).join("") + "</tbody></table>";
    var agent = t.byAgent ? '<table class="runs cc-table"><thead><tr><th>Specialist</th><th>Rows done</th><th>Redo rate</th><th>Failed runs</th><th>Actual against estimate</th></tr></thead><tbody>'
      + t.byAgent.map(function (a) {
        return "<tr><td>" + ccSwatch(a.colour || "#8C99A6") + esc(a.role) + '</td><td class="mono" title="' + esc(ccRowsTitle(a.doneRows)) + '">' + a.done + '</td><td title="' + esc(ccRowsTitle(a.redoRows)) + '">' + pct(a.redoRate) + '</td><td class="mono">' + a.failed + "</td><td>" + ratio(a.estRatio) + "</td></tr>";
      }).join("") + "</tbody></table>"
      : '<p class="panel faint">Per specialist: ' + ccNoData() + ". Rows are tied to a specialist only by the agents= field of DIRECTOR lines, and there are none yet.</p>";
    host.innerHTML = '<div class="table-wrap">' + dept + '</div><p class="why-line">Actual is calendar time from requested to done against the row\'s first Est: figure (median ratio). Redo counts presses of Redo with a note, from the dated clause each one writes in the row. Hover a figure for the rows behind it.</p><div class="table-wrap">' + agent + "</div>";
  }

  function renderCCUsage() {
    var v = ccView(), u = v.usage, host = $("teamUsage");
    var days = u.days, cap = u.cap;
    var segOrder = (state.team.departments || []).map(function (d) { return d.id; }).concat(["unassigned", "shared", "untagged"]);
    var maxV = Math.max(cap || 0, Math.max.apply(null, days.map(function (d) { return d.total || 0; })), 1);
    var W = 640, H = 170, padL = 26, padB = 22, plotH = H - padB - 10, colW = (W - padL) / days.length, barW = Math.min(26, colW - 6);
    var y = function (val) { return 10 + plotH - (val / maxV) * plotH; };
    var used = {};
    var bars = days.map(function (d, i) {
      var x = padL + i * colW + (colW - barW) / 2, label = String(+d.ymd.slice(8, 10));
      var out = '<text x="' + (x + barW / 2) + '" y="' + (H - 6) + '" text-anchor="middle" class="cc-axis">' + label + "</text>";
      if (d.total == null) return out + '<g><title>' + esc(d.ymd + ": no data yet, before the first logged run") + '</title><rect x="' + x + '" y="' + (10 + plotH - 3) + '" width="' + barW + '" height="3" fill="#1D242D"/></g>';
      var top = 10 + plotH, parts = [];
      var segs = ccFilter === "all" ? segOrder.filter(function (k) { return d.segments[k]; }).map(function (k) { return [k, d.segments[k]]; }) : (d.shown ? [[ccFilter, d.shown]] : []);
      segs.forEach(function (sg, j) {
        used[sg[0]] = true;
        var h = (sg[1] / maxV) * plotH, yy = top - h;
        parts.push('<rect x="' + x + '" y="' + (yy + (j ? 1 : 0)) + '" width="' + barW + '" height="' + Math.max(1, h - (j ? 1 : 0)) + '" rx="' + (j === segs.length - 1 ? 2 : 0) + '" fill="' + esc(ccDept(sg[0]).colour) + '"/>');
        top = yy;
      });
      var tip = d.ymd + ": " + (ccFilter === "all" ? d.total + " routine run" + (d.total === 1 ? "" : "s") : d.shown + " tagged " + ccDept(ccFilter).name + " of " + d.total) + (segs.length ? "\n" + segs.map(function (sg) { return ccDept(sg[0]).name + " " + sg[1]; }).join("\n") : "");
      return out + "<g><title>" + esc(tip) + '</title><rect x="' + (padL + i * colW) + '" y="10" width="' + colW + '" height="' + plotH + '" fill="transparent"/>' + parts.join("") + "</g>";
    }).join("");
    var capLine = cap != null ? '<line x1="' + padL + '" x2="' + W + '" y1="' + y(cap) + '" y2="' + y(cap) + '" class="cc-cap"/><text x="' + (W - 2) + '" y="' + (y(cap) - 4) + '" text-anchor="end" class="cc-axis">cap ' + cap + "</text>" : "";
    var axis = '<line x1="' + padL + '" x2="' + W + '" y1="' + (10 + plotH) + '" y2="' + (10 + plotH) + '" class="cc-base"/><text x="' + (padL - 6) + '" y="' + (10 + plotH) + '" text-anchor="end" class="cc-axis">0</text><text x="' + (padL - 6) + '" y="' + (y(maxV) + 8) + '" text-anchor="end" class="cc-axis">' + maxV + "</text>";
    host.innerHTML = '<p class="cc-line"><span class="k">Headroom today</span> ' + (u.headroom == null ? ccNoData(cap == null ? "No routine cap found in Tools" : "The run log has no lines yet") : '<b class="mono">' + u.headroom + "</b> of " + cap + " routine runs left") + ' <span class="faint">Runs, not tokens: routines draw plan usage the platform cannot see. Cap from Tools, checked 14 Apr 2026.</span></p>'
      + '<svg class="cc-svg cc-usage" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Routine runs a day, last 14 days">' + axis + capLine + bars + "</svg>"
      + (Object.keys(used).length > 1 ? ccLegend(segOrder.filter(function (k) { return used[k]; })) : "")
      + ccTable("usage", ["Day", "Routine runs", ccFilter === "all" ? "By department" : ccDept(ccFilter).name], days.slice().reverse().map(function (d) {
        return ['<span class="mono">' + esc(d.ymd) + "</span>", d.total == null ? ccNoData() : '<span class="mono">' + d.total + "</span>", d.total == null ? "" : ccFilter === "all" ? esc(Object.keys(d.segments).map(function (k) { return ccDept(k).name + " " + d.segments[k]; }).join(", ")) : '<span class="mono">' + d.shown + "</span>"];
      }));
    wireTableToggles(host, renderCCUsage);
  }

  function renderCCNeeds() {
    var n = ccView().needs;
    $("teamNeeds").innerHTML = (n.lines.length ? '<ul class="cc-needs">' + n.lines.map(function (l) { return "<li><b>" + esc(l.text) + '</b><div class="faint mono">' + esc(l.numbers) + "</div></li>"; }).join("") + "</ul>"
      : '<p class="faint">No rule fires on the current figures.</p>')
      + (n.notChecked.length ? '<p class="why-line">Not checked yet: ' + n.notChecked.map(function (x) { return esc(x.rule) + " (" + esc(x.why) + ")"; }).join("; ") + "</p>" : "")
      + '<p class="why-line">Rules and thresholds live in <a href="#/notes/System%2FDepartments.md">Departments</a>; change a number there and this follows.</p>';
  }

  // ---------- leads: the Owlbridge pipeline, from state.leads (built in lib/leads.mts) ----------
  // v1 (PR #13): the top strip, the board by status, filters remembered per device, a detail
  // panel, Add lead, and opt-out to the suppression list. v2 (Lead gen station v2) adds the sub
  // pages #/leads (home), #/leads/list, #/leads/board, #/leads/sequence, #/leads/reports and
  // #/leads/record/<id>, and the Owlbridge
  // activity log: every status change, next step, field save, Done and logged touch made here
  // appends one line to that note (POST /api/lead), and the record's timeline, the home feed and
  // the sequence position read it back. Every count opens or names the rows it was counted from,
  // so no figure shows without its source. Nothing here sends an email or contacts anyone.
  function lsGet(k, d) { try { var v = JSON.parse(localStorage.getItem(k) || "null"); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  var LEAD_FILTER_KEY = "brainLeadFilters", LEAD_VIEW_KEY = "brainLeadView", LEAD_COLS_KEY = "brainLeadCols", LEAD_SORT_KEY = "brainLeadSort";
  var leadFilters = { tier: "", segment: "", source: "", status: "" };
  (function () { var f = lsGet(LEAD_FILTER_KEY, null); if (f && typeof f === "object") Object.keys(leadFilters).forEach(function (k) { if (typeof f[k] === "string") leadFilters[k] = f[k]; }); })();
  function saveLeadFilters() { lsSet(LEAD_FILTER_KEY, leadFilters); }
  var leadOpenId = null, leadStripOpen = "", leadDragId = null;
  var leadSub = "home", leadCursorId = "", leadRecId = "", leadSel = {}, leadKind = "note", leadDoneOpen = "", leadFieldsDirty = false;
  var leadView = lsGet(LEAD_VIEW_KEY, "all"); if (typeof leadView !== "string") leadView = "all";
  var leadSort = lsGet(LEAD_SORT_KEY, null); if (!leadSort || typeof leadSort.k !== "string") leadSort = { k: "score", d: -1 };
  // The list's columns. Company is always shown; the rest are picked per device.
  var LEAD_COLS = [
    { k: "company", label: "Company", fixed: true }, { k: "tier", label: "Tier" }, { k: "score", label: "Score" },
    { k: "segment", label: "Segment" }, { k: "contact", label: "Contact" }, { k: "email", label: "Email", off: true },
    { k: "status", label: "Status" }, { k: "lastTouch", label: "Last touch" }, { k: "nextStep", label: "Next step" },
    { k: "nextDate", label: "Next date" }, { k: "source", label: "Source", off: true }
  ];
  var leadCols = lsGet(LEAD_COLS_KEY, null);
  if (!Array.isArray(leadCols)) leadCols = LEAD_COLS.filter(function (c) { return !c.off && !c.fixed; }).map(function (c) { return c.k; });
  var LEAD_SENT = ["sent", "replied", "call booked", "proposal", "won"];
  var LEAD_REPLIED = ["replied", "call booked", "proposal", "won"];
  var LEAD_STAGES_FALLBACK = ["researched", "drafted", "sent", "replied", "call booked", "proposal", "won"];
  var YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
  function leadsAll() { return (state && state.leads && state.leads.leads) || []; }
  function leadById(id) { return leadsAll().find(function (l) { return l.id === id; }) || null; }
  function leadInPlay(l) { return (state.leads.closed || []).indexOf(l.status) < 0; }
  function leadStages() { return (state.leads && state.leads.stages) || LEAD_STAGES_FALLBACK; }
  function leadMatches(l) {
    return (!leadFilters.tier || l.tier === leadFilters.tier) && (!leadFilters.segment || l.segment === leadFilters.segment)
      && (!leadFilters.source || l.source === leadFilters.source) && (!leadFilters.status || l.status === leadFilters.status);
  }
  function ymdDays(a, b) { return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000); }
  function ymdAdd(ymd, n) { var d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function leadMonday(ymd) { var d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
  function leadDateLabel(ymd) {
    if (!YMD_RE.test(ymd || "")) return "";
    var p = ymd.split("-"); return (+p[2]) + " " + MONTHS[+p[1] - 1].slice(0, 3);
  }
  function leadDueWords(l) {
    var n = ymdDays(l.nextDate, state.today.ymd);
    return n <= 0 ? "Today" : n === 1 ? "1 day over" : n + " days over";
  }
  function leadStatusChip(s) { return '<span class="lead-status s-' + esc(String(s || "").replace(/\s+/g, "-")) + '">' + esc(s || "no status") + "</span>"; }
  function leadMeta(l) {
    return [l.tier ? "Tier " + l.tier : "", l.score ? l.score + "/100" : ""].filter(Boolean).join(" · ");
  }
  function leadTierChip(t) { return t ? '<span class="lead-tier t-' + esc(String(t).replace(/\W+/g, "")) + '" title="Tier ' + esc(t) + '">' + esc(t) + "</span>" : '<span class="faint">none</span>'; }
  function leadScoreBar(s) {
    var n = /^\d{1,3}$/.test(String(s || "")) ? Math.min(100, +s) : null;
    return n === null ? '<span class="faint">no score</span>' : '<span class="lead-score" title="Score ' + n + ' out of 100"><em><b style="width:' + n + '%"></b></em><span class="mono">' + n + "</span></span>";
  }
  function leadScoreRing(s) {
    var n = /^\d{1,3}$/.test(String(s || "")) ? Math.min(100, +s) : null;
    return n === null ? "" : '<span class="lead-ring" style="--p:' + n + '" role="img" aria-label="Score ' + n + ' out of 100"><b class="mono">' + n + "</b></span>";
  }
  // Last touch, relative, and amber after 7 days or red after 14 (worked out server side, as
  // l.touchDays and l.stale). The words carry the state too, so it never rests on colour alone.
  function leadTouchWords(l) {
    var n = l.touchDays;
    if (n === null || n === undefined) return "no touch yet";
    return n <= 0 ? "today" : n === 1 ? "yesterday" : n + " days ago";
  }
  function leadTouch(l) {
    var w = esc(leadTouchWords(l));
    if (!l.stale) return '<span class="lead-touch' + (l.touchDays == null ? " faint" : "") + '" title="' + (l.lastTouch ? "Last touch " + esc(l.lastTouch) : "No last touch in the row") + '">' + w + "</span>";
    return '<span class="lead-touch stale-' + l.stale + '" title="Last touch ' + esc(l.lastTouch) + ": no touch for over " + (l.stale === "red" ? 14 : 7) + ' days"><span aria-hidden="true">&#9679; </span>' + w + '<span class="sr-only">, stale</span></span>';
  }
  function leadFiltered() { return Object.keys(leadFilters).some(function (k) { return leadFilters[k]; }); }
  function leadOpenRecord(id) { location.hash = "#/leads/record/" + encodeURIComponent(id); }
  function leadEmailOk(e) { return /^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/.test(String(e || "").trim()); }

  // ---------- the strip (v1) ----------
  function leadStripTiles() {
    var all = leadsAll(), monday = leadMonday(state.today.ymd);
    var sentAll = all.filter(function (l) { return LEAD_SENT.indexOf(l.status) > -1; });
    var replies = all.filter(function (l) { return LEAD_REPLIED.indexOf(l.status) > -1; });
    var rate = sentAll.length >= 10 ? Math.round((replies.length / sentAll.length) * 100) + "%" : "";
    return [
      { id: "play", k: "In play", rows: all.filter(leadInPlay), why: "Every row not lost, opted out or disqualified." },
      { id: "sentweek", k: "Sent this week", rows: all.filter(function (l) { return l.status === "sent" && l.lastTouch >= monday && l.lastTouch <= state.today.ymd; }), why: "Rows at sent whose last touch is since Monday " + leadDateLabel(monday) + "." },
      { id: "replies", k: "Replies", rows: replies, sub: rate ? rate + " of " + sentAll.length + " sent" : sentAll.length + " sent, rate from 10", why: "Rows at replied, call booked, proposal or won. The rate is replies divided by rows at sent or further along (lost and opted-out rows are left out, since the table does not say whether they were sent), shown once 10 or more are sent." },
      { id: "calls", k: "Calls booked", rows: all.filter(function (l) { return l.status === "call booked"; }), why: "Rows at call booked." },
      { id: "won", k: "Won", rows: all.filter(function (l) { return l.status === "won"; }), why: "Rows at won. A count only: the table holds no deal values." }
    ];
  }
  function renderLeadStrip() {
    var tiles = leadStripTiles();
    $("leadsStrip").innerHTML = tiles.map(function (t) {
      return '<button type="button" class="stat-tile lead-tile" data-tile="' + t.id + '" aria-pressed="' + (leadStripOpen === t.id ? "true" : "false") + '" title="' + esc(t.why) + '">'
        + '<div class="k">' + esc(t.k) + '</div><div class="v mono">' + t.rows.length + "</div>"
        + (t.sub ? '<div class="tile-sub">' + esc(t.sub) + "</div>" : "") + "</button>";
    }).join("");
    $("leadsStrip").querySelectorAll(".lead-tile").forEach(function (b) {
      b.addEventListener("click", function () { leadStripOpen = leadStripOpen === b.dataset.tile ? "" : b.dataset.tile; renderLeadStrip(); });
    });
    var box = $("leadsStripRows"), open = tiles.find(function (t) { return t.id === leadStripOpen; });
    box.hidden = !open;
    if (!open) { box.innerHTML = ""; return; }
    box.innerHTML = '<div class="lead-strip-why">' + esc(open.k) + ": " + esc(open.why) + "</div>"
      + (open.rows.length ? '<ul class="lead-mini">' + open.rows.map(function (l) { return '<li><a href="#/leads/record/' + encodeURIComponent(l.id) + '">' + esc(l.company) + "</a> " + leadStatusChip(l.status) + (l.lastTouch ? ' <span class="mono faint">' + esc(leadDateLabel(l.lastTouch)) + "</span>" : "") + "</li>"; }).join("") + "</ul>"
        : '<p class="empty">No rows count towards this yet.</p>');
  }

  // ---------- filters (v1), now on the list and the board ----------
  function renderLeadFilters() {
    var all = leadsAll();
    document.querySelectorAll(".lead-filters select").forEach(function (sel) {
      var f = sel.dataset.f;
      var values = f === "status" ? state.leads.statuses.slice() : Array.from(new Set(all.map(function (l) { return l[f]; }).filter(Boolean))).sort();
      if (leadFilters[f] && values.indexOf(leadFilters[f]) < 0) values.push(leadFilters[f]);
      sel.innerHTML = '<option value="">All</option>' + values.map(function (v) { return '<option' + (v === leadFilters[f] ? " selected" : "") + ' value="' + esc(v) + '">' + esc(v) + "</option>"; }).join("");
    });
    $("leadFClear").hidden = !leadFiltered();
  }
  document.querySelectorAll(".lead-filters select").forEach(function (sel) {
    sel.addEventListener("change", function () { leadFilters[sel.dataset.f] = sel.value; saveLeadFilters(); leadSel = {}; renderLeads(); });
  });
  if ($("leadFClear")) $("leadFClear").addEventListener("click", function () { Object.keys(leadFilters).forEach(function (k) { leadFilters[k] = ""; }); saveLeadFilters(); renderLeads(); });

  // ---------- home: Today (with Done), Coming up, the funnel, the activity feed ----------
  function leadDueRow(l, withDone) {
    var over = l.due && ymdDays(l.nextDate, state.today.ymd) > 0;
    var when = l.due ? leadDueWords(l) : leadDateLabel(l.nextDate);
    var open = withDone && leadDoneOpen === l.id;
    return '<div class="lead-due-row-wrap" data-id="' + esc(l.id) + '"><div class="lead-due-row">'
      + '<span class="lead-due-when mono' + (over ? " over" : "") + '" title="Next date ' + esc(l.nextDate) + '">' + (over ? '<span aria-hidden="true">&#9650; </span>' : "") + esc(when) + "</span>"
      + '<a class="lead-due-co" href="#/leads/record/' + encodeURIComponent(l.id) + '">' + esc(l.company) + "</a>"
      + '<span class="lead-due-step">' + esc(l.nextStep || "No next step written") + "</span>"
      + leadStatusChip(l.status)
      + (withDone ? '<button type="button" class="ghost small lead-done-btn" aria-expanded="' + open + '" title="Log this step as done and set the next one">Done</button>' : "")
      + "</div>"
      + (open ? '<form class="lead-done-form"><span class="why">Done: ' + esc(l.nextStep || "the next step") + ". What happens next?</span>"
        + '<input type="text" class="lead-done-step" aria-label="Next step" placeholder="Next step">'
        + '<input type="date" class="lead-done-date" aria-label="Next date" value="' + esc(ymdAdd(state.today.ymd, 3)) + '">'
        + '<button type="submit" class="primary">Save</button><button type="button" class="ghost small lead-done-cancel">Cancel</button></form>' : "")
      + "</div>";
  }
  function renderLeadToday() {
    var all = leadsAll(), today = state.today.ymd, week = ymdAdd(today, 7);
    var byDate = function (a, b) { return a.nextDate < b.nextDate ? -1 : a.nextDate > b.nextDate ? 1 : a.company.localeCompare(b.company); };
    var due = all.filter(function (l) { return l.due; }).sort(byDate);
    var soon = all.filter(function (l) { return !l.due && leadInPlay(l) && YMD_RE.test(l.nextDate) && l.nextDate > today && l.nextDate <= week; }).sort(byDate);
    $("leadsDueCount").textContent = due.length ? String(due.length) : "";
    $("leadsSoonCount").textContent = soon.length ? String(soon.length) : "";
    var host = $("leadsDue");
    if (!due.length) {
      var anyDated = all.some(function (l) { return leadInPlay(l) && YMD_RE.test(l.nextDate); });
      host.innerHTML = '<p class="empty">' + (anyDated ? "Nothing due today. The next dates in play are all in the future." : "Nothing due: no lead in play has a next date yet. Set one on a lead's record.") + "</p>";
    } else host.innerHTML = due.map(function (l) { return leadDueRow(l, true); }).join("");
    $("leadsSoon").innerHTML = soon.length ? soon.slice(0, 10).map(function (l) { return leadDueRow(l, false); }).join("")
      + (soon.length > 10 ? '<p class="why-line"><a href="#/leads/list" data-view-go="week">All ' + soon.length + " due in the next 7 days</a></p>" : "")
      : '<p class="empty">Nothing else due in the next 7 days.</p>';
    $("leadsSoon").querySelectorAll("[data-view-go]").forEach(function (a) { a.addEventListener("click", function () { leadView = a.dataset.viewGo; lsSet(LEAD_VIEW_KEY, leadView); }); });
    host.querySelectorAll(".lead-due-row-wrap").forEach(function (w) {
      var id = w.dataset.id, btn = w.querySelector(".lead-done-btn"), form = w.querySelector(".lead-done-form");
      if (btn) btn.addEventListener("click", function () { leadDoneOpen = leadDoneOpen === id ? "" : id; renderLeadToday(); var f = host.querySelector('.lead-due-row-wrap[data-id="' + CSS.escape(id) + '"] .lead-done-step'); if (f) f.focus(); });
      if (!form) return;
      form.querySelector(".lead-done-cancel").addEventListener("click", function () { leadDoneOpen = ""; renderLeadToday(); });
      form.addEventListener("submit", async function (e) {
        e.preventDefault();
        var sb = form.querySelector("button[type=submit]"); sb.disabled = true;
        try {
          var r = await api("lead", { method: "POST", body: { action: "done", id: id, nextStep: form.querySelector(".lead-done-step").value.trim(), nextDate: form.querySelector(".lead-done-date").value } });
          leadDoneOpen = "";
          toast(r.unchanged ? "Nothing changed: the step, date and last touch were already as sent."
            : r.activityError ? "Done, saved to Owlbridge pipeline, but the activity line did not save: " + r.activityError
            : "Done, and logged to Owlbridge activity log.", !!r.activityError);
          fire({ count: 12, region: "cortex", boost: 0.2 });
          await load(false);
        } catch (err) { toast(err.message, true); sb.disabled = false; }
      });
    });
  }
  function renderLeadFunnel() {
    var f = state.leads.funnel || [], inPlay = leadsAll().filter(leadInPlay).length;
    var max = Math.max.apply(null, f.map(function (s) { return s.count; }).concat([1]));
    $("leadsFunnelSub").textContent = inPlay + " in play";
    $("leadsFunnel").innerHTML = f.map(function (s) {
      return '<button type="button" class="lead-fr" data-stage="' + esc(s.stage) + '" title="' + s.count + " at " + esc(s.stage) + "; " + s.reached + ' at this stage or further along. Opens these rows in the list.">'
        + '<span class="lead-fr-k">' + esc(cap(s.stage)) + '</span><span class="lead-bar"><b style="width:' + (s.count / max * 100) + '%"></b></span><span class="lead-fr-n mono">' + s.count + "</span></button>"
        + (s.conversion !== null && s.conversion !== undefined ? '<div class="lead-conv mono" title="Of the ' + s.reached + " leads that reached " + esc(s.stage) + ", the share now at the next stage or further along. Closed rows are left out.\">" + s.conversion + "% on to the next stage</div>" : "");
    }).join("");
    var closed = leadsAll().filter(function (l) { return !leadInPlay(l); }).length;
    $("leadsFunnelNote").textContent = "Stage-to-stage conversion shows once a stage has reached " + (state.leads.conversionFrom || 10) + " or more leads." + (closed ? " " + closed + " closed (lost, opted out or disqualified) are not in the funnel." : "");
    $("leadsFunnel").querySelectorAll(".lead-fr").forEach(function (b) {
      b.addEventListener("click", function () { leadFilters.status = b.dataset.stage; saveLeadFilters(); leadView = "all"; lsSet(LEAD_VIEW_KEY, leadView); location.hash = "#/leads/list"; });
    });
  }
  function leadTypeIcon(t) { return '<span class="lead-ic t-' + esc(t || "note") + '" title="' + esc(t || "note") + '" aria-hidden="true">' + esc(String(t || "?").charAt(0).toUpperCase()) + "</span>"; }
  function leadActivityWhen(at) {
    var m = String(at || "").match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?/);
    if (!m) return at || "";
    var d = m[1] === state.today.ymd ? "Today" : m[1] === ymdAdd(state.today.ymd, -1) ? "Yesterday" : leadDateLabel(m[1]);
    return d + (m[2] ? " " + m[2] : "");
  }
  function renderLeadFeed() {
    var A = state.leads.activity || { exists: false, latest: [] };
    var host = $("leadsFeed");
    if (!A.exists) host.innerHTML = '<p class="empty">Owlbridge activity log is not in the vault yet. The first status change, next step or logged call here creates it.</p>';
    else if (!A.latest.length) host.innerHTML = '<p class="empty">No activity yet. Every status change, next step and logged call here writes a line to <a href="#/notes/' + encodeURIComponent(A.path) + '">Owlbridge activity log</a>, and the Director adds one per lead it touches.</p>';
    else host.innerHTML = A.latest.map(function (a) {
      return '<div class="lead-fe">' + leadTypeIcon(a.type) + "<div>"
        + (a.company ? '<a href="#/leads/record/' + encodeURIComponent(a.lead) + '">' + esc(a.company) + "</a>" : '<span class="mono faint">' + esc(a.lead || "no lead") + "</span>")
        + " <span>" + esc(a.summary) + '</span><div class="lead-fe-m mono">' + esc(leadActivityWhen(a.at)) + " · " + esc(a.by || "unsigned") + " · " + esc(a.type) + "</div></div></div>";
    }).join("") + '<p class="why-line">' + A.total + ' lines in <a href="#/notes/' + encodeURIComponent(A.path) + '">Owlbridge activity log</a>. The newest 20 are shown.</p>';
    // Team on Owlbridge: the newest run log line that names Owlbridge, its department or a lead id.
    var runs = (state.runs || []).filter(function (r) { return /dept=[^;\]]*owlbridge|\bowlbridge\b|\bL-[a-z0-9]/i.test((r.job || "") + " " + (r.note || "")); });
    var r = runs[0];
    $("leadsTeamLine").innerHTML = '<span class="k">Team on Owlbridge</span> ' + (r
      ? esc(r.when) + ", " + esc(r.job) + " (" + esc(r.result) + "): " + esc(String(r.note || "").replace(/^\[[^\]]*\]\s*/, "").slice(0, 200)) + (String(r.note || "").length > 200 ? "..." : "") + ' <a href="#/runs">Runs</a>'
      : "no run log line names Owlbridge yet.");
  }

  // ---------- list: saved views, columns, sort, bulk ----------
  function leadViews() {
    var today = state.today.ymd, week = ymdAdd(today, 7);
    return [
      { id: "all", label: "All", f: function () { return true; } },
      { id: "a", label: "Tier A", f: function (l) { return l.tier === "A"; } },
      { id: "week", label: "Due this week", f: function (l) { return leadInPlay(l) && YMD_RE.test(l.nextDate) && l.nextDate <= week; }, why: "In play with a next date in the next 7 days, overdue included" },
      { id: "drafted", label: "Drafted, not sent", f: function (l) { return l.status === "drafted"; } },
      { id: "research", label: "Not yet drafted", f: function (l) { return l.status === "researched"; } },
      { id: "replied", label: "Replied", f: function (l) { return ["replied", "call booked", "proposal"].indexOf(l.status) > -1; }, why: "At replied, call booked or proposal" },
      { id: "optedout", label: "Opted out", f: function (l) { return l.status === "opted out"; } }
    ];
  }
  var TIER_ORDER = { A: 0, B: 1, C: 2, seed: 3 };
  function leadSortVal(l, k) {
    if (k === "score") return /^\d+$/.test(l.score) ? +l.score : -1;
    if (k === "tier") return l.tier in TIER_ORDER ? TIER_ORDER[l.tier] : 9;
    if (k === "status") { var i = state.leads.statuses.indexOf(l.status); return i < 0 ? 99 : i; }
    if (k === "lastTouch") return l.touchDays == null ? 99999 : l.touchDays;
    if (k === "nextDate") return l.nextDate || "9999";
    return String(l[k] || "").toLowerCase();
  }
  function leadSorter(a, b) {
    var x = leadSortVal(a, leadSort.k), y = leadSortVal(b, leadSort.k);
    var c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return c * leadSort.d || a.company.localeCompare(b.company);
  }
  function leadCell(l, k) {
    if (k === "company") return '<a class="lead-open" href="#/leads/record/' + encodeURIComponent(l.id) + '">' + esc(l.company) + "</a>";
    if (k === "tier") return leadTierChip(l.tier);
    if (k === "score") return leadScoreBar(l.score);
    if (k === "contact") return l.contact ? esc(l.contact.split(",")[0]) : '<span class="faint">none</span>';
    if (k === "email") return leadEmailOk(l.email) ? '<span class="mono">' + esc(l.email) + "</span>" : '<span class="faint">' + esc(l.email || "none") + "</span>";
    if (k === "status") return leadStatusChip(l.status);
    if (k === "lastTouch") return leadTouch(l);
    if (k === "nextStep") return l.nextStep ? esc(l.nextStep) : '<span class="faint">not set</span>';
    if (k === "nextDate") return l.nextDate ? '<span class="mono' + (l.due ? " over" : "") + '">' + (l.due ? '<span aria-hidden="true">&#9650; </span>' : "") + esc(leadDateLabel(l.nextDate)) + (l.due ? '<span class="sr-only">, due</span>' : "") + "</span>" : '<span class="faint">none</span>';
    return esc(l[k] || "");
  }
  function leadListRows() {
    var views = leadViews(), cur = views.find(function (v) { return v.id === leadView; }) || views[0];
    return { views: views, cur: cur, base: leadsAll().filter(leadMatches), rows: leadsAll().filter(leadMatches).filter(cur.f).sort(leadSorter) };
  }
  function renderLeadList() {
    var d = leadListRows(), rows = d.rows;
    $("leadViews").innerHTML = d.views.map(function (v) {
      return '<button type="button" role="tab" aria-selected="' + (v.id === d.cur.id) + '" data-v="' + v.id + '"' + (v.why ? ' title="' + esc(v.why) + '"' : "") + ">" + esc(v.label) + ' <span class="count mono">' + d.base.filter(v.f).length + "</span></button>";
    }).join("");
    $("leadViews").querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () { leadView = b.dataset.v; lsSet(LEAD_VIEW_KEY, leadView); leadSel = {}; renderLeadList(); });
    });
    var ids = {}; rows.forEach(function (l) { ids[l.id] = true; });
    Object.keys(leadSel).forEach(function (id) { if (!ids[id]) delete leadSel[id]; });
    var cols = LEAD_COLS.filter(function (c) { return c.fixed || leadCols.indexOf(c.k) > -1; });
    var all = rows.length && rows.every(function (l) { return leadSel[l.id]; });
    var head = '<thead><tr><th class="lead-th-sel"><input type="checkbox" id="leadSelAll" aria-label="Select every row shown"' + (all ? " checked" : "") + "></th>"
      + cols.map(function (c) {
        var on = leadSort.k === c.k;
        return '<th scope="col" aria-sort="' + (on ? (leadSort.d > 0 ? "ascending" : "descending") : "none") + '"><button type="button" class="lead-sort" data-k="' + c.k + '">' + esc(c.label) + (on ? '<span aria-hidden="true">' + (leadSort.d > 0 ? " &#8593;" : " &#8595;") + "</span>" : "") + "</button></th>";
      }).join("") + "</tr></thead>";
    var body = "<tbody>" + (rows.length ? rows.map(function (l) {
      var cls = (leadSel[l.id] ? "sel" : "") + (leadCursorId === l.id ? " cursor" : "");
      return '<tr data-id="' + esc(l.id) + '" tabindex="-1"' + (cls.trim() ? ' class="' + cls.trim() + '"' : "") + '><td class="lead-td-sel"><input type="checkbox" data-sel="' + esc(l.id) + '" aria-label="Select ' + esc(l.company) + '"' + (leadSel[l.id] ? " checked" : "") + "></td>"
        + cols.map(function (c) { return '<td class="lead-td-' + c.k + '" data-label="' + esc(c.label) + '">' + leadCell(l, c.k) + "</td>"; }).join("") + "</tr>";
    }).join("") : '<tr><td colspan="' + (cols.length + 1) + '" class="empty">No leads in this view' + (leadFiltered() ? " with these filters" : "") + ".</td></tr>") + "</tbody>";
    var byStatus = state.leads.statuses.map(function (s) { return [s, rows.filter(function (l) { return l.status === s; }).length]; }).filter(function (x) { return x[1]; });
    var foot = '<tfoot><tr><td colspan="' + (cols.length + 1) + '">' + rows.length + " lead" + (rows.length === 1 ? "" : "s") + (byStatus.length ? " · " + byStatus.map(function (x) { return x[1] + " " + esc(x[0]); }).join(" · ") : "") + "</td></tr></tfoot>";
    $("leadTable").innerHTML = head + body + foot;
    $("leadTable").querySelectorAll(".lead-sort").forEach(function (b) {
      b.addEventListener("click", function () {
        var k = b.dataset.k;
        leadSort = { k: k, d: leadSort.k === k ? -leadSort.d : (k === "score" ? -1 : 1) };
        lsSet(LEAD_SORT_KEY, leadSort); renderLeadList();
      });
    });
    $("leadTable").querySelectorAll("[data-sel]").forEach(function (c) {
      c.addEventListener("change", function () {
        if (c.checked) leadSel[c.dataset.sel] = true; else delete leadSel[c.dataset.sel];
        c.closest("tr").classList.toggle("sel", c.checked);
        var boxes = $("leadTable").querySelectorAll("[data-sel]");
        $("leadSelAll").checked = boxes.length > 0 && Array.prototype.every.call(boxes, function (x) { return x.checked; });
        renderLeadBulk();
      });
    });
    $("leadSelAll").addEventListener("change", function () {
      var on = $("leadSelAll").checked;
      $("leadTable").querySelectorAll("[data-sel]").forEach(function (c) { c.checked = on; c.closest("tr").classList.toggle("sel", on); if (on) leadSel[c.dataset.sel] = true; else delete leadSel[c.dataset.sel]; });
      renderLeadBulk();
    });
    renderLeadBulk();
    renderLeadColPick();
  }
  // The bulk bar: built once while rows are ticked, so a value typed into it survives ticking more.
  function renderLeadBulk() {
    var bar = $("leadBulk"), n = Object.keys(leadSel).length;
    if (!n) { bar.hidden = true; bar.innerHTML = ""; return; }
    if (bar.hidden || !bar.innerHTML) {
      var statuses = state.leads.statuses.filter(function (s) { return s !== "opted out"; });
      bar.innerHTML = '<b class="lead-bulk-n"></b>'
        + '<label>Set status <select id="leadBulkStatus">' + statuses.map(function (s) { return "<option>" + esc(s) + "</option>"; }).join("") + '</select></label><button type="button" data-bulk="status">Apply</button>'
        + '<label>Next date <input type="date" id="leadBulkDate"></label><button type="button" data-bulk="nextDate">Apply</button>'
        + '<label class="lead-bulk-step">Next step <input type="text" id="leadBulkStep" placeholder="Next step"></label><button type="button" data-bulk="nextStep">Apply</button>'
        + '<button type="button" class="ghost small" id="leadBulkClear">Clear</button>'
        + '<span class="why">One activity line per lead. Opt-outs are one at a time, from the record, and a lead already opted out keeps that status. Nothing is sent.</span>';
      bar.querySelectorAll("[data-bulk]").forEach(function (b) { b.addEventListener("click", function () { leadBulkApply(b.dataset.bulk, b); }); });
      $("leadBulkClear").addEventListener("click", function () { leadSel = {}; renderLeadList(); });
      bar.hidden = false;
    }
    bar.querySelector(".lead-bulk-n").textContent = n + " selected";
  }
  async function leadBulkApply(op, btn) {
    var ids = Object.keys(leadSel);
    var value = op === "status" ? $("leadBulkStatus").value : op === "nextDate" ? $("leadBulkDate").value : $("leadBulkStep").value.trim();
    if (op !== "status" && !value && !confirm("Clear the " + (op === "nextDate" ? "next date" : "next step") + " on " + ids.length + " lead" + (ids.length === 1 ? "" : "s") + "?")) return;
    if (op === "status" && !confirm("Move " + ids.length + " lead" + (ids.length === 1 ? "" : "s") + " to " + value + "?\n\nThis writes to Owlbridge pipeline and adds one line per lead to Owlbridge activity log.")) return;
    btn.disabled = true;
    try {
      var r = await api("lead", { method: "POST", body: { action: "bulk", ids: ids, op: op, value: value } });
      var n = (r.changed || []).length;
      var keptWords = r.kept ? " Left as opted out: " + r.kept.map(function (id) { var x = leadById(id); return x ? x.company : id; }).join(", ") + "." : "";
      toast(r.unchanged ? "Nothing changed." + keptWords : n + " lead" + (n === 1 ? "" : "s") + " updated" + (r.logged ? ", " + r.logged + " activity line" + (r.logged === 1 ? "" : "s") + " logged" : "") + "." + (r.missing ? " Not found: " + r.missing.join(", ") + "." : "") + keptWords + (r.activityError ? " The activity lines did not save: " + r.activityError : ""), !!r.activityError);
      leadSel = {};
      fire({ count: 14, region: "cortex", boost: 0.2 });
      await load(false);
    } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
  }
  function renderLeadColPick() {
    var box = $("leadColPick");
    box.innerHTML = '<div class="lead-colpick-head">Columns, remembered on this device</div>' + LEAD_COLS.filter(function (c) { return !c.fixed; }).map(function (c) {
      return '<label class="lead-colpick-row"><input type="checkbox" data-col="' + c.k + '"' + (leadCols.indexOf(c.k) > -1 ? " checked" : "") + "> " + esc(c.label) + "</label>";
    }).join("");
    box.querySelectorAll("[data-col]").forEach(function (c) {
      c.addEventListener("change", function () {
        leadCols = LEAD_COLS.filter(function (x) { return !x.fixed && (x.k === c.dataset.col ? c.checked : leadCols.indexOf(x.k) > -1); }).map(function (x) { return x.k; });
        lsSet(LEAD_COLS_KEY, leadCols); renderLeadList();
        var again = $("leadColPick").querySelector('[data-col="' + c.dataset.col + '"]'); if (again) again.focus();
      });
    });
  }
  if ($("leadColPickBtn")) {
    $("leadColPickBtn").addEventListener("click", function () {
      var open = $("leadColPick").hidden; $("leadColPick").hidden = !open; $("leadColPickBtn").setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("click", function (e) {
      if ($("leadColPick").hidden || e.target.closest("#leadColPickWrap")) return;
      $("leadColPick").hidden = true; $("leadColPickBtn").setAttribute("aria-expanded", "false");
    });
  }

  // ---------- board: count per column, stale colour, the score as a ring ----------
  function leadStatusSelect(l, cls) {
    return '<select class="' + cls + '" aria-label="Move ' + esc(l.company) + ' to another status">'
      + state.leads.statuses.map(function (s) { return "<option" + (s === l.status ? " selected" : "") + ">" + esc(s) + "</option>"; }).join("")
      + (state.leads.statuses.indexOf(l.status) < 0 ? '<option selected value="' + esc(l.status) + '">' + esc(l.status || "no status") + "</option>" : "")
      + "</select>";
  }
  function renderLeadBoard() {
    var host = $("leadsBoard"), shown = leadsAll().filter(leadMatches);
    var cols = state.leads.statuses.slice();
    shown.forEach(function (l) { if (cols.indexOf(l.status) < 0) cols.push(l.status); }); // a status the note has that the list does not
    if (leadFilters.status) cols = cols.filter(function (s) { return s === leadFilters.status; });
    host.innerHTML = cols.map(function (s) {
      var items = shown.filter(function (l) { return l.status === s; })
        .sort(function (a, b) { return (a.nextDate || "9999") < (b.nextDate || "9999") ? -1 : (a.nextDate || "9999") > (b.nextDate || "9999") ? 1 : (+b.score || 0) - (+a.score || 0); });
      var stale = items.filter(function (l) { return l.stale; }).length;
      return '<section class="lead-col' + (items.length ? "" : " empty-col") + '" data-status="' + esc(s) + '" aria-label="' + esc(s) + ", " + items.length + ' leads">'
        + '<h3><span>' + esc(cap(s || "no status")) + '</span><span class="count mono" title="' + items.length + " lead" + (items.length === 1 ? "" : "s") + (stale ? ", " + stale + " with no touch for over 7 days" : "") + '">' + items.length + (stale ? ' <span class="stale-amber">(' + stale + " stale)</span>" : "") + "</span></h3>"
        + '<div class="lead-col-cards">' + (items.length ? items.map(function (l) {
          return '<article class="lead-card' + (l.due ? " due" : "") + (l.stale ? " stale-" + l.stale : "") + (leadCursorId === l.id ? " cursor" : "") + '" draggable="true" tabindex="0" data-id="' + esc(l.id) + '">'
            + '<div class="lead-card-top"><div class="lead-card-names"><div class="lead-co">' + esc(l.company) + "</div>"
            + (l.contact ? '<div class="lead-contact">' + esc(l.contact) + "</div>" : "") + "</div>" + leadScoreRing(l.score) + "</div>"
            + '<div class="lead-card-foot">' + (l.tier ? leadTierChip(l.tier) : "") + leadTouch(l)
            + (l.nextDate ? '<span class="lead-next mono' + (l.due ? " over" : "") + '" title="Next date' + (l.due ? ", due" : "") + '">' + esc(leadDateLabel(l.nextDate)) + "</span>" : "") + "</div>"
            + '<div class="lead-card-acts">' + leadStatusSelect(l, "lead-move") + '<button type="button" class="ghost small lead-quick" title="Quick edit in a side panel">Quick edit</button></div></article>';
        }).join("") : '<p class="empty">None' + (leadFiltered() ? " in this filter" : "") + ".</p>") + "</div></section>";
    }).join("");
    host.querySelectorAll(".lead-card").forEach(function (card) {
      var id = card.dataset.id;
      card.addEventListener("click", function (e) { if (e.target.closest("select, button")) return; leadOpenRecord(id); });
      card.addEventListener("keydown", function (e) { if (e.target === card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); leadOpenRecord(id); } });
      card.addEventListener("dragstart", function (e) { leadDragId = id; card.classList.add("dragging"); try { e.dataTransfer.setData("text/plain", id); e.dataTransfer.effectAllowed = "move"; } catch (err) {} });
      card.addEventListener("dragend", function () { leadDragId = null; card.classList.remove("dragging"); host.querySelectorAll(".lead-col.over").forEach(function (c) { c.classList.remove("over"); }); });
      var sel = card.querySelector(".lead-move");
      sel.addEventListener("click", function (e) { e.stopPropagation(); });
      sel.addEventListener("change", function () { var l = leadById(id); if (l) moveLead(l, sel.value, function () { sel.value = l.status; }); });
      card.querySelector(".lead-quick").addEventListener("click", function (e) { e.stopPropagation(); openLeadDetail(id); });
    });
    host.querySelectorAll(".lead-col").forEach(function (col) {
      col.addEventListener("dragover", function (e) { if (!leadDragId) return; e.preventDefault(); col.classList.add("over"); });
      col.addEventListener("dragleave", function (e) { if (!col.contains(e.relatedTarget)) col.classList.remove("over"); });
      col.addEventListener("drop", function (e) {
        e.preventDefault(); col.classList.remove("over");
        var l = leadById(leadDragId || (e.dataTransfer && e.dataTransfer.getData("text/plain")));
        leadDragId = null;
        if (l) moveLead(l, col.dataset.status);
      });
    });
  }

  // ---------- record: header, stage path, fields, timeline, related ----------
  function leadResearchHtml(l) {
    var research = (l.research || []).map(function (r) {
      var name = r.path.split("/").pop().replace(/\.md$/, "");
      return '<div class="lead-research"><div class="meta"><span>' + esc(r.heading || "Table") + ' in <a href="#/notes/' + encodeURIComponent(r.path) + '">' + esc(name) + "</a></span></div>"
        + '<dl class="lead-fields">' + r.fields.map(function (f) { return "<dt>" + esc(f[0]) + "</dt><dd>" + richText(f[1]) + "</dd>"; }).join("") + "</dl></div>";
    }).join("");
    var researchNames = (state.leads.researchPaths || []).map(function (p) { return p.split("/").pop().replace(/\.md$/, ""); }).join(", ");
    return research || '<p class="empty">No row for ' + esc(l.company) + " in " + esc(researchNames || "a lead list note") + ".</p>";
  }
  function leadSuppressed(l) {
    var n = function (t) { return String(t || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim(); };
    return l.status === "opted out" || (state.leads.suppressed || []).some(function (s) { var a = n(s.company), b = n(l.company); return a && b && (a === b || a.indexOf(b + " ") === 0 || b.indexOf(a + " ") === 0); });
  }
  function leadMailLinks(l) {
    var thread = leadGmailThread(l);
    var domain = leadEmailOk(l.email) ? l.email.split("@")[1].toLowerCase() : "";
    return [
      thread ? '<a href="' + esc(thread) + '" target="_blank" rel="noopener">Open the Gmail thread</a>' : "",
      domain ? '<a href="https://mail.google.com/mail/u/0/#search/' + encodeURIComponent(domain) + '" target="_blank" rel="noopener" title="Searches your mailbox for the company domain">Search Gmail for ' + esc(domain) + "</a>"
        : '<a href="https://mail.google.com/mail/u/0/#search/' + encodeURIComponent('"' + l.company + '"') + '" target="_blank" rel="noopener" title="No published address in the row, so this searches for the company name">Search Gmail for ' + esc(l.company) + "</a>"
    ].filter(Boolean);
  }
  function renderLeadRecord() {
    var host = $("leadsRecord"), l = leadById(leadRecId);
    if (!l) {
      host.dataset.id = "";
      host.innerHTML = '<p class="empty">No lead with the id ' + esc(leadRecId) + ' in Owlbridge pipeline. It may have been renamed or removed in the vault. <a href="#/leads/list">Back to all leads</a></p>';
      return;
    }
    // A refresh while a note is half written, or a field half edited, keeps what was typed.
    var same = host.dataset.id === l.id;
    var keepText = same && host.querySelector(".lead-comp-text") ? host.querySelector(".lead-comp-text").value : "";
    var keepFields = {};
    if (same && leadFieldsDirty) host.querySelectorAll("[data-fk]").forEach(function (i) { keepFields[i.dataset.fk] = i.value; });
    if (!same) { leadFieldsDirty = false; leadKind = "note"; }
    host.dataset.id = l.id;
    var stages = leadStages(), idx = stages.indexOf(l.status), closedList = state.leads.closed || [];
    var email = leadEmailOk(l.email) ? l.email : "";
    var head = '<div class="lead-rec-crumb"><a href="#/leads/list">All leads</a> <span class="faint">/ ' + esc(l.company) + "</span></div>"
      + '<div class="lead-rhead">' + leadTierChip(l.tier) + '<div class="lead-rhead-t"><h2 class="lead-rec-title">' + esc(l.company) + "</h2>"
      + '<div class="lead-rec-sub">' + [l.segment, l.contact].filter(Boolean).map(esc).join(" · ")
      + (email ? ' · <span class="mono">' + esc(email) + '</span> <button type="button" class="ghost small lead-copy" data-copy="' + esc(email) + '" aria-label="Copy ' + esc(email) + '">Copy</button>' : l.email ? ' · <span class="faint">' + esc(l.email) + "</span>" : "")
      + "</div></div>" + '<div class="lead-rhead-score">' + leadScoreBar(l.score) + "</div></div>";
    var path = '<div class="lead-pathrow"><ol class="lead-path" aria-label="Stage">' + stages.map(function (s, i) {
      return '<li><button type="button" data-stage="' + esc(s) + '" class="' + (idx > -1 && i < idx ? "done" : "") + '"' + (i === idx ? ' aria-current="step"' : "") + ' title="' + (i === idx ? "Current stage" : "Move to " + esc(s)) + '">'
        + (idx > -1 && i < idx ? '<span aria-hidden="true">&#10003; </span>' : "") + esc(cap(s)) + "</button></li>";
    }).join("") + "</ol>"
      + (idx > -1 && idx < stages.length - 1 ? '<button type="button" class="primary lead-mark" data-stage-next="' + esc(stages[idx + 1]) + '">Mark ' + esc(stages[idx + 1]) + "</button>" : "")
      + '<select class="lead-close-sel" aria-label="Close this lead"><option value="">Close as...</option>' + closedList.map(function (s) { return "<option" + (s === l.status ? " disabled" : "") + ">" + esc(s) + "</option>"; }).join("") + "</select></div>"
      + (idx < 0 ? '<p class="lead-closed-note">' + leadStatusChip(l.status) + " This lead is closed. Pick a stage on the path to reopen it.</p>" : "");
    // Fields: every editable cell, one save.
    var tiers = ["A", "B", "C", "seed"]; if (l.tier && tiers.indexOf(l.tier) < 0) tiers.push(l.tier);
    var inp = function (k, label, v, type) {
      return '<label class="lead-f"><span>' + esc(label) + "</span>" + (k === "tier"
        ? '<select data-fk="tier"><option value="">none</option>' + tiers.map(function (t) { return "<option" + (t === v ? " selected" : "") + ">" + esc(t) + "</option>"; }).join("") + "</select>"
        : '<input type="' + (type || "text") + '" data-fk="' + k + '" value="' + esc(v) + '"' + (k === "score" ? ' inputmode="numeric" placeholder="0 to 100"' : "") + ">") + "</label>";
    };
    var extra = Object.keys(l.extra || {}).map(function (k) { return [cap(k), l.extra[k]]; });
    var fields = '<form class="panel lead-fields-card"><h2>Fields</h2>'
      + inp("contact", "Contact", l.contact) + inp("email", "Email", l.email) + inp("segment", "Segment", l.segment) + inp("tier", "Tier", l.tier)
      + inp("score", "Score", l.score) + inp("source", "Source", l.source) + inp("nextStep", "Next step", l.nextStep) + inp("nextDate", "Next date", l.nextDate, "date")
      + '<dl class="lead-fields lead-fields-ro">' + [["Id", l.id], ["Status", l.status], ["Last touch", l.lastTouch]].concat(extra).map(function (f) { return "<dt>" + esc(f[0]) + "</dt><dd>" + (f[1] ? esc(f[1]) : '<span class="faint">blank</span>') + "</dd>"; }).join("") + "</dl>"
      + '<div class="lead-fields-save"><button type="submit" class="primary">Save</button><span class="why">One save writes the row and one activity line.</span></div></form>';
    // Timeline: Focus, the composer, then history by day.
    var over = l.due && ymdDays(l.nextDate, state.today.ymd) > 0;
    var focus = '<div class="lead-focus' + (l.due ? " due" : "") + '"><span class="k">Focus: next step' + (l.due ? (over ? ", overdue" : ", due today") : "") + "</span><b>" + esc(l.nextStep || "No next step set") + "</b>"
      + '<span class="lead-focus-d">' + (l.nextDate ? (l.due ? esc(leadDueWords(l)) + ", " + esc(leadDateLabel(l.nextDate)) : "Due " + esc(leadDateLabel(l.nextDate))) : "No date") + "</span></div>";
    var kinds = state.leads.logTypes || ["note", "call", "email", "meeting"];
    var composer = '<form class="lead-composer"><div class="lead-seg" role="group" aria-label="Activity type">' + kinds.map(function (k) { return '<button type="button" data-kind="' + k + '" aria-pressed="' + (leadKind === k) + '">' + esc(cap(k)) + "</button>"; }).join("") + "</div>"
      + '<label class="sr-only" for="leadCompText">Log a ' + esc(leadKind) + '</label><textarea id="leadCompText" class="lead-comp-text" rows="2" placeholder="Log a ' + esc(leadKind) + (leadKind === "email" ? ": start with Email 1, Email 2 or Email 3 to count it in the sequence" : "") + '"></textarea>'
      + '<div class="lead-comp-row"><button type="submit" class="primary">Log ' + esc(leadKind) + '</button><span class="why">Adds one line to Owlbridge activity log and sets last touch to today. Nothing is sent.</span></div></form>';
    var hist = (l.history || []);
    var history = '<h3 class="lead-hist-h">History <span class="mono faint">' + (l.activityCount || 0) + " line" + (l.activityCount === 1 ? "" : "s") + "</span></h3>"
      + (hist.length ? '<div class="lead-tl">' + hist.map(function (g) {
        return '<div class="lead-day mono">' + esc(g.day ? (g.day === state.today.ymd ? "Today" : leadDateLabel(g.day) + " " + g.day.slice(0, 4)) : "Undated") + "</div>"
          + g.items.map(function (it) {
            return '<div class="lead-te">' + leadTypeIcon(it.type) + "<div>" + esc(it.summary)
              + '<div class="lead-fe-m mono">' + [it.time, it.by || "unsigned", it.type + (it.count > 1 ? ", " + it.count + " changes in one save" : "")].filter(Boolean).map(esc).join(" · ") + "</div></div></div>";
          }).join("");
      }).join("") + "</div>" : '<p class="empty">No activity for this lead yet. A status change, a next step or a logged touch here writes the first line.</p>');
    var timeline = '<section class="panel lead-timeline">' + focus + composer + history + "</section>";
    // Related: research, the sequence position, mail, the suppression flag.
    var seq = l.sequence || { words: "" };
    var related = '<section class="panel lead-related"><h2>Research</h2>' + leadResearchHtml(l)
      + '<h2>Sequence</h2><p class="lead-rel-p">' + esc(seq.words) + '</p><p class="why-line">Email 2 on day 4, email 3 on day 10. Steps are counted from email lines in Owlbridge activity log.</p>'
      + '<h2>Mail</h2><p class="lead-links">' + leadMailLinks(l).join(" ") + "</p>"
      + (leadSuppressed(l) ? '<p class="lead-suppressed"><span aria-hidden="true">&#9888; </span>On the suppression list in <a href="#/notes/' + encodeURIComponent(state.leads.stationPath) + '">Owlbridge lead gen station</a>. Never contacted again.</p>' : "")
      + '<h2>In the vault</h2><p class="lead-links"><a href="#/notes/' + encodeURIComponent(state.leads.path) + '">Owlbridge pipeline</a> <a href="#/notes/' + encodeURIComponent((state.leads.activity || {}).path || "") + '">Owlbridge activity log</a></p></section>';
    host.innerHTML = head + path + '<div class="lead-r3">' + fields + timeline + related + "</div>";
    // restore what was being typed
    if (keepText) host.querySelector(".lead-comp-text").value = keepText;
    Object.keys(keepFields).forEach(function (k) { var i = host.querySelector('[data-fk="' + k + '"]'); if (i) i.value = keepFields[k]; });
    // wiring
    var cp = host.querySelector(".lead-copy");
    if (cp) cp.addEventListener("click", function () {
      var t = cp.dataset.copy;
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { toast("Copied " + t + "."); }, function () { toast("Could not copy. The address is " + t + ".", true); });
    });
    host.querySelectorAll(".lead-path [data-stage]").forEach(function (b) {
      b.addEventListener("click", function () {
        var s = b.dataset.stage; if (s === l.status) return;
        if (!confirm("Move " + l.company + " from " + l.status + " to " + s + "?\n\nThis writes to Owlbridge pipeline and adds one line to Owlbridge activity log.")) return;
        moveLead(l, s);
      });
    });
    var mk = host.querySelector(".lead-mark"); if (mk) mk.addEventListener("click", function () { moveLead(l, mk.dataset.stageNext); });
    var cs = host.querySelector(".lead-close-sel");
    cs.addEventListener("change", function () {
      var s = cs.value; if (!s) return;
      if (s !== "opted out" && !confirm("Close " + l.company + " as " + s + "?")) { cs.value = ""; return; }
      moveLead(l, s, function () { cs.value = ""; });
    });
    var ff = host.querySelector(".lead-fields-card");
    ff.addEventListener("input", function () { leadFieldsDirty = true; });
    ff.addEventListener("submit", async function (e) {
      e.preventDefault();
      var body = { action: "fields", id: l.id }, any = false;
      ff.querySelectorAll("[data-fk]").forEach(function (i) { var k = i.dataset.fk, v = i.value.trim(); if (v !== String(l[k] || "")) { body[k] = v; any = true; } });
      if (!any) { toast("Nothing changed."); return; }
      var sb = ff.querySelector("button[type=submit]"); sb.disabled = true;
      try {
        var r = await api("lead", { method: "POST", body: body });
        leadFieldsDirty = false;
        toast(r.unchanged ? "Nothing changed." : "Saved to Owlbridge pipeline" + (r.logged ? ", and logged" : "") + "." + (r.activityError ? " The activity line did not save: " + r.activityError : ""), !!r.activityError);
        await load(false);
      } catch (err) { toast(err.message, true); } finally { sb.disabled = false; }
    });
    host.querySelectorAll(".lead-seg [data-kind]").forEach(function (b) {
      b.addEventListener("click", function () { leadKind = b.dataset.kind; renderLeadRecord(); var t = $("leadCompText"); if (t) t.focus(); });
    });
    var comp = host.querySelector(".lead-composer");
    comp.addEventListener("submit", async function (e) {
      e.preventDefault();
      var ta = comp.querySelector(".lead-comp-text"), text = ta.value.trim();
      if (!text) { toast("Write what happened first.", true); ta.focus(); return; }
      var sb = comp.querySelector("button[type=submit]"); sb.disabled = true;
      try {
        await api("lead", { method: "POST", body: { action: "log", id: l.id, type: leadKind, summary: text } });
        ta.value = "";
        toast("Logged to Owlbridge activity log.");
        fire({ count: 10, region: "cortex", boost: 0.15 });
        await load(false);
      } catch (err) { toast(err.message, true); } finally { sb.disabled = false; }
    });
  }

  // ---------- the area and its sub pages ----------
  var LEAD_SUBS = ["home", "list", "board", "sequence", "reports", "record"];
  function leadsRoute(parts) {
    var sub = parts[0] || "home";
    if (LEAD_SUBS.indexOf(sub) < 0) sub = "home";
    leadSub = sub;
    leadRecId = sub === "record" ? decodeURIComponent(parts.slice(1).join("/")) : "";
    if (sub !== "record" && $("leadsRecord")) $("leadsRecord").dataset.id = "";
    if (state) renderLeads();
  }
  function renderLeads() {
    if (!state || !$("view-leads")) return;
    var L = state.leads;
    setBadge("badgeLeads", L ? L.due : 0); setBadge("badgeLeadsTab", L ? L.due : 0);
    if (!L) return;
    $("leadsNoteLink").href = "#/notes/" + encodeURIComponent(L.path);
    var missing = !L.exists ? "Owlbridge pipeline is not in the vault. The Leads area reads " + L.path + "; nothing shows until that note exists."
      : !L.tableFound ? "Owlbridge pipeline has no table under a Leads heading, so there is nothing to show. The Leads area reads the first table under ## Leads in " + L.path + "."
      : "";
    $("leadsMissing").hidden = !missing; $("leadsMissing").textContent = missing;
    $("leadsBody").hidden = !!missing;
    if (missing) return;
    $("leadsTabDue").textContent = L.due ? String(L.due) : "";
    $("leadsTabAll").textContent = String(leadsAll().length);
    document.querySelectorAll(".lead-tabs a").forEach(function (a) {
      var on = a.dataset.lsub === leadSub || (leadSub === "record" && a.dataset.lsub === "list");
      a.classList.toggle("active", on); if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    document.querySelectorAll(".lead-page").forEach(function (p) { p.hidden = p.dataset.lsub !== leadSub; });
    $("leadsFilterBar").hidden = leadSub !== "list" && leadSub !== "board";
    $("leadColPickWrap").hidden = leadSub !== "list";
    if (leadSub === "home") { renderLeadStrip(); renderLeadToday(); renderLeadFunnel(); renderLeadFeed(); }
    if (leadSub === "list" || leadSub === "board") renderLeadFilters();
    if (leadSub === "list") renderLeadList();
    if (leadSub === "board") renderLeadBoard();
    if (leadSub === "sequence") renderLeadSequence();
    if (leadSub === "reports") renderLeadReports();
    if (leadSub === "record") renderLeadRecord();
    if (leadOpenId && !$("leadOverlay").hidden) renderLeadDetail();
  }
  if ($("leadSearchBtn")) $("leadSearchBtn").addEventListener("click", function () { openPalette(); });
  // ---------- list and board keys: J and K move, Enter opens the record, S changes the status ----------
  // Only on the list or the board, with no panel open, and never while typing (the document
  // listener returns before this for a text field). The cursor is kept by lead id, so a re-render
  // after a save keeps it on the same lead. On the board the order is column by column.
  function leadNavItems() {
    var sel = leadSub === "list" ? "#leadTable tbody tr[data-id]" : leadSub === "board" ? "#leadsBoard .lead-card[data-id]" : "";
    return sel ? Array.prototype.slice.call(document.querySelectorAll(sel)) : [];
  }
  function leadCursorTo(el) {
    leadNavItems().forEach(function (x) { x.classList.toggle("cursor", x === el); });
    leadCursorId = el.dataset.id;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest" });
  }
  function leadListShortcut(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return false;
    if (location.hash.replace(/^#\/?/, "").split("/")[0] !== "leads") return false;
    if (leadSub !== "list" && leadSub !== "board") return false;
    if (($("leadOverlay") && !$("leadOverlay").hidden) || ($("detailOverlay") && !$("detailOverlay").hidden)) return false;
    var k = e.key.toLowerCase();
    if (k !== "j" && k !== "k" && k !== "enter" && k !== "s") return false;
    var items = leadNavItems();
    if (!items.length) return false;
    var idx = items.findIndex(function (x) { return x.dataset.id === leadCursorId; });
    if (k === "j" || k === "k") {
      var next = idx < 0 ? (k === "j" ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, idx + (k === "j" ? 1 : -1)));
      leadCursorTo(items[next]);
      return true;
    }
    if (idx < 0) return false;
    var cur = items[idx];
    if (k === "enter") {
      // Enter on a link, a button or a box keeps its own meaning; only the row itself (or nothing
      // in particular) opens the record.
      var a = document.activeElement;
      if (a && a !== cur && a !== document.body && a.closest && a.closest("a, button, input, select, textarea, label")) return false;
      leadOpenRecord(cur.dataset.id);
      return true;
    }
    // S: on the list, tick the row and put focus on the bulk bar's status (which asks to confirm
    // before it writes); on the board, focus the card's own status menu.
    if (leadSub === "list") {
      if (!leadSel[cur.dataset.id]) { leadSel[cur.dataset.id] = true; renderLeadList(); }
      var bs = $("leadBulkStatus"); if (bs) bs.focus();
      return true;
    }
    var ms = cur.querySelector("select"); if (ms) ms.focus();
    return true;
  }

  // ---------- rows behind a figure: every count on Sequence and Reports opens the leads it counts ----------
  function leadRowsBox(box, title, ids, onClose) {
    if (!title) { box.hidden = true; box.innerHTML = ""; return; }
    var rows = ids.map(function (id) { return leadById(id) || { id: id, company: id, status: "" }; });
    box.hidden = false;
    box.innerHTML = '<div class="lead-rows-head"><b>' + esc(title) + '</b> <span class="mono faint">' + rows.length + '</span><button type="button" class="ghost small lead-rows-close">Close</button></div>'
      + (rows.length ? '<ul class="lead-mini">' + rows.map(function (l) { return '<li><a href="#/leads/record/' + encodeURIComponent(l.id) + '">' + esc(l.company) + "</a> " + (l.status ? leadStatusChip(l.status) : "") + "</li>"; }).join("") + "</ul>"
        : '<p class="empty">No leads counted here.</p>');
    box.querySelector(".lead-rows-close").addEventListener("click", onClose);
  }

  // ---------- sequence: the three Owlbridge emails, read only ----------
  var leadSeqOpen = "";
  function renderLeadSequence() {
    var S = state.leads.sequence;
    var host = $("leadSeqChain");
    if (!S) { host.innerHTML = '<p class="empty">The sequence is not in this build of the state yet. Refresh.</p>'; return; }
    $("leadSeqNote").href = "#/notes/" + encodeURIComponent(S.path);
    var sets = {};
    var stat = function (key, label, ids, why) {
      sets[key] = { title: label, ids: ids };
      return '<button type="button" class="lead-seq-stat" data-set="' + key + '" aria-pressed="' + (leadSeqOpen === key) + '" title="' + esc(why) + '"><b class="mono">' + ids.length + "</b><span>" + esc(label.replace(/^Email \d, /, "")) + "</span></button>";
    };
    var anySent = S.steps.some(function (st) { return st.sent.length; });
    host.innerHTML = (S.found ? "" : '<p class="empty">Owlbridge outreach drafts has no "## Email 1", "## Email 2" or "## Email 3" heading, so the words cannot be shown here. The counts below still come from the activity log.</p>')
      + S.steps.map(function (st, i) {
        var waitWords = st.waiting.length
          ? st.waiting.length + " waiting: " + st.waiting.map(function (w) { return '<a href="#/leads/record/' + encodeURIComponent(w.id) + '">' + esc(w.company) + "</a>" + (w.due ? ' <span class="mono faint">due ' + esc(leadDateLabel(w.due)) + "</span>" : ""); }).join(", ")
          : "No lead is waiting on this email.";
        return (i ? '<div class="lead-seq-wait mono" aria-label="Wait ' + st.waitDays + ' days">wait ' + st.waitDays + " day" + (st.waitDays === 1 ? "" : "s") + "</div>" : "")
          + '<section class="panel lead-seq-step" aria-label="Email ' + st.step + '">'
          + '<div class="lead-seq-body"><h3>Email ' + st.step + " · day " + st.day + (st.step > 1 ? " · same thread" : "") + "</h3>"
          + (st.subject ? '<p class="lead-seq-subj"><span class="k">Subject</span> ' + esc(st.subject) + "</p>" : "")
          + (st.excerpt ? '<p class="lead-seq-ex">' + esc(st.excerpt) + "</p>" : "")
          + (st.words ? '<details class="lead-seq-words"><summary>The full words</summary><pre>' + esc(st.words) + "</pre></details>" : "")
          + '<p class="lead-seq-waiting">' + waitWords + "</p></div>"
          + '<div class="lead-seq-stats">'
          + stat("s" + st.step, "Email " + st.step + ", sent", st.sent, "Leads with an Email " + st.step + " line in the activity log")
          + stat("r" + st.step, "Email " + st.step + ", replied", st.replied, "Leads whose last logged email is Email " + st.step + " and whose status is replied, call booked, proposal or won")
          + stat("o" + st.step, "Email " + st.step + ", opted out", st.optedOut, "Leads whose last logged email is Email " + st.step + " and whose status is opted out")
          + "</div></section>";
      }).join("")
      + (anySent ? "" : '<p class="why-line">No email line is logged yet, so every sent, replied and opted out count reads 0 because nothing has been logged as sent, not as a result. Log a sent email on a record (type email, summary starting "Email 1") and it counts here.</p>')
      + (S.unlogged.length ? '<p class="why-line">' + S.unlogged.length + " lead" + (S.unlogged.length === 1 ? " is" : "s are") + ' at sent or further with no email line, so no step counts ' + (S.unlogged.length === 1 ? "it" : "them") + '. <button type="button" class="linkish" data-set="unlogged">Show</button></p>' : "");
    sets.unlogged = { title: "At sent or further, no email line logged", ids: S.unlogged };
    var close = function () { leadSeqOpen = ""; renderLeadSequence(); };
    var open = sets[leadSeqOpen];
    leadRowsBox($("leadSeqRows"), open ? open.title : "", open ? open.ids : [], close);
    host.querySelectorAll("[data-set]").forEach(function (b) {
      b.addEventListener("click", function () { leadSeqOpen = leadSeqOpen === b.dataset.set ? "" : b.dataset.set; renderLeadSequence(); if (leadSeqOpen) $("leadSeqRows").scrollIntoView({ block: "nearest" }); });
    });
  }

  // ---------- reports ----------
  var leadRepOpen = "";
  function renderLeadReports() {
    var R = state.leads.reports;
    var host = $("leadReports");
    if (!R) { host.innerHTML = '<p class="empty">Reports are not in this build of the state yet. Refresh.</p>'; return; }
    var sets = {}, n = 0;
    var bars = function (title, groups, label) {
      var max = Math.max.apply(null, groups.map(function (g) { return g.count; }).concat([1]));
      return '<section class="panel lead-rep"><h2>' + esc(title) + '</h2><div class="lead-funnel">' + groups.map(function (g) {
        var key = "g" + (n++); sets[key] = { title: title + ": " + (label ? label(g.key) : g.key), ids: g.ids };
        return '<button type="button" class="lead-fr lead-rep-fr" data-set="' + key + '" aria-pressed="' + (leadRepOpen === key) + '" title="' + g.count + " lead" + (g.count === 1 ? "" : "s") + '. Opens the rows.">'
          + '<span class="lead-fr-k">' + esc(label ? label(g.key) : cap(g.key)) + '</span><span class="lead-bar"><b style="width:' + (g.count / max * 100) + '%"></b></span><span class="lead-fr-n mono">' + g.count + "</span></button>";
      }).join("") + "</div></section>";
    };
    var rr = R.replyRate, md = R.medianReply;
    sets.sent = { title: "Sent or further along", ids: rr.sent }; sets.replied = { title: "Replied or further along", ids: rr.replied }; sets.median = { title: "Leads with a logged sent date and reply date", ids: md.ids };
    var fig = function (key, v, label) { return '<button type="button" class="lead-rep-fig" data-set="' + key + '" aria-pressed="' + (leadRepOpen === key) + '"><b class="mono">' + v + "</b><span>" + esc(label) + "</span></button>"; };
    var response = '<section class="panel lead-rep"><h2>Response</h2><div class="lead-rep-figs">'
      + fig("sent", rr.sent.length, "sent or further") + fig("replied", rr.replied.length, "replied or further")
      + (rr.rate !== null ? fig("replied", rr.rate + "%", "reply rate") : "")
      + (md.days !== null ? fig("median", md.days, "median days, sent to reply") : "") + "</div>"
      + (rr.rate === null ? '<p class="why-line">The reply rate appears once ' + rr.from + " or more are sent; " + rr.sent.length + (rr.sent.length === 1 ? " is" : " are") + " so far.</p>" : '<p class="why-line">Replied or further, divided by sent or further. Lost and opted-out rows are left out.</p>')
      + (md.days === null ? '<p class="why-line">Median days from sent to reply appears once ' + md.from + " leads have both dates in the activity log (an email or a move to sent, then a move to replied or further); " + md.ids.length + (md.ids.length === 1 ? " does" : " do") + " so far.</p>" : "")
      + '<p class="why-line">No pound values: none of the leads carries one yet.</p></section>';
    var touched = bars("Leads touched per week", R.touched.map(function (w) { return { key: w.week, count: w.count, ids: w.ids }; }), function (k) { return "w/c " + leadDateLabel(k); });
    var anyTouch = R.touched.some(function (w) { return w.count; });
    host.innerHTML = bars("By stage", R.byStage) + response
      + bars("By tier", R.byTier, function (k) { return k === "(blank)" ? "No tier" : "Tier " + k; })
      + bars("By segment", R.bySegment) + bars("By source", R.bySource)
      + touched.replace("</section>", '<p class="why-line">' + (anyTouch ? "" : "No touch logged in these weeks yet. ") + "A touch is any activity line except a system one (a lead added, or a field edited).</p></section>");
    var close = function () { leadRepOpen = ""; renderLeadReports(); };
    var open = sets[leadRepOpen];
    leadRowsBox($("leadRepRows"), open ? open.title : "", open ? open.ids : [], close);
    host.querySelectorAll("[data-set]").forEach(function (b) {
      b.addEventListener("click", function () { leadRepOpen = leadRepOpen === b.dataset.set ? "" : b.dataset.set; renderLeadReports(); if (leadRepOpen) $("leadRepRows").scrollIntoView({ block: "nearest" }); });
    });
  }


  // A move: the status, and today as the last touch, and one line in the activity log (server
  // side). Opted out asks first, and the server also adds the company to the suppression list.
  // Shown at once, put back if the write fails.
  async function moveLead(l, status, onCancel) {
    if (!l || !status || status === l.status) { if (onCancel) onCancel(); return; }
    var confirmed = false;
    if (status === "opted out") {
      confirmed = confirm("Opt out " + l.company + "?\n\nThis sets the lead to opted out and adds " + l.company + (l.email && /@/.test(l.email) ? " (" + l.email + ")" : "") + " to the suppression list in Owlbridge lead gen station. A company on that list is never contacted again, and the list is never deleted from.");
      if (!confirmed) { if (onCancel) onCancel(); return; }
    }
    var before = { status: l.status, lastTouch: l.lastTouch, due: l.due };
    l.status = status; l.lastTouch = state.today.ymd; l.due = l.due && (state.leads.closed || []).indexOf(status) < 0;
    renderLeads();
    try {
      var r = await api("lead", { method: "POST", body: { action: "status", id: l.id, status: status, confirm: confirmed || undefined } });
      toast(l.company + " moved to " + status + (r.suppressed ? ", and added to the suppression list" : "") + "." + (r.activityError ? " The activity line did not save: " + r.activityError : ""), !!r.activityError);
      fire({ count: 12, region: "cortex", boost: 0.2 });
      await load(false);
    } catch (err) {
      l.status = before.status; l.lastTouch = before.lastTouch; l.due = before.due;
      renderLeads();
      toast(err.message, true);
    }
  }

  // ---------- lead detail panel (v1): stays for quick edits from the board ----------
  function leadGmailThread(l) {
    var cells = [l.nextStep].concat(Object.keys(l.extra || {}).map(function (k) { return l.extra[k]; }));
    for (var i = 0; i < cells.length; i++) { var m = String(cells[i] || "").match(/https:\/\/mail\.google\.com\/[^\s|)]+/); if (m) return m[0]; }
    return "";
  }
  function renderLeadDetail() {
    var l = leadById(leadOpenId);
    if (!l) { closeLeadDetail(); return; }
    var fields = [["Id", l.id], ["Company", l.company], ["Segment", l.segment], ["Tier", l.tier], ["Score", l.score], ["Contact", l.contact], ["Email", l.email], ["Last touch", l.lastTouch], ["Source", l.source]]
      .concat(Object.keys(l.extra || {}).map(function (k) { return [cap(k), l.extra[k]]; }));
    var links = ['<a href="#/leads/record/' + encodeURIComponent(l.id) + '" class="lead-panel-full">Open the full record</a>']
      .concat(leadMailLinks(l)).concat(['<a href="#/notes/' + encodeURIComponent(state.leads.path) + '">Open Owlbridge pipeline</a>']);
    $("leadBody").innerHTML = '<div class="t">' + esc(l.company) + "</div>"
      + '<div class="row">' + leadStatusChip(l.status) + (l.due ? '<span class="lead-next mono over">Due: ' + esc(leadDueWords(l)) + "</span>" : "") + "</div>"
      + '<div class="detail-section"><h3>Status</h3><div class="row">' + leadStatusSelect(l, "lead-detail-move") + '<span class="why">A move also sets last touch to today and logs one line.</span></div></div>'
      + '<form class="detail-section lead-next-form"><h3>Next step</h3>'
      + '<input type="text" class="lead-next-step" value="' + esc(l.nextStep) + '" aria-label="Next step" placeholder="What happens next">'
      + '<div class="row"><input type="date" class="lead-next-date" value="' + esc(l.nextDate) + '" aria-label="Next date"><button type="submit" class="primary">Save</button></div></form>'
      + '<div class="detail-section"><h3>Every field</h3><dl class="lead-fields">' + fields.map(function (f) { return "<dt>" + esc(f[0]) + "</dt><dd>" + (f[1] ? esc(f[1]) : '<span class="faint">blank</span>') + "</dd>"; }).join("") + "</dl></div>"
      + '<div class="detail-section"><h3>Research</h3>' + leadResearchHtml(l) + "</div>"
      + '<div class="detail-section"><h3>Links</h3><p class="lead-links">' + links.join(" ") + "</p></div>";
    $("leadBody").querySelector(".lead-panel-full").addEventListener("click", closeLeadDetail);
    var sel = $("leadBody").querySelector(".lead-detail-move");
    sel.addEventListener("change", function () { moveLead(l, sel.value, function () { sel.value = l.status; }); });
    var form = $("leadBody").querySelector(".lead-next-form");
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      var btn = form.querySelector("button"); btn.disabled = true;
      try {
        var r = await api("lead", { method: "POST", body: { action: "next", id: l.id, nextStep: form.querySelector(".lead-next-step").value, nextDate: form.querySelector(".lead-next-date").value } });
        toast(r.unchanged ? "Nothing changed." : "Next step saved to Owlbridge pipeline, and logged.");
        await load(false);
      } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
    });
  }
  function openLeadDetail(id) {
    if (!leadById(id)) return;
    leadOpenId = id;
    renderLeadDetail();
    $("leadOverlay").hidden = false;
  }
  function closeLeadDetail() { leadOpenId = null; if ($("leadOverlay")) $("leadOverlay").hidden = true; }
  if ($("leadClose")) $("leadClose").addEventListener("click", closeLeadDetail);
  if ($("leadOverlay")) $("leadOverlay").addEventListener("click", function (e) { if (e.target === $("leadOverlay")) closeLeadDetail(); });
  function leadPanelShortcut(e) {
    if (!$("leadOverlay") || $("leadOverlay").hidden) return false;
    if (e.key === "Escape") { closeLeadDetail(); return true; }
    return false;
  }

  // ---------- add lead ----------
  if ($("leadAddBtn")) $("leadAddBtn").addEventListener("click", function () { $("leadAddForm").hidden = false; $("leadNewCompany").focus(); });
  if ($("leadAddClose")) $("leadAddClose").addEventListener("click", function () { $("leadAddForm").hidden = true; });
  if ($("leadAddForm")) $("leadAddForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var btn = $("leadAddForm").querySelector("button[type=submit]"); btn.disabled = true;
    var v = function (id) { return $(id).value.trim(); };
    try {
      var r = await api("lead", { method: "POST", body: { action: "add", company: v("leadNewCompany"), segment: v("leadNewSegment"), tier: v("leadNewTier"), score: v("leadNewScore"), contact: v("leadNewContact"), email: v("leadNewEmail"), source: v("leadNewSource"), nextStep: v("leadNewStep"), nextDate: v("leadNewDate") } });
      toast("Added to Owlbridge pipeline as " + r.id + ".");
      $("leadAddForm").reset(); $("leadAddForm").hidden = true;
      fire({ count: 14, region: "cortex", boost: 0.25 });
      await load(false);
    } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
  });

  // ---------- command palette: Cmd+K / Ctrl+K ----------
  // Recent remembers the last few things picked through the palette itself, on this device only
  // (see the localStorage note in artifact-capabilities: this is a per-device convenience, never
  // read back by Claude or shared between devices).
  var RECENT_KEY = "brainRecent", RECENT_MAX = 6;
  function recentGet() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch (e) { return []; } }
  function recentPush(id) {
    try {
      var list = recentGet().filter(function (r) { return r !== id; });
      list.unshift(id);
      localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
    } catch (e) {}
  }
  var AREA_LABELS = { "": "Go to Brain", tasks: "Go to Tasks", fernmoor: "Go to Fernmoor", approvals: "Go to Approvals", leads: "Go to Leads", notes: "Go to Notes", journal: "Go to Journal", scout: "Go to Scout", chat: "Go to Chat", team: "Go to Team", runs: "Go to Runs" };
  function paletteGoTos() {
    return Array.prototype.map.call(document.querySelectorAll(".nav a"), function (a) {
      var route = a.dataset.route || "";
      return { id: "goto:" + route, kind: "goto", label: AREA_LABELS[route] || ("Go to " + route), run: function () { location.hash = "#/" + route; } };
    });
  }
  // The app's existing top-level actions: reused as-is, nothing new built for the palette.
  function paletteQuickActions() {
    return [
      { id: "action:refresh", kind: "action", label: "Refresh from the vault", run: function () { $("refreshBtn").click(); } },
      { id: "action:runnow", kind: "action", label: "Run Claude now", run: function () { runClaudeNow(); } },
      { id: "action:lock", kind: "action", label: "Lock this device", run: function () { $("lockBtn").click(); } }
    ];
  }
  var paletteOpen = false, paletteItems = [], paletteIndex = 0;
  function buildPaletteSections(query) {
    var q = query.trim().toLowerCase();
    var all = paletteGoTos().concat(paletteQuickActions());
    var byId = {}; all.forEach(function (x) { byId[x.id] = x; });
    var match = function (list) { return !q ? list : list.filter(function (x) { return x.label.toLowerCase().indexOf(q) > -1; }); };
    var sections = [];
    var recent = match(recentGet().map(function (id) { return byId[id]; }).filter(Boolean));
    if (recent.length) sections.push({ label: "Recent", items: recent });
    var quick = match(paletteQuickActions());
    if (quick.length) sections.push({ label: "Quick actions", items: quick });
    var goTos = match(paletteGoTos());
    if (goTos.length) sections.push({ label: "Go to", items: goTos });
    // Leads: company, contact or email; Enter opens the record page.
    if (q && state && state.leads) {
      var leadHits = leadsAll().filter(function (l) { return (l.company + " " + l.contact + " " + l.email).toLowerCase().indexOf(q) > -1; }).slice(0, 6);
      if (leadHits.length) sections.push({ label: "Leads", items: leadHits.map(function (l) {
        return { id: "lead:" + l.id, kind: "lead", label: l.company + " (" + l.status + ")", run: function () { leadOpenRecord(l.id); } };
      }) });
    }
    if (q) {
      var text = query.trim();
      var freeItems = [
        { id: "free:request", kind: "free", label: "Send to Claude as a request", run: function () { submitRequest(text, "").catch(function (e) { toast(e.message, true); }); } },
        { id: "free:chat", kind: "free", label: "Ask in chat", run: function () { location.hash = "#/chat"; $("chatText").value = text; sendChat(false); } },
        { id: "free:task", kind: "free", label: "Add as a task", run: function () { submitTask(text, "next").catch(function (e) { toast(e.message, true); }); } }
      ];
      // Quick capture (the C shortcut, or the phone's floating add button) opens on this same
      // free-text step, just with "Add as a task" the default and the other two one key away.
      if (quickCaptureMode) freeItems = [freeItems[2], freeItems[0], freeItems[1]];
      sections.push({ label: 'Use "' + text + '"', items: freeItems });
    }
    return sections;
  }
  function paletteRun(it) {
    if (!it) return;
    it.run();
    if (it.kind === "goto" || it.kind === "action") recentPush(it.id);
    closePalette();
  }
  function paletteRender() {
    var sections = buildPaletteSections($("paletteInput").value);
    paletteItems = [];
    sections.forEach(function (s) { s.items.forEach(function (it) { paletteItems.push(it); }); });
    if (paletteIndex >= paletteItems.length) paletteIndex = Math.max(0, paletteItems.length - 1);
    var host = $("paletteList"); host.innerHTML = "";
    if (!paletteItems.length) { host.innerHTML = '<div class="palette-empty">Nothing matches. Keep typing to send it to Claude, chat or a task.</div>'; return; }
    var n = 0;
    sections.forEach(function (s) {
      var sec = document.createElement("div"); sec.className = "palette-section";
      sec.innerHTML = '<div class="palette-section-label">' + esc(s.label) + "</div>";
      s.items.forEach(function (it) {
        var i = n++;
        var row = document.createElement("div"); row.className = "palette-row" + (i === paletteIndex ? " active" : ""); row.dataset.i = i;
        var hint = i < 9 ? String(i + 1) : "";
        row.innerHTML = '<span class="pr-label">' + esc(it.label) + '</span>' + (hint ? '<span class="pr-hint">' + esc(hint) + "</span>" : "");
        row.addEventListener("mouseenter", function () { paletteIndex = i; paletteHighlight(); });
        row.addEventListener("click", function () { paletteRun(it); });
        sec.appendChild(row);
      });
      host.appendChild(sec);
    });
  }
  function paletteHighlight() {
    document.querySelectorAll(".palette-row").forEach(function (r) {
      var on = Number(r.dataset.i) === paletteIndex;
      r.classList.toggle("active", on);
      if (on && r.scrollIntoView) r.scrollIntoView({ block: "nearest" });
    });
  }
  var quickCaptureMode = false;
  function openPalette(quick) {
    quickCaptureMode = !!quick;
    paletteOpen = true; paletteIndex = 0;
    $("paletteOverlay").hidden = false;
    $("paletteInput").value = "";
    $("paletteInput").placeholder = quickCaptureMode
      ? "Capture something: a task, a request, or a question for chat..."
      : "Go somewhere, run something, or type a request...";
    paletteRender();
    setTimeout(function () { $("paletteInput").focus(); }, 0);
  }
  function closePalette() { paletteOpen = false; quickCaptureMode = false; $("paletteOverlay").hidden = true; }
  // The floating add button (phone) and the C shortcut both land here: the palette, already on
  // its free-text step in spirit, just typed into.
  function openQuickCapture() { openPalette(true); }
  function paletteKeydown(e) {
    if (e.key === "Escape") { e.preventDefault(); closePalette(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); paletteIndex = Math.min(paletteItems.length - 1, paletteIndex + 1); paletteHighlight(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); paletteIndex = Math.max(0, paletteIndex - 1); paletteHighlight(); return; }
    if (e.key === "Enter") { e.preventDefault(); paletteRun(paletteItems[paletteIndex]); return; }
    if (/^[1-9]$/.test(e.key) && !$("paletteInput").value) { e.preventDefault(); var idx = Number(e.key) - 1; if (paletteItems[idx]) paletteRun(paletteItems[idx]); }
  }
  if ($("paletteInput")) $("paletteInput").addEventListener("input", function () { paletteIndex = 0; paletteRender(); });
  if ($("paletteOverlay")) $("paletteOverlay").addEventListener("click", function (e) { if (e.target === $("paletteOverlay")) closePalette(); });
  if ($("paletteBtn")) $("paletteBtn").addEventListener("click", function () { openPalette(); });
  if ($("fabAdd")) $("fabAdd").addEventListener("click", function () { openQuickCapture(); });

  // ---------- sheets: the phone's More tab, and the ? shortcut reference ----------
  var sheetOpen = null; // "more" | "shortcuts" | null
  function sheetOverlayId(which) { return which === "more" ? "moreSheetOverlay" : "shortcutSheetOverlay"; }
  function openSheet(which) {
    closePalette();
    sheetOpen = which;
    var el = $(sheetOverlayId(which)); if (el) el.hidden = false;
  }
  function closeSheet() {
    if (!sheetOpen) return;
    var el = $(sheetOverlayId(sheetOpen)); if (el) el.hidden = true;
    sheetOpen = null;
  }
  function openMoreSheet() { openSheet("more"); }
  function openShortcutSheet() { openSheet("shortcuts"); }
  if ($("moreTabBtn")) $("moreTabBtn").addEventListener("click", function () { openMoreSheet(); });
  if ($("moreSheetClose")) $("moreSheetClose").addEventListener("click", closeSheet);
  if ($("shortcutSheetClose")) $("shortcutSheetClose").addEventListener("click", closeSheet);
  document.querySelectorAll(".sheet-overlay").forEach(function (ov) {
    ov.addEventListener("click", function (e) { if (e.target === ov) closeSheet(); });
  });
  document.querySelectorAll(".sheet-link").forEach(function (a) { a.addEventListener("click", closeSheet); });

  // ---------- sidebar: collapse to an icon rail, remembered per device ----------
  var SIDEBAR_KEY = "brainSidebarCollapsed";
  function setSidebarCollapsed(on) {
    var el = $("sidebar"); if (!el) return;
    el.classList.toggle("collapsed", on);
    document.body.classList.toggle("sidebar-collapsed", on);
    if ($("sidebarToggle")) { $("sidebarToggle").setAttribute("aria-expanded", on ? "false" : "true"); $("sidebarToggle").title = on ? "Expand sidebar (Cmd/Ctrl+\\)" : "Collapse sidebar (Cmd/Ctrl+\\)"; }
    try { localStorage.setItem(SIDEBAR_KEY, on ? "1" : "0"); } catch (e) {}
  }
  function toggleSidebar() { setSidebarCollapsed(!($("sidebar") && $("sidebar").classList.contains("collapsed"))); }
  (function () { try { setSidebarCollapsed(localStorage.getItem(SIDEBAR_KEY) === "1"); } catch (e) {} })();
  if ($("sidebarToggle")) $("sidebarToggle").addEventListener("click", toggleSidebar);

  // ---------- run Claude now: shared by the sidebar foot button, the approvals watcher
  // button and the command palette's quick action, so the three read the queue the same way ----------
  function runClaudeNow(btn) {
    if (btn) btn.disabled = true;
    return api("watcher", { method: "POST", body: {} }).then(function (w) {
      if (w.fired) { toast("Claude has started. Watch the bar at the top."); startRun("the queue"); fire({ count: 40, region: "all", boost: 0.6 }); }
      else if (w.why === "already going" || w.why === "already started moments ago") toast("Claude is already running and picks up everything in the queue.");
      else toast("Claude was not started: " + w.why + ".", true);
      return w;
    }).catch(function (e) { toast(e.message, true); }).finally(function () { if (btn) btn.disabled = false; });
  }
  if ($("runNowBtn")) $("runNowBtn").addEventListener("click", function () { runClaudeNow($("runNowBtn")); });

  // ---------- browser notifications: only for a run this page itself started, only after an
  // explicit tap on this button, never asked on page load ----------
  function paintNotifyBtn() {
    var b = $("notifyBtn"); if (!b) return;
    var supported = "Notification" in window;
    var perm = supported ? Notification.permission : "unsupported";
    b.classList.toggle("on", perm === "granted");
    b.title = perm === "granted" ? "Notifications on for runs you start here"
      : perm === "denied" ? "Notifications are blocked for this site in your browser"
      : supported ? "Get a notification when a run you started finishes" : "Notifications are not supported in this browser";
    b.setAttribute("aria-label", b.title);
  }
  if ($("notifyBtn")) $("notifyBtn").addEventListener("click", async function () {
    if (!("Notification" in window)) { toast("Notifications are not supported in this browser.", true); return; }
    if (Notification.permission === "granted") { toast("Notifications are already on."); return; }
    if (Notification.permission === "denied") { toast("Notifications are blocked for this site in your browser settings.", true); return; }
    try {
      var perm = await Notification.requestPermission();
      paintNotifyBtn();
      toast(perm === "granted" ? "Notifications on. You will hear when a run you started finishes." : "Notifications not enabled.");
    } catch (e) { toast("Could not ask for notification permission.", true); }
  });

  // ---------- keyboard shortcuts: G then a letter to go somewhere, C for quick capture, ?
  // for this list, Cmd/Ctrl+\ to collapse the sidebar ----------
  var G_ROUTES = { b: "", t: "tasks", f: "fernmoor", a: "approvals", l: "leads", n: "notes", j: "journal", s: "scout", c: "chat", d: "team", r: "runs" };
  var gArmed = false, gArmedTimer = null;
  // One listener for the palette's own Cmd+K / Ctrl+K, the sheets, the G-then-letter and C and
  // ? shortcuts, and the approvals inbox's A/D/J/K, which only fire when that pane is on screen
  // and never while typing in a text field.
  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "k" || e.key === "K")) { e.preventDefault(); if (paletteOpen) closePalette(); else openPalette(); return; }
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === "\\") { e.preventDefault(); toggleSidebar(); return; }
    if (paletteOpen) { paletteKeydown(e); return; }
    if (sheetOpen) { if (e.key === "Escape") { e.preventDefault(); closeSheet(); } return; }
    var tag = (document.activeElement && document.activeElement.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || (document.activeElement && document.activeElement.isContentEditable)) return;
    if (gArmed) {
      e.preventDefault();
      gArmed = false; clearTimeout(gArmedTimer);
      var dest = G_ROUTES[e.key.toLowerCase()];
      if (dest !== undefined) location.hash = "#/" + dest;
      return;
    }
    if ((e.key === "g" || e.key === "G") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      gArmed = true; clearTimeout(gArmedTimer); gArmedTimer = setTimeout(function () { gArmed = false; }, 1500); return;
    }
    if ((e.key === "c" || e.key === "C") && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); openQuickCapture(); return; }
    if ((e.key === "n" || e.key === "N") && !e.metaKey && !e.ctrlKey && !e.altKey
      && location.hash.replace(/^#\/?/, "").split("/")[0] === "approvals" && $("requestForm") && $("requestForm").hidden) {
      e.preventDefault(); openRequestForm(); return;
    }
    if (e.key === "?") { e.preventDefault(); openShortcutSheet(); return; }
    if ((e.key === "[" || e.key === "]") && location.hash.replace(/^#\/?/, "").split("/")[0] === "journal") {
      e.preventDefault(); journalStep(e.key === "[" ? -1 : 1); return;
    }
    if (approvalsInboxShortcut(e)) { e.preventDefault(); return; }
    if (agentPanelShortcut(e)) { e.preventDefault(); return; }
    if (leadPanelShortcut(e)) { e.preventDefault(); return; }
    if (leadListShortcut(e)) { e.preventDefault(); return; }
    if (detailPanelShortcut(e)) e.preventDefault();
  });

  // ---------- router ----------
  // ---------- chat ----------
  var chat = { messages: [], waiting: false, loaded: false }, chatTimer = null;

  function chatWhen(at) {
    var m = String(at || "").match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}:\d{2})$/);
    if (!m) return at || "";
    var ymd = m[1] + "-" + m[2] + "-" + m[3];
    if (state && ymd === state.today.ymd) return "Today " + m[4];
    return (+m[3]) + " " + MONTHS[+m[2] - 1].slice(0, 3) + " " + m[4];
  }

  // An operator message's own state: Answered once any later message is the Brain's reply;
  // otherwise Waiting for the scheduled run, or Claude is on it while that run is actually
  // live (the same runIsLive() the top run bar uses), or Sent as the fallback when neither a
  // next run time nor a live run is known.
  function chatMsgState(i) {
    var answered = chat.messages.slice(i + 1).some(function (x) { return x.who === "Brain"; });
    if (answered) return { cls: "answered", label: "Answered" };
    if (runIsLive()) return { cls: "working", label: "Claude is on it" };
    var n = nextRun();
    if (n) return { cls: "waiting", label: "Waiting for the next run at " + whenWords(n.at) };
    return { cls: "sent", label: "Sent" };
  }
  // Approval ids a Brain reply names: matched against state.approvals and shown as their own
  // mini card in place, reusing approvalCard() and its wired Approve/Decline exactly as
  // Approvals itself uses them.
  var APPROVAL_ID_RE = /\ba-\d{4}-\d{2}-\d{2}-[a-z0-9-]+\b/g;
  function chatApprovalIdsIn(text) {
    var out = [], seen = {}, m;
    APPROVAL_ID_RE.lastIndex = 0;
    while ((m = APPROVAL_ID_RE.exec(text || ""))) { if (!seen[m[0]]) { seen[m[0]] = true; out.push(m[0]); } }
    return out;
  }
  function approvalKindOf(a) {
    var st = (a.status || "").toLowerCase();
    if (st === "pending") return "pending";
    if (st === "requested") return "requested";
    if (st === "approved" || st === "in progress") return "active";
    return "settled";
  }
  function renderChat() {
    var host = $("chatThread");
    if (!host) return;
    if (!chat.loaded) { host.innerHTML = '<p class="empty">Opening the thread.</p>'; return; }
    if (!chat.messages.length) {
      host.innerHTML = '<p class="empty">Nothing here yet. Write the first message and the next run picks it up.</p>';
    } else {
      host.innerHTML = "";
      chat.messages.forEach(function (m, i) {
        var d = document.createElement("div");
        d.className = "chat-msg " + (m.who === "Brain" ? "from-brain" : "from-me");
        var chip = "";
        if (m.who !== "Brain") { var st = chatMsgState(i); chip = '<span class="chat-state ' + st.cls + '">' + esc(st.label) + "</span>"; }
        d.innerHTML = '<div class="chat-meta"><span class="chat-who">' + esc(m.who === "Brain" ? "The Brain" : "You") + '</span><span class="chat-at">' + esc(chatWhen(m.at)) + "</span>" + chip + "</div>" +
          '<div class="chat-body">' + mdToHtml(m.text) + "</div>";
        if (m.who === "Brain" && state && state.approvals) {
          var rows = chatApprovalIdsIn(m.text).map(function (id) { return state.approvals.find(function (a) { return a.id === id; }); }).filter(Boolean);
          if (rows.length) {
            var wrap = document.createElement("div"); wrap.className = "chat-approvals";
            rows.forEach(function (a) {
              var card = approvalCard(a, approvalKindOf(a));
              // approvalCard() already wires Approve/Decline against the shared decide(); this
              // only adds a repaint of the chat thread itself once that has run, so the card
              // here (a separate element from the one on Approvals) reflects the new status
              // without waiting for the next full refresh.
              var ap = card.querySelector(".approve"), de = card.querySelector(".decline");
              if (ap) ap.addEventListener("click", function () { setTimeout(renderChat, 0); });
              if (de) de.addEventListener("click", function () { setTimeout(renderChat, 0); });
              wrap.appendChild(card);
            });
            d.appendChild(wrap);
          }
        }
        host.appendChild(d);
      });
      host.scrollTop = host.scrollHeight;
    }
    var w = $("chatWaiting");
    w.hidden = !chat.waiting;
    if (chat.waiting) w.textContent = "Waiting on the brain. " + nextRunLine();
    var b = $("badgeChat");
    if (b) { b.hidden = !chat.waiting; b.textContent = "1"; }
  }

  async function loadChat(quiet) {
    if (!$("chatThread")) return;
    try {
      var d = await api("chat");
      chat.messages = d.messages || []; chat.waiting = !!d.waiting; chat.loaded = true;
      teamChatDiff();
      renderChat();
    } catch (e) { if (!quiet && e.message !== "unauthorised") toast(e.message, true); }
  }

  async function sendChat(runNow) {
    var box = $("chatText"), text = box.value.trim();
    if (!text) { box.focus(); return; }
    var send = $("chatSend"), now = $("chatNow");
    send.disabled = true; now.disabled = true;
    try {
      var d = await api("chat", { method: "POST", body: { text: text } });
      box.value = "";
      chat.messages = d.messages || chat.messages; chat.waiting = true; chat.loaded = true;
      renderChat();
      if (runNow) {
        var r = await api("watcher", { method: "POST", body: {} });
        toast(r.fired ? "Sent. Claude is reading it now." : "Sent. " + (r.why ? "Claude was not started: " + r.why + "." : "It goes with the next run."));
        if (r.fired) startRun("your message");
      } else {
        toast(d.watcher && d.watcher.fired ? "Sent. Claude is reading it now." : "Sent. " + nextRunLine());
        if (d.watcher && d.watcher.fired) startRun("your message");
      }
      fire({ count: 18, boost: 0.5, region: "stem" });
    } catch (e) {
      if (e.message !== "unauthorised") toast(e.message, true);
    } finally { send.disabled = false; now.disabled = false; }
  }

  if ($("chatForm")) {
    $("chatForm").addEventListener("submit", function (e) { e.preventDefault(); sendChat(false); });
    $("chatNow").addEventListener("click", function () { sendChat(true); });
    $("chatText").addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); sendChat(false); }
    });
  }

  // Every route this app knows. A hash that names anything else (a stale link, a typo, an old
  // bookmark) falls back to the Brain page instead of leaving every .view hidden.
  var KNOWN_VIEWS = Object.keys(AREA_LABELS);
  function route() {
    var h = location.hash.replace(/^#\/?/, "");
    var parts = h.split("/"); var view = parts[0] || "";
    if (KNOWN_VIEWS.indexOf(view) < 0) { location.hash = "/"; return; }
    closeSheet();
    document.querySelectorAll(".view").forEach(function (v) { v.hidden = v.dataset.view !== view; });
    document.querySelectorAll(".nav a, .bt-link, .sheet-link").forEach(function (a) {
      var on = a.dataset.route === view; a.classList.toggle("active", on);
      if (on && a.scrollIntoView && a.parentNode.scrollWidth > a.parentNode.clientWidth) a.scrollIntoView({ block: "nearest", inline: "center" });
    });
    if (view === "notes" && parts[1]) { var path = decodeURIComponent(parts.slice(1).join("/")); if (!currentNote || currentNote.path !== path) openNote(path); }
    else if (view === "notes") maybeOpenLastNote();
    if (view === "leads") leadsRoute(parts.slice(1));
    if (view === "chat") { loadChat(chat.loaded); if (!chatTimer) chatTimer = setInterval(function () { loadChat(true); }, 45000); }
    else if (chatTimer) { clearInterval(chatTimer); chatTimer = null; }
    // Team has its own area now (the node drawing heads its roster): poll /api/state at the
    // cadence its motion needs (20-30s) only while that page is open and the tab is visible, on
    // top of the 5 minute ambient refresh every page already gets.
    if (view === "team") {
      if (window.Team) { window.Team.setLive(true); setTimeout(function () { window.Team.resize(); }, 0); }
      if (!teamTimer) { teamPoll(); teamTimer = setInterval(teamPoll, 25000); }
    } else if (teamTimer) { clearInterval(teamTimer); teamTimer = null; if (window.Team) window.Team.setLive(false); }
    document.body.classList.toggle("home", view === "");
    if (window.Veins) window.Veins.setRoute(view || "brain");
    if (view === "" && brain) fire({ count: 12, boost: 0.15 });
    window.scrollTo(0, 0);
  }
  if (window.Veins) window.Veins.start();
  window.addEventListener("hashchange", route);

  // ---------- boot ----------
  async function boot() {
    try { brain = window.Brain && window.Brain.mount($("brainMount")); } catch (e) { console.warn("brain failed", e); }
    try { window.Team && window.Team.mount({ onAgentClick: openAgentDetail }); } catch (e) { console.warn("team failed", e); }
    route();
    paintNotifyBtn();
    await checkDemo();
    try { key = localStorage.getItem("brainKey"); } catch (e) {}
    if (!key) { lock(true); setSync("", "locked"); return; }
    await load(true);
    if (!refreshTimer) refreshTimer = setInterval(function () { if (!document.hidden && key) load(false); }, 5 * 60 * 1000);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden || !key) return;
      if (lastRefresh && Date.now() - lastRefresh > 2 * 60 * 1000) load(false);
      else if (teamTimer) teamPoll();
    });
  }
  boot();
})();
