/* =========================================================================
 * layfive-rules.js — anti-tilt suggestion / caution / hard-stop engine
 * -------------------------------------------------------------------------
 * Ruleset v2 (2026-04-14). See ANTI_TILT_RULES.md for full spec.
 *
 * Runs only when a live P&L session is active (lf_pnl_session_v1 with
 * active:true). After each spin (we hook refreshAll), we evaluate metrics
 * against three tiers of rules:
 *   - suggestion     (informational, shown on Switch / pre-session UI)
 *   - caution        (non-blocking banner at top of Scorecard)
 *   - hard-stop      (blocking modal with End / Override choice)
 *
 * Windows:
 *   - Session window  = pnl.history (every spin tracked since live P&L start)
 *   - Last-12 window  = the most recent 12 entries of pnl.history
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

  // ---------- Rule evaluation ----------
  // Returns array of { id, severity, msg, actions } — we'll pick the highest.
  function evaluate(pnl, entries) {
    var triggers = [];
    if (!pnl.active || !pnl.element) return triggers;
    var sel = pnl.element;
    var last12 = entries.slice(-12);
    var leadAll = leaderOf(entries);
    var lead12 = leaderOf(last12);
    var unitCost = (pnl.unitCount || 0) * (pnl.unitValue || 0) * 15; // bet per spin
    var remaining = (pnl.startBankroll || 0) + (pnl.netPL || 0);
    var selTailStreak = tailBlankStreak(entries, sel);

    // --- HARD STOPS ---
    // H1: selected element lost 4 in a row (most recent)
    if (selTailStreak >= 4) {
      triggers.push({
        id: 'H1_streak4',
        severity: 'hard',
        title: 'Hard stop: 4 losses in a row',
        msg: 'Your selected element <b>' + EL_NAMES[sel] + '</b> has missed ' + selTailStreak +
             ' spins in a row. Per rule, stop betting now.',
      });
    }
    // H2: 20 spins with back-and-forth, no net ahead in last 20
    if (entries.length >= 20) {
      var last20 = entries.slice(-20);
      if (!hasAnyPositiveNet(last20)) {
        triggers.push({
          id: 'H2_nomomentum20',
          severity: 'hard',
          title: 'Hard stop: 20 spins, never net ahead',
          msg: 'Over the last 20 spins the net P&L never went positive. Back-and-forth with no momentum — stop.',
        });
      }
    }
    // H3: 2+ co-leaders, OR selected element lost the lead
    if (lead12.coLeaders.length >= 2) {
      triggers.push({
        id: 'H3_coleaders',
        severity: 'hard',
        title: 'Hard stop: co-leaders detected',
        msg: 'In the last 12 spins ' + lead12.coLeaders.length + ' elements are tied for the lead (' +
             lead12.coLeaders.map(function (e) { return EL_NAMES[e]; }).join(', ') +
             '). No clear leader — stop.',
      });
    } else if (lead12.leader && lead12.leader !== sel) {
      triggers.push({
        id: 'H3_lostlead',
        severity: 'hard',
        title: 'Hard stop: selected lost the lead',
        msg: 'In the last 12 spins <b>' + EL_NAMES[lead12.leader] + '</b> has taken the lead over your selected <b>' +
             EL_NAMES[sel] + '</b>. Stop.',
      });
    }
    // H5: 2+ elements each pulled 2+ spins ahead of the selected in the last 12.
    //     No clear single challenger to switch to → stop.
    var passers = ELS.filter(function (el) {
      if (el === sel) return false;
      return lead12.counts[el] - lead12.counts[sel] >= 2;
    });
    if (passers.length >= 2) {
      triggers.push({
        id: 'H5_multipassers',
        severity: 'hard',
        title: 'Hard stop: multiple elements passed yours',
        msg: passers.map(function (e) { return EL_NAMES[e]; }).join(', ') +
             ' are each 2+ spins ahead of your selected <b>' + EL_NAMES[sel] +
             '</b> in the last 12 spins. No single clear new leader — stop now.',
      });
    }
    // H4: 4 of 5 elements each have 4-blank streaks in last 12, and the 1 remaining isn't the current leader
    var with4Blanks = ELS.filter(function (el) { return hasBlankStreak(last12, el, 4); });
    if (with4Blanks.length >= 4) {
      var remaining1 = ELS.filter(function (el) { return with4Blanks.indexOf(el) < 0; });
      var theOne = remaining1[0] || null;
      if (theOne && lead12.leader !== theOne) {
        triggers.push({
          id: 'H4_4of5cold',
          severity: 'hard',
          title: 'Hard stop: 4 of 5 elements cold',
          msg: '4 of the 5 elements each had a 4-blank streak in the last 12 spins, and the remaining one (<b>' +
               EL_NAMES[theOne] + '</b>) isn\'t the current leader. Stop.',
        });
      }
    }

    // --- CAUTIONS ---
    // C1: 35 spins played — end session regardless of W/L
    if (entries.length >= 35) {
      triggers.push({
        id: 'C1_35spins',
        severity: 'caution',
        title: '35 spins reached',
        msg: 'You\'ve played 35 spins this session. End it regardless of W/L.',
      });
    }
    // C2: Any element is 2+ ahead of any other element in the last-12 window,
    //     and the new leader is NOT the currently selected one. Action depends
    //     on whether the player is up:
    //       - up (netPL > 0)      → suggest SWITCH to the new leader
    //       - not up (netPL <= 0) → suggest STOP
    //     Never "stay on selected" — that's the point of the rule.
    if (lead12.leader && lead12.lead >= 2 && lead12.leader !== sel) {
      var newLeader = lead12.leader;
      var isUp = (pnl.netPL || 0) > 0;
      var canAfford4 = remaining >= 4 * unitCost;
      var msg;
      if (isUp) {
        msg = 'You\'re up, and <b>' + EL_NAMES[newLeader] + '</b> is 2+ ahead in the last 12 spins. ' +
              'Switch to <b>' + EL_NAMES[newLeader] + '</b>' +
              (canAfford4 ? '.' : ' (reduce bet so 4 more spins are possible — do not refill).');
      } else {
        msg = '<b>' + EL_NAMES[newLeader] + '</b> is 2+ ahead in the last 12 spins and you\'re not up yet. ' +
              'Stop now.' + (canAfford4 ? '' : ' Bankroll can\'t cover 4 more spins anyway.');
      }
      triggers.push({
        id: 'C2_leadchange_' + (isUp ? 'up' : 'down') + '_' + newLeader,
        severity: 'caution',
        title: isUp ? 'Switch to new leader' : 'Stop — you\'re not up',
        msg: msg,
      });
    }
    // C3: Win ≥ 100% with lead still 2–5, suggest lowering bet to lock 100% gain
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

    // --- SUGGESTIONS (informational — shown pre-session / in Switch modal) ---
    // (Kept lightweight; UI currently shows these only when user opens Switch.)

    return triggers;
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
