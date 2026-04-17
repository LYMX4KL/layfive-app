/*
 * LayFive Auth & Tier Gating (v1)
 * --------------------------------
 * Adds Supabase authentication check and feature gating to the tracker app.
 * Uses Supabase JS client loaded from CDN.
 *
 * Auth flow:
 *   - "Login via layfive.com" button opens website login in new tab
 *   - After login, user returns to tracker; Supabase session cookie is shared
 *     (only works if tracker is served from same domain or uses Supabase token)
 *   - Since tracker is on GitHub Pages (different domain), we use Supabase
 *     client-side auth with stored session tokens.
 *
 * Tier gating:
 *   - Free: scorecard, reference, videos, basic save/load
 *   - Pro: + Restart, suggestions, analysis, W/L, practice, coaching
 *   - Premium: + P&L, OCR, Group, Rules, element selector, lead-loss
 */
(function () {
  'use strict';

  // Supabase config — uses the same project as the website
  var SUPABASE_URL = 'https://YOUR_SUPABASE_URL.supabase.co';  // TODO: Replace with actual URL
  var SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';            // TODO: Replace with actual key

  var _supabase = null;
  var _user = null;
  var _tier = 'free';  // free, pro, premium
  var _authReady = false;

  // Feature → minimum tier mapping
  var TIER_LEVELS = { free: 0, pro: 1, premium: 2 };
  var FEATURE_TIERS = {
    // Pro+ features
    restart:      'pro',
    suggestions:  'pro',
    analysis:     'pro',
    wl_log:       'pro',
    practice:     'pro',
    coaching:     'pro',
    sessions:     'pro',
    reports:      'pro',
    // Premium features
    pnl:          'premium',
    ocr:          'premium',
    group:        'premium',
    rules:        'premium',
    element_sel:  'premium',
    lead_loss:    'premium',
  };

  // ---------- Supabase init ----------
  function initSupabase() {
    if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
      console.warn('[auth] Supabase SDK not loaded');
      return false;
    }
    _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return true;
  }

  // ---------- Check session ----------
  async function checkSession() {
    if (!_supabase) return;
    try {
      var result = await _supabase.auth.getSession();
      var session = result.data && result.data.session;
      if (session && session.user) {
        _user = session.user;
        // Fetch tier from profiles table
        var profileResult = await _supabase
          .from('profiles')
          .select('tier')
          .eq('id', _user.id)
          .single();
        if (profileResult.data && profileResult.data.tier) {
          _tier = profileResult.data.tier;
        }
      } else {
        _user = null;
        _tier = 'free';
      }
    } catch (e) {
      console.warn('[auth] Session check failed:', e);
      _user = null;
      _tier = 'free';
    }
    _authReady = true;
    updateUI();
  }

  // ---------- Login redirect ----------
  function loginRedirect() {
    // Open layfive.com login page in a new tab
    // Pass the tracker URL as redirect so user can come back
    var returnUrl = encodeURIComponent(window.location.href);
    window.open('https://www.layfive.com/login?redirect=' + returnUrl, '_blank');
  }

  // ---------- Logout ----------
  async function logout() {
    if (!_supabase) return;
    await _supabase.auth.signOut();
    _user = null;
    _tier = 'free';
    updateUI();
  }

  // ---------- Feature gate check ----------
  function canAccess(feature) {
    var required = FEATURE_TIERS[feature];
    if (!required) return true; // Unknown feature = allow
    return TIER_LEVELS[_tier] >= TIER_LEVELS[required];
  }

  function showUpgradePrompt(feature) {
    var required = FEATURE_TIERS[feature] || 'pro';
    var tierName = required === 'premium' ? 'Premium ($7.99/mo)' : 'Pro ($2.99/mo)';

    var overlay = document.createElement('div');
    overlay.id = 'tier-gate-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:10000;display:flex;align-items:center;justify-content:center;padding:12px';

    var box = document.createElement('div');
    box.style.cssText = 'background:#1a1f2e;border:2px solid ' + (required === 'premium' ? '#a78bfa' : '#d4af37') + ';border-radius:12px;padding:20px;width:100%;max-width:320px;color:#eee;text-align:center';
    box.innerHTML =
      '<div style="font-size:2em;margin-bottom:8px">' + (required === 'premium' ? '👑' : '⭐') + '</div>' +
      '<h3 style="color:' + (required === 'premium' ? '#a78bfa' : '#d4af37') + ';margin:0 0 10px">' + tierName + ' Feature</h3>' +
      '<p style="font-size:.9em;line-height:1.5;margin:0 0 14px;color:#ccc">' +
        'This feature requires a <b>' + tierName + '</b> membership. ' +
        (_user ? 'Upgrade on layfive.com to unlock it.' : 'Log in or sign up to get started.') +
      '</p>' +
      '<div style="display:flex;gap:8px">' +
        '<button id="tg-close" style="flex:1;padding:10px;background:#444;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer">Close</button>' +
        '<button id="tg-upgrade" style="flex:1;padding:10px;background:' + (required === 'premium' ? '#a78bfa' : '#d4af37') + ';color:#000;border:none;border-radius:6px;font-weight:700;cursor:pointer">' +
          (_user ? 'Upgrade' : 'Sign Up') +
        '</button>' +
      '</div>';

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    document.getElementById('tg-close').onclick = function () { overlay.remove(); };
    document.getElementById('tg-upgrade').onclick = function () {
      overlay.remove();
      window.open('https://www.layfive.com/pricing', '_blank');
    };
    overlay.onclick = function (ev) { if (ev.target === overlay) overlay.remove(); };
  }

  // Gate wrapper: checks access and shows prompt if denied
  function gateFeature(feature, callback) {
    if (canAccess(feature)) {
      if (callback) callback();
      return true;
    }
    showUpgradePrompt(feature);
    return false;
  }

  // ---------- UI updates ----------
  function updateUI() {
    // Update login/tier badge in top bar
    var badge = document.getElementById('lf-auth-badge');
    if (!badge) return;

    if (_user) {
      var tierLabel = _tier === 'premium' ? 'PREMIUM' : _tier === 'pro' ? 'PRO' : 'FREE';
      var tierColor = _tier === 'premium' ? '#a78bfa' : _tier === 'pro' ? '#d4af37' : '#888';
      badge.innerHTML =
        '<span style="background:' + tierColor + ';color:#000;padding:2px 6px;border-radius:4px;font-size:.7em;font-weight:800;letter-spacing:.5px">' + tierLabel + '</span>';
      badge.onclick = function () {
        if (confirm('Logged in as ' + _user.email + '\nTier: ' + tierLabel + '\n\nLog out?')) {
          logout();
        }
      };
      badge.title = _user.email + ' (' + tierLabel + ')';
    } else {
      badge.innerHTML = '<span style="color:#d4af37;font-size:.8em;font-weight:700;cursor:pointer">Login</span>';
      badge.onclick = loginRedirect;
      badge.title = 'Log in via layfive.com';
    }

    // Show/hide element selector based on tier
    var elPicker = document.getElementById('myElPicker');
    if (elPicker) {
      elPicker.style.display = canAccess('element_sel') ? '' : 'none';
    }
  }

  // ---------- Expose API ----------
  window._lfAuth = {
    getTier: function () { return _tier; },
    getUser: function () { return _user; },
    isReady: function () { return _authReady; },
    canAccess: canAccess,
    gateFeature: gateFeature,
    showUpgradePrompt: showUpgradePrompt,
    loginRedirect: loginRedirect,
    logout: logout,
    checkSession: checkSession,
  };

  // ---------- Init ----------
  function init() {
    // Inject auth badge into top bar (after the language button)
    var topBar = document.querySelector('.top');
    if (topBar) {
      var badge = document.createElement('span');
      badge.id = 'lf-auth-badge';
      badge.style.cssText = 'cursor:pointer;margin-left:4px';
      // Insert before the profile button
      var profileBtn = topBar.querySelector('.profile-btn');
      if (profileBtn) {
        topBar.insertBefore(badge, profileBtn);
      } else {
        topBar.appendChild(badge);
      }
    }

    // Init Supabase and check session
    if (initSupabase()) {
      checkSession();
    } else {
      _authReady = true;
      updateUI();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
