// ==UserScript==
// @name         Kio Upload Optimizer
// @namespace    https://github.com/ProofPage/Kio-Upload-Optimizer
// @version      5.1.0
// @description  Eliminates CPU, memory, and disk I/O bottlenecks on kio.ac across uploads (zero-copy worker chunk reuse, native XHR transfers, progress & chart rAF throttling, 0ms postTask pacing) and collection downloads (shared 500ms speed ticker, BroadcastChannel & countdown rAF throttling) without triggering Ad-Shield or OOMs.
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
    version: 'v5.1.0',
    reusedBufs: 0,
    blobFallbacks: 0,
    throttledProgress: 0,
    postTaskSaved: 0,
    rafCapped: 0,
    speedTimersCoalesced: 0,
    bcThrottled: 0,
    countdownRafCapped: 0,
  };
  window.__kioUploadOptimizer = { version: diag.version, diag };

  function showModeChip() {
    if (!document.documentElement) return;
    const chip = document.createElement('div');
    chip.textContent = 'Kio: CPU & I/O Optimized';
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

  // Strictly bounded (<= 96 MiB / 6 chunks) zero-copy cache exclusively for active streaming-worker chunks.
  // Never caches arbitrary Blob.arrayBuffer() calls, eliminating OOMs on large files and LegacyUploader.
  const bufToBlob = new WeakMap();
  const cachedBlobBufs = new Map();
  const MAX_CACHEABLE_CHUNK_BYTES = 16 * 1024 * 1024 + 4096;
  const MAX_CACHED_BYTES = 96 * 1024 * 1024;
  const MAX_CACHED_CHUNKS = 6;
  let cachedTotalBytes = 0;

  function deleteCachedBuf(blob) {
    const entry = cachedBlobBufs.get(blob);
    if (!entry) return false;
    cachedBlobBufs.delete(blob);
    cachedTotalBytes = Math.max(0, cachedTotalBytes - entry.bytes);
    return true;
  }

  function clearCachedBufs() {
    cachedBlobBufs.clear();
    cachedTotalBytes = 0;
  }

  function setCachedBuf(blob, buf) {
    if (!blob || !(buf instanceof ArrayBuffer) || buf.byteLength === 0 || buf.byteLength > MAX_CACHEABLE_CHUNK_BYTES) {
      return;
    }
    deleteCachedBuf(blob);
    while (
      cachedBlobBufs.size > 0 &&
      (cachedBlobBufs.size >= MAX_CACHED_CHUNKS || cachedTotalBytes + buf.byteLength > MAX_CACHED_BYTES)
    ) {
      const oldest = cachedBlobBufs.keys().next().value;
      deleteCachedBuf(oldest);
    }
    cachedBlobBufs.set(blob, { buf, bytes: buf.byteLength });
    cachedTotalBytes += buf.byteLength;
  }

  window.addEventListener('pagehide', clearCachedBufs);

  // 1) Tag chunk ArrayBuffers with a WeakMap reference (zero memory overhead) and recycle from streaming-worker
  if (typeof Blob !== 'undefined' && typeof Blob.prototype.arrayBuffer === 'function') {
    const origArrayBuffer = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      const blob = this;
      return origArrayBuffer.call(blob).then((buf) => {
        if (buf && buf.byteLength > 0 && buf.byteLength <= MAX_CACHEABLE_CHUNK_BYTES) {
          bufToBlob.set(buf, blob);
        }
        return buf;
      });
    };
  }

  if (typeof window.Worker === 'function') {
    try {
      const OrigWorker = window.Worker;
      window.Worker = new Proxy(OrigWorker, {
        construct(target, args) {
          const rawUrl = args[0] instanceof URL ? args[0].href : String(args[0] || '');
          const opts = args[1];
          if (!rawUrl.includes('streaming-worker') || opts?.type !== 'module') {
            return new target(...args);
          }

          const shimCode = `
            const inflight = new Map();
            const origPost = self.postMessage.bind(self);
            const origAdd = self.addEventListener.bind(self);
            let workerMsgHandler = null;
            const queued = [];

            origAdd('message', (ev) => {
              const d = ev.data;
              if (d && typeof d.id === 'string' && d.chunk instanceof ArrayBuffer) {
                inflight.set(d.id, d.chunk);
              }
              if (workerMsgHandler) {
                workerMsgHandler(ev);
              } else {
                queued.push(ev);
              }
            });

            self.addEventListener = function (type, fn, options) {
              if (type === 'message' && typeof fn === 'function' && !workerMsgHandler) {
                workerMsgHandler = fn;
                while (queued.length) fn(queued.shift());
                return;
              }
              return origAdd(type, fn, options);
            };

            self.postMessage = function (msg, transfer) {
              if (msg && typeof msg.id === 'string') {
                const chunk = inflight.get(msg.id);
                inflight.delete(msg.id);
                if (chunk && msg.success && !msg.exists) {
                  const xfer = Array.isArray(transfer) ? [...transfer, chunk] : [chunk];
                  msg.__kioChunk = chunk;
                  return origPost(msg, xfer);
                }
              }
              return origPost(msg, transfer);
            };

            await import(${JSON.stringify(rawUrl)});
          `;

          let worker;
          let shimUrl = null;
          try {
            shimUrl = URL.createObjectURL(new Blob([shimCode], { type: 'text/javascript' }));
            worker = new target(shimUrl, opts);
            setTimeout(() => URL.revokeObjectURL(shimUrl), 10000);
          } catch {
            if (shimUrl) URL.revokeObjectURL(shimUrl);
            return new target(...args);
          }

          const idToBlob = new Map();
          const origPostMessage = worker.postMessage.bind(worker);
          const origAddEventListener = worker.addEventListener.bind(worker);
          const origTerminate = worker.terminate.bind(worker);

          worker.postMessage = function (msg, transfer) {
            try {
              if (msg && typeof msg.id === 'string' && msg.chunk instanceof ArrayBuffer) {
                const blob = bufToBlob.get(msg.chunk);
                if (blob) {
                  idToBlob.set(msg.id, blob);
                  bufToBlob.delete(msg.chunk);
                }
              }
            } catch {}
            return origPostMessage(msg, transfer);
          };

          worker.addEventListener = function (type, listener, options) {
            if (type === 'message' && typeof listener === 'function') {
              const wrapped = function (ev) {
                const data = ev?.data;
                if (data && typeof data.id === 'string') {
                  const blob = idToBlob.get(data.id);
                  idToBlob.delete(data.id);
                  if (data.__kioChunk instanceof ArrayBuffer) {
                    const chunkBuf = data.__kioChunk;
                    delete data.__kioChunk;
                    if (blob) setCachedBuf(blob, chunkBuf);
                  }
                }
                return listener.call(this, ev);
              };
              return origAddEventListener(type, wrapped, options);
            }
            return origAddEventListener(type, listener, options);
          };

          worker.terminate = function () {
            idToBlob.clear();
            clearCachedBufs();
            return origTerminate();
          };

          return worker;
        },
      });
    } catch {}
  }

  // 2) Disable Request.prototype.duplex so kio.ac uses native XMLHttpRequest instead of 64 KiB ReadableStream slicing.
  // NOTE: Do NOT wrap window.fetch or XMLHttpRequest.prototype.open — kio.ac's Ad-Shield loader pre-hooks and
  // inspects those two functions and breaks page scripts/Turnstile if they are pre-wrapped at document-start.
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

  // 3) Reuse worker-hashed buffers in XHR.send(Blob) and throttle upload.onprogress to 500ms
  // (without touching XMLHttpRequest.prototype.open)
  if (typeof XMLHttpRequest !== 'undefined') {
    try {
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function (body) {
        if (body instanceof Blob && body.size > 0 && body.size <= MAX_CACHEABLE_CHUNK_BYTES) {
          const entry = cachedBlobBufs.get(body);
          if (entry && entry.bytes === body.size) {
            deleteCachedBuf(body);
            diag.reusedBufs += 1;
            return origSend.call(this, new Uint8Array(entry.buf));
          }
          if (cachedBlobBufs.size > 0) {
            diag.blobFallbacks += 1;
          }
        }
        return origSend.apply(this, arguments);
      };

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
              if (now - lastRun >= 500 || (ev && ev.lengthComputable && ev.loaded >= ev.total)) {
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

  // 4) Replace 0ms scheduler.postTask busy-wait yields in the streaming uploader (50ms fg / 250ms bg)
  const sched = window.scheduler;
  if (sched && typeof sched.postTask === 'function') {
    const origPostTask = sched.postTask.bind(sched);

    sched.postTask = function (callback, options) {
      if (
        options?.priority === 'user-visible' &&
        options?.delay == null &&
        typeof callback === 'function' &&
        callback.toString().replace(/\s+/g, '') === '()=>{}'
      ) {
        diag.postTaskSaved += 1;
        const delayMs = document.hidden ? 250 : 50;
        return new Promise((resolve) => {
          setTimeout(() => resolve(callback()), delayMs);
        });
      }
      return origPostTask(callback, options);
    };
  }

  // 5) Cap chartjs-plugin-streaming rAF redraws (1fps) & 5s countdown modal rAF spin (4fps)
  const origRAF = window.requestAnimationFrame?.bind(window);
  const origCancelRAF = window.cancelAnimationFrame?.bind(window);
  if (origRAF && origCancelRAF) {
    const rafTimers = new Map();
    let nextFakeId = -1;

    window.requestAnimationFrame = function (callback) {
      if (typeof callback === 'function') {
        const src = callback.toString();
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
      if (rafTimers.has(id)) {
        clearTimeout(rafTimers.get(id));
        rafTimers.delete(id);
        return;
      }
      return origCancelRAF(id);
    };
  }

  // 6) Coalesce per-chunk 500ms Li speed-meter intervals (hundreds of chunks per large file -> 1 shared ticker)
  if (typeof window.setInterval === 'function' && typeof window.clearInterval === 'function') {
    const origSetInterval = window.setInterval.bind(window);
    const origClearInterval = window.clearInterval.bind(window);
    const speedCallbacks = new Map();
    let nextCoalescedId = -1000000;
    let sharedTickerId = null;
    let bgTickSkip = false;

    function runSpeedTicker() {
      if (document.hidden) {
        bgTickSkip = !bgTickSkip;
        if (bgTickSkip) return;
      } else {
        bgTickSkip = false;
      }
      for (const fn of [...speedCallbacks.values()]) {
        try {
          fn();
        } catch {}
      }
    }

    window.setInterval = function (fn, delay) {
      if (delay === 500 && arguments.length <= 2 && typeof fn === 'function') {
        const src = fn.toString();
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
        if (speedCallbacks.size === 0 && sharedTickerId !== null) {
          origClearInterval(sharedTickerId);
          sharedTickerId = null;
          bgTickSkip = false;
        }
        return;
      }
      return origClearInterval(id);
    };
  }

  // 7) Throttle Service Worker ZIP/stream BroadcastChannel numeric progress bursts (250ms leading + trailing)
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
            const prevTimer = channelTimers.get(this);
            if (prevTimer) {
              clearTimeout(prevTimer.tid);
              channelTimers.delete(this);
            }
            if (typeof fn !== 'function' || typeof this.name !== 'string' || !this.name.includes(':')) {
              originalHandlers.delete(this);
              return origSet.call(this, fn);
            }

            let lastRun = 0;
            const state = { tid: null, pendingEv: null, ctx: this };
            channelTimers.set(this, state);

            const flush = () => {
              if (state.tid) {
                clearTimeout(state.tid);
                state.tid = null;
              }
              const ev = state.pendingEv;
              state.pendingEv = null;
              if (ev) {
                lastRun = performance.now();
                fn.call(state.ctx, ev);
              }
            };

            const throttled = function (ev) {
              if (typeof ev?.data !== 'number') {
                flush();
                return fn.call(this, ev);
              }
              const now = performance.now();
              const elapsed = now - lastRun;
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
              flushAndClear(state, this);
              channelTimers.delete(this);
            }
            return origClose.apply(this, arguments);
          };
        }
      }
    } catch {}
  }

  function flushAndClear(state, ctx) {
    if (state.tid) {
      clearTimeout(state.tid);
      state.tid = null;
    }
    const ev = state.pendingEv;
    state.pendingEv = null;
    if (ev && typeof ctx?.onmessage === 'function') {
      try {
        ctx.onmessage(ev);
      } catch {}
    }
  }
})();


