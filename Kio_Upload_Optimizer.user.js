// ==UserScript==
// @name         Kio Upload Optimizer
// @namespace    https://github.com/ProofPage/Kio-Upload-Optimizer
// @version      5.6.1
// @description  Eliminates CPU, timer, stream-slicing, and encrypted-buffer memory leaks on kio.ac with zero extra RAM usage, plus desktop & mobile UI/UX alignment, spacing, and hydration-safe task-tray overlap fixes.
// @author       Page
// @match        https://kio.ac/*
// @homepageURL  https://github.com/ProofPage/Kio-Upload-Optimizer
// @supportURL   https://github.com/ProofPage/Kio-Upload-Optimizer/issues
// @updateURL    https://cdn.jsdelivr.net/gh/ProofPage/Kio-Upload-Optimizer@main/Kio_Upload_Optimizer.user.js
// @downloadURL  https://cdn.jsdelivr.net/gh/ProofPage/Kio-Upload-Optimizer@main/Kio_Upload_Optimizer.user.js
// @run-at       document-start
// @grant        none
// @noframes
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  if (window.__kioUploadOptimizerLoaded) return;
  window.__kioUploadOptimizerLoaded = true;

  const diag = {
    version: 'v5.6.1',
    throttledProgress: 0,
    postTaskSaved: 0,
    rafCapped: 0,
    speedTimersCoalesced: 0,
    speedTimersAutoFreed: 0,
    encryptedBuffersFreed: 0,
    bcThrottled: 0,
    countdownRafCapped: 0,
    uiFixesApplied: false,
  };
  window.__kioUploadOptimizer = { version: diag.version, diag };

  const fnToString = Function.prototype.toString;
  function safeFnSource(fn) {
    try {
      return fnToString.call(fn);
    } catch {
      return '';
    }
  }

  const UI_FIX_CSS = `
    /* Floating task queue widget (bottom-right, lifted cleanly above desktop /upload CTA button) */
    .fixed.right-4.bottom-4 {
      z-index: 40 !important;
      bottom: calc(var(--kio-tray-bottom, 16px) + env(safe-area-inset-bottom, 0px)) !important;
    }
    /* Fix chevron toggle button: ml-auto + rotate-180 + py-4 shoved the arrow 1px against the left border */
    .fixed.right-4.bottom-4 > [data-slot="accordion"] > [data-slot="accordion-item"] > .flex.justify-end [data-slot="accordion-trigger"] {
      display: inline-flex !important;
      flex: none !important;
      width: 36px !important;
      height: 36px !important;
      padding: 0 !important;
      align-items: center !important;
      justify-content: center !important;
      background-color: var(--background) !important;
      box-shadow: 0 4px 12px rgb(0 0 0 / 0.28) !important;
    }
    .fixed.right-4.bottom-4 > [data-slot="accordion"] > [data-slot="accordion-item"] > .flex.justify-end [data-slot="accordion-trigger"] [data-slot="accordion-trigger-icon"] {
      margin: 0 !important;
    }
    /* Align task list cleanly beneath toggle button without stray ml-2 or dead pb-4 bottom gap */
    .fixed.right-4.bottom-4 > [data-slot="accordion"] > [data-slot="accordion-item"] > [data-slot="accordion-content"] > div {
      margin-left: 0 !important;
      padding-top: 8px !important;
      padding-bottom: 0 !important;
    }
    .fixed.right-4.bottom-4 [data-slot="accordion-content"] .w-80 {
      width: clamp(368px, 26vw, 440px) !important;
      max-width: calc(100vw - 32px) !important;
      max-height: min(35vh, 260px) !important;
      scrollbar-width: thin;
    }
    /* Nested sub-task accordion inside a Collection card */
    .fixed.right-4.bottom-4 [data-slot="accordion-content"] [data-slot="accordion-content"] > div {
      margin-left: 8px !important;
      padding-top: 6px !important;
      padding-bottom: 0 !important;
    }
    /* Make floating task cards opaque & cleanly spaced so underlying buttons never bleed through */
    .fixed.right-4.bottom-4 [data-slot="accordion-content"] [data-slot="accordion-trigger"] {
      background-color: var(--background) !important;
      box-shadow: 0 6px 20px rgb(0 0 0 / 0.32) !important;
      padding: 0 !important;
      gap: 0 !important;
    }
    .fixed.right-4.bottom-4 [data-slot="accordion-content"] [data-slot="accordion-trigger"] > div:first-child {
      padding: 10px 8px 8px 12px !important;
      gap: 10px !important;
      align-items: center !important;
    }
    .fixed.right-4.bottom-4 [data-slot="accordion-content"] [data-slot="accordion-trigger"] > div:first-child .flex.flex-col {
      gap: 2px !important;
      line-height: 1.3 !important;
    }
    .fixed.right-4.bottom-4 [data-slot="accordion-content"] [data-slot="accordion-trigger"] > div:first-child .text-xs {
      font-variant-numeric: tabular-nums !important;
      opacity: 0.78 !important;
    }
    .fixed.right-4.bottom-4 [data-slot="accordion-content"] [data-slot="accordion-trigger"] > div:first-child > div:last-child {
      gap: 2px !important;
      align-items: center !important;
    }
    .fixed.right-4.bottom-4 [data-slot="accordion-content"] [data-slot="accordion-trigger"] > div:first-child > div:last-child [data-slot="button"] {
      width: 32px !important;
      height: 32px !important;
    }
    /* Hide Kiosk's empty invisible pause button rendered on completed tasks */
    .fixed.right-4.bottom-4 [data-slot="accordion-content"] [data-slot="accordion-trigger"] > div:first-child > div:last-child [data-slot="button"]:empty {
      display: none !important;
    }
    .fixed.right-4.bottom-4 [data-slot="accordion-content"] [data-slot="progress"] {
      border-radius: 0 !important;
      height: 3px !important;
    }

    /* /upload desktop staging layout (scoped via :has(> div > .min-w-80) so no other route is affected) */
    .wrapper > div.flex.flex-row.p-12:has(> div > .min-w-80) {
      padding: 20px 16px !important;
      gap: 16px !important;
    }
    .wrapper > div.flex.flex-row.p-12:has(> div > .min-w-80) > div:last-child {
      width: clamp(368px, 26vw, 440px) !important;
      min-width: 368px !important;
      height: 100% !important;
      min-height: 0 !important;
      flex-shrink: 0 !important;
      overflow: hidden !important;
      gap: 12px !important;
    }
    .wrapper > div.flex.flex-row.p-12:has(> div > .min-w-80) > div:last-child > .min-w-80 {
      min-width: 0 !important;
      width: 100% !important;
      flex: 1 1 auto !important;
      min-height: 0 !important;
      overflow-y: auto !important;
      scrollbar-width: thin;
      padding-right: 2px;
      margin-bottom: calc(var(--kio-tray-h, 0px) + var(--kio-tray-gap, 0px)) !important;
    }
    .wrapper > div.flex.flex-row.p-12:has(> div > .min-w-80) > div:last-child > div:last-child {
      flex-shrink: 0 !important;
    }
    .wrapper > div.flex.flex-row.p-12:has(> div > .min-w-80) > div:last-child > div:last-child [data-slot="turnstile"],
    .wrapper > div.flex.flex-row.p-12:has(> div > .min-w-80) > div:last-child > div:last-child button[data-slot="button"] {
      width: 100% !important;
    }

    /* /upload mobile staging layout (<= 768px flex-col, strictly scoped to staging screen) */
    .wrapper > div.flex.flex-col:has(> div > .min-w-80) > div:first-child.min-h-144 {
      min-height: 220px !important;
      max-height: 46dvh !important;
      height: auto !important;
      flex-shrink: 0 !important;
    }
    .wrapper > div.flex.flex-col:has(> div > .min-w-80) > div:first-child > div.p-4 {
      padding: 12px 16px !important;
      gap: 12px !important;
      align-items: stretch !important;
    }
    .wrapper > div.flex.flex-col:has(> div > .min-w-80) > div:last-child {
      padding: 12px 16px calc(16px + env(safe-area-inset-bottom, 0px) + var(--kio-task-tray-h, 0px)) 16px !important;
      gap: 20px !important;
    }
    .wrapper > div.flex.flex-col:has(> div > .min-w-80) .min-w-80 {
      min-width: 0 !important;
      width: 100% !important;
    }
    .wrapper > div.flex.flex-col:has(> div > .min-w-80) > div:last-child > div:last-child button[data-slot="button"] {
      width: 100% !important;
      height: 44px !important;
      font-size: 15px !important;
    }

    /* File explorer table header/cell exact horizontal alignment (0px offset, scoped to FileExplorer tables) */
    table:has(th[data-slot="table-head"]:nth-child(2) button[data-slot="button"]) th[data-slot="table-head"]:first-child,
    table:has(th[data-slot="table-head"]:nth-child(2) button[data-slot="button"]) td[data-slot="table-cell"]:first-child {
      width: 40px !important;
      padding-left: 12px !important;
      padding-right: 4px !important;
    }
    table:has(th[data-slot="table-head"]:nth-child(2) button[data-slot="button"]) td[data-slot="table-cell"]:first-child svg {
      display: block !important;
      margin: 0 auto !important;
    }
    table th[data-slot="table-head"]:nth-child(2) button[data-slot="button"] {
      margin-left: -8px !important;
    }
    table th[data-slot="table-head"]:nth-child(3) button[data-slot="button"].mr-8 {
      margin-right: 24px !important;
    }
    table:has(th[data-slot="table-head"]:nth-child(2) button[data-slot="button"]) td[data-slot="table-cell"]:nth-child(3) {
      font-variant-numeric: tabular-nums !important;
    }

    /* Desktop file explorer footer stats bar (scoped so mobile flex-col keeps full-width bars) */
    .wrapper > div.flex.flex-row.p-12:has(> div > .min-w-80) > div:first-child > div.p-4 {
      padding: 14px 16px !important;
      gap: 20px !important;
      align-items: center !important;
    }
    .wrapper > div:has(> div > .min-w-80) > div:first-child > div.p-4 .flex-1.flex-col {
      gap: 8px !important;
    }
    .wrapper > div:has(> div > .min-w-80) > div:first-child > div.p-4 label {
      font-variant-numeric: tabular-nums !important;
    }

    /* Options panel: fix accordion py-4 clash, section spacing, date & password inputs */
    .wrapper .min-w-80 [data-slot="accordion-trigger"] {
      padding-top: 0 !important;
      padding-bottom: 0 !important;
      align-items: center !important;
    }
    .wrapper .min-w-80 > label + .flex.flex-col {
      padding-top: 8px !important;
      gap: 10px !important;
    }
    .wrapper .min-w-80 [data-slot="accordion-content"] > div {
      padding-bottom: 4px !important;
    }
    .wrapper .min-w-80 input[type="datetime-local"] {
      padding-top: 0 !important;
      padding-bottom: 0 !important;
      align-items: center !important;
      font-variant-numeric: tabular-nums !important;
    }
    .wrapper .relative > input[data-slot="input"]:has(+ button) {
      padding-right: 42px !important;
    }

    @media (max-width: 768px) {
      /* Prevent iOS Safari auto-zoom on <16px inputs */
      .wrapper .min-w-80 input[type="datetime-local"] {
        font-size: 16px !important;
        height: 40px !important;
      }
      /* Larger touch targets for floating task controls on mobile */
      .fixed.right-4.bottom-4 [data-slot="accordion-content"] [data-slot="accordion-trigger"] > div:first-child > div:last-child [data-slot="button"] {
        width: 36px !important;
        height: 36px !important;
      }
    }
  `;

  const DESKTOP_CTA_SELECTOR = '.wrapper > div.flex.flex-row.p-12:has(> div > .min-w-80) > div:last-child > div:last-child';

  let layoutResizeObs = null;
  let trayMountObs = null;
  let observedTray = null;
  let observedCta = null;
  let observedWrapper = null;
  let observedRouteHost = null;
  let trayObserverBound = false;

  function watchLayoutLifecycle() {
    if (typeof MutationObserver !== 'function' || !document.body) return;
    if (!trayMountObs) {
      trayMountObs = new MutationObserver(() => {
        syncTaskTrayOffset();
      });
    }
    trayMountObs.disconnect();
    if (observedTray && observedTray.isConnected && observedTray.parentElement) {
      // Zero-overhead mode: watch only shallow direct children of tray's parent, body,
      // route host, and /upload wrapper so DOM updates inside file lists/progress bars never fire.
      trayMountObs.observe(observedTray.parentElement, { childList: true });
      if (observedTray.parentElement !== document.body) {
        trayMountObs.observe(document.body, { childList: true });
      }
      if (observedRouteHost && observedRouteHost.isConnected) {
        trayMountObs.observe(observedRouteHost, { childList: true });
      }
      if (observedWrapper && observedWrapper.isConnected) {
        trayMountObs.observe(observedWrapper, { childList: true });
      }
    } else {
      // Discovery/hydration mode: locate the live tray node, then immediately narrow scope.
      trayMountObs.observe(document.body, { childList: true, subtree: true });
    }
  }

  function syncTaskTrayOffset() {
    if (observedTray && !observedTray.isConnected) observedTray = null;
    if (observedCta && !observedCta.isConnected) observedCta = null;
    if (observedWrapper && !observedWrapper.isConnected) observedWrapper = null;
    if (observedRouteHost && !observedRouteHost.isConnected) observedRouteHost = null;

    const tray = observedTray || document.querySelector('.fixed.right-4.bottom-4');
    const cta = document.querySelector(DESKTOP_CTA_SELECTOR);
    const wrapper = document.querySelector('.wrapper');
    const routeHost = (wrapper && wrapper.parentElement) || document.querySelector('main main > div');

    let needRewatch = false;
    if (wrapper !== observedWrapper) {
      observedWrapper = wrapper;
      needRewatch = true;
    }
    if (routeHost !== observedRouteHost) {
      observedRouteHost = routeHost;
      needRewatch = true;
    }

    if ((tray !== observedTray || cta !== observedCta) && typeof ResizeObserver === 'function') {
      if (layoutResizeObs) layoutResizeObs.disconnect();
      observedTray = tray;
      observedCta = cta;
      if (tray || cta) {
        layoutResizeObs = new ResizeObserver(syncTaskTrayOffset);
        if (tray) layoutResizeObs.observe(tray);
        if (cta) layoutResizeObs.observe(cta);
      }
      needRewatch = true;
    } else if (!tray) {
      needRewatch = true;
    }

    if (needRewatch) watchLayoutLifecycle();

    const rootStyle = document.documentElement.style;

    // On desktop /upload staging, keep the CTA ("업로드 & 링크 생성" + optional Turnstile) anchored at the bottom
    // and lift the floating task tray cleanly 12px above the topmost visible CTA element.
    let trayBottom = 16;
    if (cta) {
      let topMost = Infinity;
      for (const child of cta.children) {
        const cr = child.getBoundingClientRect();
        if (cr.height > 0 && cr.width > 0 && cr.top < topMost) topMost = cr.top;
      }
      if (!Number.isFinite(topMost)) {
        const ctaRect = cta.getBoundingClientRect();
        if (ctaRect.height > 0 && ctaRect.width > 0) topMost = ctaRect.top;
      }
      if (Number.isFinite(topMost)) {
        trayBottom = Math.max(16, Math.ceil(window.innerHeight - topMost + 12));
      }
    }
    rootStyle.setProperty('--kio-tray-bottom', `${trayBottom}px`);

    if (!tray) {
      rootStyle.setProperty('--kio-tray-h', '0px');
      rootStyle.setProperty('--kio-tray-gap', '0px');
      rootStyle.setProperty('--kio-task-tray-h', '0px');
      return;
    }
    const r = tray.getBoundingClientRect();
    if (r.height > 0 && r.width > 0) {
      const maxH = Math.floor(window.innerHeight * 0.65);
      const boxH = Math.min(maxH, Math.ceil(r.height));
      const mobileClearance = Math.min(maxH, Math.max(0, Math.ceil(window.innerHeight - r.top)));
      rootStyle.setProperty('--kio-tray-h', `${boxH}px`);
      rootStyle.setProperty('--kio-tray-gap', '12px');
      rootStyle.setProperty('--kio-task-tray-h', `${mobileClearance}px`);
    } else {
      rootStyle.setProperty('--kio-tray-h', '0px');
      rootStyle.setProperty('--kio-tray-gap', '0px');
      rootStyle.setProperty('--kio-task-tray-h', '0px');
    }
  }

  function bindTaskTrayObserver() {
    if (trayObserverBound) return;
    trayObserverBound = true;
    window.addEventListener('resize', syncTaskTrayOffset, { passive: true });
    window.addEventListener('load', syncTaskTrayOffset, { once: true });
    if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
      window.visualViewport.addEventListener('resize', syncTaskTrayOffset, { passive: true });
    }
    syncTaskTrayOffset();
  }

  function injectUiFixes() {
    if (!document.documentElement) return;
    if (!document.getElementById('kio-ui-ux-fixes')) {
      const style = document.createElement('style');
      style.id = 'kio-ui-ux-fixes';
      style.textContent = UI_FIX_CSS;
      (document.head || document.documentElement).appendChild(style);
      diag.uiFixesApplied = true;
    }
    bindTaskTrayObserver();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectUiFixes, { once: true });
  } else {
    injectUiFixes();
  }

  // 1) Disable Request.prototype.duplex so kio.ac uses native file-backed XMLHttpRequest.send(Blob)
  // instead of slicing every 16 MiB chunk into 256 x 64 KiB ReadableStream arrayBuffer() allocations in JS.
  // Keeping XHR.send(Blob) file-backed (zero ArrayBuffer caching in V8 heap) prevents renderer Out-of-Memory crashes.
  if (typeof Request !== 'undefined') {
    try {
      const desc = Object.getOwnPropertyDescriptor(Request.prototype, 'duplex');
      if (!desc || desc.configurable) {
        Object.defineProperty(Request.prototype, 'duplex', {
          get() {
            return undefined;
          },
          configurable: true,
        });
      }
    } catch {}
  }

  // 2) Throttle XMLHttpRequestUpload.onprogress to 500ms (without touching XMLHttpRequest.prototype.open/send)
  if (typeof XMLHttpRequest !== 'undefined') {
    try {
      const targetProto =
        typeof XMLHttpRequestEventTarget !== 'undefined'
          ? XMLHttpRequestEventTarget.prototype
          : XMLHttpRequestUpload.prototype;
      const progDesc = Object.getOwnPropertyDescriptor(targetProto, 'onprogress');
      if (progDesc && progDesc.configurable && typeof progDesc.set === 'function') {
        const origSet = progDesc.set;
        const origGet = progDesc.get;
        const originalHandlers = new WeakMap();

        Object.defineProperty(targetProto, 'onprogress', {
          configurable: true,
          enumerable: progDesc.enumerable,
          get() {
            return originalHandlers.has(this)
              ? originalHandlers.get(this)
              : origGet
                ? origGet.call(this)
                : null;
          },
          set(fn) {
            const isUploadTarget =
              typeof XMLHttpRequestUpload !== 'undefined' && this instanceof XMLHttpRequestUpload;
            if (typeof fn !== 'function' || !isUploadTarget) {
              originalHandlers.delete(this);
              return origSet.call(this, fn);
            }
            let lastRun = 0;
            const throttled = function (ev) {
              const now = performance.now();
              if (
                lastRun === 0 ||
                now - lastRun >= 500 ||
                (ev && ev.lengthComputable && ev.loaded >= ev.total)
              ) {
                lastRun = now;
                return fn.call(this, ev);
              }
              diag.throttledProgress += 1;
            };
            originalHandlers.set(this, fn);
            return origSet.call(this, throttled);
          },
        });
      }
    } catch {}
  }

  // 3) Replace 0ms scheduler.postTask busy-wait yields in the streaming uploader (50ms fg / 150ms bg)
  const sched = window.scheduler;
  if (sched && typeof sched.postTask === 'function') {
    const origPostTask = sched.postTask.bind(sched);

    sched.postTask = function (callback, options) {
      if (
        options?.priority === 'user-visible' &&
        options?.delay == null &&
        !options?.signal &&
        typeof callback === 'function' &&
        safeFnSource(callback).replace(/\s+/g, '') === '()=>{}'
      ) {
        diag.postTaskSaved += 1;
        const delayMs = document.hidden ? 150 : 50;
        return new Promise((resolve) => {
          setTimeout(() => resolve(callback()), delayMs);
        });
      }
      return origPostTask(callback, options);
    };
  }

  // 4) Cap chartjs-plugin-streaming rAF redraws (1fps) & 5s countdown modal rAF spin (4fps)
  const origRAF = window.requestAnimationFrame?.bind(window);
  const origCancelRAF = window.cancelAnimationFrame?.bind(window);
  if (origRAF && origCancelRAF) {
    const rafTimers = new Map();
    let nextFakeId = -1;

    window.requestAnimationFrame = function (callback) {
      if (typeof callback === 'function') {
        const src = safeFnSource(callback);
        if (src.includes('nextRefresh') && src.includes('frameRequestID')) {
          if (document.hidden) {
            return origRAF(callback);
          }
          diag.rafCapped += 1;
          const id = nextFakeId--;
          const tid = setTimeout(() => {
            rafTimers.delete(id);
            callback(performance.now());
          }, 1000);
          rafTimers.set(id, tid);
          return id;
        }
        if (
          src.includes('Math.floor') &&
          src.includes('Math.max') &&
          src.includes('Date.now') &&
          src.includes('requestAnimationFrame')
        ) {
          diag.countdownRafCapped += 1;
          const id = nextFakeId--;
          const tid = setTimeout(() => {
            rafTimers.delete(id);
            callback(performance.now());
          }, 250);
          rafTimers.set(id, tid);
          return id;
        }
      }
      return origRAF(callback);
    };

    window.cancelAnimationFrame = function (id) {
      if (typeof id === 'number' && id < 0) {
        if (rafTimers.has(id)) {
          clearTimeout(rafTimers.get(id));
          rafTimers.delete(id);
        }
        return;
      }
      return origCancelRAF(id);
    };
  }

  // 5) Coalesce per-chunk 500ms Li speed-meter intervals AND fix Kiosk's state-completion leaks:
  // - Kiosk clears `Li.interval` only inside lazy getter `ended`, which is often never read on `zH` chunks.
  // - Kiosk's `zH._startEncrypted()` never releases its 16 MiB `this._buffer` Uint8Array after writing to disk.
  // Clearing both strictly on terminal `state` events (4=done, 5=aborted) preserves active, queued, paused (3),
  // and retrying (6) tasks with zero heuristics and zero global Math.max patching.
  if (typeof window.setInterval === 'function' && typeof window.clearInterval === 'function') {
    const origSetInterval = window.setInterval.bind(window);
    const origClearInterval = window.clearInterval.bind(window);
    const speedCallbacks = new Map();
    let nextCoalescedId = -1000000;
    let sharedTickerId = null;
    let bgTickSkip = false;

    function stopSharedTickerIfEmpty() {
      if (speedCallbacks.size === 0 && sharedTickerId !== null) {
        origClearInterval(sharedTickerId);
        sharedTickerId = null;
        bgTickSkip = false;
      }
    }

    function runSpeedTicker() {
      if (document.hidden) {
        bgTickSkip = !bgTickSkip;
        if (bgTickSkip) return;
      } else {
        bgTickSkip = false;
      }
      for (const [id, fn] of [...speedCallbacks.entries()]) {
        try {
          fn();
        } catch {
          speedCallbacks.delete(id);
        }
      }
      stopSharedTickerIfEmpty();
    }

    window.setInterval = function (fn, delay) {
      if (delay === 500 && arguments.length <= 2 && typeof fn === 'function') {
        const src = safeFnSource(fn);
        if (src.includes('this.speed') && src.includes('this.loaded') && src.includes('Math.max')) {
          const id = nextCoalescedId--;
          speedCallbacks.set(id, fn);
          diag.speedTimersCoalesced += 1;
          if (sharedTickerId === null) {
            sharedTickerId = origSetInterval(runSpeedTicker, 500);
          }
          return id;
        }
      }
      return origSetInterval.apply(window, arguments);
    };

    window.clearInterval = function (id) {
      if (speedCallbacks.has(id)) {
        speedCallbacks.delete(id);
        stopSharedTickerIfEmpty();
        return;
      }
      return origClearInterval(id);
    };

    if (typeof EventTarget !== 'undefined' && typeof EventTarget.prototype.dispatchEvent === 'function') {
      const origDispatchEvent = EventTarget.prototype.dispatchEvent;
      EventTarget.prototype.dispatchEvent = function (ev) {
        const result = origDispatchEvent.call(this, ev);
        if (ev && ev.type === 'state' && (ev.detail === 4 || ev.detail === 5)) {
          if (this && typeof this.interval === 'number' && speedCallbacks.has(this.interval)) {
            speedCallbacks.delete(this.interval);
            stopSharedTickerIfEmpty();
            diag.speedTimersAutoFreed += 1;
          }
          if (this && this.type === 'download:handle:chunk' && this._buffer instanceof Uint8Array) {
            this._buffer = undefined;
            diag.encryptedBuffersFreed += 1;
          }
        }
        return result;
      };
    }
  }

  // 6) Throttle Service Worker ZIP/stream BroadcastChannel numeric progress bursts (250ms leading + trailing)
  if (typeof window.BroadcastChannel === 'function') {
    try {
      const bcProto = window.BroadcastChannel.prototype;
      const msgDesc = Object.getOwnPropertyDescriptor(bcProto, 'onmessage');
      const origClose = bcProto.close;

      if (msgDesc && msgDesc.configurable && typeof msgDesc.set === 'function') {
        const origSet = msgDesc.set;
        const origGet = msgDesc.get;
        const originalHandlers = new WeakMap();
        const channelTimers = new WeakMap();

        Object.defineProperty(bcProto, 'onmessage', {
          configurable: true,
          enumerable: msgDesc.enumerable,
          get() {
            return originalHandlers.has(this)
              ? originalHandlers.get(this)
              : origGet
                ? origGet.call(this)
                : null;
          },
          set(fn) {
            const prevState = channelTimers.get(this);
            if (prevState) {
              if (prevState.tid) clearTimeout(prevState.tid);
              prevState.tid = null;
              prevState.pendingEv = null;
              channelTimers.delete(this);
            }
            if (typeof fn !== 'function' || typeof this.name !== 'string' || !this.name.includes(':')) {
              originalHandlers.delete(this);
              return origSet.call(this, fn);
            }

            let lastRun = 0;
            const state = { tid: null, pendingEv: null, ctx: this, closed: false };
            channelTimers.set(this, state);

            const flush = () => {
              if (state.tid) {
                clearTimeout(state.tid);
                state.tid = null;
              }
              const ev = state.pendingEv;
              state.pendingEv = null;
              if (ev && !state.closed) {
                lastRun = performance.now();
                fn.call(state.ctx, ev);
              }
            };

            const throttled = function (ev) {
              if (state.closed) return;
              if (typeof ev?.data !== 'number') {
                flush();
                return fn.call(this, ev);
              }
              const now = performance.now();
              const elapsed = lastRun === 0 ? 250 : now - lastRun;
              if (elapsed >= 250) {
                if (state.tid) {
                  clearTimeout(state.tid);
                  state.tid = null;
                }
                state.pendingEv = null;
                lastRun = now;
                return fn.call(this, ev);
              }
              diag.bcThrottled += 1;
              state.pendingEv = ev;
              if (!state.tid) {
                state.tid = setTimeout(flush, 250 - elapsed);
              }
            };

            originalHandlers.set(this, fn);
            return origSet.call(this, throttled);
          },
        });

        if (typeof origClose === 'function') {
          bcProto.close = function () {
            const state = channelTimers.get(this);
            if (state) {
              channelTimers.delete(this);
              state.closed = true;
              if (state.tid) {
                clearTimeout(state.tid);
                state.tid = null;
              }
              state.pendingEv = null;
            }
            return origClose.apply(this, arguments);
          };
        }
      }
    } catch {}
  }
})();



