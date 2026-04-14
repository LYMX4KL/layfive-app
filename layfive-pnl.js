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
    history: []          // [{ spinIdx, num, hitType, delta, runningPL }]
  };

  // ---------- helpers ----------
  function costPerSpin() { return SPOTS_PER_SPIN * pnl.unitCount * pnl.unitValue; }
  function fmt(n) { return (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n * 100) / 100).toFixed(2); }
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
        '<input id="pnl-uc" type="number" min="1" step="1" value="' + (pnl.unitCount || 1) + '" style="width:100%;padding:6px;background:#0f1320;color:#eee;border:1px solid #444;border-radius:6px;font-size:1em">' +
      '</label>' +
      '<label style="display:block;margin:8px 0">Unit value ($):<br>' +
        '<input id="pnl-uv" type="number" min="0.01" step="0.01" value="' + (pnl.unitValue || 5) + '" style="width:100%;padding:6px;background:#0f1320;color:#eee;border:1px solid #444;border-radius:6px;font-size:1em">' +
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
      if (!el || uc < 1 || uv <= 0) { alert('Fill in all fields with positive numbers.'); return; }
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
        pnl.active = true;
        pnl.element = el;
        pnl.unitCount = uc;
        pnl.unitValue = uv;
        pnl.startBankroll = minBR;        // 4-spin minimum, hard rule
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
    var plColor = pnl.netPL >= 0 ? '#7fdc7f' : '#ff7373';
    panel.innerHTML =
      '<span><b style="color:#d4af37">' + EL_NAMES[pnl.element] + '</b></span>' +
      '<span>Bet: <b>' + pnl.unitCount + '×' + fmt(pnl.unitValue) + '</b> (cost ' + fmt(costPerSpin()) + '/spin)</span>' +
      '<span>Spins: <b>' + pnl.spinsPlayed + '</b></span>' +
      '<span>P&amp;L: <b style="color:' + plColor + '">' + fmt(pnl.netPL) + ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(0) + '%)</b></span>' +
      '<span>Remaining: <b>' + fmt(rem) + '</b> / start ' + fmt(pnl.startBankroll) + '</span>' +
      '<span style="margin-left:auto;display:flex;gap:6px">' +
        '<button id="pnl-switch-btn" style="background:#5a3a8a;color:#fff;border:1px solid #8a6acc;border-radius:6px;padding:3px 8px;font-size:.9em;cursor:pointer">Switch</button>' +
        '<button id="pnl-end-btn" style="background:#6b0f0f;color:#fff;border:1px solid #c94a4a;border-radius:6px;padding:3px 8px;font-size:.9em;cursor:pointer">End</button>' +
      '</span>';
    var sw = document.getElementById('pnl-switch-btn');
    if (sw) sw.onclick = function () { openSetupModal(true); };
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
      td.style.cssText = 'font-size:.7em;text-align:center;padding:1px 2px;font-variant-numeric:tabular-nums;line-height:1.1';
      var rowNum = idx + 1;
      var entry = pnl.history.find(function (h) { return h.spinIdx === rowNum; });
      if (entry) {
        // Display: top = payout total this spin, bottom = net profit (+), or "$0 / $0" on miss.
        var isWin = entry.hitType === 's' || entry.hitType === 'sp';
        var payout = (typeof entry.payout === 'number') ? entry.payout : (isWin ? (entry.delta + 15 * pnl.unitCount * pnl.unitValue) : 0);
        if (isWin) {
          td.innerHTML =
            '<span style="color:#7fdc7f">' + fmt(payout) + '</span>' +
            '<br><span style="color:#7fdc7f;font-size:.85em">+' + fmt(entry.delta) + '</span>';
        } else {
          // Miss: $0 payout on top, actual loss (-$X) on bottom.
          td.innerHTML =
            '<span style="color:#888">$0</span>' +
            '<br><span style="color:#ff7373;font-size:.85em">' + fmt(entry.delta) + '</span>';
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
          var delta = netForHit(ht);
          pnl.netPL += delta;
          pnl.spinsPlayed += 1;
          pnl.history.push({ spinIdx: spinIdx, num: num, hitType: ht, delta: delta, payout: payoutForHit(ht), runningPL: pnl.netPL });
          persist();
          refreshStatsPanel();
          // Re-inject immediately so the current spin's P&L shows up now,
          // not on the next refresh. (refreshAll already ran inside orig.apply,
          // before we pushed to history.)
          injectColumn();
        }
      } catch (e) { console.warn('[pnl] update failed', e); }
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
      try { injectColumn(); } catch (e) {}
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
    btn.onclick = function () { openSetupModal(false); };
    bar.appendChild(btn);
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
