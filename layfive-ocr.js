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
          // Pass 3: stretch + threshold at mid-tone.
          var threshold = 140;
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

  function showConfirmModal(numbers, imageDataUrl, processedDataUrl) {
    closeAllOcr();
    var overlay = document.createElement('div');
    overlay.id = 'lfocr-confirm-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:10000;display:flex;align-items:stretch;justify-content:center;padding:8px;overflow-y:auto';
    var rowsHtml = numbers.map(function (n, i) {
      return (
        '<div class="lfocr-row" data-idx="' + i + '" style="display:flex;gap:4px;align-items:center;margin:2px 0">' +
          '<span style="width:26px;color:#888;font-size:.75em;text-align:right">#' + (i + 1) + '</span>' +
          '<input type="number" min="0" max="36" step="1" value="' + n + '" class="lfocr-cell" style="flex:1;padding:4px;background:#0f1320;color:#eee;border:1px solid #444;border-radius:4px;font-size:1.1em;text-align:center;font-weight:700">' +
          '<button class="lfocr-row-del" title="Remove" style="background:#6b2020;color:#fff;border:none;border-radius:4px;padding:3px 7px;cursor:pointer">✕</button>' +
        '</div>'
      );
    }).join('');
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
        '<div id="lfocr-rows" style="flex:1;min-height:100px;max-height:55vh;overflow-y:auto;border:1px solid #333;border-radius:6px;padding:6px;background:#0f1320">' +
          (numbers.length ? rowsHtml : '<div style="color:#888;text-align:center;padding:12px">No numbers detected. Use + Add row.</div>') +
        '</div>' +
        '<button id="lfocr-add-row" style="width:100%;margin-top:4px;padding:5px;background:#2a4a7a;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:.9em">+ Add row</button>' +
      '</div>';

    overlay.innerHTML =
      '<div style="background:#1a1f2e;border:2px solid #d4af37;border-radius:12px;padding:12px;max-width:700px;width:100%;color:#eee;display:flex;flex-direction:column;margin:auto">' +
        '<h3 style="color:#d4af37;text-align:center;margin:0 0 4px;font-size:1.05em">Confirm imported numbers</h3>' +
        '<div style="font-size:.78em;color:#aaa;text-align:center;margin-bottom:8px">' +
          'Compare the photo against the captured list. Edit, remove, or add numbers as needed.' +
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

    function rebindDeletes() {
      var dels = overlay.querySelectorAll('.lfocr-row-del');
      dels.forEach(function (btn) {
        btn.onclick = function () {
          var row = btn.parentElement;
          if (row) row.remove();
        };
      });
    }
    rebindDeletes();

    document.getElementById('lfocr-add-row').onclick = function () {
      var container = document.getElementById('lfocr-rows');
      if (!container) return;
      var idx = container.querySelectorAll('.lfocr-row').length;
      var row = document.createElement('div');
      row.className = 'lfocr-row';
      row.style.cssText = 'display:flex;gap:6px;align-items:center;margin:3px 0';
      row.innerHTML =
        '<span style="width:30px;color:#888;font-size:.8em;text-align:right">#' + (idx + 1) + '</span>' +
        '<input type="number" min="0" max="36" step="1" value="0" class="lfocr-cell" style="flex:1;padding:6px;background:#0f1320;color:#eee;border:1px solid #444;border-radius:4px;font-size:1em;text-align:center">' +
        '<button class="lfocr-row-del" title="Remove" style="background:#6b2020;color:#fff;border:none;border-radius:4px;padding:4px 8px;cursor:pointer">✕</button>';
      // Remove the "no numbers" placeholder if present
      var placeholder = container.querySelector('div[style*="No numbers"]');
      if (placeholder) placeholder.remove();
      container.appendChild(row);
      rebindDeletes();
      row.querySelector('input').focus();
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

  function runOcrPipeline(croppedDataUrl) {
      openOverlay();
      showStatus('Preparing image...');
      var processedDataUrl = null;
      preprocessImage(croppedDataUrl).then(function (result) {
        processedDataUrl = result.dataUrl;
        showStatus('Loading OCR engine...');
        return loadTesseract();
      }).then(function (Tesseract) {
        showStatus('Reading board...', 0);
        // PSM 6 = single uniform block of text. Good for scoreboards where
        // numbers are in a single column/row and the rest is noise.
        // Also try PSM 11 (sparse text) as a fallback.
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
        // Pass BOTH images to the confirm modal: the original crop (what the
        // player sees) and the processed B&W (what Tesseract saw).
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
    overlay.innerHTML =
      '<div style="background:#1a1f2e;border:2px solid #d4af37;border-radius:12px;padding:16px;max-width:320px;width:100%;color:#eee">' +
        '<h3 style="color:#d4af37;text-align:center;margin:0 0 10px">Photo source</h3>' +
        '<button id="lfocr-src-cam" style="width:100%;padding:12px;margin-bottom:8px;background:#2e7d32;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer;font-size:1em">📷 Take a new photo</button>' +
        '<button id="lfocr-src-lib" style="width:100%;padding:12px;margin-bottom:8px;background:#2a4a7a;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer;font-size:1em">🖼️ Upload from gallery</button>' +
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
    document.getElementById('lfocr-src-cancel').onclick = function () { overlay.remove(); };
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
