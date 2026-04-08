/*
 * LayFive Supabase integration (preview / opt-in)
 * ------------------------------------------------
 * Loaded by index.html only when the URL contains ?supabase=1
 *
 * What it does:
 *   1. Shows a one-time bilingual (EN + 中文) consent popup
 *   2. Generates an anonymous device UUID stored in localStorage
 *   3. Hooks into the tracker's existing session/spin functions
 *      and pushes anonymized data to the LayFive Supabase project
 *
 * What it does NOT do:
 *   - No personal info, no login, no email, no name
 *   - No change to existing offline behavior — tracker still works
 *     100% without network
 *   - If the user clicks "No Thanks", nothing is ever uploaded
 *
 * Project: xkcglcxhkxpvtumorcki.supabase.co
 */
(function () {
  'use strict';

  // ---------- Configuration ----------
  var SUPABASE_URL = 'https://xkcglcxhkxpvtumorcki.supabase.co';
  var SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_PhD96K8thW97356rT7VmDA_75mEruoY';
  var APP_VERSION = 'preview-2026-04-08';

  // localStorage keys
  var LS_DEVICE_ID   = 'lf_device_id';
  var LS_CONSENT     = 'lf_sb_consent';
  var LS_LANG_KEY    = 'lf_lang';

  // ---------- Small helpers ----------
  function log()  { try { console.log.apply(console, ['[LayFive/SB]'].concat([].slice.call(arguments))); } catch(e){} }
  function warn() { try { console.warn.apply(console, ['[LayFive/SB]'].concat([].slice.call(arguments))); } catch(e){} }
  function err()  { try { console.error.apply(console, ['[LayFive/SB]'].concat([].slice.call(arguments))); } catch(e){} }

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function getLang() {
    try {
      var v = localStorage.getItem(LS_LANG_KEY);
      if (v === 'zh' || v === 'en') return v;
    } catch (e) {}
    var nav = (navigator.language || 'en').toLowerCase();
    return nav.indexOf('zh') === 0 ? 'zh' : 'en';
  }

  function getDeviceId() {
    try {
      var id = localStorage.getItem(LS_DEVICE_ID);
      if (!id) {
        id = uuid();
        localStorage.setItem(LS_DEVICE_ID, id);
      }
      return id;
    } catch (e) {
      return null;
    }
  }

  function getConsent() {
    try { return localStorage.getItem(LS_CONSENT); } catch (e) { return null; }
  }
  function setConsent(v) {
    try { localStorage.setItem(LS_CONSENT, v); } catch (e) {}
  }

  // ---------- Bilingual copy ----------
  var COPY = {
    en: {
      title: 'Help improve LayFive?',
      body: 'LayFive can collect anonymous data about your roulette sessions ' +
            '(which numbers came up, element hits, bankroll changes) to improve ' +
            'coaching recommendations for all players. No names, no accounts, ' +
            'no personal information is collected. You can change your mind later.',
      allow: 'Allow',
      deny: 'No Thanks'
    },
    zh: {
      title: '帮助改进 LayFive？',
      body: 'LayFive 可以收集您轮盘记录的匿名数据（开出的号码、五行命中、资金变化），' +
            '用于改进对所有玩家的建议。不收集姓名、账号或任何个人信息。您可以随时更改此选择。',
      allow: '同意',
      deny: '不，谢谢'
    }
  };

  // ---------- Consent popup ----------
  function showConsentPopup() {
    return new Promise(function (resolve) {
      var lang = getLang();
      var c = COPY[lang] || COPY.en;

      var overlay = document.createElement('div');
      overlay.id = 'lf-sb-consent-overlay';
      overlay.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:999999;' +
        'display:flex;align-items:center;justify-content:center;' +
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
        'padding:20px;';

      var box = document.createElement('div');
      box.style.cssText =
        'background:#1a1a1a;color:#fff;border:1px solid #333;border-radius:14px;' +
        'max-width:480px;width:100%;padding:26px 24px;box-shadow:0 20px 60px rgba(0,0,0,0.5);';

      var h = document.createElement('h2');
      h.textContent = c.title;
      h.style.cssText = 'margin:0 0 14px 0;font-size:20px;font-weight:700;';

      var p = document.createElement('p');
      p.textContent = c.body;
      p.style.cssText = 'margin:0 0 22px 0;font-size:14px;line-height:1.55;color:#cfcfcf;';

      var btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';

      var denyBtn = document.createElement('button');
      denyBtn.textContent = c.deny;
      denyBtn.style.cssText =
        'padding:10px 18px;border-radius:8px;border:1px solid #444;' +
        'background:transparent;color:#ccc;font-size:14px;cursor:pointer;';

      var allowBtn = document.createElement('button');
      allowBtn.textContent = c.allow;
      allowBtn.style.cssText =
        'padding:10px 20px;border-radius:8px;border:none;' +
        'background:#c9a450;color:#111;font-size:14px;font-weight:700;cursor:pointer;';

      denyBtn.onclick = function () {
        setConsent('no');
        overlay.remove();
        resolve('no');
      };
      allowBtn.onclick = function () {
        setConsent('yes');
        overlay.remove();
        resolve('yes');
      };

      btnRow.appendChild(denyBtn);
      btnRow.appendChild(allowBtn);
      box.appendChild(h);
      box.appendChild(p);
      box.appendChild(btnRow);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    });
  }

  // ---------- Supabase client loader ----------
  function loadSupabaseClient() {
    return new Promise(function (resolve, reject) {
      if (window.supabase && window.supabase.createClient) {
        return resolve(window.supabase);
      }
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      s.onload = function () {
        if (window.supabase && window.supabase.createClient) resolve(window.supabase);
        else reject(new Error('supabase global missing after load'));
      };
      s.onerror = function () { reject(new Error('failed to load supabase-js')); };
      document.head.appendChild(s);
    });
  }

  // ---------- Database operations (fire-and-forget) ----------
  var sb = null;
  var deviceId = null;
  var currentSessionDbId = null;
  var spinIndexCounter = 0;

  function safeInsert(table, row) {
    if (!sb) return Promise.resolve(null);
    return sb.from(table).insert(row).select().then(function (res) {
      if (res.error) { warn('insert ' + table + ' error:', res.error.message); return null; }
      return res.data && res.data[0];
    }).catch(function (e) { warn('insert ' + table + ' exception:', e); return null; });
  }

  function safeUpdate(table, match, patch) {
    if (!sb) return Promise.resolve(null);
    var q = sb.from(table).update(patch);
    Object.keys(match).forEach(function (k) { q = q.eq(k, match[k]); });
    return q.then(function (res) {
      if (res.error) { warn('update ' + table + ' error:', res.error.message); return null; }
      return res;
    }).catch(function (e) { warn('update ' + table + ' exception:', e); return null; });
  }

  function ensureDevice() {
    return safeInsert('devices', {
      id: deviceId,
      app_version: APP_VERSION
    }).then(function (row) {
      return row;
    });
  }

  // ---------- Hooks into existing tracker functions ----------
  function tryWrap(fnName, wrapper) {
    var orig = window[fnName];
    if (typeof orig !== 'function') return false;
    window[fnName] = function () {
      var result = orig.apply(this, arguments);
      try { wrapper.apply(this, arguments); } catch (e) { warn(fnName + ' hook failed:', e); }
      return result;
    };
    log('hooked', fnName);
    return true;
  }

  function installHooks() {
    tryWrap('newSess', function () {
      try {
        var sess = (window.sessions && window.sessions[window.sessions.length - 1]) || null;
        var casino = sess && sess.casino ? String(sess.casino).slice(0, 120) : null;
        var playDate = sess && sess.date ? String(sess.date).slice(0, 10) : null;
        spinIndexCounter = 0;
        safeInsert('sessions', {
          device_id: deviceId,
          play_mode: 'scorecard',
          casino_name: casino,
          play_date: playDate,
          element_played: null,
          total_spins: 0
        }).then(function (row) {
          if (row && row.id) currentSessionDbId = row.id;
        });
      } catch (e) { warn('newSess hook inner error:', e); }
    });

    tryWrap('addSpin', function (num) {
      try {
        if (!currentSessionDbId) return;
        spinIndexCounter += 1;
        var sess = (window.sessions && window.sessions[window.sessions.length - 1]) || null;
        var lastSpin = sess && sess.spins && sess.spins[sess.spins.length - 1];
        var hits = (lastSpin && lastSpin.hits) || {};
        function norm(v) { return (v === 's' || v === 'sp') ? v : null; }
        safeInsert('spins', {
          session_id: currentSessionDbId,
          spin_index: spinIndexCounter,
          number: (typeof num === 'number') ? num : null,
          hit_metal: norm(hits.M),
          hit_wood:  norm(hits.W),
          hit_water: norm(hits.Wa),
          hit_fire:  norm(hits.F),
          hit_earth: norm(hits.E)
        });
      } catch (e) { warn('addSpin hook inner error:', e); }
    });

    var endHook = function () {
      try {
        if (!currentSessionDbId) return;
        safeUpdate('sessions',
          { id: currentSessionDbId },
          { ended_at: new Date().toISOString(), total_spins: spinIndexCounter }
        );
        currentSessionDbId = null;
        spinIndexCounter = 0;
      } catch (e) { warn('end hook inner error:', e); }
    };
    tryWrap('restartSess', endHook);
  }

  // ---------- Init ----------
  function init() {
    log('init (consent status: ' + getConsent() + ')');

    var consent = getConsent();
    var consentPromise;
    if (consent === 'yes' || consent === 'no') {
      consentPromise = Promise.resolve(consent);
    } else {
      consentPromise = showConsentPopup();
    }

    consentPromise.then(function (decision) {
      if (decision !== 'yes') {
        log('consent declined — data collection disabled');
        return;
      }
      return loadSupabaseClient()
        .then(function (sbLib) {
          sb = sbLib.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
          deviceId = getDeviceId();
          log('client ready, device:', deviceId);
          return ensureDevice();
        })
        .then(function () {
          installHooks();
          setTimeout(installHooks, 500);
          setTimeout(installHooks, 2000);
        })
        .catch(function (e) { err('init failed:', e); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
