/* =========================================================================
 * layfive-ocr.js — Scoreboard photo import (Tesseract.js OCR)
 * -------------------------------------------------------------------------
 * Adds a 📷 Import photo button to the Scorecard tab. User uploads a
 * picture of the casino scoreboard, Tesseract.js extracts numbers, and
 * shows a confirmation modal where they can edit/reorder before the
 * numbers are pushed into the scorecard via window.addSpin().
 *
 * Board-reading convention: most casino scoreboards show the newest
 * number on top, oldest at the bottom. The confirm modal preserves
 * that top-to-bottom order as read. On import, the list is REVERSED
 * before calling addSpin() so the scorecard ends up with oldest first
 * (which matches the app's chronological row order).
 *
 * Tesseract.js is lazy-loaded from unpkg only when the user clicks the
 * button the first time — no cost to page load.
 * ========================================================================= */
(function () {
  if (window._lfOcrInstalled) return;
  window._lfOcrInstalled = true;

  var TESS_CDN = 'https://unpkg.com/tesseract.js@5/dist/tesseract.min.js';
  var tessLoading = null;

  // ---------- Claude Vision API config ----------
  // When enabled, the app calls the /api/ocr-vision route on layfive.com
  // instead of running Tesseract locally. Much higher accuracy for LED boards.
  // To enable: paste shared secret into the Photo source picker once; it is
  // stored in localStorage and reused. Tesseract remains the fallback if the
  // API call fails or no secret is set.
  var VISION_URL = 'https://layfive.com/api/ocr-vision';
  var VISION_LS_SECRET = 'lf_ocr_vision_secret';
  var VISION_LS_ENABLED = 'lf_ocr_vision_enabled';

  // ---------- AI Learning: correction tracking ----------
  // Tracks what the OCR read vs what the user corrected, so we can:
  //   1. Learn which digit confusions happen most often
  //   2. Dynamically adjust the Vision prompt with personalized hints
  //   3. Save cropped images + corrections as training data for future models
  var LEARN_LS_KEY = 'lf_ocr_learn';        // localStorage key for corrections log
  var LEARN_LS_PATTERNS = 'lf_ocr_patterns'; // localStorage key for aggregated confusion patterns

  function _learnLoadLog() {
    try { return JSON.parse(localStorage.getItem(LEARN_LS_KEY)) || []; } catch (e) { return []; }
  }
  function _learnSaveLog(log) {
    try { localStorage.setItem(LEARN_LS_KEY, JSON.stringify(log)); } catch (e) {}
  }
  function _learnLoadPatterns() {
    try { return JSON.parse(localStorage.getItem(LEARN_LS_PATTERNS)) || {}; } catch (e) { return {}; }
  }
  function _learnSavePatterns(p) {
    try { localStorage.setItem(LEARN_LS_PATTERNS, JSON.stringify(p)); } catch (e) {}
  }

  // Compare original OCR output vs user-corrected list.
  // Uses longest-common-subsequence alignment so inserts, deletes, and
  // substitutions are detected even when the user reordered rows.
  function _learnComputeDiff(original, corrected) {
    // Build LCS table
    var m = original.length, n = corrected.length;
    var dp = [];
    for (var i = 0; i <= m; i++) {
      dp[i] = [];
      for (var j = 0; j <= n; j++) {
        if (i === 0 || j === 0) dp[i][j] = 0;
        else if (original[i-1] === corrected[j-1]) dp[i][j] = dp[i-1][j-1] + 1;
        else dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
      }
    }
    // Backtrack to find edits
    var edits = [];
    var ii = m, jj = n;
    while (ii > 0 && jj > 0) {
      if (original[ii-1] === corrected[jj-1]) { ii--; jj--; }
      else if (dp[ii-1][jj] >= dp[ii][jj-1]) {
        edits.push({ type: 'delete', ocrValue: original[ii-1], position: ii-1 });
        ii--;
      } else {
        edits.push({ type: 'insert', userValue: corrected[jj-1], position: jj-1 });
        jj--;
      }
    }
    while (ii > 0) { edits.push({ type: 'delete', ocrValue: original[ii-1], position: ii-1 }); ii--; }
    while (jj > 0) { edits.push({ type: 'insert', userValue: corrected[jj-1], position: jj-1 }); jj--; }

    // Also detect substitutions: adjacent delete+insert at same position
    // Simple approach: walk original & corrected in order, if lengths match
    // and values differ at index i, that's a substitution
    var substitutions = [];
    var minLen = Math.min(m, n);
    for (var k = 0; k < minLen; k++) {
      if (original[k] !== corrected[k]) {
        substitutions.push({ ocrRead: original[k], userCorrected: corrected[k], position: k });
      }
    }
    return { edits: edits, substitutions: substitutions, origLen: m, corrLen: n };
  }

  // Update aggregated confusion patterns from a diff
  function _learnUpdatePatterns(diff) {
    var patterns = _learnLoadPatterns();
    // Track substitution patterns: "6->9" means OCR read 6, user said 9
    diff.substitutions.forEach(function (s) {
      var key = s.ocrRead + '->' + s.userCorrected;
      if (!patterns[key]) patterns[key] = { count: 0, firstSeen: Date.now() };
      patterns[key].count++;
      patterns[key].lastSeen = Date.now();
    });
    // Track insert count (OCR missed numbers)
    var insertCount = diff.edits.filter(function (e) { return e.type === 'insert'; }).length;
    if (insertCount > 0) {
      if (!patterns._missedNumbers) patterns._missedNumbers = { count: 0 };
      patterns._missedNumbers.count += insertCount;
    }
    // Track delete count (OCR hallucinated numbers)
    var deleteCount = diff.edits.filter(function (e) { return e.type === 'delete'; }).length;
    if (deleteCount > 0) {
      if (!patterns._extraNumbers) patterns._extraNumbers = { count: 0 };
      patterns._extraNumbers.count += deleteCount;
    }
    _learnSavePatterns(patterns);
    return patterns;
  }

  // Record a complete correction event
  function _learnRecordCorrection(original, corrected, imageDataUrl, engine) {
    var diff = _learnComputeDiff(original, corrected);
    // Skip if no changes were made (user accepted OCR as-is)
    var hasChanges = diff.substitutions.length > 0 || diff.edits.length > 0;

    // Always update patterns (even no-change = positive signal)
    var patterns = _learnUpdatePatterns(diff);
    if (!patterns._totalScans) patterns._totalScans = { count: 0 };
    patterns._totalScans.count++;
    if (!hasChanges) {
      if (!patterns._perfectScans) patterns._perfectScans = { count: 0 };
      patterns._perfectScans.count++;
    }
    _learnSavePatterns(patterns);

    // Save to local correction log (keep last 200 entries)
    var log = _learnLoadLog();
    var entry = {
      ts: Date.now(),
      engine: engine || 'unknown',
      original: original,
      corrected: corrected,
      subs: diff.substitutions.length,
      inserts: diff.edits.filter(function (e) { return e.type === 'insert'; }).length,
      deletes: diff.edits.filter(function (e) { return e.type === 'delete'; }).length,
      perfect: !hasChanges
    };
    log.push(entry);
    if (log.length > 200) log = log.slice(-200);
    _learnSaveLog(log);

    // Save to Firebase if available (training data)
    _learnSaveToFirebase(entry, imageDataUrl);

    return { diff: diff, patterns: patterns, hasChanges: hasChanges };
  }

  // Push correction + image to Firebase for training data collection
  function _learnSaveToFirebase(entry, imageDataUrl) {
    // Requires firebase globals from index.html
    if (typeof db === 'undefined' || typeof currentUser === 'undefined') return;
    if (!window.firebaseReady || !window.currentUser) return;
    try {
      var doc = {
        ts: entry.ts,
        engine: entry.engine,
        original: entry.original,
        corrected: entry.corrected,
        subs: entry.subs,
        inserts: entry.inserts,
        deletes: entry.deletes,
        perfect: entry.perfect
      };
      // Save the cropped image for training (only if there were corrections)
      if (imageDataUrl && !entry.perfect) {
        doc.image = imageDataUrl;
      }
      db.collection('users').doc(currentUser.uid)
        .collection('ocr_training').add(doc)
        .catch(function (e) { console.warn('[ocr-learn] Firebase save failed', e); });
    } catch (e) { console.warn('[ocr-learn] Firebase error', e); }
  }

  // Build a dynamic prompt hint from learned correction patterns.
  // This gets appended to the Vision API prompt when patterns are available.
  function _learnGetPromptHints() {
    var patterns = _learnLoadPatterns();
    var hints = [];
    var keys = Object.keys(patterns).filter(function (k) { return k.indexOf('->') >= 0; });
    // Sort by frequency (most common confusions first)
    keys.sort(function (a, b) { return (patterns[b].count || 0) - (patterns[a].count || 0); });
    // Take top 5 most common confusions
    var top = keys.slice(0, 5);
    top.forEach(function (k) {
      var parts = k.split('->');
      var cnt = patterns[k].count;
      if (cnt >= 2) { // Only include if it happened at least twice
        hints.push('This user frequently corrects ' + parts[0] + ' to ' + parts[1] + ' (' + cnt + ' times) — pay extra attention to distinguishing these.');
      }
    });
    if (!hints.length) return '';
    return '\n\nLEARNED FROM USER CORRECTIONS:\n' + hints.join('\n');
  }

  // Get learning stats summary (for display in settings or analysis)
  function _learnGetStats() {
    var patterns = _learnLoadPatterns();
    var log = _learnLoadLog();
    var totalScans = (patterns._totalScans && patterns._totalScans.count) || 0;
    var perfectScans = (patterns._perfectScans && patterns._perfectScans.count) || 0;
    var missedNumbers = (patterns._missedNumbers && patterns._missedNumbers.count) || 0;
    var extraNumbers = (patterns._extraNumbers && patterns._extraNumbers.count) || 0;
    // Top confusions
    var confusions = Object.keys(patterns)
      .filter(function (k) { return k.indexOf('->') >= 0; })
      .map(function (k) { return { pair: k, count: patterns[k].count }; })
      .sort(function (a, b) { return b.count - a.count; })
      .slice(0, 10);
    return {
      totalScans: totalScans,
      perfectScans: perfectScans,
      accuracy: totalScans > 0 ? Math.round((perfectScans / totalScans) * 100) : 0,
      missedNumbers: missedNumbers,
      extraNumbers: extraNumbers,
      topConfusions: confusions,
      recentLog: log.slice(-10)
    };
  }

  // Expose stats for the settings/analysis UI
  window._lfOcrLearnStats = _learnGetStats;
  window._lfOcrLearnPatterns = _learnLoadPatterns;

  function getVisionSecret() {
    try { return localStorage.getItem(VISION_LS_SECRET) || ''; } catch (e) { return ''; }
  }
  function setVisionSecret(v) {
    try { localStorage.setItem(VISION_LS_SECRET, v || ''); } catch (e) {}
  }
  function isVisionEnabled() {
    try { return localStorage.getItem(VISION_LS_ENABLED) === '1' && !!getVisionSecret(); } catch (e) { return false; }
  }
  function setVisionEnabled(on) {
    try { localStorage.setItem(VISION_LS_ENABLED, on ? '1' : '0'); } catch (e) {}
  }

  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (tessLoading) return tessLoading;
    tessLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = TESS_CDN;
      s.onload = function () { resolve(window.Tesseract); };
      s.onerror = function () { reject(new Error('Failed to load Tesseract.js')); };
      document.head.appendChild(s);
    });
    return tessLoading;
  }

  // ---------- Image preprocessing ----------
  // Improves OCR accuracy on LED scoreboards by:
  //   1. upscaling 2x so digits have more pixels
  //   2. converting to grayscale
  //   3. auto-inverting if the image is bright text on dark background
  //   4. stretching contrast to full range
  //   5. hard-thresholding to pure black/white
  // Returns a Promise that resolves with a data URL of the processed image.
  function preprocessImage(srcDataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        try {
          var scale = 2;
          var w = img.naturalWidth * scale;
          var h = img.naturalHeight * scale;
          // Cap max dimension to avoid blowing up memory on huge photos.
          var MAX = 2400;
          if (w > MAX || h > MAX) {
            var r = Math.min(MAX / w, MAX / h);
            w = Math.round(w * r); h = Math.round(h * r);
          }
          var c = document.createElement('canvas');
          c.width = w; c.height = h;
          var ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          var imageData = ctx.getImageData(0, 0, w, h);
          var d = imageData.data;
          // Pass 1: grayscale + compute mean brightness.
          var sum = 0;
          var N = d.length / 4;
          for (var i = 0; i < d.length; i += 4) {
            var g = Math.round(0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2]);
            d[i] = g; d[i+1] = g; d[i+2] = g;
            sum += g;
          }
          var mean = sum / N;
          // Auto-invert: if image is dark (LED on black bg), invert so text is dark on light.
          var invert = mean < 128;
          // Pass 2: find min/max for contrast stretch.
          var lo = 255, hi = 0;
          for (var j = 0; j < d.length; j += 4) {
            var v = invert ? (255 - d[j]) : d[j];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          var range = Math.max(1, hi - lo);
          // Pass 3: stretch + threshold at midpoint.
          // 128 = true midpoint after contrast-stretch; 140 was too aggressive
          // and clipped digit edges on some LED boards.
          var threshold = 128;
          for (var k = 0; k < d.length; k += 4) {
            var src = invert ? (255 - d[k]) : d[k];
            var stretched = Math.round(((src - lo) / range) * 255);
            var bw = stretched > threshold ? 255 : 0;
            d[k] = bw; d[k+1] = bw; d[k+2] = bw;
          }
          ctx.putImageData(imageData, 0, 0);
          resolve({ dataUrl: c.toDataURL('image/png'), inverted: invert });
        } catch (e) { reject(e); }
      };
      img.onerror = function () { reject(new Error('Image load failed')); };
      img.src = srcDataUrl;
    });
  }

  // Extract numbers 0-36 from raw OCR text.
  // Strategy: split into lines, from each line pull the first 1-2 digit
  // token that parses as 0-36. Preserves order as read.
  function parseNumbers(text) {
    var out = [];
    if (!text) return out;
    var lines = text.split(/\n+/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // Grab all digit runs on this line.
      var matches = line.match(/\d{1,2}/g);
      if (!matches) continue;
      for (var j = 0; j < matches.length; j++) {
        var n = parseInt(matches[j], 10);
        if (isFinite(n) && n >= 0 && n <= 36) {
          out.push(n);
        }
      }
    }
    return out;
  }

  function showStatus(msg, pct) {
    var o = document.getElementById('lfocr-status');
    if (!o) return;
    var bar = pct != null ? Math.round(pct * 100) + '%' : '';
    o.innerHTML =
      '<div style="text-align:center;color:#eee">' +
      '<div style="font-size:1.1em;margin-bottom:8px">' + msg + '</div>' +
      (bar ? '<div style="color:#d4af37">' + bar + '</div>' : '') +
      '</div>';
  }

  function closeAllOcr() {
    var ids = ['lfocr-overlay', 'lfocr-confirm-overlay', 'lfocr-source-overlay', 'lfocr-crop-overlay'];
    ids.forEach(function (id) { var el = document.getElementById(id); if (el) el.remove(); });
  }

  // ---------- Crop UI ----------
  // Shows the selected photo with a draggable/resizable rectangle.
  // User drags the 4 corners to box the scoreboard, then taps "Crop & Read".
  // Resolves with a data URL of the cropped region (in the original resolution).
  function showCropUI(srcDataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var iw = img.naturalWidth, ih = img.naturalHeight;
        closeAllOcr();
        var overlay = document.createElement('div');
        overlay.id = 'lfocr-crop-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:10000;display:flex;flex-direction:column;padding:8px;color:#eee;user-select:none;-webkit-user-select:none;touch-action:none';
        overlay.innerHTML =
          '<div style="text-align:center;font-size:.9em;margin-bottom:6px;color:#d4af37">Drag the corners to box the scoreboard numbers</div>' +
          '<div id="lfocr-crop-stage" style="position:relative;flex:1;overflow:hidden;background:#000;border:1px solid #444;border-radius:6px"></div>' +
          '<div style="display:flex;gap:8px;margin-top:10px">' +
            '<button id="lfocr-crop-cancel" style="flex:1;padding:10px;background:#444;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer">Cancel</button>' +
            '<button id="lfocr-crop-full" style="flex:1;padding:10px;background:#2a4a7a;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer">Use full image</button>' +
            '<button id="lfocr-crop-ok" style="flex:2;padding:10px;background:#2e7d32;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer">Crop & Read</button>' +
          '</div>';
        document.body.appendChild(overlay);

        var stage = document.getElementById('lfocr-crop-stage');
        // Compute display size so image fits stage while keeping aspect ratio.
        var rect = stage.getBoundingClientRect();
        var sw = rect.width, sh = rect.height;
        var scale = Math.min(sw / iw, sh / ih);
        var dw = Math.round(iw * scale), dh = Math.round(ih * scale);
        var ox = Math.round((sw - dw) / 2), oy = Math.round((sh - dh) / 2);

        // Image layer
        var imgEl = document.createElement('img');
        imgEl.src = srcDataUrl;
        imgEl.style.cssText = 'position:absolute;left:' + ox + 'px;top:' + oy + 'px;width:' + dw + 'px;height:' + dh + 'px;pointer-events:none';
        stage.appendChild(imgEl);

        // Dim layer (4 rects around the crop frame)
        function mkDim() {
          var d = document.createElement('div');
          d.style.cssText = 'position:absolute;background:rgba(0,0,0,.6);pointer-events:none';
          stage.appendChild(d);
          return d;
        }
        var dimT = mkDim(), dimB = mkDim(), dimL = mkDim(), dimR = mkDim();

        // Crop frame (starts as 70% of displayed image, centered)
        var cx = ox + Math.round(dw * 0.15);
        var cy = oy + Math.round(dh * 0.15);
        var cw = Math.round(dw * 0.7);
        var ch = Math.round(dh * 0.7);

        var frame = document.createElement('div');
        frame.style.cssText = 'position:absolute;border:2px solid #d4af37;box-sizing:border-box;pointer-events:none';
        stage.appendChild(frame);

        // Four draggable corner handles
        function mkHandle(corner) {
          var h = document.createElement('div');
          h.dataset.corner = corner;
          h.style.cssText = 'position:absolute;width:32px;height:32px;margin-left:-16px;margin-top:-16px;background:#d4af37;border:2px solid #000;border-radius:50%;cursor:move;touch-action:none;z-index:5';
          stage.appendChild(h);
          return h;
        }
        var hTL = mkHandle('tl'), hTR = mkHandle('tr'), hBL = mkHandle('bl'), hBR = mkHandle('br');

        function render() {
          // Clamp
          cx = Math.max(ox, Math.min(cx, ox + dw - 20));
          cy = Math.max(oy, Math.min(cy, oy + dh - 20));
          cw = Math.max(20, Math.min(cw, ox + dw - cx));
          ch = Math.max(20, Math.min(ch, oy + dh - cy));
          frame.style.left = cx + 'px';
          frame.style.top = cy + 'px';
          frame.style.width = cw + 'px';
          frame.style.height = ch + 'px';
          hTL.style.left = cx + 'px'; hTL.style.top = cy + 'px';
          hTR.style.left = (cx + cw) + 'px'; hTR.style.top = cy + 'px';
          hBL.style.left = cx + 'px'; hBL.style.top = (cy + ch) + 'px';
          hBR.style.left = (cx + cw) + 'px'; hBR.style.top = (cy + ch) + 'px';
          // Dim regions
          dimT.style.left = '0'; dimT.style.top = '0'; dimT.style.width = sw + 'px'; dimT.style.height = cy + 'px';
          dimB.style.left = '0'; dimB.style.top = (cy + ch) + 'px'; dimB.style.width = sw + 'px'; dimB.style.height = (sh - cy - ch) + 'px';
          dimL.style.left = '0'; dimL.style.top = cy + 'px'; dimL.style.width = cx + 'px'; dimL.style.height = ch + 'px';
          dimR.style.left = (cx + cw) + 'px'; dimR.style.top = cy + 'px'; dimR.style.width = (sw - cx - cw) + 'px'; dimR.style.height = ch + 'px';
        }
        render();

        // Pointer drag logic for handles
        function attachHandle(h) {
          h.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            h.setPointerCapture(e.pointerId);
            function onMove(ev) {
              var r = stage.getBoundingClientRect();
              var x = ev.clientX - r.left, y = ev.clientY - r.top;
              var corner = h.dataset.corner;
              if (corner === 'tl') { var nr = cx + cw, nb = cy + ch; cx = x; cy = y; cw = nr - cx; ch = nb - cy; }
              else if (corner === 'tr') { var nl = cx, nb2 = cy + ch; cy = y; cw = x - nl; ch = nb2 - cy; }
              else if (corner === 'bl') { var nr3 = cx + cw, nt = cy; cx = x; cw = nr3 - cx; ch = y - nt; }
              else if (corner === 'br') { cw = x - cx; ch = y - cy; }
              render();
            }
            function onUp() {
              h.removeEventListener('pointermove', onMove);
              h.removeEventListener('pointerup', onUp);
              h.removeEventListener('pointercancel', onUp);
            }
            h.addEventListener('pointermove', onMove);
            h.addEventListener('pointerup', onUp);
            h.addEventListener('pointercancel', onUp);
          });
        }
        attachHandle(hTL); attachHandle(hTR); attachHandle(hBL); attachHandle(hBR);

        document.getElementById('lfocr-crop-cancel').onclick = function () {
          overlay.remove();
          reject(new Error('cancelled'));
        };
        document.getElementById('lfocr-crop-full').onclick = function () {
          overlay.remove();
          resolve(srcDataUrl);
        };
        document.getElementById('lfocr-crop-ok').onclick = function () {
          // Map display coordinates back to original image coordinates.
          var srcX = Math.round((cx - ox) / scale);
          var srcY = Math.round((cy - oy) / scale);
          var srcW = Math.round(cw / scale);
          var srcH = Math.round(ch / scale);
          var c = document.createElement('canvas');
          c.width = srcW; c.height = srcH;
          var ctx = c.getContext('2d');
          ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);
          overlay.remove();
          resolve(c.toDataURL('image/png'));
        };
      };
      img.onerror = function () { reject(new Error('Image load failed for crop')); };
      img.src = srcDataUrl;
    });
  }

  function openOverlay() {
    closeAllOcr();
    var overlay = document.createElement('div');
    overlay.id = 'lfocr-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px';
    overlay.innerHTML =
      '<div style="background:#1a1f2e;border:2px solid #d4af37;border-radius:12px;padding:20px;max-width:320px;width:100%;color:#eee">' +
      '<div id="lfocr-status" style="min-height:60px">Reading board...</div>' +
      '<button id="lfocr-cancel" style="margin-top:12px;width:100%;padding:8px;background:#444;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer">Cancel</button>' +
      '</div>';
    document.body.appendChild(overlay);
    document.getElementById('lfocr-cancel').onclick = closeAllOcr;
  }

  // Track which engine was used for the current scan (for learning records)
  var _currentScanEngine = 'tesseract';

  function showConfirmModal(numbers, imageDataUrl, processedDataUrl) {
    // Snapshot the original OCR output for learning comparison on confirm
    var _originalOcrNumbers = numbers.slice();
    closeAllOcr();
    var overlay = document.createElement('div');
    overlay.id = 'lfocr-confirm-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:10000;display:flex;align-items:stretch;justify-content:center;padding:8px;overflow-y:auto';
    // Side-by-side layout: photo on left, number list on right (on wider screens).
    // On phones (<600px), it stacks vertically with photo on top.
    var photoBlock = imageDataUrl ? (
      '<div style="flex:1 1 45%;min-width:140px;display:flex;flex-direction:column;gap:4px">' +
        '<div style="color:#d4af37;font-size:.75em;text-align:center">Photo (cropped)</div>' +
        '<img src="' + imageDataUrl + '" style="width:100%;max-height:55vh;object-fit:contain;border:1px solid #444;border-radius:4px;background:#000">' +
        (processedDataUrl ? (
          '<details style="font-size:.75em;color:#888"><summary style="cursor:pointer">What Tesseract saw</summary>' +
          '<img src="' + processedDataUrl + '" style="width:100%;max-height:40vh;object-fit:contain;border:1px solid #444;border-radius:4px;margin-top:4px;background:#fff"></details>'
        ) : '') +
      '</div>'
    ) : '';
    var listBlock =
      '<div style="flex:1 1 45%;min-width:160px;display:flex;flex-direction:column">' +
        '<div style="color:#d4af37;font-size:.75em;text-align:center;margin-bottom:4px">Captured numbers</div>' +
        '<div id="lfocr-rows" style="flex:1;min-height:100px;max-height:55vh;overflow-y:auto;border:1px solid #333;border-radius:6px;padding:6px;background:#0f1320"></div>' +
        '<button id="lfocr-add-row" style="width:100%;margin-top:4px;padding:5px;background:#2a4a7a;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:.9em">+ Add row at end</button>' +
      '</div>';

    overlay.innerHTML =
      '<div style="background:#1a1f2e;border:2px solid #d4af37;border-radius:12px;padding:12px;max-width:700px;width:100%;color:#eee;display:flex;flex-direction:column;margin:auto">' +
        '<h3 style="color:#d4af37;text-align:center;margin:0 0 4px;font-size:1.05em">Confirm imported numbers</h3>' +
        '<div style="font-size:.78em;color:#aaa;text-align:center;margin-bottom:8px">' +
          'Use ↑↓ to reorder, ✕ to delete, or tap a + bar to insert a missing number.' +
        '</div>' +
        '<div style="background:#0f1320;border:1px solid #333;border-radius:6px;padding:6px 8px;margin-bottom:8px;font-size:.82em">' +
          '<div style="color:#d4af37;margin-bottom:4px">List order in photo:</div>' +
          '<label style="display:inline-flex;align-items:center;gap:4px;margin:2px 8px 2px 0;cursor:pointer">' +
            '<input type="radio" name="lfocr-order" value="newest-top" checked> Top = NEWEST (most casinos)' +
          '</label>' +
          '<label style="display:inline-flex;align-items:center;gap:4px;margin:2px 0;cursor:pointer">' +
            '<input type="radio" name="lfocr-order" value="oldest-top"> Top = OLDEST' +
          '</label>' +
        '</div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start">' +
          photoBlock +
          listBlock +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-top:10px">' +
          '<button id="lfocr-confirm-cancel" style="flex:1;padding:8px;background:#444;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer">Cancel</button>' +
          '<button id="lfocr-confirm-ok" style="flex:2;padding:8px;background:#2e7d32;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer">Import to Scorecard</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var rowsContainer = document.getElementById('lfocr-rows');

    function buildRow(value) {
      var row = document.createElement('div');
      row.className = 'lfocr-row';
      row.style.cssText = 'display:flex;gap:3px;align-items:center;margin:2px 0';
      row.innerHTML =
        '<span class="lfocr-num" style="width:26px;color:#888;font-size:.72em;text-align:right">#</span>' +
        '<input type="number" min="0" max="36" step="1" value="' + value + '" class="lfocr-cell" style="flex:1;min-width:0;padding:4px;background:#0f1320;color:#eee;border:1px solid #444;border-radius:4px;font-size:1.05em;text-align:center;font-weight:700">' +
        '<button class="lfocr-row-up" title="Move up" style="background:#2a4a7a;color:#fff;border:none;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:.85em">↑</button>' +
        '<button class="lfocr-row-down" title="Move down" style="background:#2a4a7a;color:#fff;border:none;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:.85em">↓</button>' +
        '<button class="lfocr-row-del" title="Remove" style="background:#6b2020;color:#fff;border:none;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:.85em">✕</button>';
      return row;
    }

    function buildInsertBar() {
      var bar = document.createElement('div');
      bar.className = 'lfocr-insert';
      bar.style.cssText = 'display:flex;justify-content:center;margin:1px 0';
      bar.innerHTML = '<button class="lfocr-insert-btn" title="Insert a missing number here" style="background:transparent;color:#888;border:1px dashed #444;border-radius:4px;padding:1px 14px;cursor:pointer;font-size:.72em">+ insert</button>';
      return bar;
    }

    function renumberRows() {
      var rows = rowsContainer.querySelectorAll('.lfocr-row');
      rows.forEach(function (r, i) {
        var nm = r.querySelector('.lfocr-num');
        if (nm) nm.textContent = '#' + (i + 1);
      });
    }

    // Completely rebuild the list from the current row data.
    // This avoids all DOM ordering bugs with interleaved insert bars.
    function fullRebuild() {
      // Collect current values
      var rows = Array.prototype.slice.call(rowsContainer.querySelectorAll('.lfocr-row'));
      var values = rows.map(function (r) {
        var inp = r.querySelector('input');
        return inp ? parseInt(inp.value, 10) || 0 : 0;
      });
      // Clear and rebuild
      rowsContainer.innerHTML = '';
      values.forEach(function (v) {
        rowsContainer.appendChild(buildInsertBar());
        rowsContainer.appendChild(buildRow(v));
      });
      rowsContainer.appendChild(buildInsertBar());
      renumberRows();
      bindHandlers();
    }

    function bindHandlers() {
      rowsContainer.querySelectorAll('.lfocr-row-del').forEach(function (btn) {
        btn.onclick = function () {
          var row = btn.closest('.lfocr-row');
          if (!row) return;
          // Get values, remove this one, rebuild
          var rows = Array.prototype.slice.call(rowsContainer.querySelectorAll('.lfocr-row'));
          var idx = rows.indexOf(row);
          if (idx < 0) return;
          var values = rows.map(function (r) { var inp = r.querySelector('input'); return inp ? parseInt(inp.value, 10) || 0 : 0; });
          values.splice(idx, 1);
          rowsContainer.innerHTML = '';
          values.forEach(function (v) { rowsContainer.appendChild(buildInsertBar()); rowsContainer.appendChild(buildRow(v)); });
          rowsContainer.appendChild(buildInsertBar());
          renumberRows();
          bindHandlers();
        };
      });
      rowsContainer.querySelectorAll('.lfocr-row-up').forEach(function (btn) {
        btn.onclick = function () {
          var row = btn.closest('.lfocr-row');
          if (!row) return;
          var rows = Array.prototype.slice.call(rowsContainer.querySelectorAll('.lfocr-row'));
          var idx = rows.indexOf(row);
          if (idx <= 0) return;
          // Swap values and rebuild
          var values = rows.map(function (r) { var inp = r.querySelector('input'); return inp ? parseInt(inp.value, 10) || 0 : 0; });
          var tmp = values[idx]; values[idx] = values[idx - 1]; values[idx - 1] = tmp;
          rowsContainer.innerHTML = '';
          values.forEach(function (v) { rowsContainer.appendChild(buildInsertBar()); rowsContainer.appendChild(buildRow(v)); });
          rowsContainer.appendChild(buildInsertBar());
          renumberRows();
          bindHandlers();
          // Scroll the moved row into view
          var newRows = rowsContainer.querySelectorAll('.lfocr-row');
          if (newRows[idx - 1]) newRows[idx - 1].scrollIntoView({ block: 'nearest' });
        };
      });
      rowsContainer.querySelectorAll('.lfocr-row-down').forEach(function (btn) {
        btn.onclick = function () {
          var row = btn.closest('.lfocr-row');
          if (!row) return;
          var rows = Array.prototype.slice.call(rowsContainer.querySelectorAll('.lfocr-row'));
          var idx = rows.indexOf(row);
          if (idx < 0 || idx >= rows.length - 1) return;
          var values = rows.map(function (r) { var inp = r.querySelector('input'); return inp ? parseInt(inp.value, 10) || 0 : 0; });
          var tmp = values[idx]; values[idx] = values[idx + 1]; values[idx + 1] = tmp;
          rowsContainer.innerHTML = '';
          values.forEach(function (v) { rowsContainer.appendChild(buildInsertBar()); rowsContainer.appendChild(buildRow(v)); });
          rowsContainer.appendChild(buildInsertBar());
          renumberRows();
          bindHandlers();
          var newRows = rowsContainer.querySelectorAll('.lfocr-row');
          if (newRows[idx + 1]) newRows[idx + 1].scrollIntoView({ block: 'nearest' });
        };
      });
      rowsContainer.querySelectorAll('.lfocr-insert-btn').forEach(function (btn) {
        btn.onclick = function () {
          var bar = btn.closest('.lfocr-insert');
          if (!bar) return;
          // Find which position this insert bar is at
          var allBars = Array.prototype.slice.call(rowsContainer.querySelectorAll('.lfocr-insert'));
          var barIdx = allBars.indexOf(bar);
          var rows = Array.prototype.slice.call(rowsContainer.querySelectorAll('.lfocr-row'));
          var values = rows.map(function (r) { var inp = r.querySelector('input'); return inp ? parseInt(inp.value, 10) || 0 : 0; });
          // Insert at barIdx position (bar 0 = before first row, bar 1 = after first row, etc.)
          values.splice(barIdx, 0, 0);
          rowsContainer.innerHTML = '';
          values.forEach(function (v) { rowsContainer.appendChild(buildInsertBar()); rowsContainer.appendChild(buildRow(v)); });
          rowsContainer.appendChild(buildInsertBar());
          renumberRows();
          bindHandlers();
          // Focus the new row's input
          var newRows = rowsContainer.querySelectorAll('.lfocr-row');
          if (newRows[barIdx]) {
            var inp = newRows[barIdx].querySelector('input');
            if (inp) { inp.focus(); inp.select(); }
          }
        };
      });
    }

    // Initial population
    rowsContainer.innerHTML = '';
    numbers.forEach(function (n) {
      rowsContainer.appendChild(buildInsertBar());
      rowsContainer.appendChild(buildRow(n));
    });
    rowsContainer.appendChild(buildInsertBar());
    renumberRows();
    bindHandlers();

    document.getElementById('lfocr-add-row').onclick = function () {
      // Collect existing values, add a 0 at the end, rebuild
      var rows = Array.prototype.slice.call(rowsContainer.querySelectorAll('.lfocr-row'));
      var values = rows.map(function (r) { var inp = r.querySelector('input'); return inp ? parseInt(inp.value, 10) || 0 : 0; });
      values.push(0);
      rowsContainer.innerHTML = '';
      values.forEach(function (v) { rowsContainer.appendChild(buildInsertBar()); rowsContainer.appendChild(buildRow(v)); });
      rowsContainer.appendChild(buildInsertBar());
      renumberRows();
      bindHandlers();
      // Focus the new last row's input
      var newRows = rowsContainer.querySelectorAll('.lfocr-row');
      var lastRow = newRows[newRows.length - 1];
      if (lastRow) { var inp = lastRow.querySelector('input'); if (inp) { inp.focus(); inp.select(); } }
    };

    document.getElementById('lfocr-confirm-cancel').onclick = closeAllOcr;
    document.getElementById('lfocr-confirm-ok').onclick = function () {
      var cells = overlay.querySelectorAll('.lfocr-cell');
      var nums = [];
      for (var i = 0; i < cells.length; i++) {
        var v = parseInt(cells[i].value, 10);
        if (isFinite(v) && v >= 0 && v <= 36) nums.push(v);
      }
      if (!nums.length) { alert('No valid numbers (0-36) to import.'); return; }
      if (typeof window.addSpin !== 'function') { alert('addSpin not available.'); return; }
      // Scorecard chronology = oldest first, newest at the bottom.
      // User tells us which direction the photo list runs.
      var orderEl = overlay.querySelector('input[name="lfocr-order"]:checked');
      var orderVal = orderEl ? orderEl.value : 'newest-top';
      var chronological = (orderVal === 'newest-top') ? nums.slice().reverse() : nums.slice();
      var ok = confirm('Import ' + chronological.length + ' numbers into the Scorecard?\n\nOldest-first order (as they\'ll be added): ' + chronological.join(', '));
      if (!ok) return;

      // --- AI Learning: record what OCR got vs what user confirmed ---
      try {
        var result = _learnRecordCorrection(_originalOcrNumbers, nums, imageDataUrl, _currentScanEngine);
        if (result.hasChanges) {
          console.log('[ocr-learn] Corrections recorded:', result.diff.substitutions.length, 'subs,',
            result.diff.edits.filter(function(e){return e.type==='insert'}).length, 'inserts,',
            result.diff.edits.filter(function(e){return e.type==='delete'}).length, 'deletes');
        } else {
          console.log('[ocr-learn] Perfect scan — no corrections needed');
        }
      } catch (e) { console.warn('[ocr-learn] Failed to record', e); }

      closeAllOcr();
      // Push one by one. (addSpin triggers refreshAll/PL hook per call.)
      for (var j = 0; j < chronological.length; j++) {
        try { window.addSpin(chronological[j]); } catch (e) { console.warn('addSpin failed', e); }
      }
    };
  }

  function handleFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var origDataUrl = reader.result;
      // Step 1: let the user crop the scoreboard area.
      showCropUI(origDataUrl).then(function (croppedDataUrl) {
        runOcrPipeline(croppedDataUrl);
      }).catch(function (err) {
        if (err && err.message === 'cancelled') return; // user cancelled crop
        console.error('[ocr] crop failed', err);
        alert('Crop failed: ' + (err && err.message ? err.message : err));
      });
    };
    reader.readAsDataURL(file);
  }

  // Call the layfive.com Vision API. Returns a Promise resolving to an array
  // of numbers in the order they appear on the board (top to bottom).
  function callVisionApi(croppedDataUrl) {
    var secret = getVisionSecret();
    var hints = _learnGetPromptHints(); // Dynamic hints from correction history
    return fetch(VISION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OCR-Secret': secret
      },
      body: JSON.stringify({ image: croppedDataUrl, hints: hints || undefined })
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) { throw new Error('Vision API ' + res.status + ': ' + t.slice(0, 200)); });
      }
      return res.json();
    }).then(function (j) {
      return Array.isArray(j.numbers) ? j.numbers : [];
    });
  }

  function runOcrPipeline(croppedDataUrl) {
      openOverlay();
      if (isVisionEnabled()) {
        _currentScanEngine = 'vision';
        showStatus('Calling Claude Vision...');
        callVisionApi(croppedDataUrl).then(function (nums) {
          // Pass the original crop as both "photo" and "what was seen" — no
          // preprocessing was applied since Vision reads the raw image.
          showConfirmModal(nums, croppedDataUrl, null);
        }).catch(function (err) {
          console.warn('[ocr] Vision failed, falling back to Tesseract', err);
          showStatus('Vision failed, trying local OCR...');
          setTimeout(function () { runTesseractPipeline(croppedDataUrl); }, 400);
        });
      } else {
        runTesseractPipeline(croppedDataUrl);
      }
  }

  function runTesseractPipeline(croppedDataUrl) {
      _currentScanEngine = 'tesseract';
      showStatus('Preparing image...');
      var processedDataUrl = null;
      preprocessImage(croppedDataUrl).then(function (result) {
        processedDataUrl = result.dataUrl;
        showStatus('Loading OCR engine...');
        return loadTesseract();
      }).then(function (Tesseract) {
        showStatus('Reading board...', 0);
        return Tesseract.recognize(processedDataUrl, 'eng', {
          logger: function (m) {
            if (m && m.status === 'recognizing text') {
              showStatus('Reading board...', m.progress);
            } else if (m && m.status) {
              showStatus(m.status + '...');
            }
          },
          tessedit_char_whitelist: '0123456789',
          tessedit_pageseg_mode: '6',
          preserve_interword_spaces: '1',
        });
      }).then(function (result) {
        var text = (result && result.data && result.data.text) || '';
        var nums = parseNumbers(text);
        showConfirmModal(nums, croppedDataUrl, processedDataUrl);
      }).catch(function (err) {
        showStatus('Error: ' + (err && err.message ? err.message : err));
        console.error('[ocr] failed', err);
      });
  }

  // ---------- Button injection ----------
  function installButton() {
    var pane = document.getElementById('p0');
    if (!pane) return false;
    if (document.getElementById('lfocr-btn')) return true;
    var actions = pane.querySelector('.actions');
    if (!actions) return false;
    // Ensure the row wraps so new buttons never overflow off-screen on phones.
    actions.style.flexWrap = 'wrap';
    var btn = document.createElement('button');
    btn.id = 'lfocr-btn';
    btn.type = 'button';
    btn.title = 'Import numbers from a scoreboard photo';
    btn.textContent = '📷 Photo';
    // Bright, highly visible so it's hard to miss. Also prepended so it shows first.
    btn.style.cssText = 'background:linear-gradient(135deg,#f5a623,#d48506);color:#000;border:1px solid #ffc567;border-radius:6px;padding:6px 10px;font-weight:700;font-size:.9em;cursor:pointer';
    btn.onclick = function () {
      if (window._lfAuth && !window._lfAuth.gateFeature('ocr')) return;
      var fi = document.getElementById('lfocr-file');
      if (fi) fi.click();
    };
    // Two hidden file inputs: one for camera, one for gallery. The button
    // opens a small picker so Kenny can choose between taking a new photo
    // and uploading from his photo library.
    var fiCam = document.createElement('input');
    fiCam.type = 'file';
    fiCam.accept = 'image/*';
    fiCam.capture = 'environment';
    fiCam.id = 'lfocr-file-cam';
    fiCam.style.display = 'none';
    fiCam.onchange = function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) handleFile(f);
      e.target.value = '';
    };
    var fiLib = document.createElement('input');
    fiLib.type = 'file';
    fiLib.accept = 'image/*';
    fiLib.id = 'lfocr-file-lib';
    fiLib.style.display = 'none';
    fiLib.onchange = function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) handleFile(f);
      e.target.value = '';
    };
    btn.onclick = showSourcePicker;
    // Prepend so it appears first in the row (most visible spot on phone).
    if (actions.firstChild) actions.insertBefore(btn, actions.firstChild);
    else actions.appendChild(btn);
    actions.appendChild(fiCam);
    actions.appendChild(fiLib);
    return true;
  }

  // Small modal letting the user choose camera vs gallery for the photo source.
  function showSourcePicker() {
    closeAllOcr();
    var overlay = document.createElement('div');
    overlay.id = 'lfocr-source-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px';
    var engineOn = isVisionEnabled();
    var engineLabel = engineOn ? '🧠 Claude Vision (accurate)' : '⚙️ Tesseract (local, free)';
    var engineColor = engineOn ? '#2e7d32' : '#555';
    overlay.innerHTML =
      '<div style="background:#1a1f2e;border:2px solid #d4af37;border-radius:12px;padding:16px;max-width:320px;width:100%;color:#eee">' +
        '<h3 style="color:#d4af37;text-align:center;margin:0 0 8px">Photo source</h3>' +
        '<div style="background:#0f1320;border:1px solid #333;border-radius:6px;padding:6px 8px;margin-bottom:10px;font-size:.75em;color:#bbb;line-height:1.35">' +
          '<div style="color:#d4af37;font-weight:700;margin-bottom:3px">📸 For best results:</div>' +
          '• Stand <b>close</b> — fill the frame with just the numbers column<br>' +
          '• Shoot <b>straight-on</b>, not at an angle<br>' +
          '• Avoid glare — tilt phone if you see reflections<br>' +
          '• Hold <b>steady</b> — tap to focus, then wait a beat' +
        '</div>' +
        '<button id="lfocr-src-cam" style="width:100%;padding:12px;margin-bottom:8px;background:#2e7d32;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer;font-size:1em">📷 Take a new photo</button>' +
        '<button id="lfocr-src-lib" style="width:100%;padding:12px;margin-bottom:8px;background:#2a4a7a;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer;font-size:1em">🖼️ Upload from gallery</button>' +
        '<div style="margin:10px 0 6px;font-size:.8em;color:#aaa;text-align:center">OCR engine:</div>' +
        '<button id="lfocr-engine-btn" style="width:100%;padding:8px;margin-bottom:6px;background:' + engineColor + ';color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:.9em">' + engineLabel + '</button>' +
        '<button id="lfocr-engine-setup" style="width:100%;padding:6px;margin-bottom:8px;background:#333;color:#bbb;border:none;border-radius:6px;cursor:pointer;font-size:.8em">Vision setup</button>' +
        '<div id="lfocr-learn-stats" style="margin:8px 0;font-size:.75em;color:#888"></div>' +
        '<button id="lfocr-src-cancel" style="width:100%;padding:8px;background:#444;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer">Cancel</button>' +
      '</div>';
    document.body.appendChild(overlay);
    document.getElementById('lfocr-src-cam').onclick = function () {
      overlay.remove();
      var fi = document.getElementById('lfocr-file-cam');
      if (fi) fi.click();
    };
    document.getElementById('lfocr-src-lib').onclick = function () {
      overlay.remove();
      var fi = document.getElementById('lfocr-file-lib');
      if (fi) fi.click();
    };
    document.getElementById('lfocr-engine-btn').onclick = function () {
      if (!getVisionSecret()) {
        alert('Tap "Vision setup" first to paste your shared secret.');
        return;
      }
      setVisionEnabled(!isVisionEnabled());
      overlay.remove();
      showSourcePicker();
    };
    document.getElementById('lfocr-engine-setup').onclick = function () {
      var cur = getVisionSecret();
      var v = prompt('Paste your OCR shared secret (from Vercel env OCR_SHARED_SECRET):', cur);
      if (v === null) return; // cancelled
      setVisionSecret(v.trim());
      if (v.trim()) setVisionEnabled(true);
      overlay.remove();
      showSourcePicker();
    };
    document.getElementById('lfocr-src-cancel').onclick = function () { overlay.remove(); };

    // Show AI learning stats if any scans have been done
    try {
      var stats = _learnGetStats();
      var statsEl = document.getElementById('lfocr-learn-stats');
      if (statsEl && stats.totalScans > 0) {
        var html = '<div style="background:#0f1320;border:1px solid #333;border-radius:6px;padding:6px 8px">' +
          '<div style="color:#d4af37;font-weight:700;margin-bottom:3px">🧠 AI Learning</div>' +
          '<div>Scans: <b>' + stats.totalScans + '</b> · Perfect: <b>' + stats.perfectScans + '</b> (' + stats.accuracy + '%)</div>';
        if (stats.topConfusions.length > 0) {
          html += '<div style="margin-top:3px">Top confusions: ';
          html += stats.topConfusions.slice(0, 3).map(function (c) {
            var parts = c.pair.split('->');
            return '<span style="color:#ff9a3c">' + parts[0] + '→' + parts[1] + '</span> ×' + c.count;
          }).join(', ');
          html += '</div>';
        }
        if (stats.missedNumbers > 0) {
          html += '<div>Missed numbers: ' + stats.missedNumbers + ' · Extra: ' + stats.extraNumbers + '</div>';
        }
        html += '</div>';
        statsEl.innerHTML = html;
      }
    } catch (e) { /* stats display is non-critical */ }
  }

  function tryInstall() {
    if (installButton()) return;
    setTimeout(tryInstall, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInstall);
  } else {
    tryInstall();
  }
})();
