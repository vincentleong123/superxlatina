/* WPS Player (lite) — lean, adaptive, no ads/HLS-double-buffer/sprite VTT.
   Contract: works with the shared .wps-player markup in the player templates.
   Auto-adapts the stage to each video's real aspect ratio (no crop), uses a
   downloaded preview clip for instant motion + scrub previews (no double
   stream fetch), and folds retry/error handling in here. */
(function () {
  'use strict';

  var root = document.querySelector('.wps-player');
  if (!root) return;
  var video = document.getElementById('wpsVideo');
  if (!video) return;
  function $(s, r) { return (r || root).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || root).querySelectorAll(s)); }

  var SRC = root.getAttribute('data-src') || '';
  var POSTER = root.getAttribute('data-poster') || '';
  var PREVIEW_SRC = root.getAttribute('data-preview') || '';
  var IS_HLS = /\.m3u8(\?|$|#)/i.test(SRC);

  // element refs
  var controlsEl = $('.wps-controls'),
      centerPlay = $('.wps-big-play'),
      loaderEl = $('.wps-loader'),
      loaderPct = $('.wps-loader-pct'),
      posterEl = $('.wps-poster'),
      progressWrap = $('.wps-progress-wrap'),
      progressEl = $('.wps-progress'),
      bufferedEl = $('.wps-buffered'),
      playedEl = $('.wps-played'),
      thumbEl = $('.wps-thumb'),
      previewBubble = $('.wps-preview-bubble'),
      previewImg = $('.wps-preview-img'),
      previewTime = $('.wps-preview-time'),
      previewVideo = $('.wps-preview-video'),
      previewCanvas = $('.wps-preview-canvas'),
      previewCtx = previewCanvas ? previewCanvas.getContext('2d') : null,
      timeEl = $('.wps-time'),
      qualityBtn = $('[data-act="quality"]'),
      speedBtn = $('[data-act="speed"]');

  var hls = null;
  var HLS_SUPPORTED = typeof Hls !== 'undefined' && Hls.isSupported();

  var state = {
    controlsVisible: true, hideTimer: null,
    scrubbing: false, dragging: false, wasPaused: true,
    muted: false, volume: 1,
    retries: 0, MAX_RETRIES: 2,
    introMode: false, introTimer: null
  };

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    return (h > 0 ? h + ':' + (m < 10 ? '0' : '') + m : m) + ':' + (s < 10 ? '0' : '') + s;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function ratioFromEvent(e) {
    var r = progressEl.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  }

  // ── normalized stage ──
  //    Desktop: fixed 16:10 stage, everything object-fit:contain — fully
  //    normalized, no stretch, no crop.
  //    Mobile (no fullscreen / no rotate needed — autoplays silent):
  //      • landscape fills a 16:11 stage (mild "not too slim" fill so the
  //        video reads big instead of a thin sliver);
  //      • portrait matches its own native ratio so it scales as large as the
  //        screen allows, still object-fit:contain (bigger, never cropped).
  //    Both are capped to ~90% of the viewport height so nothing overflows.
  function fitStage() {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      var landscape = video.videoWidth > video.videoHeight;
      var fs = !!document.fullscreenElement;
      var stretchPoster = false;
      if (fs) {
        root.style.aspectRatio = '';
        video.style.objectFit = 'contain';
        root.classList.remove('wps-stretch');
        root.classList.add('wps-portrait');
      } else if (window.innerWidth <= 768) {
        var availW = root.clientWidth || window.innerWidth;
        var need = availW / (window.innerHeight * 0.9);
        var ratio;
        if (landscape) {
          ratio = Math.max(16 / 11, need);
          video.style.objectFit = 'fill';
          stretchPoster = true;
        } else {
          ratio = Math.max(video.videoWidth / video.videoHeight, need);
          video.style.objectFit = 'contain';
        }
        root.style.aspectRatio = Math.min(ratio, 3).toFixed(4);
        root.classList.toggle('wps-stretch', landscape);
        root.classList.toggle('wps-portrait', !landscape);
      } else {
        root.style.aspectRatio = '16 / 10';
        video.style.objectFit = 'contain';
        root.classList.toggle('wps-stretch', landscape);
        root.classList.toggle('wps-portrait', !landscape);
      }
      if (posterEl) posterEl.style.backgroundSize = stretchPoster ? '100% 100%' : 'contain';
    }
  }

  // ── source loading (mp4 + native/hls fallback) ──
  function loadMedia(src, autoplay) {
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    video.removeAttribute('src');
    video.load();
    IS_HLS = /\.m3u8(\?|$|#)/i.test(src);
    if (IS_HLS && HLS_SUPPORTED) {
      hls = new Hls({ maxBufferLength: 30, startFragPrefetch: true });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        buildQualityMenu();
        if (autoplay) { var p = video.play(); if (p && p.catch) p.catch(function () {}); }
      });
      hls.on(Hls.Events.ERROR, function (e, d) {
        if (d && d.fatal) retry();
      });
    } else {
      video.setAttribute('src', src);
      video.load();
      if (autoplay) { var p2 = video.play(); if (p2 && p2.catch) p2.catch(function () {}); }
    }
    // scrub source: prefer the tiny downloaded clip (never double-fetch hotlink)
    if (previewVideo) {
      previewVideo.removeAttribute('src');
      if (PREVIEW_SRC) { previewVideo.setAttribute('src', PREVIEW_SRC); previewVideo.load(); }
    }
    if (previewImg && POSTER) previewImg.style.backgroundImage = 'url(' + POSTER + ')';
  }

  function retry() {
    if (state.retries >= state.MAX_RETRIES || !SRC) {
      var errUi = document.getElementById('playerError');
      if (errUi) errUi.style.display = 'block';
      if (loaderEl) loaderEl.classList.remove('show');
      return;
    }
    state.retries++;
    if (loaderEl) loaderEl.classList.add('show');
    setTimeout(function () {
      loadMedia(SRC, true);
      if (loaderEl) setTimeout(function () { loaderEl.classList.remove('show'); }, 5000);
    }, 700);
  }

  // ── perceived speed: instant-motion intro clip, then real stream ──
  function introEnd() {
    if (!state.introMode) return;
    state.introMode = false;
    if (state.introTimer) { clearTimeout(state.introTimer); state.introTimer = null; }
    video.removeAttribute('data-intro');
    video.removeAttribute('src');
    video.load();
    loadMedia(SRC, true);
  }

  function introStart() {
    if (!PREVIEW_SRC || IS_HLS) { loadMedia(SRC, true); return; }
    state.introMode = true;
    video.setAttribute('data-intro', '1');
    video.setAttribute('src', PREVIEW_SRC);
    video.load();
    var p = video.play();
    if (p && p.catch) p.catch(function () {});
    video.addEventListener('ended', introEnd, { once: true });
    state.introTimer = setTimeout(introEnd, 7000);
  }

  // ── controls visibility ──
  function showControls() {
    state.controlsVisible = true;
    root.classList.add('wps-controls-on');
    scheduleHide();
  }
  function scheduleHide() {
    if (state.hideTimer) clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(function () {
      if (!video.paused && !state.scrubbing && !video.muted) hideControls();
    }, 2600);
  }
  function hideControls() {
    state.controlsVisible = false;
    root.classList.remove('wps-controls-on');
    closeMenus();
  }
  function toggleControls() {
    if (state.controlsVisible && video.currentTime > 0 && !video.paused) hideControls();
    else showControls();
  }
  function closeMenus() { $$('.wps-menu').forEach(function (m) { m.classList.remove('open'); }); }

  // ── play / pause ──
  var PLAY_SVG = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  var PAUSE_SVG = '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
  function updatePlayBtn() {
    var b = $('[data-act="play"]');
    if (!b) return;
    b.innerHTML = video.paused ? PLAY_SVG : PAUSE_SVG;
    b.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
  }
  function togglePlay() {
    if (video.paused || video.ended) { var p = video.play(); if (p && p.catch) p.catch(function () {}); }
    else video.pause();
  }

  // ── progress ──
  function updateProgress() {
    var d = video.duration || 0, c = video.currentTime || 0;
    if (d > 0) {
      playedEl.style.width = (c / d) * 100 + '%';
      thumbEl.style.left = (c / d) * 100 + '%';
      bufferedEl.style.width = bufferPct() + '%';
    }
    if (timeEl) timeEl.textContent = fmt(c) + ' / ' + fmt(d);
  }
  function bufferPct() {
    var d = video.duration || 0;
    if (d <= 0) return 0;
    if (video.buffered && video.buffered.length) return Math.min(100, (video.buffered.end(video.buffered.length - 1) / d) * 100);
    return 0;
  }
  function updateLoaderPct() {
    if (!loaderPct || !loaderEl || !loaderEl.classList.contains('show')) return;
    var p = Math.round(bufferPct());
    loaderPct.textContent = p > 0 ? p + '% buffered' : 'Loading…';
  }

  // ── scrub preview (uses downloaded clip; poster fallback) ──
  function drawFrame() {
    if (!previewCtx || !previewVideo) return;
    try {
      previewCtx.drawImage(previewVideo, 0, 0, 160, 90);
      previewCanvas.style.display = 'block';
      if (previewImg) previewImg.style.display = 'none';
    } catch (e) {}
  }
  if (previewVideo) {
    previewVideo.addEventListener('seeked', function () {
      if (previewBubble.classList.contains('show')) drawFrame();
    });
    previewVideo.addEventListener('loadeddata', function () {
      if (previewBubble.classList.contains('show')) drawFrame();
    });
  }
  // Position the popup so it follows the cursor and never runs off the bar.
  function positionBubble(ratio) {
    var wrapW = progressWrap.clientWidth || 1;
    var bubbleW = previewBubble.offsetWidth || 180;
    var half = bubbleW / 2;
    var px = ratio * wrapW;
    var left = Math.max(half, Math.min(wrapW - half, px));
    previewBubble.style.left = left + 'px';
    var car = px - (left - half);
    car = Math.max(8, Math.min(bubbleW - 8, car));
    previewBubble.style.setProperty('--car', car.toFixed(1) + 'px');
  }
  function scrubTo(ratio) {
    var d = video.duration || 0, t = ratio * d;
    video.currentTime = t;
    if (timeEl) timeEl.textContent = fmt(t) + ' / ' + fmt(d);
    if (previewTime) previewTime.textContent = fmt(t);
    positionBubble(ratio);
    if (previewVideo && PREVIEW_SRC) {
      try {
        if (previewVideo.readyState >= 1) previewVideo.currentTime = t;
      } catch (e) {}
    } else if (previewImg) {
      previewImg.style.backgroundSize = 'cover';
      previewImg.style.backgroundPosition = 'center';
    }
  }
  function handleHover(e) {
    if (state.dragging) return;
    var ratio = ratioFromEvent(e), d = video.duration || 0;
    positionBubble(ratio);
    if (previewTime) previewTime.textContent = fmt(ratio * d);
    if (previewBubble && d) previewBubble.classList.add('show');
    if (state.scrubbing) return;
    // light hover: poster or scrub-video frame
    if (previewVideo && PREVIEW_SRC && previewVideo.readyState >= 1) {
      try { previewVideo.currentTime = ratio * d; } catch (e2) {}
    }
  }
  function startScrub(e) {
    state.scrubbing = true; state.dragging = true;
    state.wasPaused = video.paused;
    video.pause();
    if (previewBubble) previewBubble.classList.add('show');
    root.classList.add('wps-scrubbing');
    closeMenus();
    scrubTo(ratioFromEvent(e));
  }
  function endScrub() {
    state.scrubbing = false; state.dragging = false;
    if (previewBubble) previewBubble.classList.remove('show');
    root.classList.remove('wps-scrubbing');
    if (!state.wasPaused) { var p = video.play(); if (p && p.catch) p.catch(function () {}); }
    showControls();
  }

  // ── menus ──
  function buildSpeedMenu() {
    var menu = $('.wps-menu[data-menu="speed"]');
    if (!menu) return;
    [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].forEach(function (r) {
      var b = document.createElement('button');
      b.textContent = r + 'x';
      b.addEventListener('click', function () {
        video.playbackRate = r;
        if (speedBtn) speedBtn.textContent = r + 'x';
        closeMenus();
      });
      menu.appendChild(b);
    });
  }
  function buildQualityMenu() {
    if (!hls || !hls.levels || hls.levels.length < 2) { if (qualityBtn) qualityBtn.style.display = 'none'; return; }
    if (qualityBtn) qualityBtn.style.display = '';
    var menu = $('.wps-menu[data-menu="quality"]');
    if (!menu) return;
    menu.innerHTML = '';
    var seen = {};
    [{ label: 'Auto', level: -1 }].concat(
      hls.levels.slice().reverse().filter(function (l) {
        if (seen[l.height]) return false; seen[l.height] = 1; return true;
      }).map(function (l) {
        var h = l.height;
        return { label: (h >= 1000 ? (h / 1000).toFixed(1) : h) + 'p', level: hls.levels.indexOf(l) };
      })
    ).forEach(function (it) {
      var b = document.createElement('button');
      b.textContent = it.label;
      b.addEventListener('click', function () {
        try { hls.currentLevel = it.level; } catch (e) {}
        closeMenus();
      });
      menu.appendChild(b);
    });
  }

  // ── fullscreen / pip / speed seek ──
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (root.requestFullscreen) root.requestFullscreen();
  }
  function togglePip() {
    if (document.pictureInPictureElement) document.exitPictureInPicture();
    else if (video.requestPictureInPicture) video.requestPictureInPicture();
  }
  function seekRelative(sec, flash) {
    video.currentTime = clamp(video.currentTime + sec, 0, video.duration || 0);
    if (flash) {
      var el = document.createElement('div');
      el.className = 'wps-seek-flash';
      el.textContent = (sec > 0 ? '+' : '') + sec + 's';
      root.appendChild(el);
      setTimeout(function () { el.remove(); }, 650);
    }
    showControls();
  }

  // ── TikTok-style hot keys: Left/Right jump to prev/next video ──
  function goVideo(dir) {
    var link = document.getElementById(dir < 0 ? 'navPrev' : 'navNext');
    if (link && link.getAttribute('href')) {
      var href = link.getAttribute('href');
      if (link.classList && link.classList.contains('counting')) {
        var evt = new MouseEvent('click', { bubbles: true, cancelable: true });
        link.dispatchEvent(evt);
      }
      window.location.href = href;
    }
  }

  // ── touch gestures ──
  var lastTap = 0;
  function handleTap(e) {
    var now = Date.now();
    if (now - lastTap < 320) {
      var r = root.getBoundingClientRect(), x = e.clientX - r.left;
      if (x < r.width / 3) seekRelative(-10, true);
      else if (x > (r.width * 2) / 3) seekRelative(10, true);
      lastTap = 0;
      return;
    }
    lastTap = now;
    toggleControls();
  }

  // ── volume ──
  function adjustVolume(d) {
    state.volume = clamp(state.volume + d, 0, 1);
    video.volume = state.volume;
    video.muted = state.volume === 0;
    state.muted = video.muted;
    updateVolBtn();
    var v = $('.wps-volume input'); if (v) v.value = state.volume;
  }
  function toggleMute() {
    state.muted = !state.muted;
    video.muted = state.muted;
    updateVolBtn();
  }
  function updateVolBtn() {
    var b = $('[data-act="mute"]');
    if (b) b.classList.toggle('muted', video.muted || video.volume === 0);
  }

  // ── media events ──
  video.addEventListener('timeupdate', updateProgress);
  video.addEventListener('progress', function () { updateProgress(); updateLoaderPct(); });
  video.addEventListener('loadedmetadata', function () { fitStage(); updateProgress(); buildQualityMenu(); });
  video.addEventListener('durationchange', updateProgress);
  video.addEventListener('waiting', function () { if (video.paused) return; if (loaderEl) loaderEl.classList.add('show'); updateLoaderPct(); });
  video.addEventListener('canplay', function () { if (loaderEl) loaderEl.classList.remove('show'); });
  video.addEventListener('playing', function () {
    if (loaderEl) loaderEl.classList.remove('show');
    root.classList.add('wps-has-played');
    if (posterEl) posterEl.classList.add('hide');
    fitStage();
  });
  video.addEventListener('play', function () {
    root.classList.add('wps-playing');
    if (posterEl) posterEl.classList.add('hide');
    updatePlayBtn();
    scheduleHide();
  });
  video.addEventListener('pause', function () {
    root.classList.remove('wps-playing');
    updatePlayBtn();
    showControls();
  });
  video.addEventListener('error', function () { if (loaderEl) loaderEl.classList.remove('show'); retry(); });

  // ── keyboard ──
  document.addEventListener('keydown', function (e) {
    var t = (e.target && e.target.tagName) || '';
    if (t === 'INPUT' || t === 'TEXTAREA') return;
    switch (e.key) {
      case ' ': case 'k': case 'K': e.preventDefault(); togglePlay(); break;
      case 'ArrowLeft': e.preventDefault(); goVideo(-1); break;
      case 'ArrowRight': e.preventDefault(); goVideo(1); break;
      case 'j': case 'J': seekRelative(-10, true); break;
      case 'l': case 'L': seekRelative(10, true); break;
      case 'ArrowUp': e.preventDefault(); adjustVolume(0.1); break;
      case 'ArrowDown': e.preventDefault(); adjustVolume(-0.1); break;
      case 'm': case 'M': toggleMute(); break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 'Home': video.currentTime = 0; break;
      case 'End': video.currentTime = (video.duration || 0) - 0.5; break;
      default:
        if (e.key >= '0' && e.key <= '9' && video.duration) video.currentTime = (+e.key / 10) * video.duration;
    }
  });

  // ── button actions ──
  $$('[data-act]').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      switch (btn.getAttribute('data-act')) {
        case 'play': togglePlay(); break;
        case 'rewind': seekRelative(-10, true); break;
        case 'forward': seekRelative(10, true); break;
        case 'mute': toggleMute(); break;
        case 'pip': togglePip(); break;
        case 'fs': toggleFullscreen(); break;
        case 'speed': case 'quality':
          var menu = $('.wps-menu[data-menu="' + btn.getAttribute('data-act') + '"]');
          if (!menu) break;
          var open = menu.classList.contains('open');
          closeMenus();
          if (!open) menu.classList.add('open');
          break;
      }
    });
  });

  var volInput = $('.wps-volume input');
  if (volInput) {
    volInput.addEventListener('input', function () {
      video.volume = +volInput.value;
      video.muted = video.volume === 0;
      state.volume = video.volume;
      updateVolBtn();
    });
  }

  // progress interactions (pointer — unifies mouse + touch)
  if (progressWrap) {
    progressWrap.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      progressWrap.setPointerCapture(e.pointerId);
      startScrub(e);
    });
    progressWrap.addEventListener('pointermove', function (e) {
      if (state.dragging) scrubTo(ratioFromEvent(e));
      else handleHover(e);
    });
    progressWrap.addEventListener('pointerup', function (e) {
      if (state.scrubbing) { scrubTo(ratioFromEvent(e)); endScrub(); }
    });
    progressWrap.addEventListener('pointercancel', function () { if (state.scrubbing) endScrub(); });
    progressWrap.addEventListener('mouseleave', function () {
      if (!state.dragging && previewBubble) previewBubble.classList.remove('show');
    });
  }

  if (centerPlay) centerPlay.addEventListener('click', function (e) { e.stopPropagation(); togglePlay(); });
  root.addEventListener('pointermove', showControls);
  root.addEventListener('pointerdown', function (e) { if (e.pointerType === 'touch') handleTap(e); });
  root.addEventListener('dblclick', toggleFullscreen);
  document.addEventListener('click', function (e) {
    if (!e.target.closest || (!e.target.closest('.wps-menu') && !e.target.closest('[data-act]'))) closeMenus();
  });
  document.addEventListener('fullscreenchange', function () {
    root.classList.toggle('wps-fullscreen', !!document.fullscreenElement);
    fitStage();
  });

  // ── viewport changes (rotate/resize): re-fit the mobile stage so it grows
  //    or squashes with the screen instead of overflowing / cropping ──
  window.addEventListener('resize', function () { fitStage(); }, { passive: true });
  window.addEventListener('orientationchange', function () { setTimeout(fitStage, 250); });

  // ── init ──
  state.muted = video.muted;
  updateVolBtn();
  updatePlayBtn();
  buildSpeedMenu();
  updateProgress();

  if (typeof video.autoplay === 'undefined' || video.muted || video.paused) {
    // templates mark the <video> autoplay+muted; browsers enforce muted autoplay.
    // If it's blocked, keep it simple: show controls, try once on gesture.
  }
  // start intro (instant motion via preview clip) then real stream
  introStart();

  // kick progress updates even before media loads
  setInterval(updateLoaderPct, 500);
})();