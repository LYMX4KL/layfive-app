/*
 * LayFive Group Sharing (v2 — Scorecard)
 * --------------------------------------
 * Host creates a 6-digit group code. Joiners type the code to watch the
 * host's scorecard fill in live via Supabase Realtime (with polling fallback).
 * Only the host can enter dropped numbers. Bets/bankroll stay private.
 *
 * v2 changes:
 *  - Host publishes via polling loop (robust to addSpin re-wrapping).
 *  - Viewer has polling fallback in case realtime misses events.
 *  - Non-blocking banner instead of alert() so the page doesn't freeze.
 *  - Joiner can "mirror & fork" (copy scorecard, keep viewing in parallel).
 *  - Mid-session start is supported (existing spins get seeded on create).
 */
(function () {
  'use strict';
 
  var SB_URL = 'https://xkcglcxhkxpvtumorcki.supabase.co';
  var SB_KEY = 'sb_publishable_PhD96K8thW97356rT7VmDA_75mEruoY';
  var LS_CID = 'lf_client_id';
  var ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var HOST_POLL_MS = 1200;     // host: how often to check for new local spins to publish
  var VIEWER_POLL_MS = 3500;   // viewer: how often to poll as realtime fallback
 
  var sb = null;
  var state = {
    role: null,          // 'host' | 'viewer' | null
    sessionId: null,
    code: null,
    channel: null,
    hostBuffer: [],      // host: pending {idx, num} to publish
    hostNextIdx: 1,      // host: next spin_index to assign (1-based)
    publishedUpTo: 0,    // host: highest idx confirmed published
    viewerSeenMax: 0,    // viewer: highest spin_index applied
    hostTimer: null,
    viewerTimer: null,
    forked: false,       // viewer: true once they fork to local session
    applyingRemote: false
  };
 
  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
  function clientId() {
    var id = localStorage.getItem(LS_CID);
    if (!id) { id = uuid(); localStorage.setItem(LS_CID, id); }
    return id;
  }
  function genCode() {
    var s = '';
    for (var i = 0; i < 6; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return s;
  }
  function loadSB() {
    return new Promise(function (res, rej) {
      if (window.supabase && window.supabase.createClient) return res(window.supabase);
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      s.onload = function () { window.supabase ? res(window.supabase) : rej(new Error('supabase missing')); };
      s.onerror = function () { rej(new Error('failed to load supabase')); };
      document.head.appendChild(s);
    });
  }
  function ensureClient() {
    if (sb) return Promise.resolve(sb);
    return loadSB().then(function (lib) { sb = lib.createClient(SB_URL, SB_KEY); return sb; });
  }
 
  // ---------- Non-blocking banner ----------
  function showBanner(html, tone) {
    var b = document.getElementById('gs-banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'gs-banner';
      b.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:99999;min-width:240px;max-width:90vw;padding:10px 14px;border-radius:8px;font-size:.95em;box-shadow:0 4px 18px rgba(0,0,0,.4);display:flex;gap:10px;align-items:center';
      document.body.appendChild(b);
    }
    var bg = tone === 'err' ? '#6b0f0f' : tone === 'warn' ? '#7a5a10' : '#0b5c2a';
    b.style.background = bg;
    b.style.color = '#fff';
    b.style.border = '1px solid rgba(255,255,255,.2)';
    b.innerHTML = html + ' <button style="margin-left:auto;background:transparent;color:#fff;border:1px solid rgba(255,255,255,.5);border-radius:4px;padding:2px 8px;cursor:pointer" onclick="document.getElementById(\'gs-banner\').remove()">OK</button>';
  }
 
  // ---------- UI ----------
  function buildUI() {
    var pane = document.getElementById('p0');
    if (!pane) return;
    if (document.getElementById('gs-bar')) return;
    var actions = pane.querySelector('.actions');
    if (!actions) return;
    var bar = document.createElement('div');
    bar.id = 'gs-bar';
    bar.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;padding:6px 4px;font-size:.85em;align-items:center';
    bar.innerHTML =
      '<button id="gs-start" style="background:#0b5c2a;color:#fff;border:1px solid #3a9a55;border-radius:6px;padding:5px 10px;font-weight:700;cursor:pointer">👥 Start Group</button>' +
      '<button id="gs-join" style="background:#1e3a8a;color:#fff;border:1px solid #4a6bd4;border-radius:6px;padding:5px 10px;font-weight:700;cursor:pointer">🔗 Join Group</button>' +
      '<span id="gs-status" style="color:#ccc;margin-left:6px;font-size:.9em"></span>' +
      '<button id="gs-fork" style="display:none;background:#5a3a8a;color:#fff;border:1px solid #8a6acc;border-radius:6px;padding:5px 10px;font-weight:700;cursor:pointer">📋 Copy & Fork</button>' +
      '<button id="gs-leave" style="display:none;background:#6b0f0f;color:#fff;border:1px solid #c94a4a;border-radius:6px;padding:5px 10px;font-weight:700;cursor:pointer">Leave</button>';
    actions.parentNode.insertBefore(bar, actions.nextSibling);
    document.getElementById('gs-start').onclick = startGroup;
    document.getElementById('gs-join').onclick = joinGroup;
    document.getElementById('gs-leave').onclick = leaveGroup;
    document.getElementById('gs-fork').onclick = forkFromGroup;
  }
  function updateUI() {
    var status = document.getElementById('gs-status');
    var start = document.getElementById('gs-start');
    var join = document.getElementById('gs-join');
    var leave = document.getElementById('gs-leave');
    var fork = document.getElementById('gs-fork');
    if (!status) return;
    if (state.role === 'host') {
      status.innerHTML = '🟢 Group <b>' + state.code + '</b> (host)';
      start.style.display = 'none'; join.style.display = 'none';
      leave.style.display = ''; fork.style.display = 'none';
    } else if (state.role === 'viewer') {
      status.innerHTML = '🟢 Group <b>' + state.code + (state.forked ? '</b> (viewing + local fork)' : '</b> (viewing)');
      start.style.display = 'none'; join.style.display = 'none';
      leave.style.display = ''; fork.style.display = state.forked ? 'none' : '';
    } else {
      status.textContent = '';
      start.style.display = ''; join.style.display = '';
      leave.style.display = 'none'; fork.style.display = 'none';
    }
    // Lock scorecard input for viewers UNLESS they've forked
    var pane = document.getElementById('p0');
    if (!pane) return;
    var lock = state.role === 'viewer' && !state.forked;
    var sc = pane.querySelector('.sc-wrap');
    if (sc) sc.style.pointerEvents = lock ? 'none' : '';
    var btns = pane.querySelectorAll('.actions button');
    btns.forEach(function (b) {
      if (b.classList.contains('btn-ref')) return;
      b.disabled = lock;
      b.style.opacity = lock ? 0.4 : '';
    });
  }
 
  // ---------- Host: hook addSpin to capture numbers ----------
  function installHostHook() {
    if (typeof window.addSpin !== 'function') return false;
    if (window._lfOrigAddSpin) return true;
    window._lfOrigAddSpin = window.addSpin;
    window.addSpin = function (num) {
      var res = window._lfOrigAddSpin.apply(this, arguments);
      try {
        if (!state.applyingRemote && state.role === 'host' && typeof num === 'number') {
          state.hostBuffer.push({ idx: state.hostNextIdx++, num: num });
        }
      } catch (e) { console.warn('[group] capture failed', e); }
      return res;
    };
    console.log('[group] host hook installed');
    return true;
  }
 
  // ---------- Host: publish loop ----------
  function hostPublishTick() {
    if (state.role !== 'host' || !sb || !state.sessionId) return;
    if (!state.hostBuffer.length) return;
    var snapshot = state.hostBuffer.slice();
    var batch = snapshot.map(function (e) {
      return { session_id: state.sessionId, spin_index: e.idx, number: e.num };
    });
    sb.from('group_spins').upsert(batch, { onConflict: 'session_id,spin_index', ignoreDuplicates: true })
      .then(function (r) {
        if (r && r.error) {
          console.warn('[group] publish error', r.error);
          return;
        }
        // drop the items we successfully published from the buffer
        var lastIdx = snapshot[snapshot.length - 1].idx;
        state.hostBuffer = state.hostBuffer.filter(function (e) { return e.idx > lastIdx; });
        state.publishedUpTo = lastIdx;
      })
      .catch(function (e) { console.warn('[group] publish exception', e); });
  }
  function startHostLoop() {
    stopHostLoop();
    state.hostTimer = setInterval(hostPublishTick, HOST_POLL_MS);
  }
  function stopHostLoop() {
    if (state.hostTimer) { clearInterval(state.hostTimer); state.hostTimer = null; }
  }
 
  // ---------- Viewer: polling fallback ----------
  function viewerPollTick() {
    if (state.role !== 'viewer' || !sb || !state.sessionId) return;
    sb.from('group_spins')
      .select('spin_index,number')
      .eq('session_id', state.sessionId)
      .gt('spin_index', state.viewerSeenMax)
      .order('spin_index', { ascending: true })
      .then(function (r) {
        if (!r || !r.data || !r.data.length) return;
        r.data.forEach(function (row) {
          if (row.spin_index <= state.viewerSeenMax) return;
          applyRemoteSpin(row.number);
          state.viewerSeenMax = row.spin_index;
        });
      });
  }
  function startViewerLoop() {
    stopViewerLoop();
    state.viewerTimer = setInterval(viewerPollTick, VIEWER_POLL_MS);
  }
  function stopViewerLoop() {
    if (state.viewerTimer) { clearInterval(state.viewerTimer); state.viewerTimer = null; }
  }
 
  // ---------- Start / Join / Fork / Leave ----------
  function startGroup() {
    ensureClient().then(function () {
      var cid = clientId();
      var tries = 0;
      function attempt() {
        var code = genCode();
        return sb.from('group_sessions').insert({ code: code, host_id: cid, mode: 'scorecard' }).select().single()
          .then(function (r) {
            if (r.error) { tries++; if (tries < 5) return attempt(); throw r.error; }
            return r.data;
          });
      }
      return attempt().then(function (row) {
        state.role = 'host';
        state.sessionId = row.id;
        state.code = row.code;
        state.hostBuffer = [];
        state.hostNextIdx = 1;
        state.publishedUpTo = 0;
        installHostHook();
        // Seed existing local spins by reading the scorecard cells (s1, s2, ...)
        // This is resilient to whatever variable name the app uses internally.
        var i = 1;
        while (true) {
          var cell = document.getElementById('s' + i);
          if (!cell) break;
          var txt = (cell.textContent || '').trim();
          var n = parseInt(txt, 10);
          if (isNaN(n)) break;
          state.hostBuffer.push({ idx: state.hostNextIdx++, num: n });
          i++;
        }
        updateUI();
        showBanner('Group started — code <b style="letter-spacing:2px;font-size:1.2em">' + row.code + '</b> — share with friends (copied to clipboard).', 'ok');
        try { navigator.clipboard && navigator.clipboard.writeText(row.code); } catch (e) {}
        startHostLoop();
        hostPublishTick();
      });
    }).catch(function (e) {
      console.error('[group]', e);
      showBanner('Failed to start group: ' + (e.message || e), 'err');
    });
  }
 
  function joinGroup() {
    var code = (prompt('Enter 6-digit group code:') || '').trim().toUpperCase();
    if (!code) return;
    ensureClient().then(function () {
      return sb.from('group_sessions').select('*').eq('code', code).is('ended_at', null).maybeSingle();
    }).then(function (r) {
      if (r.error || !r.data) throw new Error('Group not found or has ended.');
      var row = r.data;
      if (window.spins && window.spins.length) {
        if (!confirm('Joining will clear your current scorecard. Continue?')) return;
      }
      window.spins = [];
      if (typeof window.refreshAll === 'function') window.refreshAll();
      state.role = 'viewer';
      state.sessionId = row.id;
      state.code = row.code;
      state.viewerSeenMax = 0;
      state.forked = false;
      return sb.from('group_spins').select('*').eq('session_id', row.id).order('spin_index', { ascending: true })
        .then(function (sp) {
          if (sp.data) sp.data.forEach(function (rr) {
            applyRemoteSpin(rr.number);
            if (rr.spin_index > state.viewerSeenMax) state.viewerSeenMax = rr.spin_index;
          });
          subscribeSpins();
          startViewerLoop();
          updateUI();
          showBanner('Joined group <b>' + row.code + '</b>. You can watch live, or tap "Copy & Fork" to start your own tracker from this scorecard.', 'ok');
        });
    }).catch(function (e) {
      console.error('[group]', e);
      showBanner('Failed to join: ' + (e.message || e), 'err');
    });
  }
 
  function forkFromGroup() {
    if (state.role !== 'viewer') return;
    state.forked = true;
    updateUI();
    showBanner('Forked — you can now enter your own bets and play privately. You\'ll still see the host\'s spins update above.', 'ok');
  }
 
  function applyRemoteSpin(num) {
    var fn = window._lfOrigAddSpin || window.addSpin;
    if (typeof fn !== 'function') return;
    state.applyingRemote = true;
    try { fn(num); } catch (e) { console.warn('[group] applyRemoteSpin failed', e); }
    finally { state.applyingRemote = false; }
  }
 
  function subscribeSpins() {
    if (!sb || !state.sessionId) return;
    try {
      var ch = sb.channel('gs:' + state.sessionId + ':' + Math.random().toString(36).slice(2, 8))
        .on('postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'group_spins',
            filter: 'session_id=eq.' + state.sessionId },
          function (p) {
            var row = p.new;
            if (!row || row.spin_index <= state.viewerSeenMax) return;
            applyRemoteSpin(row.number);
            state.viewerSeenMax = row.spin_index;
          })
        .subscribe(function (status, err) {
          console.log('[group] realtime status:', status, err || '');
        });
      state.channel = ch;
    } catch (e) {
      console.warn('[group] subscribe failed', e);
    }
  }
 
  function leaveGroup() {
    var p = Promise.resolve();
    if (state.role === 'host' && sb && state.sessionId) {
      p = sb.from('group_sessions').update({ ended_at: new Date().toISOString() }).eq('id', state.sessionId).then(function () {});
    }
    stopHostLoop();
    stopViewerLoop();
    if (state.channel && sb) { try { sb.removeChannel(state.channel); } catch (e) {} }
    state.role = null;
    state.sessionId = null;
    state.code = null;
    state.channel = null;
    state.publishedUpTo = 0;
    state.viewerSeenMax = 0;
    state.forked = false;
    p.finally ? p.finally(updateUI) : p.then(updateUI, updateUI);
  }
 
  function init() {
    buildUI();
    ensureClient().catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
