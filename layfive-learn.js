/* =========================================================================
 * layfive-learn.js — AI Learning Engine for Rules & Analysis
 * -------------------------------------------------------------------------
 * Tracks rule outcomes, detects patterns across pooled sessions, and
 * generates personalized coaching insights for each player.
 *
 * Three pillars:
 *   1. Rule Outcome Tracker — records every rule fire + what happened
 *      afterward (profitable? how many more spins? did player follow it?)
 *   2. Pattern Detection — scans pooled sessions for non-obvious patterns
 *      (hot streaks, session length sweet spots, element correlations)
 *   3. Personal Coach — compares player's behavior vs pool averages and
 *      gives specific, actionable advice
 *
 * Storage: localStorage for instant access + Firebase for cross-player
 * pooled learning. Same dual-storage pattern as OCR learning.
 *
 * Dependencies (from index.html / other modules):
 *   - window.hitType(num, el)
 *   - sessions[] array (saved sessions)
 *   - Firebase globals (db, currentUser, firebaseReady) — optional
 * ========================================================================= */
(function () {
  if (window._lfLearnInstalled) return;
  window._lfLearnInstalled = true;

  var ELS = ['M', 'W', 'Wa', 'F', 'E'];
  var EL_NAMES = { M: 'Metal', W: 'Wood', Wa: 'Water', F: 'Fire', E: 'Earth' };
  var GRACE = 12;

  // ---------- Storage keys ----------
  var LS_RULE_LOG = 'lf_learn_rules';       // per-rule fire events + outcomes
  var LS_PATTERNS = 'lf_learn_patterns';    // discovered patterns cache
  var LS_COACHING = 'lf_learn_coaching';    // personalized coaching insights
  var LS_STATS = 'lf_learn_stats';          // aggregated stats cache

  function _load(key) { try { return JSON.parse(localStorage.getItem(key)) || null; } catch (e) { return null; } }
  function _save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }

  // ===================================================================
  // 1. RULE OUTCOME TRACKER
  // ===================================================================
  // After each session save, we simulate rules against that session's
  // spin data and record:
  //   - Which rules fired and at which spin
  //   - What happened AFTER the rule fired (P&L, spins remaining)
  //   - Whether the rule's advice would have been profitable to follow

  function analyzeRuleOutcomes(sess) {
    if (!sess || !sess.spins || sess.spins.length < GRACE + 5) return null;
    var sp = sess.spins;
    var element = sess.pnl ? sess.pnl.element : null;
    if (!element) return null;

    var outcomes = [];
    var fn = window.hitType;
    if (typeof fn !== 'function') return null;

    // Build entries array (same format as layfive-rules.js evaluate())
    var entries = sp.map(function (s) {
      var hits = {};
      ELS.forEach(function (el) { hits[el] = fn(s.num, el); });
      return { num: s.num, hits: hits, delta: s.delta || 0 };
    });

    // Simulate each spin and check which rules WOULD fire
    for (var i = GRACE + 1; i <= entries.length; i++) {
      var window15 = entries.slice(Math.max(0, i - 15), i);
      var window20 = entries.slice(Math.max(0, i - 20), i);
      var windowAll = entries.slice(0, i);

      // Calculate P&L at this point
      var plAtFire = 0;
      for (var p = 0; p < i; p++) plAtFire += (entries[p].delta || 0);

      // Calculate P&L from this point to session end
      var plAfterFire = 0;
      for (var a = i; a < entries.length; a++) plAfterFire += (entries[a].delta || 0);

      var spinsAfter = entries.length - i;

      // --- Check H1: 4-loss tail streak ---
      var selStreak = 0;
      for (var t = i - 1; t >= 0; t--) {
        if (entries[t].hits[element] === '-') selStreak++;
        else break;
      }
      if (selStreak >= 4) {
        outcomes.push({
          rule: 'H1', spin: i, plAtFire: plAtFire, plAfterFire: plAfterFire,
          spinsAfter: spinsAfter,
          shouldHaveStopped: plAfterFire < 0,
          detail: element + ' missed ' + selStreak + ' in a row'
        });
      }

      // --- Check H2: 20 spins, never net positive ---
      if (i >= 20) {
        var hasPositive = false;
        var runNet = 0;
        for (var h = Math.max(0, i - 20); h < i; h++) {
          runNet += (entries[h].delta || 0);
          if (runNet > 0) { hasPositive = true; break; }
        }
        if (!hasPositive) {
          outcomes.push({
            rule: 'H2', spin: i, plAtFire: plAtFire, plAfterFire: plAfterFire,
            spinsAfter: spinsAfter,
            shouldHaveStopped: plAfterFire < 0,
            detail: 'No positive net in last 20 spins'
          });
        }
      }

      // --- Check C1: 30 spins past grace ---
      if (i === GRACE + 30) {
        outcomes.push({
          rule: 'C1', spin: i, plAtFire: plAtFire, plAfterFire: plAfterFire,
          spinsAfter: spinsAfter,
          shouldHaveStopped: plAfterFire < 0,
          detail: '30 spins reached'
        });
      }

      // --- Check C2: New leader with lead >= 2 ---
      var leadInfo = _leaderOf(windowAll);
      if (leadInfo.leader && leadInfo.leader !== element && leadInfo.lead >= 2) {
        // Only record first occurrence per leader change
        var lastC2 = outcomes.filter(function (o) { return o.rule === 'C2'; });
        var alreadyFired = lastC2.length > 0 && lastC2[lastC2.length - 1].detail.indexOf(leadInfo.leader) >= 0;
        if (!alreadyFired) {
          outcomes.push({
            rule: 'C2', spin: i, plAtFire: plAtFire, plAfterFire: plAfterFire,
            spinsAfter: spinsAfter,
            shouldHaveStopped: plAfterFire < 0,
            detail: EL_NAMES[leadInfo.leader] + ' leads by ' + leadInfo.lead
          });
        }
      }

      // --- Check Suggestion: leader with lead >= 2 ---
      if (leadInfo.leader && leadInfo.lead >= 2) {
        // Record first suggestion only
        var hasSug = outcomes.some(function (o) { return o.rule === 'SUG'; });
        if (!hasSug) {
          // Track if following the suggestion would have been profitable
          var sugElement = leadInfo.leader;
          var sugPL = 0;
          for (var sg = i; sg < entries.length; sg++) {
            var ht = entries[sg].hits[sugElement];
            if (ht === 's') sugPL += 21;      // straight hit pays 21 units
            else if (ht === 'sp') sugPL += 3;  // split hit pays 3 units
            else sugPL -= 15;                   // miss costs 15 units
          }
          outcomes.push({
            rule: 'SUG', spin: i, plAtFire: plAtFire, plAfterFire: sugPL,
            spinsAfter: spinsAfter,
            shouldHaveStopped: false,
            profitable: sugPL > 0,
            detail: EL_NAMES[sugElement] + ' (lead ' + leadInfo.lead + '), following would ' +
                    (sugPL > 0 ? 'profit ' + sugPL + 'u' : 'lose ' + Math.abs(sugPL) + 'u')
          });
        }
      }

      // --- Check H4: 4 of 5 cold in last 15 ---
      if (i >= 15) {
        var coldCount = 0;
        ELS.forEach(function (el) {
          var run = 0, maxRun = 0;
          for (var b = Math.max(0, i - 15); b < i; b++) {
            if (entries[b].hits[el] === '-') { run++; if (run > maxRun) maxRun = run; }
            else run = 0;
          }
          if (maxRun >= 4) coldCount++;
        });
        if (coldCount >= 4) {
          outcomes.push({
            rule: 'H4', spin: i, plAtFire: plAtFire, plAfterFire: plAfterFire,
            spinsAfter: spinsAfter,
            shouldHaveStopped: plAfterFire < 0,
            detail: coldCount + ' of 5 elements cold'
          });
        }
      }
    }

    // Deduplicate: keep only first fire per rule per session
    var seen = {};
    var deduped = [];
    outcomes.forEach(function (o) {
      var key = o.rule;
      if (key === 'C2') key += '_' + o.detail; // allow multiple C2 for different leaders
      if (!seen[key]) { seen[key] = true; deduped.push(o); }
    });

    return {
      sessionTs: sess.ts || Date.now(),
      element: element,
      totalSpins: entries.length,
      sessionPL: entries.reduce(function (s, e) { return s + (e.delta || 0); }, 0),
      outcomes: deduped
    };
  }

  // Helper: same as layfive-rules.js leaderOf
  function _leaderOf(entries) {
    var counts = {};
    ELS.forEach(function (el) {
      var c = 0;
      entries.forEach(function (e) { if (e.hits[el] === 's' || e.hits[el] === 'sp') c++; });
      counts[el] = c;
    });
    var sorted = ELS.slice().sort(function (a, b) { return counts[b] - counts[a]; });
    var topCount = counts[sorted[0]];
    var coLeaders = ELS.filter(function (el) { return counts[el] === topCount; });
    var secondCount = 0;
    for (var i = 0; i < sorted.length; i++) {
      if (counts[sorted[i]] < topCount) { secondCount = counts[sorted[i]]; break; }
    }
    return {
      leader: coLeaders.length === 1 ? coLeaders[0] : null,
      lead: topCount - secondCount,
      counts: counts
    };
  }

  // ===================================================================
  // 2. PATTERN DETECTION ENGINE
  // ===================================================================
  // Scans pooled sessions to find non-obvious patterns.

  function detectPatterns(allSessions) {
    if (!allSessions || allSessions.length < 3) return null;
    var fn = window.hitType;
    if (typeof fn !== 'function') return null;

    var patterns = [];

    // --- Pattern: Optimal session length ---
    // Group sessions by length buckets and compute avg P&L
    var lengthBuckets = {};
    var profitableSessions = 0;
    var totalSessions = 0;

    allSessions.forEach(function (sess) {
      if (!sess.spins || !sess.pnl) return;
      totalSessions++;
      var n = sess.spins.length;
      var bucket = n < 20 ? '12-19' : n < 25 ? '20-24' : n < 30 ? '25-29' : n < 35 ? '30-34' : n < 40 ? '35-39' : '40+';
      if (!lengthBuckets[bucket]) lengthBuckets[bucket] = { count: 0, totalPL: 0, profitable: 0 };
      var pl = sess.pnl.netPL || 0;
      lengthBuckets[bucket].count++;
      lengthBuckets[bucket].totalPL += pl;
      if (pl > 0) { lengthBuckets[bucket].profitable++; profitableSessions++; }
    });

    // Find best and worst buckets
    var bucketKeys = Object.keys(lengthBuckets).filter(function (k) { return lengthBuckets[k].count >= 2; });
    if (bucketKeys.length >= 2) {
      bucketKeys.sort(function (a, b) {
        var avgA = lengthBuckets[a].totalPL / lengthBuckets[a].count;
        var avgB = lengthBuckets[b].totalPL / lengthBuckets[b].count;
        return avgB - avgA;
      });
      var best = bucketKeys[0];
      var worst = bucketKeys[bucketKeys.length - 1];
      var bestAvg = (lengthBuckets[best].totalPL / lengthBuckets[best].count).toFixed(1);
      var worstAvg = (lengthBuckets[worst].totalPL / lengthBuckets[worst].count).toFixed(1);
      patterns.push({
        type: 'session_length',
        insight: 'Best session length: ' + best + ' spins (avg ' + (bestAvg >= 0 ? '+' : '') + bestAvg + 'u). Worst: ' + worst + ' spins (avg ' + worstAvg + 'u).',
        confidence: Math.min(100, Math.round(totalSessions * 5)),
        data: { lengthBuckets: lengthBuckets, best: best, worst: worst }
      });
    }

    // --- Pattern: Element win rates ---
    // Which element wins (most hits) most often across sessions?
    var elWins = {};
    ELS.forEach(function (el) { elWins[el] = 0; });
    var elSessionCount = 0;

    allSessions.forEach(function (sess) {
      if (!sess.spins || sess.spins.length < GRACE) return;
      elSessionCount++;
      var counts = {};
      ELS.forEach(function (el) {
        counts[el] = sess.spins.filter(function (s) {
          return s.hits && (s.hits[el] === 's' || s.hits[el] === 'sp');
        }).length;
      });
      var maxCount = Math.max.apply(null, ELS.map(function (el) { return counts[el]; }));
      ELS.forEach(function (el) { if (counts[el] === maxCount) elWins[el]++; });
    });

    if (elSessionCount >= 5) {
      var elSorted = ELS.slice().sort(function (a, b) { return elWins[b] - elWins[a]; });
      var topEl = elSorted[0];
      var topPct = Math.round(elWins[topEl] / elSessionCount * 100);
      var botEl = elSorted[elSorted.length - 1];
      var botPct = Math.round(elWins[botEl] / elSessionCount * 100);

      if (topPct > 25) { // More than expected 20%
        patterns.push({
          type: 'element_bias',
          insight: EL_NAMES[topEl] + ' wins ' + topPct + '% of sessions (expected ~20%). ' +
                   EL_NAMES[botEl] + ' wins only ' + botPct + '%.',
          confidence: Math.min(100, Math.round(elSessionCount * 3)),
          data: { elWins: elWins, sessions: elSessionCount }
        });
      } else {
        patterns.push({
          type: 'element_balance',
          insight: 'Element wins are balanced (range: ' + botPct + '%-' + topPct + '%). No element bias detected.',
          confidence: Math.min(100, Math.round(elSessionCount * 3)),
          data: { elWins: elWins }
        });
      }
    }

    // --- Pattern: Hot streak profitability ---
    // When an element hits 3+ times in last 5 spins, what happens next?
    var hotStreakEvents = 0, hotStreakProfitable = 0, hotStreakTotalPL = 0;

    allSessions.forEach(function (sess) {
      if (!sess.spins || sess.spins.length < 20) return;
      var sp = sess.spins;
      ELS.forEach(function (el) {
        for (var i = GRACE + 5; i < sp.length - 5; i++) {
          // Check last 5 spins for 3+ hits
          var last5Hits = 0;
          for (var j = i - 5; j < i; j++) {
            if (sp[j].hits && (sp[j].hits[el] === 's' || sp[j].hits[el] === 'sp')) last5Hits++;
          }
          if (last5Hits >= 3) {
            hotStreakEvents++;
            // Check next 5 spins
            var pl5 = 0;
            for (var k = i; k < Math.min(i + 5, sp.length); k++) {
              var ht = sp[k].hits ? sp[k].hits[el] : '-';
              if (ht === 's') pl5 += 21;
              else if (ht === 'sp') pl5 += 3;
              else pl5 -= 15;
            }
            hotStreakTotalPL += pl5;
            if (pl5 > 0) hotStreakProfitable++;
            // Skip ahead to avoid counting overlapping windows
            i += 4;
          }
        }
      });
    });

    if (hotStreakEvents >= 5) {
      var hotWinRate = Math.round(hotStreakProfitable / hotStreakEvents * 100);
      var hotAvgPL = (hotStreakTotalPL / hotStreakEvents).toFixed(1);
      patterns.push({
        type: 'hot_streak',
        insight: 'After 3+ hits in 5 spins ("hot streak"), the next 5 spins are profitable ' + hotWinRate + '% of the time (avg ' + (hotAvgPL >= 0 ? '+' : '') + hotAvgPL + 'u).',
        confidence: Math.min(100, Math.round(hotStreakEvents * 2)),
        data: { events: hotStreakEvents, profitable: hotStreakProfitable, avgPL: hotAvgPL }
      });
    }

    // --- Pattern: Cold streak recovery timing ---
    // After a 4-blank streak, how many spins until next hit?
    var coldRecoveries = [], coldEvents = 0;

    allSessions.forEach(function (sess) {
      if (!sess.spins || sess.spins.length < 15) return;
      var sp = sess.spins;
      ELS.forEach(function (el) {
        var blankRun = 0;
        for (var i = 0; i < sp.length; i++) {
          if (sp[i].hits && sp[i].hits[el] === '-') {
            blankRun++;
          } else {
            if (blankRun >= 4) {
              coldEvents++;
              // How many spins was the recovery?
              coldRecoveries.push(blankRun === 4 ? 1 : blankRun - 3); // approximate
            }
            blankRun = 0;
          }
        }
      });
    });

    if (coldRecoveries.length >= 5) {
      var avgRecovery = (coldRecoveries.reduce(function (s, v) { return s + v; }, 0) / coldRecoveries.length).toFixed(1);
      var quickRecovery = coldRecoveries.filter(function (v) { return v <= 3; }).length;
      var quickPct = Math.round(quickRecovery / coldRecoveries.length * 100);
      patterns.push({
        type: 'cold_recovery',
        insight: 'After a 4-blank cold streak, elements recover within 3 spins ' + quickPct + '% of the time (avg recovery: ' + avgRecovery + ' spins). Don\'t chase cold elements.',
        confidence: Math.min(100, Math.round(coldRecoveries.length)),
        data: { events: coldEvents, avgRecovery: avgRecovery, quickPct: quickPct }
      });
    }

    return patterns;
  }

  // ===================================================================
  // 3. PERSONALIZED COACHING ENGINE
  // ===================================================================
  // Compares player's behavior against pool stats and rule outcomes.

  function generateCoaching(ruleLog, patterns, allSessions) {
    var coaching = [];

    if (!ruleLog || ruleLog.length < 3) {
      coaching.push({
        type: 'not_enough_data',
        advice: 'Play at least 3 more sessions to unlock personalized coaching insights.',
        priority: 0
      });
      return coaching;
    }

    // --- Coaching: Rule compliance analysis ---
    // Which rules does the player tend to ignore?
    var ruleStats = {};
    ruleLog.forEach(function (session) {
      if (!session.outcomes) return;
      session.outcomes.forEach(function (o) {
        if (!ruleStats[o.rule]) ruleStats[o.rule] = { fires: 0, shouldStop: 0, playerContinued: 0, avgLossAfter: 0 };
        ruleStats[o.rule].fires++;
        if (o.shouldHaveStopped) ruleStats[o.rule].shouldStop++;
        if (o.spinsAfter > 3) ruleStats[o.rule].playerContinued++;
        ruleStats[o.rule].avgLossAfter += (o.plAfterFire || 0);
      });
    });

    Object.keys(ruleStats).forEach(function (rule) {
      var s = ruleStats[rule];
      if (s.fires < 2) return;
      var avgAfter = (s.avgLossAfter / s.fires).toFixed(1);
      var stopPct = Math.round(s.shouldStop / s.fires * 100);

      if (stopPct >= 60 && rule.indexOf('H') === 0) {
        coaching.push({
          type: 'rule_follow',
          rule: rule,
          advice: rule + ' fired ' + s.fires + ' times. Stopping would have saved money ' + stopPct + '% of the time (avg P&L after ignoring: ' + avgAfter + 'u). Follow this rule.',
          priority: 3
        });
      } else if (stopPct >= 50 && rule.indexOf('C') === 0) {
        coaching.push({
          type: 'rule_follow',
          rule: rule,
          advice: rule + ' is correct ' + stopPct + '% of the time. Average P&L after ignoring: ' + avgAfter + 'u.',
          priority: 2
        });
      } else if (stopPct < 40 && s.fires >= 3) {
        coaching.push({
          type: 'rule_overfire',
          rule: rule,
          advice: rule + ' fires often but only correct ' + stopPct + '% of the time. May be too sensitive for your play style.',
          priority: 1
        });
      }
    });

    // --- Coaching: Suggestion accuracy ---
    var sugOutcomes = [];
    ruleLog.forEach(function (session) {
      if (!session.outcomes) return;
      session.outcomes.forEach(function (o) {
        if (o.rule === 'SUG') sugOutcomes.push(o);
      });
    });

    if (sugOutcomes.length >= 3) {
      var sugProfitable = sugOutcomes.filter(function (o) { return o.profitable; }).length;
      var sugPct = Math.round(sugProfitable / sugOutcomes.length * 100);
      var sugAvgPL = (sugOutcomes.reduce(function (s, o) { return s + (o.plAfterFire || 0); }, 0) / sugOutcomes.length).toFixed(1);
      coaching.push({
        type: 'suggestion_accuracy',
        advice: 'Green star suggestion is profitable ' + sugPct + '% of the time (avg ' + (sugAvgPL >= 0 ? '+' : '') + sugAvgPL + 'u after following). ' +
                (sugPct >= 60 ? 'Trust it.' : sugPct >= 40 ? 'Use it as one signal among many.' : 'It needs more data to be reliable.'),
        priority: 2
      });
    }

    // --- Coaching: Session length advice ---
    if (patterns) {
      var lenPattern = patterns.filter(function (p) { return p.type === 'session_length'; })[0];
      if (lenPattern && lenPattern.data) {
        coaching.push({
          type: 'session_length',
          advice: lenPattern.insight + ' Consider ending sessions in the ' + lenPattern.data.best + ' range.',
          priority: 2
        });
      }
    }

    // --- Coaching: Overall win rate ---
    var totalWins = 0, totalLosses = 0;
    ruleLog.forEach(function (s) {
      if (s.sessionPL > 0) totalWins++;
      else totalLosses++;
    });
    if (ruleLog.length >= 5) {
      var winRate = Math.round(totalWins / ruleLog.length * 100);
      coaching.push({
        type: 'win_rate',
        advice: 'Your overall win rate is ' + winRate + '% across ' + ruleLog.length + ' sessions. ' +
                (winRate >= 50 ? 'You\'re beating the average — keep following the rules.' :
                 winRate >= 35 ? 'Close to average. Focus on following hard-stop rules to protect bankroll.' :
                 'Below average. Review which rules you\'re overriding and consider shorter sessions.'),
        priority: 3
      });
    }

    // Sort by priority (highest first)
    coaching.sort(function (a, b) { return b.priority - a.priority; });
    return coaching;
  }

  // ===================================================================
  // MAIN ENTRY POINTS
  // ===================================================================

  // Called after every session save — analyzes rule outcomes for that session
  function recordSession(sess) {
    var outcome = analyzeRuleOutcomes(sess);
    if (!outcome) return;

    var log = _load(LS_RULE_LOG) || [];
    log.push(outcome);
    if (log.length > 500) log = log.slice(-500);
    _save(LS_RULE_LOG, log);

    // Push to Firebase
    _saveToFirebase(outcome);

    return outcome;
  }

  // Run full analysis on all available sessions
  function runFullAnalysis(allSessions) {
    // 1. Analyze rule outcomes for any sessions not yet in log
    var log = _load(LS_RULE_LOG) || [];
    var logTimestamps = {};
    log.forEach(function (l) { logTimestamps[l.sessionTs] = true; });

    var newCount = 0;
    allSessions.forEach(function (sess) {
      if (!sess.ts || logTimestamps[sess.ts]) return;
      var outcome = analyzeRuleOutcomes(sess);
      if (outcome) { log.push(outcome); newCount++; }
    });
    if (newCount > 0) {
      if (log.length > 500) log = log.slice(-500);
      _save(LS_RULE_LOG, log);
    }

    // 2. Detect patterns
    var patterns = detectPatterns(allSessions);
    _save(LS_PATTERNS, patterns);

    // 3. Generate coaching
    var coaching = generateCoaching(log, patterns, allSessions);
    _save(LS_COACHING, coaching);

    // 4. Build aggregate rule stats
    var ruleAgg = {};
    log.forEach(function (session) {
      if (!session.outcomes) return;
      session.outcomes.forEach(function (o) {
        if (!ruleAgg[o.rule]) ruleAgg[o.rule] = {
          fires: 0, correctStops: 0, totalPLAfter: 0, avgSpin: 0, spinSum: 0
        };
        ruleAgg[o.rule].fires++;
        if (o.shouldHaveStopped) ruleAgg[o.rule].correctStops++;
        ruleAgg[o.rule].totalPLAfter += (o.plAfterFire || 0);
        ruleAgg[o.rule].spinSum += (o.spin || 0);
      });
    });
    Object.keys(ruleAgg).forEach(function (r) {
      var s = ruleAgg[r];
      s.accuracy = s.fires > 0 ? Math.round(s.correctStops / s.fires * 100) : 0;
      s.avgPLAfter = s.fires > 0 ? Math.round(s.totalPLAfter / s.fires * 10) / 10 : 0;
      s.avgSpin = s.fires > 0 ? Math.round(s.spinSum / s.fires) : 0;
    });

    var stats = {
      totalSessions: log.length,
      wins: log.filter(function (s) { return s.sessionPL > 0; }).length,
      losses: log.filter(function (s) { return s.sessionPL <= 0; }).length,
      avgPL: log.length > 0 ? Math.round(log.reduce(function (s, l) { return s + l.sessionPL; }, 0) / log.length * 10) / 10 : 0,
      ruleStats: ruleAgg,
      patterns: patterns,
      coaching: coaching,
      lastUpdated: Date.now()
    };
    _save(LS_STATS, stats);

    return stats;
  }

  // Get cached stats (fast, no recompute)
  function getStats() {
    return _load(LS_STATS);
  }

  // Get coaching insights
  function getCoaching() {
    return _load(LS_COACHING);
  }

  // Get detected patterns
  function getPatterns() {
    return _load(LS_PATTERNS);
  }

  // Firebase push
  function _saveToFirebase(outcome) {
    if (typeof db === 'undefined' || !window.firebaseReady || !window.currentUser) return;
    try {
      db.collection('users').doc(window.currentUser.uid)
        .collection('rule_outcomes').add(outcome)
        .catch(function (e) { console.warn('[learn] Firebase save failed', e); });
    } catch (e) {}
  }

  // ===================================================================
  // RENDER: Build HTML for the AI Insights section in Analysis tab
  // ===================================================================
  function renderInsightsHTML(stats, lang) {
    if (!stats) return '<span style="color:var(--dim);font-size:.85em">' +
      (lang === 'zh' ? '保存更多场次后解锁 AI 洞察' : 'Save more sessions to unlock AI insights') + '</span>';

    var html = '';

    // --- Rule Performance Cards ---
    var ruleOrder = ['H1', 'H2', 'H4', 'C1', 'C2', 'C3', 'SUG'];
    var ruleLabels = {
      H1: '4-Loss Streak', H2: 'No Momentum', H4: '4/5 Cold',
      C1: '30-Spin Cap', C2: 'Leader Change', C3: '100% Gain Lock', SUG: 'Green Star'
    };

    html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">';
    ruleOrder.forEach(function (r) {
      var s = stats.ruleStats[r];
      if (!s || s.fires < 1) return;
      var color = s.accuracy >= 60 ? '#2e7d32' : s.accuracy >= 40 ? '#f5a623' : '#c62828';
      var emoji = r.indexOf('H') === 0 ? '🛑' : r === 'SUG' ? '⭐' : '⚠️';
      html += '<div style="flex:1 1 140px;background:#0f1320;border:1px solid #333;border-radius:6px;padding:6px 8px;min-width:130px">' +
        '<div style="font-size:.72em;color:#888">' + emoji + ' ' + (ruleLabels[r] || r) + '</div>' +
        '<div style="font-size:1.1em;font-weight:700;color:' + color + '">' + s.accuracy + '% correct</div>' +
        '<div style="font-size:.72em;color:#aaa">' + s.fires + ' fires · avg spin ' + s.avgSpin + '</div>' +
        '<div style="font-size:.72em;color:' + (s.avgPLAfter < 0 ? '#ff6b6b' : '#4caf50') + '">After: ' +
          (s.avgPLAfter >= 0 ? '+' : '') + s.avgPLAfter + 'u avg</div>' +
      '</div>';
    });
    html += '</div>';

    // --- Patterns ---
    if (stats.patterns && stats.patterns.length > 0) {
      html += '<div style="margin-bottom:8px">';
      html += '<div style="color:#d4af37;font-size:.8em;font-weight:700;margin-bottom:4px">' +
        (lang === 'zh' ? '🔍 发现的模式' : '🔍 Discovered Patterns') + '</div>';
      stats.patterns.forEach(function (p) {
        var barWidth = Math.min(100, p.confidence);
        html += '<div style="background:#0f1320;border:1px solid #333;border-radius:4px;padding:5px 8px;margin-bottom:3px;font-size:.78em">' +
          '<div style="color:#eee">' + p.insight + '</div>' +
          '<div style="margin-top:2px;display:flex;align-items:center;gap:4px">' +
            '<div style="flex:1;background:#1a1f2e;border-radius:2px;height:4px"><div style="width:' + barWidth + '%;background:#d4af37;height:100%;border-radius:2px"></div></div>' +
            '<span style="color:#888;font-size:.75em">' + p.confidence + '% conf</span>' +
          '</div></div>';
      });
      html += '</div>';
    }

    // --- Coaching ---
    if (stats.coaching && stats.coaching.length > 0) {
      html += '<div>';
      html += '<div style="color:#d4af37;font-size:.8em;font-weight:700;margin-bottom:4px">' +
        (lang === 'zh' ? '🎯 个人建议' : '🎯 Personal Coaching') + '</div>';
      stats.coaching.forEach(function (c) {
        if (c.type === 'not_enough_data') return;
        var icon = c.priority >= 3 ? '🔴' : c.priority >= 2 ? '🟡' : '🟢';
        html += '<div style="background:#0f1320;border:1px solid #333;border-radius:4px;padding:5px 8px;margin-bottom:3px;font-size:.78em">' +
          '<span>' + icon + ' </span><span style="color:#eee">' + c.advice + '</span></div>';
      });
      html += '</div>';
    }

    // --- Summary bar ---
    html += '<div style="display:flex;gap:8px;margin-top:8px;font-size:.75em;color:#888;justify-content:center">' +
      '<span>Sessions: ' + stats.totalSessions + '</span>' +
      '<span>Win rate: ' + (stats.totalSessions > 0 ? Math.round(stats.wins / stats.totalSessions * 100) : 0) + '%</span>' +
      '<span>Avg P&L: ' + (stats.avgPL >= 0 ? '+' : '') + stats.avgPL + 'u</span>' +
    '</div>';

    return html;
  }

  // ===================================================================
  // EXPOSE TO GLOBAL SCOPE
  // ===================================================================
  window._lfLearn = {
    recordSession: recordSession,
    runFullAnalysis: runFullAnalysis,
    getStats: getStats,
    getCoaching: getCoaching,
    getPatterns: getPatterns,
    renderInsightsHTML: renderInsightsHTML
  };

})();
