/* VAST player for Super X Latina — ported from xMelayu.
   TAG = EASY channel mid-roll units; fires once per 90s cap after 25s of
   playback on any <video data-vast>. Full VAST2 XML → first MP4 MediaFile,
   complete tracking (impression/creativeView/start/quartiles/skip/complete/
   mute/unmute) + impression/error pixels, skip-with-countdown, mute toggle,
   loading spinner and an 8s watchdog. Exposed as window.XVAST. */
(function () {
  var ZONES = ['6039304', '6039306', '6039312'];
  var CAP_MS = 90000;
  var DELAY_SECS = 25;
  var lastShown = 0;
  var adCache = null;
  var adBusy = null;
  var attached = new Map();
  var stylesInjected = false;
  var observer = null;

  function fire(u) {
    if (!u) return;
    try { var i = new Image(); i.src = u; } catch (e) {}
  }

  function clean(s) {
    return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  }

  function text(el) { return el && el.textContent ? el.textContent.trim() : ''; }
  function attr(el, name) { return el ? (el.getAttribute(name) || '') : ''; }

  function toSec(t) {
    if (!t) return NaN;
    var m = String(t).match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
    if (!m) return NaN;
    return ((+m[1] || 0) * 60 + (+m[2])) * 60 + parseFloat(m[3]);
  }

  function parseVast(xml) {
    var doc;
    try { doc = new DOMParser().parseFromString(xml, 'application/xml'); } catch (e) { return null; }
    if (!doc || doc.getElementsByTagName('parsererror').length) return null;
    var linear = doc.querySelector('Linear');
    if (!linear) return null;
    var files = linear.querySelectorAll('MediaFile');
    var media = '';
    for (var i = 0; i < files.length; i++) {
      var type = String(attr(files[i], 'type')).toLowerCase();
      if (type.indexOf('mp4') !== -1) { media = clean(text(files[i])); break; }
    }
    if (!media && files.length) media = clean(text(files[0]));
    if (!media) return null;
    var tracking = {};
    var evs = linear.querySelectorAll('Tracking');
    for (var j = 0; j < evs.length; j++) {
      var ev = attr(evs[j], 'event');
      if (!ev) continue;
      if (!tracking[ev]) tracking[ev] = [];
      tracking[ev].push(clean(text(evs[j])));
    }
    var errors = linear.getElementsByTagName('Error');
    return {
      media: media,
      duration: toSec(text(linear.querySelector('Duration'))),
      skipOffset: toSec(attr(linear, 'skipoffset')),
      clickThrough: clean(text(linear.querySelector('ClickThrough'))),
      impression: clean(text(doc.querySelector('Impression'))),
      error: errors.length ? clean(text(errors[0])) : '',
      tracking: tracking
    };
  }

  function loadAd() {
    if (adCache !== null) return Promise.resolve(adCache);
    if (adBusy) return adBusy;
    var zi = 0;
    adBusy = (function attempt() {
      if (zi >= ZONES.length) return Promise.resolve(null);
      var tag = 'https://s.magsrv.com/v1/vast.php?idzone=' + ZONES[zi++];
      return fetch(tag, { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.text(); })
        .then(parseVast)
        .then(function (ad) { if (ad) return ad; throw new Error('empty'); })
        .catch(function () { return attempt(); });
    })()
      .finally(function () { adBusy = null; })
      .then(function (ad) { adCache = ad; return ad; });
    return adBusy;
  }

  function injectStyles() {
    var s = document.createElement('style');
    s.textContent = [
      '.xv-ad{position:absolute;inset:0;z-index:60;background:#000;overflow:hidden;direction:ltr}',
      '.xv-ad-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}',
      '.xv-ad-click{position:absolute;inset:0;z-index:1;cursor:pointer}',
      '.xv-ad-top{position:absolute;top:0;left:0;right:0;z-index:2;display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:8px 10px;background:linear-gradient(rgba(0,0,0,.55),transparent);pointer-events:none}',
      '.xv-ad-top>*{pointer-events:auto}',
      '.xv-ad-badge{font:600 10px/1.4 Arial,sans-serif;text-transform:uppercase;letter-spacing:1px;color:#fff;background:rgba(255,255,255,.22);padding:3px 8px;border-radius:3px;margin-right:auto}',
      '.xv-ad-count{font:700 12px/1.4 Arial,sans-serif;color:#fff;min-width:34px;text-align:center;text-shadow:0 1px 2px rgba(0,0,0,.8)}',
      '.xv-ad-skip{display:none;font:700 12px/1.4 Arial,sans-serif;color:#fff;background:rgba(0,0,0,.72);border:1px solid rgba(255,255,255,.35);padding:7px 14px;border-radius:4px;cursor:pointer}',
      '.xv-ad-skip:hover{background:rgba(245,158,11,.9);border-color:transparent}',
      '.xv-ad-mute{position:absolute;right:10px;bottom:10px;z-index:2;font:700 11px/1.4 Arial,sans-serif;color:#fff;background:rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.25);padding:5px 10px;border-radius:4px;cursor:pointer}',
      '.xv-ad-loading{position:absolute;inset:0;z-index:3;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);pointer-events:none}',
      '.xv-ad-loading span{font:700 12px/1.4 Arial,sans-serif;color:#fff;letter-spacing:2px;text-transform:uppercase;padding:8px 14px;border-radius:4px;background:rgba(255,255,255,.12)}',
      '.xv-ad-loading::after{content:"";width:14px;height:14px;margin-left:8px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:xvspin .8s linear infinite}',
      '@keyframes xvspin{to{transform:rotate(360deg)}}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  }

  function runAd(state, host, ad) {
    if (!state.live) return;
    if (Date.now() - lastShown < CAP_MS) {
      attached.delete(state.el);
      state.el.removeAttribute('data-xv');
      return;
    }
    lastShown = Date.now();

    var el = state.el;
    el.pause();

    if (!stylesInjected) { stylesInjected = true; injectStyles(); }
    var o = document.createElement('div');
    o.className = 'xv-ad';
    o.setAttribute('role', 'presentation');
    o.innerHTML =
      '<video class="xv-ad-video" playsinline></video>' +
      '<div class="xv-ad-click" role="link" aria-label="Advertisement"></div>' +
      '<div class="xv-ad-top"><span class="xv-ad-badge">Ad</span><span class="xv-ad-count"></span><button class="xv-ad-skip" type="button">Skip Ad &raquo;</button></div>' +
      '<button class="xv-ad-mute" type="button">Mute</button>' +
      '<div class="xv-ad-loading"><span>Ad</span></div>';
    host.appendChild(o);

    var v = o.querySelector('.xv-ad-video');
    var click = o.querySelector('.xv-ad-click');
    var skip = o.querySelector('.xv-ad-skip');
    var count = o.querySelector('.xv-ad-count');
    var mute = o.querySelector('.xv-ad-mute');
    var loading = o.querySelector('.xv-ad-loading');
    var skippable = ad.skipOffset && isFinite(ad.skipOffset) && ad.skipOffset > 0;
    var announced = false;
    var skipReady = false;
    var fired = {};
    var watchdog = null;

    function trace(ev) {
      if (fired[ev] || !ad.tracking[ev] || !ad.tracking[ev].length) return;
      fired[ev] = true;
      for (var i = 0; i < ad.tracking[ev].length; i++) fire(ad.tracking[ev][i]);
    }

    function finish() {
      if (!state.live) return;
      state.live = false;
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      v.pause();
      v.removeAttribute('src'); v.load();
      if (o.parentNode) o.parentNode.removeChild(o);
      attached.delete(el);
      el.removeAttribute('data-xv');
      if (el.paused) {
        try { var p = el.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
      }
    }

    o.addEventListener('click', function (e) {
      if (e.target === skip || e.target === mute || e.target === count) return;
      if (ad.clickThrough) { try { window.open(ad.clickThrough, '_blank', 'noopener'); } catch (e2) {} }
    });

    mute.addEventListener('click', function (e) {
      e.stopPropagation();
      v.muted = !v.muted;
      mute.textContent = v.muted ? 'Mute' : 'Unmute';
      trace(v.muted ? 'mute' : 'unmute');
    });

    skip.addEventListener('click', function (e) {
      e.stopPropagation();
      trace('skip'); finish();
    });

    v.addEventListener('error', function () {
      if (!state.live) return;
      if (ad.error) fire(ad.error.replace('[ERRORCODE]', '303'));
      finish();
    });

    v.addEventListener('ended', function () { if (state.live) { trace('complete'); finish(); } });

    v.addEventListener('canplay', function () { if (o.parentNode) loading.style.display = 'none'; });

    v.addEventListener('playing', function () {
      if (o.parentNode) loading.style.display = 'none';
      if (announced || !state.live) return;
      announced = true;
      fire(ad.impression);
      trace('creativeView');
      trace('start');
    });

    v.addEventListener('timeupdate', function () {
      if (!o.parentNode) return;
      var d = v.duration || ad.duration || 0;
      var t = v.currentTime || 0;
      if (d > 0) {
        var p = t / d;
        if (p >= 0.25) trace('firstQuartile');
        if (p >= 0.5) trace('midpoint');
        if (p >= 0.75) trace('thirdQuartile');
      }
      if (skippable) {
        if (t >= ad.skipOffset) {
          if (!skipReady) { skipReady = true; skip.style.display = 'block'; count.style.display = 'none'; }
        } else {
          var s = Math.ceil(ad.skipOffset - t);
          if (s <= 0) { skipReady = true; skip.style.display = 'block'; count.style.display = 'none'; }
          else count.textContent = s;
        }
      } else if (d > 0) {
        count.textContent = Math.ceil(d - t);
      }
    });

    watchdog = setTimeout(function () {
      if (state.live && v.paused && v.readyState < 3 && !v.error) finish();
    }, 8000);

    v.muted = true;
    v.src = ad.media;
    try { var pr = v.play(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) { finish(); }
  }

  function attach(el) {
    if (!el || typeof el.play !== 'function' || attached.has(el)) return;
    if (el.hasAttribute('data-xv-no')) return;
    attached.set(el, { el: el, live: true });
    var state = attached.get(el);

    var host = el.parentElement;
    if (!host) { attached.delete(el); return; }
    var cs = getComputedStyle(host);
    if (cs.position === 'static') host.style.position = 'relative';

    var started = false;
    function maybe() {
      if (!state.live || started) return;
      if (el.currentTime < DELAY_SECS) return;
      started = true;
      el.removeEventListener('timeupdate', maybe);
      loadAd().then(function (ad) {
        if (!state.live) return;
        if (ad) runAd(state, host, ad);
        else {
          attached.delete(el);
          el.removeAttribute('data-xv');
        }
      });
    }
    el.addEventListener('timeupdate', maybe);
    if (el.currentTime >= DELAY_SECS) maybe();
  }

  function boot() {
    var els = document.querySelectorAll('video[data-vast]:not([data-xv])');
    for (var i = 0; i < els.length; i++) {
      els[i].setAttribute('data-xv', '1');
      attach(els[i]);
    }
    if (observer) return;
    observer = new MutationObserver(function () {
      var found = document.querySelectorAll('video[data-vast]:not([data-xv])');
      for (var j = 0; j < found.length; j++) {
        found[j].setAttribute('data-xv', '1');
        attach(found[j]);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.XVAST = { attach: attach, tag: ZONES.map(function (z) { return 'https://s.magsrv.com/v1/vast.php?idzone=' + z; }).join(' ') };
})();