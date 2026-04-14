/*
 * LayFive Group Sharing (v1 — Scorecard)
 * --------------------------------------
 * Host creates a 6-digit group code. Joiners type the code to watch the
 * host's scorecard fill in live via Supabase Realtime.
 * Only the host can enter dropped numbers. Bets/bankroll stay private.
 */
(function () {
  'use strict';

  var SB_URL = 'https://xkcglcxhkxpvtumorcki.supabase.co';
  var SB_KEY = 'sb_publishable_PhD96K8thW97356rT7VmDA_75mEruoY';
  var LS_CID = 'lf_client_id';
  var ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  var sb = null;
  var state = { role: null, sessionId: null, code: null, channel: null };
  var applyingRemote = false;

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
      '<button id="gs-leave" style="display:none;background:#6b0f0f;color:#fff;border:1px solid #c94a4a;border-radius:6px;padding:5px 10px;font-weight:700;cursor:pointer">Leave</button>';
    actions.parentNode.insertBefore(bar, actions.nextSibling);
    document.getElementById('gs-start').onclick = startGroup;
    document.getElementById('gs-join').onclick = joinGroup;
    document.getElementById('gs-leave').onclick = leaveGroup;
  }
  function updateUI() {
    var status = document.getElementById('gs-status');
    var start = document.getElementById('gs-start');
    var join = document.getElementById('gs-join');
    var leave = document.getElementById('gs-leave');
    if (!status) return;
    if (state.role === 'host') {
      status.innerHTML = '🟢 Group <b>' + state.code + '</b> (host)';
      start.style.display = 'none'; join.style.display = 'none'; leave.style.display = '';
    } else if (state.role === 'viewer') {
      status.innerHTML = '🟢 Group <b>' + state.code + '</b> (viewing)';
      start.style.display = 'none'; join.style.display = 'none'; leave.style.display = '';
    } else {
      status.textContent = '';
      start.style.display = ''; join.style.display = ''; leave.style.display = 'none';
    }
    var pane = document.getElementById('p0');
    if (!pane) return;
    var disabled = state.role === 'viewer';
    var sc = pane.querySelector('.sc-wrap');
    if (sc) sc.style.pointerEvents = disabled ? 'none' : '';
    var btns = pane.querySelectorAll('.actions button');
    btns.forEach(function (b) {
      if (b.classList.contains('btn-ref')) return;
      b.disabled = disabled;
      b.style.opacity = disabled ? 0.4 : '';
    });
  }

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
        state = { role: 'host', sessionId: row.id, code: row.code, channel: null };
        if (window.spins && window.spins.length) {
          var rows = window.spins.map(function (s, i) {
            return { session_id: row.id, spin_index: i + 1, number: s.num };
          });
          sb.from('group_spins').insert(rows).then(function () {});
        }
        updateUI();
        alert('Group started!\n\nShare this code with your friends:\n\n  ' + row.code);
      });
    }).catch(function (e) {
      console.error('[group]', e);
      alert('Failed to start group: ' + (e.message || e));
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
        if (!confirm('Joining will replace your current scorecard. Continue?')) return;
      }
      window.spins = [];
      if (typeof window.refreshAll === 'function') window.refreshAll();
      state = { role: 'viewer', sessionId: row.id, code: row.code, channel: null };
      return sb.from('group_spins').select('*').eq('session_id', row.id).order('spin_index', { ascending: true })
        .then(function (sp) {
          if (sp.data) sp.data.forEach(function (rr) { applyRemoteSpin(rr.number); });
          subscribeSpins();
          updateUI();
        });
    }).catch(function (e) {
      console.error('[group]', e);
      alert('Failed to join: ' + (e.message || e));
    });
  }

  function applyRemoteSpin(num) {
    applyingRemote = true;
    try {
      var fn = window._origAddSpin || window.addSpin;
      if (typeof fn === 'function') fn(num);
    } finally {
      applyingRemote = false;
    }
  }

  function subscribeSpins() {
    if (!sb || !state.sessionId) return;
    var ch = sb.channel('gs:' + state.sessionId)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'group_spins',
          filter: 'session_id=eq.' + state.sessionId },
        function (p) { applyRemoteSpin(p.new.number); })
      .subscribe();
    state.channel = ch;
  }

  function leaveGroup() {
    var p = Promise.resolve();
    if (state.role === 'host' && sb && state.sessionId) {
      p = sb.from('group_sessions').update({ ended_at: new Date().toISOString() }).eq('id', state.sessionId).then(function () {});
    }
    if (state.channel && sb) { try { sb.removeChannel(state.channel); } catch (e) {} }
    state = { role: null, sessionId: null, code: null, channel: null };
    p.finally ? p.finally(updateUI) : p.then(updateUI, updateUI);
  }

  function installHook() {
    if (typeof window.addSpin !== 'function') return false;
    if (window._origAddSpin) return true;
    window._origAddSpin = window.addSpin;
    window.addSpin = function (num) {
      var res = window._origAddSpin.apply(this, arguments);
      try {
        if (!applyingRemote && state.role === 'host' && sb && state.sessionId) {
          var idx = (window.spins && window.spins.length) || 0;
          sb.from('group_spins').insert({ session_id: state.sessionId, spin_index: idx, number: num }).then(function () {});
        }
      } catch (e) { console.warn('[group] publish failed', e); }
      return res;
    };
    return true;
  }

  function init() {
    buildUI();
    installHook();
    setTimeout(installHook, 500);
    setTimeout(installHook, 2000);
    ensureClient().catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
