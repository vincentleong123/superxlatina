/* Player add-ons for Super X Latina (ported from xMelayu): a resume-watching
   pill and a keyboard-shortcuts overlay ("?"). The custom timeline scrubber
   was skipped because the WPS player already ships a live-preview timeline;
   shared keys are left to the WPS player via a defaultPrevented guard. */
(function () {
  var v = document.getElementById('wpsVideo');
  if (!v || !v.load) return;
  var wrap = v.closest('.wps-player') || v.parentElement;
  if (!wrap) return;
  var vidKey = (v.getAttribute('data-vid') || '').trim();

  function fmt(t) {
    t = Math.max(0, Math.floor(t));
    var m = Math.floor(t / 60), s = t % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ── Resume-watching pill ── */
  var pill = document.createElement('div'); pill.id = 'resumePill';
  pill.innerHTML = '<span class="rp-play">&#9654;</span><span class="rp-label"></span>';
  wrap.appendChild(pill);

  if (vidKey) {
    var KEY = 'xmv_resume:' + vidKey;
    var saved = 0, saveTimer = null;
    try { saved = parseFloat(localStorage.getItem(KEY)) || 0; } catch (err) {}

    function saveNow() {
      try {
        if (v.duration && v.currentTime > 8 && v.currentTime < v.duration - 5) {
          localStorage.setItem(KEY, String(v.currentTime));
        }
      } catch (err) {}
    }
    v.addEventListener('timeupdate', function () {
      if (saveTimer) return;
      saveTimer = setTimeout(function () { saveTimer = null; saveNow(); }, 4000);
    });
    window.addEventListener('beforeunload', saveNow);
    v.addEventListener('ended', function () { try { localStorage.removeItem(KEY); } catch (err) {} });

    var resumed = false;
    function maybeResume() {
      if (resumed || !(saved > 15)) return;
      var rem = (v.duration || 0) - saved;
      if (rem < 8) return;
      var label = pill.querySelector('.rp-label');
      label.textContent = 'Resume from ' + fmt(saved) + '  \u00b7  or restart';
      pill.classList.add('show');
      var hideTimer = setTimeout(function () { pill.classList.remove('show'); }, 9000);
      wrap.addEventListener('click', function () {
        clearTimeout(hideTimer); pill.classList.remove('show');
      }, { once: true });
      pill.onclick = function (ev) {
        ev.stopPropagation();
        resumed = true;
        clearTimeout(hideTimer);
        pill.classList.remove('show');
        try { v.currentTime = saved; } catch (err) {}
        try { var p = v.play(); if (p && p.catch) p.catch(function () {}); } catch (err) {}
        saveNow();
      };
    }
    v.addEventListener('loadedmetadata', maybeResume);
    setTimeout(function () { if (v.readyState >= 1) maybeResume(); }, 700);
  }

  /* ── Keyboard shortcuts ── */
  var help = document.createElement('div'); help.id = 'kbdHelp';
  function row(html, key) { return '<div class="kb-row"><span>' + html + '</span><kbd>' + key + '</kbd></div>'; }
  help.innerHTML = '<div class="kbd-box"><h3>Keyboard shortcuts</h3>' +
    row('Play / Pause', 'Space') +
    row('Seek to <b>#</b>% of video', '0&#8211;9') +
    row('Seek start / end', 'Home / End') +
    row('Volume', '&#9650; / &#9660;') +
    row('Mute', 'M') +
    row('Fullscreen', 'F') +
    row('Previous / Next video', '&#8592; / &#8594;') +
    row('Close this panel', 'Esc') + '</div>';
  wrap.appendChild(help);

  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented) return; // let the WPS player handle shared keys first
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t.isContentEditable))) return;
    if (help.classList.contains('show')) {
      if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); help.classList.remove('show'); }
      return;
    }
    if (e.key === '?' || (e.key === '/' && e.shiftKey)) { e.preventDefault(); help.classList.add('show'); return; }
    if (e.key === 'm' || e.key === 'M') { v.muted = !v.muted; return; }
    if (e.key === 'Home') { v.currentTime = 0; return; }
    if (e.key === 'End') { v.currentTime = v.duration || 0; return; }
    if (/^[0-9]$/.test(e.key)) { v.currentTime = (parseInt(e.key, 10) / 10) * (v.duration || 0); return; }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      v.volume = Math.min(1, Math.round(((v.muted ? 1 : v.volume) + 0.1) * 10) / 10);
      v.muted = false; return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      var nv = Math.max(0, Math.round(((v.muted ? 1 : v.volume) - 0.1) * 10) / 10);
      v.volume = nv; v.muted = false; return;
    }
  });
})();