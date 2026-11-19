// ==UserScript==
// @name         Kio Upload Optimizer
// @namespace    https://github.com/ProofPage/Kio-Upload-Optimizer
// @version      5.3.0
// @description  Eliminates CPU, timer, stream-slicing, and encrypted-buffer memory leaks on kio.ac with zero extra RAM usage (native Blob XHR uploads without 64 KiB stream slicing, 500ms progress throttling, 0ms postTask pacing, 1fps chart rAF cap, shared 500ms speed ticker with exact state-based cleanup, encrypted download buffer release, BroadcastChannel & countdown rAF throttling).
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
    version: 'v5.3.0',
    throttledProgress: 0,
    postTaskSaved: 0,
    rafCapped: 0,
    speedTimersCoalesced: 0,
    speedTimersAutoFreed: 0,
    encryptedBuffersFreed: 0,
    bcThrottled: 0,
    countdownRafCapped: 0,
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

  function showModeChip() {
    if (!document.documentElement) return;
    const chip = document.createElement('div');
    chip.textContent = 'Kio: CPU & Memory Optimized';
    chip.style.cssText =
      'position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:4px 8px;border-radius:6px;' +
      'background:rgba(17,17,17,.85);color:#fff;font:12px/1.4 system-ui,sans-serif;pointer-events:none;opacity:.75';
    document.documentElement.appendChild(chip);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showModeChip, { once: true });
  } else {
    showModeChip();
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



