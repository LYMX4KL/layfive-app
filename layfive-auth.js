/*
 * LayFive Auth & Tier Gating (v2)
 * --------------------------------
 * Adds Supabase authentication and feature gating to the tracker app.
 * Uses Supabase JS client loaded from CDN.
 *
 * Auth flow (v2 — direct login):
 *   - "Login" button opens an in-app email/password modal
 *   - Authenticates directly with Supabase (same project as the website)
 *   - Session is stored in tracker's own localStorage — no cross-domain issues
 *   - "Sign up on layfive.com" link for new users
 *
 * Tier gating:
 *   - Free: scorecard, reference, videos, basic save/load
 *   - Pro: + Restart, suggestions, analysis, W/L, practice, coaching
 *   - Premium: + P&L, OCR, Group, Rules, element selector, lead-loss
 */
(function () {
  'use strict';

  // Supabase config — uses the same project as the website
  var SUPABASE_URL = 'https://xkcglcxhkxpvtumorcki.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhrY2dsY3hoa3hwdnR1bW9yY2tpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2NzE1MDMsImV4cCI6MjA5MTI0NzUwM30.mFp4ippFLpXxcPq6AjBscm-Pk4Z0VZIoZvhce0ki8vE';

  var _supabase = null;
  var _user = null;
  var _tier = 'free';  // free, pro, premium
  var _authReady = false;
  var _disclaimerAccepted = false;

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
    // Check disclaimer for paid users
    if (_user && _tier !== 'free') {
      await checkDisclaimer();
    } else {
      _disclaimerAccepted = true; // Free users don't need disclaimer
    }
    updateUI();
  }

  // ---------- Disclaimer check ----------
  async function checkDisclaimer() {
    if (!_supabase || !_user) { _disclaimerAccepted = true; return; }
    try {
      var context = _tier === 'premium' ? 'upgrade_premium' : 'upgrade_pro';
      var result = await _supabase
        .from('disclaimer_acceptances')
        .select('id')
        .eq('user_id', _user.id)
        .in('context', ['signup', context])
        .limit(1);
      if (result.data && result.data.length > 0) {
        _disclaimerAccepted = true;
      } else {
        _disclaimerAccepted = false;
        showDisclaimerModal();
      }
    } catch (e) {
      console.warn('[auth] Disclaimer check failed:', e);
      _disclaimerAccepted = true; // Don't block on error
    }
  }

  // ---------- In-app disclaimer modal ----------
  function showDisclaimerModal() {
    var existing = document.getElementById('lf-disclaimer-overlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'lf-disclaimer-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:10001;display:flex;align-items:center;justify-content:center;padding:12px;overflow-y:auto';

    var tierLabel = _tier === 'premium' ? 'Premium' : 'Pro';
    var tierColor = _tier === 'premium' ? '#a78bfa' : '#d4af37';

    var box = document.createElement('div');
    box.style.cssText = 'background:#1a1f2e;border:2px solid ' + tierColor + ';border-radius:12px;padding:20px;width:100%;max-width:380px;color:#eee;max-height:90vh;overflow-y:auto';
    box.innerHTML =
      '<h3 style="color:' + tierColor + ';margin:0 0 12px;text-align:center">Important Disclaimer</h3>' +
      '<p style="font-size:.8em;color:#aaa;margin:0 0 12px;text-align:center">Please read and accept to use ' + tierLabel + ' features.</p>' +

      '<div style="font-size:.8em;color:#ccc;line-height:1.5">' +
        '<p style="margin:0 0 8px"><b style="color:#eee">1. Not a winning strategy</b><br>' +
        'LayFive is a tracking tool. It does not change the house edge, predict outcomes, or guarantee wins. Every spin is independent. Past results do not predict future outcomes.</p>' +

        '<p style="margin:0 0 8px"><b style="color:#eee">2. Entertainment only</b><br>' +
        'LayFive is for entertainment and educational purposes. It is not financial or gambling advice.</p>' +

        '<p style="margin:0 0 8px"><b style="color:#eee">3. Responsible gambling</b><br>' +
        'Play within your means. Never gamble with money you cannot afford to lose. If gambling affects your life, call 1-800-GAMBLER.</p>' +

        '<p style="margin:0 0 8px"><b style="color:#eee">4. Non-refundable</b><br>' +
        'Paid subscriptions are non-refundable. You may cancel anytime but no refunds for the current billing period.</p>' +

        '<p style="margin:0 0 8px"><b style="color:#eee">5. Age requirement</b><br>' +
        'You must be at least 21 years old (or the legal gambling age in your jurisdiction) to use LayFive.</p>' +

        '<p style="margin:0 0 8px"><b style="color:#eee">6. Jurisdiction</b><br>' +
        'You are responsible for determining whether gambling tracking tools are permitted in your jurisdiction.</p>' +

        '<p style="margin:0;font-size:.85em;color:#666;text-align:center">&copy; 2026 LayFive. All rights reserved.</p>' +
      '</div>' +

      '<label id="lf-disc-label" style="display:flex;align-items:flex-start;gap:8px;margin:14px 0;cursor:pointer">' +
        '<input type="checkbox" id="lf-disc-check" style="margin-top:3px;accent-color:' + tierColor + '" />' +
        '<span style="font-size:.8em;color:#ddd">I have read and agree to the above disclaimer. I understand that LayFive is not a winning system and that gambling involves risk. I confirm I am at least 21 years old.</span>' +
      '</label>' +

      '<button id="lf-disc-accept" disabled style="width:100%;padding:10px;background:#555;color:#999;border:none;border-radius:6px;font-weight:700;cursor:not-allowed;font-size:.9em">Accept &amp; Continue</button>';

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    var checkbox = document.getElementById('lf-disc-check');
    var acceptBtn = document.getElementById('lf-disc-accept');

    checkbox.onchange = function () {
      if (checkbox.checked) {
        acceptBtn.disabled = false;
        acceptBtn.style.background = tierColor;
        acceptBtn.style.color = '#000';
        acceptBtn.style.cursor = 'pointer';
      } else {
        acceptBtn.disabled = true;
        acceptBtn.style.background = '#555';
        acceptBtn.style.color = '#999';
        acceptBtn.style.cursor = 'not-allowed';
      }
    };

    acceptBtn.onclick = async function () {
      acceptBtn.disabled = true;
      acceptBtn.textContent = 'Saving...';
      try {
        var context = _tier === 'premium' ? 'upgrade_premium' : 'upgrade_pro';
        await _supabase.from('disclaimer_acceptances').insert({
          user_id: _user.id,
          version: 'v1.0',
          context: context,
        });
      } catch (e) {
        console.warn('[auth] Disclaimer save failed:', e);
      }
      _disclaimerAccepted = true;
      overlay.remove();
      updateUI();
    };

    // Don't allow dismissing without accepting — no click-outside-to-close
  }

  // ---------- Direct login modal ----------
  function showLoginModal() {
    // Remove existing modal if any
    var existing = document.getElementById('lf-login-overlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'lf-login-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:10000;display:flex;align-items:center;justify-content:center;padding:12px';

    var box = document.createElement('div');
    box.style.cssText = 'background:#1a1f2e;border:2px solid #d4af37;border-radius:12px;padding:24px;width:100%;max-width:320px;color:#eee';
    box.innerHTML =
      '<h3 style="color:#d4af37;margin:0 0 16px;text-align:center">Log In to LayFive</h3>' +
      '<div style="margin-bottom:12px">' +
        '<label style="font-size:.8em;color:#aaa;display:block;margin-bottom:4px">Email</label>' +
        '<input id="lf-login-email" type="email" autocomplete="email" ' +
          'style="width:100%;padding:10px;background:#0d1117;border:1px solid #444;border-radius:6px;color:#eee;font-size:1em;box-sizing:border-box" />' +
      '</div>' +
      '<div style="margin-bottom:16px">' +
        '<label style="font-size:.8em;color:#aaa;display:block;margin-bottom:4px">Password</label>' +
        '<input id="lf-login-pass" type="password" autocomplete="current-password" ' +
          'style="width:100%;padding:10px;background:#0d1117;border:1px solid #444;border-radius:6px;color:#eee;font-size:1em;box-sizing:border-box" />' +
      '</div>' +
      '<div id="lf-login-error" style="color:#f87171;font-size:.85em;margin-bottom:10px;display:none"></div>' +
      '<div style="display:flex;gap:8px">' +
        '<button id="lf-login-cancel" style="flex:1;padding:10px;background:#444;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer">Cancel</button>' +
        '<button id="lf-login-submit" style="flex:1;padding:10px;background:#d4af37;color:#000;border:none;border-radius:6px;font-weight:700;cursor:pointer">Log In</button>' +
      '</div>' +
      '<p style="text-align:center;margin:14px 0 0;font-size:.8em;color:#888">' +
        'Don\'t have an account? <a href="https://www.layfive.com/signup" target="_blank" style="color:#d4af37">Sign up on layfive.com</a>' +
      '</p>';

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    var emailInput = document.getElementById('lf-login-email');
    var passInput = document.getElementById('lf-login-pass');
    var errorDiv = document.getElementById('lf-login-error');
    var submitBtn = document.getElementById('lf-login-submit');

    // Focus email field
    setTimeout(function () { emailInput.focus(); }, 100);

    // Cancel
    document.getElementById('lf-login-cancel').onclick = function () { overlay.remove(); };
    overlay.onclick = function (ev) { if (ev.target === overlay) overlay.remove(); };

    // Submit
    async function doLogin() {
      var email = emailInput.value.trim();
      var pass = passInput.value;
      if (!email || !pass) {
        errorDiv.textContent = 'Please enter email and password.';
        errorDiv.style.display = 'block';
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Logging in...';
      errorDiv.style.display = 'none';

      try {
        var result = await _supabase.auth.signInWithPassword({
          email: email,
          password: pass,
        });

        if (result.error) {
          errorDiv.textContent = result.error.message || 'Login failed. Check your credentials.';
          errorDiv.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Log In';
          return;
        }

        // Success — session is now stored in localStorage
        _user = result.data.user;

        // Fetch tier
        var profileResult = await _supabase
          .from('profiles')
          .select('tier')
          .eq('id', _user.id)
          .single();
        if (profileResult.data && profileResult.data.tier) {
          _tier = profileResult.data.tier;
        }

        overlay.remove();
        // Check disclaimer for paid users after login
        if (_tier !== 'free') {
          await checkDisclaimer();
        } else {
          _disclaimerAccepted = true;
        }
        updateUI();
      } catch (e) {
        errorDiv.textContent = 'Connection error. Please try again.';
        errorDiv.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Log In';
      }
    }

    submitBtn.onclick = doLogin;

    // Enter key submits
    passInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') doLogin();
    });
    emailInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') passInput.focus();
    });
  }

  // ---------- Logout ----------
  async function logout() {
    if (_supabase) await _supabase.auth.signOut();
    if (typeof window._afterSupabaseLogout === "function") { try { window._afterSupabaseLogout(); } catch(e) { console.error(e); } }
    _user = null;
    _tier = 'free';
    updateUI();
  }

  // ---------- Feature gate check ----------
  function canAccess(feature) {
    var required = FEATURE_TIERS[feature];
    if (!required) return true; // Unknown feature = allow
    if (!_disclaimerAccepted && TIER_LEVELS[_tier] > 0) return false; // Block until disclaimer accepted
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
      '<div style="font-size:2em;margin-bottom:8px">' + (required === 'premium' ? '\uD83D\uDC51' : '\u2B50') + '</div>' +
      '<h3 style="color:' + (required === 'premium' ? '#a78bfa' : '#d4af37') + ';margin:0 0 10px">' + tierName + ' Feature</h3>' +
      '<p style="font-size:.9em;line-height:1.5;margin:0 0 14px;color:#ccc">' +
        'This feature requires a <b>' + tierName + '</b> membership. ' +
        (_user ? 'Upgrade on layfive.com to unlock it.' : 'Log in or sign up to get started.') +
      '</p>' +
      '<div style="display:flex;gap:8px">' +
        '<button id="tg-close" style="flex:1;padding:10px;background:#444;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer">Close</button>' +
        '<button id="tg-upgrade" style="flex:1;padding:10px;background:' + (required === 'premium' ? '#a78bfa' : '#d4af37') + ';color:#000;border:none;border-radius:6px;font-weight:700;cursor:pointer">' +
          (_user ? 'Upgrade' : 'Log In') +
        '</button>' +
      '</div>';

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    document.getElementById('tg-close').onclick = function () { overlay.remove(); };
    document.getElementById('tg-upgrade').onclick = function () {
      overlay.remove();
      if (_user) {
        window.open('https://www.layfive.com/pricing', '_blank');
      } else {
        showLoginModal();
      }
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
      badge.onclick = showLoginModal;
      badge.title = 'Log in with your layfive.com account';
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
    isDisclaimerAccepted: function () { return _disclaimerAccepted; },
    canAccess: canAccess,
    gateFeature: gateFeature,
    showUpgradePrompt: showUpgradePrompt,
    showLoginModal: showLoginModal,
    logout: logout,
    checkSession: checkSession,    signIn: async function(email, password) {
      if (!_supabase) return { error: { message: 'Auth not ready, please refresh' } };
      try {
        var r = await _supabase.auth.signInWithPassword({ email: email, password: password });
        if (!r.error) {
          await checkSession();
          if (typeof window._afterSupabaseLogin === 'function') {
            try { window._afterSupabaseLogin(_user); } catch (e) { console.error('_afterSupabaseLogin failed', e); }
          }
        }
        return r;
      } catch (e) {
        return { error: { message: e.message || 'Login failed' } };
      }
    },
    signUp: async function(email, password, name) {
      if (!_supabase) return { error: { message: 'Auth not ready, please refresh' } };
      try {
        return await _supabase.auth.signUp({
          email: email,
          password: password,
          options: { data: { full_name: name || '' } }
        });
      } catch (e) {
        return { error: { message: e.message || 'Signup failed' } };
      }
    },
    resetPassword: async function(email) {
      if (!_supabase) return { error: { message: 'Auth not ready, please refresh' } };
      try {
        return await _supabase.auth.resetPasswordForEmail(email);
      } catch (e) {
        return { error: { message: e.message || 'Reset failed' } };
      }
    },

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
