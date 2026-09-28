/* Shared card-preview controller for galleries and related-video grids. */
(function () {
  'use strict';
  var MAX_ACTIVE = 5;
  var MAX_FETCHING = 5;
  var CACHE_LIMIT = 48 * 1024 * 1024;
  var cards = new Map();
  var active = new Map();
  var cache = new Map();
  var fetching = new Map();
  var cacheBytes = 0;
  var fetchCount = 0;
  var queue = [];
  var touch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
  var videos = {};

  (window.__CARD_PREVIEW_VIDEOS || []).forEach(function (v) { videos[v.id] = v; });

  function connectionSlow() {
    var type = navigator.connection && navigator.connection.effectiveType;
    return type === 'slow-2g' || type === '2g';
  }

  function sourceFor(v) {
    return v && (v.preview || v.video) || '';
  }

  function rangeFor(v) {
    if (!v || v.preview || !v.size || !v.dur) return null;
    var point = v.pv || Math.round((12 / v.dur) * v.size);
    return { start: 0, end: Math.min(Math.max(Math.round(point * 1.6), 1048576), 6291456, v.size - 1) };
  }

  function remember(id, url, bytes) {
    if (cache.has(id)) {
      URL.revokeObjectURL(cache.get(id).url);
      cacheBytes -= cache.get(id).bytes;
    }
    cache.set(id, { url: url, bytes: bytes || 0 });
    cacheBytes += bytes || 0;
    while (cacheBytes > CACHE_LIMIT && cache.size) {
      var oldest = cache.keys().next().value;
      var entry = cache.get(oldest);
      cache.delete(oldest);
      cacheBytes -= entry.bytes;
      URL.revokeObjectURL(entry.url);
    }
  }

  function load(v) {
    var id = v && v.id;
    if (!id) return Promise.reject(new Error('missing video'));
    if (cache.has(id)) return Promise.resolve(cache.get(id).url);
    if (fetching.has(id)) return fetching.get(id);
    var range = rangeFor(v);
    var init = range ? { headers: { Range: 'bytes=' + range.start + '-' + range.end } } : {};
    var p = fetch(sourceFor(v), init).then(function (res) {
      if (!res.ok || res.status === 416) throw new Error('preview fetch failed');
      return res.blob();
    }).then(function (blob) {
      if (!blob.size) throw new Error('empty preview');
      var url = URL.createObjectURL(blob);
      remember(id, url, blob.size);
      return url;
    });
    fetching.set(id, p);
    p.then(function () { fetching.delete(id); }, function () { fetching.delete(id); });
    return p;
  }

  function remove(card) {
    if (!card) return;
    var video = card.querySelector('.card-preview');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
    }
    card.classList.remove('previewing', 'preview-live');
    active.delete(card);
  }

  function evict() {
    while (active.size >= MAX_ACTIVE) {
      var oldest = active.keys().next().value;
      remove(oldest);
    }
  }

  function start(card) {
    if (active.has(card) || !card.isConnected || connectionSlow()) return;
    var v = videos[card.dataset.id];
    if (!v || !sourceFor(v)) return;
    evict();
    var thumb = card.querySelector('.thumb, .feat-car-thumb');
    if (!thumb) return;
    var posterImg = thumb.querySelector('img');
    var video = document.createElement('video');
    video.className = 'card-preview';
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    // No blank frame: show the existing thumbnail inside the <video> via
    // poster until the first real frame of the preview decodes.
    if (posterImg && (posterImg.currentSrc || posterImg.src)) {
      video.poster = posterImg.currentSrc || posterImg.src;
    }
    thumb.appendChild(video);
    active.set(card, Date.now());
    card.classList.add('previewing');
    load(v).then(function (url) {
      if (!active.has(card) || !video.isConnected) return;
      video.src = url;
      var revealed = false;
      var reveal = function () {
        if (revealed || !video.isConnected) return;
        revealed = true;
        video.classList.add('card-preview-live');
        card.classList.add('preview-live');
        var play = video.play();
        if (play && play.catch) play.catch(function () {});
      };
      video.addEventListener('loadeddata', function () {
        if (video.readyState >= 2) reveal();
      }, { once: true });
      video.addEventListener('canplay', reveal, { once: true });
      video.addEventListener('seeked', reveal, { once: true });
      setTimeout(function () { if (video.readyState >= 2) reveal(); }, 120);
    }).catch(function () {
      remove(card);
    });
  }

  function primeCluster(card) {
    if (!card || !card.isConnected) return;
    var upNext = [card];
    var el = card;
    while (el && upNext.length < MAX_ACTIVE) {
      el = el.nextElementSibling;
      if (el && el.matches && el.matches('.tube-card, .card-mini, .list-card, .feat-car-card, .related-section .video-card')) {
        upNext.push(el);
      }
    }
    upNext.forEach(request);
  }

  function request(card) {
    if (!card || !card.isConnected) return;
    var index = queue.indexOf(card);
    if (index >= 0) queue.splice(index, 1);
    queue.push(card);
    pump();
  }

  function pump() {
    while (fetchCount < MAX_FETCHING && queue.length) {
      var card = queue.shift();
      if (!card || !card.isConnected || active.has(card)) continue;
      fetchCount++;
      start(card);
      setTimeout(function () { fetchCount--; pump(); }, 0);
    }
  }

  function bind(card) {
    if (cards.has(card)) return;
    cards.set(card, true);
    card.addEventListener('mouseenter', function () { primeCluster(card); });
    card.addEventListener('pointerdown', function (event) {
      if (event.pointerType === 'touch' || touch) primeCluster(card);
    }, { passive: true });
  }

  function observe() {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var card = entry.target;
        if (entry.isIntersecting) primeCluster(card);
        else if (active.has(card)) remove(card);
      });
    }, { rootMargin: '0px 0px 600% 0px', threshold: 0 });

    document.querySelectorAll('.tube-card, .card-mini, .list-card, .feat-car-card, .related-section .video-card').forEach(function (card) {
      bind(card);
      observer.observe(card);
    });
  }

  window.CardPreviews = { refresh: observe, hide: remove, activeLimit: MAX_ACTIVE };
  observe();
})();
