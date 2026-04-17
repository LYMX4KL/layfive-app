/* =========================================================================
 * layfive-rules.js — anti-tilt suggestion / caution / hard-stop engine
 * -------------------------------------------------------------------------
 * Ruleset v3.1 (2026-04-16). Data-validated against 115 sessions / 4,352 spins.
 *
 * Runs only when a live P&L session is active (lf_pnl_session_v1 with
 * active:true). After each spin (we hook refreshAll), we evaluate metrics
 * against three tiers of rules:
 *   - suggestion     (green star — element with session-wide lead >= 2)
 *   - caution        (non-blocking banner — C1, C2, C3)
 *   - hard-stop      (blocking modal — H1, H2, H4)
 *
 * Grace period: First 12 spins are pre-existing casino scoreboard data.
 * NO rules fire during grace period.
 *
 * Windows:
 *   - Session window  = all spins including pre-existing board records
 *   - Last-15 window  = scorecard signals, C2, C3, H4
 *   - Last-20 window  = C2, C3, H2
 *   - Last-25 window  = C2, C3
 *
 * Changes from v2:
 *   - H3 removed (covered by C2 rolling checks)
 *   - H5 removed (covered by C2 rolling checks)
 *   - C1 lowered from 35 to 30 spins on top of 12 grace
 *   - C2 deduplicated: fires once per new leader, auto-dismisses until
 *     a different element takes lead (-90% alert noise)
 *   - C2 checks rolling at last-15/20/25 windows
 *   - H4 uses last-15 window (streak-4)
 *   - Suggestion: wait for lead >= 2 to emerge naturally (avg spin 19)
 *
 * Dependencies (defined by index.html and layfive-pnl.js):
 *   - window.hitType(num, el)
 *   - window.refreshAll  (we wrap it)
 *   - localStorage key  'lf_pnl_session_v1'
 *
 * Override state is persisted inside pnl.overrides{ruleId:{ts}} so the same
 * warning doesn't re-fire every spin after the user has already chosen to
 * override or End.
 * ========================================================================= */
