/*
 * HKM FOH Companion — pairing/connect logic.
 *
 * Flow:
 *   1. Engineer pairs from the desktop console (Hardware & Diagnostics →
 *      Remote Access). The desktop shows an `hkm://pair?host=…&port=…&token=…`
 *      QR; scanning it with the phone camera opens this APK and auto-links.
 *   2. Manual fallback: type the console LAN address + 16-char pairing token.
 *   3. This screen validates the target by probing `GET /api/remote/session`,
 *      saves the pair to the recent list, then hands the WebView to the
 *      console's live companion surface: `/?mode=remote&token=…` — a
 *      touch-optimized FOH remote synced in real time over the HKM WebSocket
 *      relay (faders, mutes, zones, master trim, telemetry meters).
 */

(function () {
  'use strict';

  var RECENT_KEY = 'hkm.companion.recent';
  var MAX_RECENT = 5;

  function $(id) {
    return document.getElementById(id);
  }

  var form = $('pair-form');
  var hostInput = $('host');
  var tokenInput = $('token');
  var connectBtn = $('connect-btn');
  var connectBtnLabel = $('connect-btn-label');
  var statusBox = $('status');
  var recentCard = $('recent-card');
  var recentList = $('recent-list');
  var clearRecentBtn = $('clear-recent');

  var linking = false;

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  function showStatus(text, kind) {
    statusBox.hidden = false;
    statusBox.textContent = text;
    statusBox.className = 'status ' + (kind || 'info');
  }

  function hideStatus() {
    statusBox.hidden = true;
    statusBox.textContent = '';
    statusBox.className = 'status';
  }

  function setBusy(busy) {
    linking = busy;
    connectBtn.disabled = busy;
    hostInput.disabled = busy;
    tokenInput.disabled = busy;
    connectBtnLabel.textContent = busy ? 'Linking…' : 'Link console';
  }

  /** "192.168.1.42" / "http://192.168.1.42:3000/" → "http://192.168.1.42:3000" */
  function normalizeBase(raw) {
    var v = String(raw || '').trim();
    if (!v) return null;
    v = v.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!v) return null;
    if (!/:\d{1,5}$/.test(v)) v += ':3000';
    return 'http://' + v;
  }

  function loadRecent() {
    try {
      var raw = window.localStorage.getItem(RECENT_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function saveRecent(entry) {
    var list = loadRecent().filter(function (r) {
      return r.base !== entry.base;
    });
    list.unshift(entry);
    try {
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
    } catch (e) {
      /* storage full/blocked — recent list is best-effort */
    }
  }

  function renderRecent() {
    var list = loadRecent();
    recentCard.hidden = list.length === 0;
    recentList.innerHTML = '';
    list.forEach(function (entry) {
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'recent-item';

      var hostSpan = document.createElement('span');
      hostSpan.className = 'recent-host';
      hostSpan.textContent = entry.base;

      var metaSpan = document.createElement('span');
      metaSpan.className = 'recent-meta';
      var when = entry.at ? new Date(entry.at) : null;
      var whenText = when
        ? when.toLocaleDateString() + ' ' + when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';
      metaSpan.textContent = (entry.label || 'HKM console') + (whenText ? ' · ' + whenText : '');

      btn.appendChild(hostSpan);
      btn.appendChild(metaSpan);
      btn.addEventListener('click', function () {
        hostInput.value = entry.base.replace(/^https?:\/\//i, '');
        tokenInput.value = entry.token || '';
        window.scrollTo({ top: 0, behavior: 'smooth' });
        hideStatus();
      });
      li.appendChild(btn);
      recentList.appendChild(li);
    });
  }

  // ------------------------------------------------------------------
  // Connect
  // ------------------------------------------------------------------

  function connect(base, token) {
    if (linking) return;
    if (!base || !token || token.replace(/\s+/g, '').length < 8) {
      showStatus('Enter the desktop console address and its 16-character pairing token.', 'error');
      return;
    }
    token = token.replace(/\s+/g, '');

    setBusy(true);
    showStatus('Contacting console at ' + base + ' …', 'info');

    var done = false;
    var timer = window.setTimeout(function () {
      if (!done) {
        done = true;
        setBusy(false);
        showStatus(
          'No answer from ' + base + '. Check the address, and that the phone and the ' +
            'desktop console are on the same Wi-Fi network.',
          'error'
        );
      }
    }, 9000);

    window
      .fetch(base + '/api/remote/hello', { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        if (!data || data.app !== 'hkm-master-audio-console') {
          setBusy(false);
          showStatus('That address answered, but it is not an HKM Master Audio Console.', 'error');
          return;
        }
        var label = data.venueName ? data.venueName + ' · ' + (data.roomName || 'FOH') : 'Linked console';
        saveRecent({ base: base, token: token, label: label, at: Date.now() });
        showStatus('Linked with ' + label + ' — opening the console remote…', 'ok');
        window.location.assign(base + '/?mode=remote&token=' + encodeURIComponent(token));
      })
      .catch(function () {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        setBusy(false);
        showStatus(
          'Cannot reach the HKM console at ' + base + '. Check the address, and that the ' +
            'phone and the desktop console are on the same Wi-Fi network.',
          'error'
        );
      });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    hideStatus();
    var base = normalizeBase(hostInput.value);
    if (!base) {
      showStatus('Enter the desktop console address (for example 192.168.1.42).', 'error');
      return;
    }
    connect(base, tokenInput.value);
  });

  clearRecentBtn.addEventListener('click', function () {
    try {
      window.localStorage.removeItem(RECENT_KEY);
    } catch (e) {
      /* ignore */
    }
    renderRecent();
  });

  // ------------------------------------------------------------------
  // Deep link: hkm://pair?host=192.168.1.42&port=3000&token=ABCD…
  // ------------------------------------------------------------------

  function handleDeepLink(url) {
    if (!url || !/^hkm:\/\/pair/i.test(String(url))) return false;
    try {
      var u = new URL(String(url));
      var host = u.searchParams.get('host') || '';
      var port = u.searchParams.get('port') || '3000';
      var token = (u.searchParams.get('token') || '').replace(/\s+/g, '');
      if (!host || !token) return false;

      hostInput.value = host + (String(port) && String(port) !== '80' ? ':' + port : '');
      tokenInput.value = token;
      hideStatus();
      connect('http://' + host + ':' + port, token);
      return true;
    } catch (e) {
      return false;
    }
  }

  function initCapacitor() {
    var cap = window.Capacitor;
    if (!cap || !cap.Plugins || !cap.Plugins.App) return;
    var App = cap.Plugins.App;

    if (typeof App.addListener === 'function') {
      App.addListener('appUrlOpen', function (data) {
        if (data && data.url) handleDeepLink(data.url);
      });
    }

    if (typeof App.getLaunchUrl === 'function') {
      App.getLaunchUrl()
        .then(function (launch) {
          if (launch && launch.url) handleDeepLink(launch.url);
        })
        .catch(function () {
          /* not launched via link */
        });
    }
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------

  window.addEventListener('load', function () {
    renderRecent();
    initCapacitor();

    var recent = loadRecent();
    if (recent.length > 0 && !hostInput.value) {
      hostInput.value = recent[0].base.replace(/^https?:\/\//i, '');
    }
    if (/iPhone|iPad|Android/i.test(navigator.userAgent)) {
      hostInput.setAttribute('autofocus', 'autofocus');
    }
  });
})();
