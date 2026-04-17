/*
 * LayFive Live P&L Tracker (v1)
 * -----------------------------
 * Adds a rightmost "P&L" column to the scorecard and a sticky stats panel
 * showing live profit/loss as the host enters spins.
 *
 * Betting model (confirmed):
 *   - 1 element covers 12 straight + 6 split = 15 betting spots per spin.
 *   - Per-spot bet = unit_count × unit_value.
 *   - Cost per spin = 15 × unit_count × unit_value.
 *   - Straight hit ('s') net = +21 × uc × uv (36-for-1 on 1 spot, minus 15 wagered).
 *   - Split  hit ('sp') net = +3 × uc × uv  (18-for-1 on 1 spot, minus 15 wagered).
 *   - Miss   ('-')   net   = -15 × uc × uv.
 *   - Min bankroll = 4 × cost_per_spin = 60 × uc × uv. Hard rule: never refill.
 *
 * UI:
 *   - "💰 P&L Setup" button (next to Group buttons) opens a setup modal.
 *   - On confirm, a sticky stats panel shows: element, bankroll, unit, spins, P&L, remaining.
 *   - A new column at the right of every scorecard row shows that spin's net P&L.
 *   - Mid-session element switch is allowed only if remaining covers 4× new bet
 *     (or the user chooses to reduce unit count so 4 spins fit).
 */
