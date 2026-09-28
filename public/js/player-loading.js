/* Navigation "Loading…" veil for Super X Latina (ported from xMelayu).
   Catching clicks on the prev/next player nav shows a full-page spinner
   before the next page swaps in. The in-player buffering overlay was dropped
   — the WPS player already renders its own loader. */
(function () {
  if (window.__sxlNavVeil) return;
  window.__sxlNavVeil = true;

  var veil = document.createElement('div');
  veil.className = 'page-loading';
  veil.innerHTML = '<div class="pl-spinner"></div><div class="pl-text">Loading\u2026</div>';
  document.body.appendChild(veil);

  var navigating = false;
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a.nav-btn') : null;
    if (!a || navigating) return;
    var href = a.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    navigating = true;
    veil.classList.add('show');
    setTimeout(function () { window.location.href = href; }, 120);
  }, true);
})();