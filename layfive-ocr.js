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
    var ids = ['lfocr-overlay', 'lfocr-confirm-overlay'];
    ids.forEach(function (id) { var el = document.getElementById(id); if (el) el.remove(); });
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

  function showConfirmModal(numbers, imageDataUrl) {
    closeAllOcr();
    var overlay = document.createElement('div');
    overlay.id = 'lfocr-confirm-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:10000;display:flex;align-items:flex-start;justify-content:center;padding:12px;overflow-y:auto';
    var rowsHtml = numbers.map(function (n, i) {
      return (
        '<div class="lfocr-row" data-idx="' + i + '" style="display:flex;gap:6px;align-items:center;margin:3px 0">' +
          '<span style="width:30px;color:#888;font-size:.8em;text-align:right">#' + (i + 1) + '</span>' +
          '<input type="number" min="0" max="36" step="1" value="' + n + '" class="lfocr-cell" style="flex:1;padding:6px;background:#0f1320;color:#eee;border:1px solid #444;border-radius:4px;font-size:1em;text-align:center">' +
          '<button class="lfocr-row-del" title="Remove" style="background:#6b2020;color:#fff;border:none;border-radius:4px;padding:4px 8px;cursor:pointer">✕</button>' +
        '</div>'
      );
    }).join('');
    overlay.innerHTML =
      '<div style="background:#1a1f2e;border:2px solid #d4af37;border-radius:12px;padding:16px;max-width:360px;width:100%;color:#eee">' +
        '<h3 style="color:#d4af37;text-align:center;margin:0 0 8px">Confirm imported numbers</h3>' +
        '<div style="font-size:.85em;color:#aaa;text-align:center;margin-bottom:8px">' +
          'Edit any wrong values, remove extras, or add missed ones.' +
        '</div>' +
        '<div style="background:#0f1320;border:1px solid #333;border-radius:6px;padding:6px 8px;margin-bottom:8px;font-size:.85em">' +
          '<div style="color:#d4af37;margin-bottom:4px">List order in photo:</div>' +
          '<label style="display:flex;align-items:center;gap:6px;margin:2px 0;cursor:pointer">' +
            '<input type="radio" name="lfocr-order" value="newest-top" checked> Top = NEWEST spin (most casinos)' +
          '</label>' +
          '<label style="display:flex;align-items:center;gap:6px;margin:2px 0;cursor:pointer">' +
            '<input type="radio" name="lfocr-order" value="oldest-top"> Top = OLDEST spin' +
          '</label>' +
        '</div>' +
        (imageDataUrl ? '<div style="text-align:center;margin-bottom:8px"><img src="' + imageDataUrl + '" style="max-width:100%;max-height:120px;border:1px solid #444;border-radius:4px"></div>' : '') +
        '<div id="lfocr-rows" style="max-height:40vh;overflow-y:auto;border:1px solid #333;border-radius:6px;padding:6px;background:#0f1320">' +
          (numbers.length ? rowsHtml : '<div style="color:#888;text-align:center;padding:12px">No numbers detected. Add them below or retake the photo.</div>') +
        '</div>' +
        '<button id="lfocr-add-row" style="width:100%;margin-top:6px;padding:6px;background:#2a4a7a;color:#fff;border:none;border-radius:4px;cursor:pointer">+ Add row</button>' +
        '<div style="display:flex;gap:8px;margin-top:12px">' +
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
      var dataUrl = reader.result;
      openOverlay();
      showStatus('Loading OCR engine...');
      loadTesseract().then(function (Tesseract) {
        showStatus('Reading board...', 0);
        return Tesseract.recognize(dataUrl, 'eng', {
          logger: function (m) {
            if (m && m.status === 'recognizing text') {
              showStatus('Reading board...', m.progress);
            } else if (m && m.status) {
              showStatus(m.status + '...');
            }
          },
          tessedit_char_whitelist: '0123456789',
        });
      }).then(function (result) {
        var text = (result && result.data && result.data.text) || '';
        var nums = parseNumbers(text);
        showConfirmModal(nums, dataUrl);
      }).catch(function (err) {
        showStatus('Error: ' + (err && err.message ? err.message : err));
        console.error('[ocr] failed', err);
      });
    };
    reader.readAsDataURL(file);
  }

  // ---------- Button injection ----------
  function installButton() {
    var pane = document.getElementById('p0');
    if (!pane) return false;
    if (document.getElementById('lfocr-btn')) return true;
    // Place into the same .actions row as Undo so it shares the sticky strip.
    var actions = pane.querySelector('.actions');
    if (!actions) return false;
    var btn = document.createElement('button');
    btn.id = 'lfocr-btn';
    btn.type = 'button';
    btn.title = 'Import numbers from a scoreboard photo';
    btn.textContent = '📷 Photo';
    btn.style.cssText = 'background:#3a5a8a;color:#fff;border:1px solid #6a8acc;border-radius:6px;padding:4px 10px;font-size:.9em;cursor:pointer;margin-left:6px';
    btn.onclick = function () {
      var fi = document.getElementById('lfocr-file');
      if (fi) fi.click();
    };
    var fi = document.createElement('input');
    fi.type = 'file';
    fi.accept = 'image/*';
    fi.capture = 'environment';
    fi.id = 'lfocr-file';
    fi.style.display = 'none';
    fi.onchange = function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) handleFile(f);
      e.target.value = ''; // allow re-select same file
    };
    actions.appendChild(btn);
    actions.appendChild(fi);
    return true;
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