(function () {
  'use strict';

  var ELS = ['M', 'W', 'Wa', 'F', 'E'];
  var EL_NAMES = { M: 'Metal', W: 'Wood', Wa: 'Water', F: 'Fire', E: 'Earth' };
  var SPOTS_PER_SPIN = 15;
  var STRAIGHT_NET_MUL = 21;
  var SPLIT_NET_MUL = 3;
  var MISS_NET_MUL = -15;
  var MIN_BR_MUL = 60;
  var LS_KEY = 'lf_pnl_session_v1';

  var pnl = {
    active: false,
    element: null,
    unitCount: 0,
    unitValue: 0,
    startBankroll: 0,
    startSpinCount: 0,   // spins.length when session started (P&L only counts later spins)
    netPL: 0,            // running net P&L
    spinsPlayed: 0,
    skipNext: false,     // when true, the next spin is recorded but not bet on (delta = 0)
    history: []          // [{ spinIdx, num, hitType, delta, runningPL, skipped? }]
  };

  // ---------- helpers ----------
  function costPerSpin() { return SPOTS_PER_SPIN * pnl.unitCount * pnl.unitValue; }
  function fmt(n) {
    var abs = Math.abs(Math.round(n * 100) / 100);
    var s = (abs % 1 === 0) ? abs.toFixed(0) : abs.toFixed(2);
    return (n < 0 ? '-' : '') + '$' + s;
  }
  function remaining() { return pnl.startBankroll + pnl.netPL; }

  function netForHit(type) {
    var u = pnl.unitCount * pnl.unitValue;
    if (type === 's') return STRAIGHT_NET_MUL * u;
    if (type === 'sp') return SPLIT_NET_MUL * u;
    return MISS_NET_MUL * u;
  }
  // Gross payout (cash returned) for this spin, including stake on winning spots.
  // Straight = 36u, Split = 18u, Miss = 0.
  function payoutForHit(type) {
    var u = pnl.unitCount * pnl.unitValue;
    if (type === 's') return 36 * u;
    if (type === 'sp') return 18 * u;
    return 0;
  }

  // Re-sync netPL / spinsPlayed / history from current scorecard row count.
  // Call after any refresh (covers Undo, row deletions, etc.) so the session
  // total always matches what the user sees on-screen.
  function resyncPL() {
    if (!pnl.active) return;
    var cnt = (typeof window._lfGetSpinCount === 'function') ? window._lfGetSpinCount() : 0;
    pnl.history = pnl.history.filter(function (h) { return h.spinIdx <= cnt; });
    var sum = 0;
    for (var i = 0; i < pnl.history.length; i++) sum += pnl.history[i].delta;
    pnl.netPL = sum;
    pnl.spinsPlayed = pnl.history.length;
  }

  function persist() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(pnl)); } catch (e) {}
  }
  function restore() {
    try {
      var s = localStorage.getItem(LS_KEY);
      if (!s) return;
      var p = JSON.parse(s);
      if (p && p.active) {
        pnl = p;
      }
    } catch (e) {}
  }

  // ---------- Setup modal ----------
  function openSetupModal(switching) {
    closeSetupModal();
    var overlay = document.createElement('div');
    overlay.id = 'pnl-setup-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:12px';
    var box = document.createElement('div');
    box.style.cssText = 'background:#1a1f2e;border:2px solid #d4af37;border-radius:12px;padding:16px;width:100%;max-width:340px;color:#eee;font-size:.95em';
    var title = switching ? 'Switch Element' : 'Live P&L Setup';
    var elOpts = ELS.map(function (e) {
      var sel = (pnl.element === e) ? ' selected' : '';
      return '<option value="' + e + '"' + sel + '>' + EL_NAMES[e] + '</option>';
    }).join('');
    box.innerHTML =
      '<h3 style="color:#d4af37;text-align:center;margin:0 0 10px">' + title + '</h3>' +
      '<label style="display:block;margin:8px 0">Element:<br>' +
        '<select id="pnl-el" style="width:100%;padding:6px;background:#0f1320;color:#eee;border:1px solid #444;border-radius:6px;font-size:1em">' + elOpts + '</select>' +
      '</label>' +
      '<label style="display:block;margin:8px 0">Unit count (chips per spot):<br>' +
        '<input id="pnl-uc" type="number" min="0" step="1" value="' + (pnl.unitCount || 1) + '" style="width:100%;padding:6px;background:#0f1320;color:#eee;border:1px solid #444;border-radius:6px;font-size:1em" title="Set to 0 to pause betting (track spins only, no P&L impact)">' +
      '</label>' +
      '<label style="display:block;margin:8px 0">Unit value ($):<br>' +
        '<input id="pnl-uv" type="number" min="0.01" step="0.01" value="' + (pnl.unitValue || 5) + '" style="width:100%;padding:6px;background:#0f1320;color:#eee;border:1px solid #444;border-radius:6px;font-size:1em">' +
      '</label>' +
      '<label style="display:block;margin:8px 0">Real starting bankroll ($) — for P&amp;L tracking:<br>' +
        '<input id="pnl-br" type="number" min="0" step="0.01" value="' + (pnl.startBankroll || '') + '" placeholder="leave blank to use 4-spin min" style="width:100%;padding:6px;background:#0f1320;color:#eee;border:1px solid #d4af37;border-radius:6px;font-size:1em">' +
      '</label>' +
      '<div id="pnl-calc" style="margin:10px 0;padding:8px;background:#0f1320;border-radius:6px;font-size:.9em;line-height:1.5"></div>' +
      '<div id="pnl-warn" style="color:#ff9a3c;font-size:.85em;margin:6px 0;display:none"></div>' +
      '<div style="display:flex;gap:8px;margin-top:12px">' +
        '<button id="pnl-cancel" style="flex:1;padding:8px;background:#444;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer">Cancel</button>' +
        '<button id="pnl-ok" style="flex:2;padding:8px;background:#d4af37;color:#000;border:none;border-radius:6px;font-weight:700;cursor:pointer">' + (switching ? 'Switch' : 'Start') + '</button>' +
      '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function recalc() {
      var uc = parseInt(document.getElementById('pnl-uc').value, 10) || 0;
      var uv = parseFloat(document.getElementById('pnl-uv').value) || 0;
      var perSpin = SPOTS_PER_SPIN * uc * uv;
      var minBR = MIN_BR_MUL * uc * uv;
      var calc = document.getElementById('pnl-calc');
      calc.innerHTML =
        'Cost per spin: <b>' + fmt(perSpin) + '</b><br>' +
        'Min bankroll (4 spins): <b>' + fmt(minBR) + '</b><br>' +
        '<span style="color:#9c9">Straight win: +' + fmt(STRAIGHT_NET_MUL * uc * uv) + '</span> · ' +
        '<span style="color:#cc9">Split win: +' + fmt(SPLIT_NET_MUL * uc * uv) + '</span> · ' +
        '<span style="color:#c99">Miss: ' + fmt(MISS_NET_MUL * uc * uv) + '</span>';
      var warn = document.getElementById('pnl-warn');
      if (switching) {
        var rem = remaining();
        if (rem < minBR) {
          warn.style.display = '';
          warn.innerHTML = '⚠ Remaining bankroll ' + fmt(rem) + ' won\'t cover 4 spins at this size. Reduce unit count to ' + Math.max(1, Math.floor(rem / (60 * uv))) + ' or lower bet.';
        } else {
          warn.style.display = 'none';
        }
      }
    }
    document.getElementById('pnl-uc').oninput = recalc;
    document.getElementById('pnl-uv').oninput = recalc;
    recalc();

    document.getElementById('pnl-cancel').onclick = closeSetupModal;
    document.getElementById('pnl-ok').onclick = function () {
      var el = document.getElementById('pnl-el').value;
      var uc = parseInt(document.getElementById('pnl-uc').value, 10) || 0;
      var uv = parseFloat(document.getElementById('pnl-uv').value) || 0;
      if (!el || uc < 0 || uv <= 0) { alert('Fill in all fields with valid numbers (unit count can be 0 to pause betting).'); return; }
      var perSpin = SPOTS_PER_SPIN * uc * uv;
      var minBR = MIN_BR_MUL * uc * uv;
      if (switching) {
        if (remaining() < minBR) {
          if (!confirm('Remaining bankroll ' + fmt(remaining()) + ' won\'t cover 4 spins of ' + fmt(perSpin) + '.\n\nProceed anyway? (Hard rule: never refill bankroll.)')) return;
        }
        pnl.element = el;
        pnl.unitCount = uc;
        pnl.unitValue = uv;
      } else {
        var brInput = document.getElementById('pnl-br');
        var realBR = brInput ? parseFloat(brInput.value) : NaN;
        if (!isFinite(realBR) || realBR <= 0) realBR = minBR;
        pnl.active = true;
        pnl.element = el;
        pnl.unitCount = uc;
        pnl.unitValue = uv;
        pnl.startBankroll = realBR;       // actual bankroll entered by user (or 4-spin min fallback)
        pnl.sessionMin = minBR;           // suggested minimum for reference
        pnl.startSpinCount = (typeof window._lfGetSpinCount === 'function') ? window._lfGetSpinCount() : 0;
        pnl.netPL = 0;
        pnl.spinsPlayed = 0;
        pnl.history = [];
      }
      persist();
      closeSetupModal();
      buildStatsPanel();
      injectColumn();
    };
  }
  function closeSetupModal() {
    var o = document.getElementById('pnl-setup-overlay');
    if (o) o.remove();
  }

  // ---------- Sticky top wrapper ----------
  // Groups .actions (incl. Undo), #gs-bar, and #pnl-stats into a single
  // sticky container so the whole control strip stays visible while the
  // scorecard scrolls.
  function installStickyTop() {
    var pane = document.getElementById('p0');
    if (!pane) return null;
    var wrap = document.getElementById('pnl-sticky-top');
    if (wrap) { updateStickyTopOffset(); return wrap; }
    var actions = pane.querySelector('.actions');
    if (!actions) return null;
    wrap = document.createElement('div');
    wrap.id = 'pnl-sticky-top';
    wrap.style.cssText = 'position:sticky;z-index:60;background:#0f1320;padding:4px 0;margin:0 -4px 4px;box-shadow:0 2px 6px rgba(0,0,0,.4)';
    actions.parentNode.insertBefore(wrap, actions);
    wrap.appendChild(actions);
    var gsBar = document.getElementById('gs-bar');
    if (gsBar) wrap.appendChild(gsBar);
    updateStickyTopOffset();
    window.addEventListener('resize', updateStickyTopOffset);
    return wrap;
  }
  // Sit below the app's existing sticky .top bar + .tabs strip so Undo stays visible.
  function updateStickyTopOffset() {
    var wrap = document.getElementById('pnl-sticky-top');
    if (!wrap) return;
    var off = 0;
    var topBar = document.querySelector('.top');
    var tabs = document.querySelector('.tabs');
    if (topBar && getComputedStyle(topBar).position === 'sticky') off += topBar.offsetHeight;
    if (tabs && getComputedStyle(tabs).position === 'sticky') off += tabs.offsetHeight;
    wrap.style.top = off + 'px';
  }

  // ---------- Stats panel ----------
  function buildStatsPanel() {
    var existing = document.getElementById('pnl-stats');
    if (existing) existing.remove();
    if (!pnl.active) return;
    var pane = document.getElementById('p0');
    if (!pane) return;
    var panel = document.createElement('div');
    panel.id = 'pnl-stats';
    panel.style.cssText = 'background:#0f1320;border:1px solid #d4af37;border-radius:8px;padding:8px 10px;margin:6px 0 0;font-size:.85em;color:#eee;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center';
    refreshStatsPanel(panel);
    var wrap = installStickyTop();
    if (wrap) wrap.appendChild(panel);
    else {
      var scwrap = pane.querySelector('.sc-wrap');
      if (scwrap) scwrap.parentNode.insertBefore(panel, scwrap);
      else pane.appendChild(panel);
    }
  }
  function refreshStatsPanel(panel) {
    panel = panel || document.getElementById('pnl-stats');
    if (!panel) return;
    var rem = remaining();
    var pct = pnl.startBankroll ? (pnl.netPL / pnl.startBankroll * 100) : 0;
    var plColor = pnl.netPL >= 0 ? '#22ff22' : '#ff3333';
    var paused = (pnl.unitCount === 0);
    var betLabel = paused
      ? '<b style="color:#ff9a3c">PAUSED (0 units)</b>'
      : '<b>' + pnl.unitCount + '×' + fmt(pnl.unitValue) + '</b> (cost ' + fmt(costPerSpin()) + '/spin)';
    var skipBtnStyle = pnl.skipNext
      ? 'background:#ff9a3c;color:#000;border:1px solid #ffc080'
      : 'background:#3a5a8a;color:#fff;border:1px solid #6a8acc';
    var skipLabel = pnl.skipNext ? '⏭ Skip armed' : '⏭ Skip next';
    panel.innerHTML =
      '<span><b style="color:#d4af37">' + EL_NAMES[pnl.element] + '</b></span>' +
      '<span>Bet: ' + betLabel + '</span>' +
      '<span>Spins: <b>' + pnl.spinsPlayed + '</b></span>' +
      '<span>P&amp;L: <b style="color:' + plColor + '">' + fmt(pnl.netPL) + ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(0) + '%)</b></span>' +
      '<span>Remaining: <b>' + fmt(rem) + '</b> / start ' + fmt(pnl.startBankroll) + '</span>' +
      '<span style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">' +
        '<button id="pnl-skip-btn" style="' + skipBtnStyle + ';border-radius:6px;padding:3px 8px;font-size:.9em;cursor:pointer" title="Record the next spin with no bet (0 P&L). Click again to cancel.">' + skipLabel + '</button>' +
        '<button id="pnl-switch-btn" style="background:#5a3a8a;color:#fff;border:1px solid #8a6acc;border-radius:6px;padding:3px 8px;font-size:.9em;cursor:pointer">Switch</button>' +
        '<button id="pnl-tolog-btn" style="background:#2e7d32;color:#fff;border:1px solid #66bb6a;border-radius:6px;padding:3px 8px;font-size:.9em;cursor:pointer" title="Send this live P&L total to the W/L Log tab">💵 &rarr; W/L Log</button>' +
        '<button id="pnl-end-btn" style="background:#6b0f0f;color:#fff;border:1px solid #c94a4a;border-radius:6px;padding:3px 8px;font-size:.9em;cursor:pointer">End</button>' +
      '</span>';
    var sk = document.getElementById('pnl-skip-btn');
    if (sk) sk.onclick = function () {
      pnl.skipNext = !pnl.skipNext;
      persist();
      refreshStatsPanel();
    };
    var sw = document.getElementById('pnl-switch-btn');
    if (sw) sw.onclick = function () { openSetupModal(true); };
    var tl = document.getElementById('pnl-tolog-btn');
    if (tl) tl.onclick = function () {
      if (typeof window.saveLivePnlToWLLog === 'function') window.saveLivePnlToWLLog();
      else alert('W/L Log handler not loaded yet. Please reload the page.');
    };
    var en = document.getElementById('pnl-end-btn');
    if (en) en.onclick = endSession;
  }
  function endSession() {
    if (!confirm('End P&L session? Final result: ' + fmt(pnl.netPL))) return;
    pnl.active = false;
    persist();
    var p = document.getElementById('pnl-stats'); if (p) p.remove();
    injectColumn();
  }

  // ---------- Column injection ----------
  // Inserts the P&L column at position 2 (between # and Drop).
  // Cell width matches the Drop column for a narrow layout.
  function injectColumn() {
    var head = document.querySelector('.sc thead tr');
    if (!head) return;
    var existingTh = head.querySelector('.pnl-h');
    if (pnl.active) {
      if (!existingTh) {
        var th = document.createElement('th');
        th.className = 'pnl-h sn';
        th.style.cssText = 'color:#d4af37;font-size:.8em;padding:2px';
        th.textContent = 'P&L';
        // Insert after the first <th> (# column), before Drop
        if (head.children.length >= 2) head.insertBefore(th, head.children[1]);
        else head.appendChild(th);
      }
    } else if (existingTh) {
      existingTh.remove();
    }
    var rows = document.querySelectorAll('.sc tbody tr');
    rows.forEach(function (tr, idx) {
      var existing = tr.querySelector('.pnl-c');
      if (existing) existing.remove();
      if (!pnl.active) return;
      var td = document.createElement('td');
      td.className = 'pnl-c sn';
      td.style.cssText = 'font-size:.8em;font-weight:900;text-align:center;padding:2px 1px;font-variant-numeric:tabular-nums;line-height:1.1;background:rgba(0,0,0,.25);overflow:hidden;letter-spacing:-0.3px;white-space:nowrap';
      var rowNum = idx + 1;
      var entry = pnl.history.find(function (h) { return h.spinIdx === rowNum; });
      if (entry) {
        if (entry.skipped) {
          // Skipped spin: no bet placed, no P&L impact. Show neutral indicator.
          td.innerHTML =
            '<span style="color:#888">—</span>' +
            '<br><span style="color:#ff9a3c;font-size:.8em">SKIP</span>';
        } else {
          // Display: top = payout total this spin, bottom = net profit (+), or "$0 / $0" on miss.
          var isWin = entry.hitType === 's' || entry.hitType === 'sp';
          var payout = (typeof entry.payout === 'number') ? entry.payout : (isWin ? (entry.delta + 15 * pnl.unitCount * pnl.unitValue) : 0);
          if (isWin) {
            td.innerHTML =
              '<span style="color:#22ff22;text-shadow:0 0 2px #0a0">' + fmt(payout) + '</span>' +
              '<br><span style="color:#22ff22;font-size:.9em;text-shadow:0 0 2px #0a0">+' + fmt(entry.delta) + '</span>';
          } else {
            // Miss: $0 payout on top, actual loss (-$X) on bottom.
            td.innerHTML =
              '<span style="color:#bbb">$0</span>' +
              '<br><span style="color:#ff3333;font-size:.9em;text-shadow:0 0 2px #600">' + fmt(entry.delta) + '</span>';
          }
        }
      } else {
        td.textContent = '';
      }
      // Insert at position 1 (after # column, before Drop)
      if (tr.children.length >= 2) tr.insertBefore(td, tr.children[1]);
      else tr.appendChild(td);
    });
  }

  // ---------- Hook addSpin to update P&L on each new spin ----------
  function installHook() {
    if (window._lfPnlHookInstalled) return true;
    if (typeof window.addSpin !== 'function') return false;
    var orig = window.addSpin;
    window._lfPnlHookInstalled = true;
    window.addSpin = function (num) {
      var beforeLen = (typeof window._lfGetSpinCount === 'function') ? window._lfGetSpinCount() : 0;
      var res = orig.apply(this, arguments);
      try {
        if (pnl.active && pnl.element) {
          var afterLen = (typeof window._lfGetSpinCount === 'function') ? window._lfGetSpinCount() : (beforeLen + 1);
          var spinIdx = afterLen; // 1-based row
          // Determine hit type via the app's hitType function
          var ht = (typeof window.hitType === 'function') ? window.hitType(num, pnl.element) : '-';
          // Skip logic: if Skip-next armed OR unitCount=0 (paused), record spin with 0 delta.
          var isSkipped = pnl.skipNext || (pnl.unitCount === 0);
          var delta = isSkipped ? 0 : netForHit(ht);
          var payout = isSkipped ? 0 : payoutForHit(ht);
          pnl.netPL += delta;
          pnl.spinsPlayed += 1;
          pnl.history.push({
            spinIdx: spinIdx,
            num: num,
            hitType: ht,
            delta: delta,
            payout: payout,
            runningPL: pnl.netPL,
            skipped: isSkipped
          });
          // Consume the one-shot skip flag (but leave unitCount=0 pause persistent).
          if (pnl.skipNext) pnl.skipNext = false;
          persist();
          refreshStatsPanel();
          // Re-inject immediately so the current spin's P&L shows up now,
          // not on the next refresh. (refreshAll already ran inside orig.apply,
          // before we pushed to history.)
          injectColumn();
        }
      } catch (e) { console.warn('[pnl] update failed', e); }
      // Lead-loss check runs on EVERY spin — uses pnl.element if P&L active,
      // otherwise uses the manually selected element from the scorecard picker.
      try { checkLeadLoss(); } catch (e) { console.warn('[pnl] lead-loss check failed', e); }
      return res;
    };
    return true;
  }

  // Hook refreshAll so our column is re-injected after every scorecard rebuild
  function installRefreshHook() {
    if (window._lfPnlRefreshHooked) return true;
    if (typeof window.refreshAll !== 'function') return false;
    var orig = window.refreshAll;
    window._lfPnlRefreshHooked = true;
    window.refreshAll = function () {
      var res = orig.apply(this, arguments);
      try { resyncPL(); refreshStatsPanel(); injectColumn(); } catch (e) {}
      return res;
    };
    return true;
  }

  // Expose a helper so other layfive scripts can read spin count without poking internals.
  // The app uses `let spins` so window.spins is undefined; we count rows in the DOM.
  // CRITICAL: exclude .pnl-c cells — our own injected P&L <td>s also carry the
  // `sn` class for sizing, so a naive `.sn:not(.empty)` count would double (or
  // more) and throw spinIdx completely off.
  window._lfGetSpinCount = function () {
    var rows = document.querySelectorAll('.sc tbody tr td.sn:not(.empty):not(.pnl-c)');
    return rows.length;
  };

  // ---------- Top-bar button ----------
  function buildButton() {
    var pane = document.getElementById('p0');
    if (!pane) return;
    var bar = document.getElementById('gs-bar');
    if (!bar) {
      // fall back to actions row if group bar isn't there yet
      bar = pane.querySelector('.actions');
      if (!bar) return;
    }
    if (document.getElementById('pnl-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'pnl-btn';
    btn.style.cssText = 'background:#8a6010;color:#fff;border:1px solid #d4af37;border-radius:6px;padding:5px 10px;font-weight:700;cursor:pointer';
    btn.textContent = '💰 P&L';
    btn.onclick = function () {
      if (window._lfAuth && !window._lfAuth.gateFeature('pnl')) return;
      openSetupModal(false);
    };
    bar.appendChild(btn);
  }

  // ========== LEAD-LOSS WARNING (Premium / Live P&L) ==========
  // Rolling last-20 check: if another element takes a 2-spin lead over the
  // player's selected element, pop up a warning so they can Restart and
  // follow the new leader.  Completely separate from C2 rule logic.
  var _leadLossDismissed = false;  // reset each time a new leader emerges

  function checkLeadLoss() {
    // Determine which element the player is tracking:
    // 1) If P&L is active, use pnl.element
    // 2) Otherwise, use the manually selected element from the scorecard picker
    var trackedEl = null;
    if (pnl.active && pnl.element) {
      trackedEl = pnl.element;
    } else if (typeof window._lfGetMyElement === 'function') {
      trackedEl = window._lfGetMyElement();
    }
    if (!trackedEl) return;

    var getSpins = window._lfGetSpins;
    if (typeof getSpins !== 'function') return;
    var allSpins = getSpins();
    if (!allSpins || allSpins.length < 12) return;

    // Respect restart offset — only look at visible spins
    var offset = (typeof window._lfGetRestartOffset === 'function') ? window._lfGetRestartOffset() : 0;
    var visible = offset > 0 ? allSpins.slice(offset) : allSpins;
    if (visible.length < 12) return;

    // Take the last 20 of visible spins
    var window20 = visible.slice(-20);

    // Count hits per element in the window
    var counts = {};
    ELS.forEach(function (el) { counts[el] = 0; });
    window20.forEach(function (sp) {
      ELS.forEach(function (el) {
        if (sp.hits && sp.hits[el] && sp.hits[el] !== '-') counts[el]++;
      });
    });

    var myCount = counts[trackedEl] || 0;

    // Find the leader that isn't the player's element
    var topEl = null, topCount = 0;
    ELS.forEach(function (el) {
      if (el !== trackedEl && counts[el] > topCount) {
        topCount = counts[el];
        topEl = el;
      }
    });

    // Warn when ANY other element takes a lead (gap >= 1) over the tracked element
    var gap = topCount - myCount;
    if (gap >= 1 && topEl && !_leadLossDismissed) {
      showLeadLossWarning(topEl, topCount, myCount, gap, trackedEl);
    }
    // Reset dismissed flag when no one leads anymore (so it fires again next time a new leader appears)
    if (gap < 1) _leadLossDismissed = false;
  }

  function showLeadLossWarning(leaderEl, leaderCount, myCount, gap, trackedEl) {
    // Don't stack multiple warnings
    if (document.getElementById('lead-loss-overlay')) return;
    _leadLossDismissed = true;

    var leaderName = EL_NAMES[leaderEl] || leaderEl;
    var myName = EL_NAMES[trackedEl] || trackedEl;

    var overlay = document.createElement('div');
    overlay.id = 'lead-loss-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:10000;display:flex;align-items:center;justify-content:center;padding:12px';

    var box = document.createElement('div');
    box.style.cssText = 'background:#1a1f2e;border:2px solid #ff4444;border-radius:12px;padding:20px;width:100%;max-width:320px;color:#eee;text-align:center';
    box.innerHTML =
      '<div style="font-size:2em;margin-bottom:8px">⚠️</div>' +
      '<h3 style="color:#ff4444;margin:0 0 10px">Lead Lost!</h3>' +
      '<p style="font-size:.95em;line-height:1.5;margin:0 0 12px">' +
        '<b style="color:#ff9a3c">' + leaderName + '</b> now leads the last 20 spins with <b>' + leaderCount + ' hits</b>.<br>' +
        'Your element <b style="color:#d4af37">' + myName + '</b> has <b>' + myCount + ' hits</b>.<br>' +
        '<span style="color:#ff4444;font-weight:700">Gap: ' + gap + ' spins behind.</span>' +
      '</p>' +
      '<p style="font-size:.85em;color:#aaa;margin:0 0 14px">Consider hitting <b>Restart</b> to hunt for a new 2-spin leader.</p>' +
      '<div style="display:flex;gap:8px">' +
        '<button id="ll-dismiss" style="flex:1;padding:10px;background:#444;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer">Got it</button>' +
        '<button id="ll-restart" style="flex:1;padding:10px;background:linear-gradient(135deg,#ff8c00,#cc4400);color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer">⟳ Restart</button>' +
      '</div>';

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    document.getElementById('ll-dismiss').onclick = function () {
      overlay.remove();
    };
    document.getElementById('ll-restart').onclick = function () {
      overlay.remove();
      // Trigger the app's restart function
      if (typeof window.restartSess === 'function') {
        window.restartSess();
      }
    };

    // Also close on overlay tap outside the box
    overlay.onclick = function (ev) {
      if (ev.target === overlay) overlay.remove();
    };
  }

  function init() {
    restore();
    installStickyTop();
    buildButton();
    installHook();
    installRefreshHook();
    setTimeout(function () { installStickyTop(); buildButton(); installHook(); installRefreshHook(); }, 500);
    setTimeout(function () { installStickyTop(); buildButton(); installHook(); installRefreshHook(); }, 2000);
    if (pnl.active) {
      buildStatsPanel();
      injectColumn();
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