(function () {
  if (window._lfRulesInstalled) return;
  window._lfRulesInstalled = true;

  var ELS = ['M', 'W', 'Wa', 'F', 'E'];
  var EL_NAMES = { M: 'Metal', W: 'Wood', Wa: 'Water', F: 'Fire', E: 'Earth' };
  var LS_KEY = 'lf_pnl_session_v1';

  function readPnl() {
    try { var s = localStorage.getItem(LS_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  function writePnl(p) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch (e) {}
  }

  // Build per-spin hit map for every element. pnl.history entries only carry
  // hitType for the *selected* element, so we recompute for all 5 elements
  // using window.hitType(num, el).
  function buildPerSpinHits(pnl) {
    if (!pnl || !pnl.history) return [];
    var fn = window.hitType;
    if (typeof fn !== 'function') return [];
    return pnl.history.map(function (h) {
      var hits = {};
      ELS.forEach(function (el) { hits[el] = fn(h.num, el); });
      return { num: h.num, hits: hits, delta: h.delta, hitTypeSelected: h.hitType };
    });
  }

  function countHits(entries, el) {
    var c = 0;
    for (var i = 0; i < entries.length; i++) {
      var h = entries[i].hits[el];
      if (h === 's' || h === 'sp') c++;
    }
    return c;
  }
  function blanksCount(entries, el) {
    var c = 0;
    for (var i = 0; i < entries.length; i++) if (entries[i].hits[el] === '-') c++;
    return c;
  }
  // Number of consecutive most-recent blanks for el at the end of entries.
  function tailBlankStreak(entries, el) {
    var c = 0;
    for (var i = entries.length - 1; i >= 0; i--) {
      if (entries[i].hits[el] === '-') c++; else break;
    }
    return c;
  }
  // Any consecutive blank streak of ≥ k anywhere in entries.
  function hasBlankStreak(entries, el, k) {
    var run = 0;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].hits[el] === '-') { run++; if (run >= k) return true; }
      else run = 0;
    }
    return false;
  }

  // Leader info for a given window: returns {leader, count, lead} where
  // `lead` is leader's count minus the 2nd place. If tie for first, leader
  // is null and lead is 0 (but coLeaders array tells caller how many tied).
  function leaderOf(entries) {
    var counts = {};
    ELS.forEach(function (el) { counts[el] = countHits(entries, el); });
    var sorted = ELS.slice().sort(function (a, b) { return counts[b] - counts[a]; });
    var topCount = counts[sorted[0]];
    var coLeaders = ELS.filter(function (el) { return counts[el] === topCount; });
    var secondCount = 0;
    for (var i = 0; i < sorted.length; i++) {
      if (counts[sorted[i]] < topCount) { secondCount = counts[sorted[i]]; break; }
    }
    return {
      leader: coLeaders.length === 1 ? coLeaders[0] : null,
      coLeaders: coLeaders,
      count: topCount,
      lead: topCount - secondCount,
      counts: counts
    };
  }

  // Highest netPL reached at any point in entries (cumulative delta).
  function peakNet(entries) {
    var net = 0, peak = 0;
    for (var i = 0; i < entries.length; i++) { net += (entries[i].delta || 0); if (net > peak) peak = net; }
    return peak;
  }
  function hasAnyPositiveNet(entries) {
    var net = 0;
    for (var i = 0; i < entries.length; i++) { net += (entries[i].delta || 0); if (net > 0) return true; }
    return false;
  }

  // ---------- Rule evaluation (v3.1) ----------
  // Returns array of { id, severity, msg } — caller picks the highest.
  var GRACE_SPINS = 12; // first 12 spins = pre-existing board data, no rules fire

  function evaluate(pnl, entries) {
    var triggers = [];
    if (!pnl.active || !pnl.element) return triggers;

    // Grace period: no rules during the initial 12 board-input spins
    if (entries.length <= GRACE_SPINS) return triggers;

    var sel = pnl.element;
    var last15 = entries.slice(-15);
    var last20 = entries.slice(-20);
    var last25 = entries.slice(-25);
    var leadAll = leaderOf(entries);
    var lead15 = leaderOf(last15);
    var unitCost = (pnl.unitCount || 0) * (pnl.unitValue || 0) * 15; // bet per spin
    var remaining = (pnl.startBankroll || 0) + (pnl.netPL || 0);
    var selTailStreak = tailBlankStreak(entries, sel);

    // === HARD STOPS (blocking modal, Premium) ===

    // H1: Selected element lost 4 in a row (tail streak).
    // Override logged + visible on scorecard restore.
    if (selTailStreak >= 4) {
      triggers.push({
        id: 'H1_streak4',
        severity: 'hard',
        title: 'Hard stop: 4 losses in a row',
        msg: 'Your selected element <b>' + EL_NAMES[sel] + '</b> has missed ' + selTailStreak +
             ' spins in a row. Per rule, stop betting now.',
      });
    }

    // H2: Last 20 spins, net P&L never positive. No momentum — stop.
    if (entries.length >= 20) {
      if (!hasAnyPositiveNet(last20)) {
        triggers.push({
          id: 'H2_nomomentum20',
          severity: 'hard',
          title: 'Hard stop: 20 spins, never net ahead',
          msg: 'Over the last 20 spins the net P&L never went positive. No momentum — stop.',
        });
      }
    }

    // H4: ABSOLUTE HARD STOP — 4 of 5 elements cold (4-blank streak) in
    // last 15, and the 1 survivor is NOT leading. Strongest warning.
    if (entries.length >= 15) {
      var with4Blanks = ELS.filter(function (el) { return hasBlankStreak(last15, el, 4); });
      if (with4Blanks.length >= 4) {
        var survivors = ELS.filter(function (el) { return with4Blanks.indexOf(el) < 0; });
        var theOne = survivors[0] || null;
        if (theOne && lead15.leader !== theOne) {
          triggers.push({
            id: 'H4_4of5cold',
            severity: 'hard',
            title: '🚨 ABSOLUTE HARD STOP: 4 of 5 elements cold',
            msg: '4 of the 5 elements each had a 4-blank streak in the last 15 spins, and the survivor (<b>' +
                 EL_NAMES[theOne] + '</b>) isn\'t leading. This is the strongest warning — stop immediately.',
          });
        }
      }
    }

    // (H3 removed in v3.1 — covered by C2 rolling checks)
    // (H5 removed in v3.1 — covered by C2 rolling checks)

    // === CAUTION RULES (non-blocking banner, Premium) ===

    // C1: 30 spins on top of the initial 12 grace → end session.
    // (30 + 12 = 42 total entries)
    if (entries.length >= GRACE_SPINS + 30) {
      triggers.push({
        id: 'C1_30spins',
        severity: 'caution',
        title: '30 spins reached — end session',
        msg: 'You\'ve played ' + (entries.length - GRACE_SPINS) + ' spins on top of the initial 12. End the session regardless of W/L.',
      });
    }

    // C2: Rolling dedup check at last-15/20/25 windows.
    // Fire ONCE when a new element takes a 2-spin lead in ANY window.
    // Auto-dismiss until a DIFFERENT element takes over.
    // Suggest cover/stop/change depending on player's net P&L.
    var c2Leader = _c2CheckWindows(pnl, sel, last15, last20, last25);
    if (c2Leader) {
      var isUp = (pnl.netPL || 0) > 0;
      var canAfford4 = remaining >= 4 * unitCost;
      var c2msg;
      if (isUp) {
        c2msg = 'You\'re up, and <b>' + EL_NAMES[c2Leader] + '</b> has taken a 2+ spin lead. ' +
                'Consider switching to <b>' + EL_NAMES[c2Leader] + '</b> or stopping to lock gains' +
                (canAfford4 ? '.' : ' (reduce bet so 4 more spins are possible — do not refill).');
      } else {
        c2msg = '<b>' + EL_NAMES[c2Leader] + '</b> has a 2+ spin lead and you\'re not up yet. ' +
                'Stop now.' + (canAfford4 ? '' : ' Bankroll can\'t cover 4 more spins anyway.');
      }
      triggers.push({
        id: 'C2_leadchange_' + c2Leader,
        severity: 'caution',
        title: isUp ? 'New leader — switch or stop' : 'New leader — stop',
        msg: c2msg,
      });
    }

    // C3: Net P&L ≥ 100% of bankroll, lead 2–5 → lower bet to lock gain.
    if (pnl.startBankroll && pnl.netPL >= pnl.startBankroll) {
      if (leadAll.leader === sel && leadAll.lead >= 2 && leadAll.lead <= 5) {
        triggers.push({
          id: 'C3_100pct_holdlead',
          severity: 'caution',
          title: '100% up — consider locking gains',
          msg: 'You\'re up 100%+ of bankroll and your lead is still ' + leadAll.lead +
               ' spins. Lower your bet to lock in the 100% gain. If P&L drops back to 20% of bankroll, stop.',
        });
      }
    }

    // === SUGGESTIONS (informational — green star on element with lead >= 2) ===
    // Wait for lead >= 2 to emerge naturally. Mark X if 4 blanks in last 15.
    // (Suggestion display handled by index.html computeSignals, not modal/banner.)
    if (leadAll.leader && leadAll.lead >= 2) {
      triggers.push({
        id: 'SUG_leader_' + leadAll.leader,
        severity: 'suggestion',
        title: 'Suggested element: ' + EL_NAMES[leadAll.leader],
        msg: '<b>' + EL_NAMES[leadAll.leader] + '</b> leads by ' + leadAll.lead +
             ' in the session. Consider this element.',
      });
    }

    return triggers;
  }

  // C2 dedup helper: check rolling windows for a new leader with lead >= 2
  // that is NOT the selected element. Returns the new leader element key,
  // or null if no alert should fire.
  // Dedup: only fires when the leader is DIFFERENT from the last one we alerted on.
  // The last alerted leader is stored in pnl._c2LastAlerted.
  function _c2CheckWindows(pnl, sel, last15, last20, last25) {
    var windows = [last15];
    if (last20.length >= 20) windows.push(last20);
    if (last25.length >= 25) windows.push(last25);

    var newLeader = null;
    for (var i = 0; i < windows.length; i++) {
      var info = leaderOf(windows[i]);
      if (info.leader && info.lead >= 2 && info.leader !== sel) {
        newLeader = info.leader;
        break; // smallest window wins (most recent signal)
      }
    }
    if (!newLeader) return null;

    // Dedup: if we already alerted on this same leader, don't fire again
    if (pnl._c2LastAlerted === newLeader) return null;

    // New leader detected — record it and fire
    pnl._c2LastAlerted = newLeader;
    writePnl(pnl);
    return newLeader;
  }

  // ---------- Override memory ----------
  function wasOverridden(pnl, id) {
    return pnl.overrides && pnl.overrides[id];
  }
  function markOverride(pnl, id) {
    pnl.overrides = pnl.overrides || {};
    pnl.overrides[id] = { ts: Date.now() };
    writePnl(pnl);
  }
  function clearOverrides() {
    var p = readPnl(); if (!p) return;
    p.overrides = {};
    writePnl(p);
  }
  window._lfRulesClearOverrides = clearOverrides;

  // ---------- UI ----------
  function dismissAll() {
    var o = document.getElementById('lf-rules-modal'); if (o) o.remove();
    var b = document.getElementById('lf-rules-banner'); if (b) b.remove();
  }
  function showBanner(trig) {
    var id = 'lf-rules-banner';
    var existing = document.getElementById(id);
    if (existing && existing.dataset.trig === trig.id) return; // same trigger already up
    if (existing) existing.remove();
    var b = document.createElement('div');
    b.id = id;
    b.dataset.trig = trig.id;
    b.style.cssText = 'position:sticky;top:0;z-index:45;background:#c48a1a;color:#111;padding:8px 10px;text-align:center;font-weight:700;font-size:.88em;line-height:1.3;box-shadow:0 2px 6px rgba(0,0,0,.4)';
    b.innerHTML = '⚠️ <b>' + trig.title + ':</b> ' + trig.msg +
      ' <button onclick="_lfDismissBanner(\'' + trig.id + '\')" style="margin-left:8px;background:#111;color:#fff;border:none;border-radius:4px;padding:3px 8px;cursor:pointer;font-weight:700">Dismiss</button>';
    var tab0 = document.getElementById('p0') || document.body;
    tab0.insertBefore(b, tab0.firstChild);
  }
  window._lfDismissBanner = function (id) {
    var p = readPnl(); if (!p) return;
    markOverride(p, id);
    var b = document.getElementById('lf-rules-banner'); if (b) b.remove();
  };

  function showHardModal(trig) {
    var existing = document.getElementById('lf-rules-modal');
    if (existing && existing.dataset.trig === trig.id) return;
    if (existing) existing.remove();
    var ov = document.createElement('div');
    ov.id = 'lf-rules-modal';
    ov.dataset.trig = trig.id;
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:12px';
    var box = document.createElement('div');
    box.style.cssText = 'background:#2a0f0f;border:3px solid #ff3333;border-radius:12px;padding:18px;width:100%;max-width:440px;color:#fff;font-size:.95em;line-height:1.45;box-shadow:0 0 30px rgba(255,51,51,.4)';
    box.innerHTML =
      '<h3 style="color:#ff6666;text-align:center;margin:0 0 12px;font-size:1.1em">🛑 ' + trig.title + '</h3>' +
      '<div style="margin:8px 0 14px">' + trig.msg + '</div>' +
      '<div style="display:flex;gap:8px">' +
        '<button id="lf-rules-override" style="flex:1;padding:10px;background:#444;color:#fff;border:1px solid #777;border-radius:6px;font-weight:700;cursor:pointer">Override &amp; keep betting</button>' +
        '<button id="lf-rules-end" style="flex:2;padding:10px;background:#d4af37;color:#000;border:none;border-radius:6px;font-weight:700;cursor:pointer">End session</button>' +
      '</div>' +
      '<div style="font-size:.78em;color:#bbb;margin-top:10px;text-align:center">Override is logged on the session record.</div>';
    ov.appendChild(box);
    document.body.appendChild(ov);
    document.getElementById('lf-rules-override').onclick = function () {
      var p = readPnl(); if (p) { markOverride(p, trig.id); }
      dismissAll();
    };
    document.getElementById('lf-rules-end').onclick = function () {
      var p = readPnl();
      if (p) {
        p.active = false;
        p.overrides = p.overrides || {};
        p.overrides['__endedByRule'] = { ts: Date.now(), ruleId: trig.id };
        writePnl(p);
      }
      dismissAll();
      var panel = document.getElementById('pnl-stats'); if (panel) panel.remove();
      // Redraw column so P&L column disappears
      try { if (typeof window.refreshAll === 'function') window.refreshAll(); } catch (e) {}
      alert('Live P&L session ended per stopping rule.');
    };
  }

  // ---------- Main evaluation driver ----------
  function runEvaluation() {
    var pnl = readPnl();
    if (!pnl || !pnl.active) { dismissAll(); return; }
    var entries = buildPerSpinHits(pnl);
    if (entries.length === 0) return;
    var triggers = evaluate(pnl, entries)
      .filter(function (t) { return !wasOverridden(pnl, t.id); });
    if (!triggers.length) { dismissAll(); return; }
    // Priority: hard > caution. Among hard, take the first.
    var hard = triggers.filter(function (t) { return t.severity === 'hard'; });
    var soft = triggers.filter(function (t) { return t.severity === 'caution'; });
    if (hard.length) { showHardModal(hard[0]); return; }
    if (soft.length) { showBanner(soft[0]); return; }
  }
  window._lfRulesRun = runEvaluation;

  // Hook refreshAll so rules re-evaluate after every spin / undo.
  function installHook() {
    if (window._lfRulesRefreshHooked) return true;
    if (typeof window.refreshAll !== 'function') return false;
    var orig = window.refreshAll;
    window._lfRulesRefreshHooked = true;
    window.refreshAll = function () {
      var res = orig.apply(this, arguments);
      try { runEvaluation(); } catch (e) { console.error('lf-rules eval error', e); }
      return res;
    };
    return true;
  }
  function tryInstall() {
    if (installHook()) { try { runEvaluation(); } catch (e) {} return; }
    setTimeout(tryInstall, 400);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInstall);
  } else {
    tryInstall();
  }
})();
