// ==UserScript==
// @name         Kio Upload Optimizer
// @namespace    https://github.com/ProofPage/Kio-Upload-Optimizer
// @version      3.1.0
// @description  Eliminates upload CPU spikes on kio.ac by avoiding duplicate file reads, smoothly pacing upload Mbps via kioUploadSpeed(mbps), throttling progress UI updates, removing 0ms busy-wait loops, and capping chart redraws.
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

  // A previously installed copy of this userscript would double-wrap the hooks and break the cap
  if (window.__kioUploadOptimizerLoaded) return;
  window.__kioUploadOptimizerLoaded = true;

  const SLICE_BYTES = 16 * 1024 * 1024;
  const STREAM_BATCH_BYTES = 256 * 1024;
  const DEFAULT_MBPS = 110; // default upload cap in Mbps (0 = no cap)
  const STORAGE_MBPS_KEY = 'kio_upload_mbps';
  const STORAGE_BG_KEY = 'kio_bg_unrestricted';
  const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const limit = { mbps: DEFAULT_MBPS, nextSendAt: 0 };
  const hiddenMode = { enabled: false }; // stay capped even when occluded or in another tab unless kioBackground(true)

  function normalizeMbps(mbps) {
    const value = Number(mbps);
    return Number.isFinite(value) && value > 0 ? Math.min(value, 2000) : 0;
  }

  try {
    const savedMbps = localStorage.getItem(STORAGE_MBPS_KEY);
    if (savedMbps !== null) limit.mbps = normalizeMbps(savedMbps);
    const savedBg = localStorage.getItem(STORAGE_BG_KEY);
    if (savedBg !== null) hiddenMode.enabled = savedBg === 'true';
  } catch {}

  function isPacingActive() {
    return limit.mbps > 0 && !(hiddenMode.enabled && document.hidden);
  }

  // Probe, so an unlimited run can be told apart from a script that never loaded or never wrapped upload APIs
  const diag = {
    version: 'v3.1.0',
    chunks: 0,
    paced: 0,
    unlimited: 0,
    hiddenUnlimited: 0,
    aborted: 0,
    streamedBytes: 0,
    ramSliceHits: 0,
    xhrFallbacks: 0,
    queuedPeak: 0,
  };

  let chipEl = null;
  function updateChip() {
    if (!chipEl) return;
    const bgLabel = hiddenMode.enabled ? ' \u00B7 bg unlimited' : '';
    const statLabel = diag.paced > 0 ? ` (${diag.paced})` : '';
    chipEl.textContent = `Kio: ${limit.mbps ? `${limit.mbps} Mbps` : 'unlimited'}${bgLabel}${statLabel}`;
  }

  function showModeChip() {
    if (chipEl) return;
    chipEl = document.createElement('div');
    chipEl.style.cssText =
      'position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:4px 8px;border-radius:6px;' +
      'background:rgba(17,17,17,.85);color:#fff;font:12px/1.4 system-ui,sans-serif;pointer-events:none;opacity:.8';
    updateChip();
    document.documentElement.appendChild(chipEl);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showModeChip, { once: true });
  } else {
    showModeChip();
  }

  // One shared queue paced by nextSendAt, used by both stream batches (256 KiB) and XHR fallback chunks
  const sliceQueue = [];
  let queueTimer = 0;

  // Network speeds use decimal Mbps (1 Mbps = 1,000,000 bits/s = 125 bytes/ms)
  const bytesPerMs = () => (limit.mbps * 1000 * 1000) / 8 / 1000;

  let scheduleHiddenWait = null;

  function drainSliceQueue() {
    if (queueTimer) {
      clearTimeout(queueTimer);
      queueTimer = 0;
    }
    while (sliceQueue.length) {
      const item = sliceQueue[0];
      if (item.aborted()) {
        sliceQueue.shift();
        diag.aborted += 1;
        item.onAbort?.();
        continue;
      }
      const now = performance.now();
      const pacingOn = isPacingActive();
      if (pacingOn && now < limit.nextSendAt) {
        const waitMs = Math.max(1, Math.ceil(limit.nextSendAt - now));
        if (document.hidden && scheduleHiddenWait) {
          scheduleHiddenWait(waitMs);
        } else {
          queueTimer = setTimeout(drainSliceQueue, waitMs);
        }
        return;
      }
      sliceQueue.shift();
      if (pacingOn) {
        diag.paced += 1;
        limit.nextSendAt = Math.max(now, limit.nextSendAt) + item.bytes / bytesPerMs();
      } else {
        diag.unlimited += 1;
        if (hiddenMode.enabled && document.hidden) diag.hiddenUnlimited += 1;
        limit.nextSendAt = 0;
      }
      if (diag.paced <= 3 || diag.paced % 20 === 0) updateChip();
      item.send();
    }
  }

  // Console helper: `kioUploadSpeed(110)` caps upload at 110 Mbps, `kioUploadSpeed(0)` removes the cap
  win.kioUploadSpeed = function (mbps) {
    if (mbps === undefined) return limit.mbps;
    limit.mbps = normalizeMbps(mbps);
    limit.nextSendAt = 0;
    try {
      localStorage.setItem(STORAGE_MBPS_KEY, String(limit.mbps));
    } catch {}
    updateChip();
    drainSliceQueue();
    return limit.mbps;
  };

  // Console helper: `kioBackground(true)` lifts the cap while the tab is hidden; default is false (always capped)
  win.kioBackground = function (enabled) {
    if (enabled === undefined) return hiddenMode.enabled;
    hiddenMode.enabled = Boolean(enabled);
    limit.nextSendAt = 0;
    try {
      localStorage.setItem(STORAGE_BG_KEY, String(hiddenMode.enabled));
    } catch {}
    updateChip();
    drainSliceQueue();
    return hiddenMode.enabled;
  };

  function paceSlice(send, bytes, aborted) {
    diag.chunks += 1;
    sliceQueue.push({ send, bytes, aborted });
    diag.queuedPeak = Math.max(diag.queuedPeak, sliceQueue.length);
    drainSliceQueue();
  }

  // Reserve a byte-budget turn for a stream batch; resolves even on abort so pull() can exit cleanly
  function waitStreamTurn(bytes, isAborted) {
    return new Promise((resolve) => {
      sliceQueue.push({
        bytes,
        aborted: isAborted,
        send: resolve,
        onAbort: resolve,
      });
      diag.queuedPeak = Math.max(diag.queuedPeak, sliceQueue.length);
      drainSliceQueue();
    });
  }

  window.__kioUploadOptimizer = {
    version: diag.version,
    limit,
    hiddenMode,
    diag,
    isPacingActive,
    queueLength: () => sliceQueue.length,
  };

  // Shared cache to avoid reading each 16 MiB chunk twice (once for SHA-256, once for upload)
  const bufToBlob = new WeakMap();
  const sliceMeta = new WeakMap();
  const cachedBlobBufs = new Map();
  const MAX_CACHED_CHUNKS = 10; // <= 160 MiB cap

  function setCachedBuf(blob, buf) {
    if (cachedBlobBufs.has(blob)) cachedBlobBufs.delete(blob);
    cachedBlobBufs.set(blob, buf);
    while (cachedBlobBufs.size > MAX_CACHED_CHUNKS) {
      const oldest = cachedBlobBufs.keys().next().value;
      cachedBlobBufs.delete(oldest);
    }
  }

  // 1) Track large chunk Blob -> ArrayBuffer reads, recycle hashed buffers, and serve 64 KiB stream slices from RAM
  if (typeof Blob !== 'undefined' && typeof Blob.prototype.slice === 'function') {
    const origSlice = Blob.prototype.slice;
    Blob.prototype.slice = function (start, end) {
      const sliced = origSlice.apply(this, arguments);
      try {
        if (cachedBlobBufs.has(this)) {
          const size = this.size;
          const relStart = start == null ? 0 : Number(start);
          const s = relStart < 0 ? Math.max(size + relStart, 0) : Math.min(relStart, size);
          const relEnd = end == null ? size : Number(end);
          const e = relEnd < 0 ? Math.max(size + relEnd, 0) : Math.min(relEnd, size);
          if (e >= s) sliceMeta.set(sliced, { parent: this, start: s, end: e });
        }
      } catch {}
      return sliced;
    };
  }

  if (typeof Blob !== 'undefined' && typeof Blob.prototype.arrayBuffer === 'function') {
    const origArrayBuffer = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      const blob = this;
      const meta = sliceMeta.get(blob);
      if (meta) {
        const cached = cachedBlobBufs.get(meta.parent);
        if (cached && meta.end <= cached.byteLength) {
          diag.ramSliceHits += 1;
          return Promise.resolve(cached.slice(meta.start, meta.end));
        }
      }
      return origArrayBuffer.call(blob).then((buf) => {
        if (buf && buf.byteLength >= 1024 * 1024) {
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
            cachedBlobBufs.clear();
            return origTerminate();
          };

          return worker;
        },
      });
    } catch {}
  }

  // 2) Smoothly pace duplex ReadableStream uploads when cap is active; switch to native XHR in unlimited mode
  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (
        init?.duplex === 'half' &&
        url.includes('/edge/v4/upload') &&
        init.body &&
        typeof init.body.getReader === 'function'
      ) {
        if (!isPacingActive()) {
          // Rejecting duplex falls back cleanly into kio.ac's Fh (native XMLHttpRequest) for lowest background CPU
          diag.xhrFallbacks += 1;
          try {
            Promise.resolve(init.body.cancel?.()).catch(() => {});
          } catch {}
          return Promise.reject(new TypeError('duplex disabled in unlimited mode'));
        }

        const sourceStream = init.body;
        const reader = sourceStream.getReader();
        const signal = init.signal;
        let cancelled = false;
        let carry = null;

        const pacedStream = new ReadableStream({
          async pull(controller) {
            if (cancelled || signal?.aborted) {
              try {
                await reader.cancel();
              } catch {}
              controller.close();
              return;
            }

            if (isPacingActive()) {
              await waitStreamTurn(STREAM_BATCH_BYTES, () => cancelled || Boolean(signal?.aborted));
            }
            if (cancelled || signal?.aborted) {
              try {
                await reader.cancel();
              } catch {}
              controller.close();
              return;
            }

            let emitted = 0;
            if (carry) {
              controller.enqueue(carry);
              emitted += carry.byteLength;
              diag.streamedBytes += carry.byteLength;
              carry = null;
            }

            while (emitted < STREAM_BATCH_BYTES) {
              const { done, value } = await reader.read();
              if (done) {
                controller.close();
                return;
              }
              if (value && value.byteLength) {
                if (emitted + value.byteLength > STREAM_BATCH_BYTES && emitted > 0) {
                  carry = value;
                  return;
                }
                controller.enqueue(value);
                emitted += value.byteLength;
                diag.streamedBytes += value.byteLength;
              }
            }
          },
          cancel(reason) {
            cancelled = true;
            return reader.cancel(reason).catch(() => {});
          },
        });

        return origFetch(input, { ...init, body: pacedStream });
      }
      return origFetch(input, init);
    };
  }

  // 3) Pace chunk uploads on the original XHR (preserving kio.ac closure state), reuse hashed buffers, throttle progress to 500ms
  if (typeof XMLHttpRequest !== 'undefined') {
    try {
      const throttledXhrs = new WeakSet();
      const throttledUploads = new WeakSet();
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        try {
          if (String(url).includes('/edge/v4/upload')) {
            throttledXhrs.add(this);
            throttledUploads.add(this.upload);
          } else {
            throttledXhrs.delete(this);
            throttledUploads.delete(this.upload);
          }
        } catch {}
        return origOpen.apply(this, arguments);
      };

      const origAbort = XMLHttpRequest.prototype.abort;
      XMLHttpRequest.prototype.abort = function () {
        this.__kioAborted = true;
        return origAbort.apply(this, arguments);
      };

      const origSend = XMLHttpRequest.prototype.send;

      function sendWithCachedBuf(xhr, body) {
        if (body instanceof Blob) {
          const cached = cachedBlobBufs.get(body);
          if (cached && cached.byteLength === body.size) {
            xhr.__kioCachedBlob = body;
            xhr.addEventListener(
              'loadend',
              () => {
                const cachedBody = xhr.__kioCachedBlob;
                xhr.__kioCachedBlob = null;
                if (cachedBody && xhr.status >= 200 && xhr.status < 300) {
                  cachedBlobBufs.delete(cachedBody);
                }
              },
              { once: true },
            );
            return origSend.call(xhr, new Uint8Array(cached));
          }
        }
        return origSend.call(xhr, body);
      }

      XMLHttpRequest.prototype.send = function (body) {
        if (throttledXhrs.has(this) && limit.mbps > 0) {
          const xhr = this;
          xhr.__kioAborted = false;
          const bytes =
            body && typeof body.size === 'number'
              ? body.size
              : body && typeof body.byteLength === 'number'
                ? body.byteLength
                : SLICE_BYTES;
          paceSlice(
            () => {
              if (!xhr.__kioAborted) sendWithCachedBuf(xhr, body);
            },
            bytes,
            () => Boolean(xhr.__kioAborted),
          );
          return;
        }

        if (body instanceof Blob) return sendWithCachedBuf(this, body);
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
            if (typeof fn !== 'function' || !throttledUploads.has(this)) {
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
            };
            originalHandlers.set(this, fn);
            return origSet.call(this, throttled);
          },
        });
      }
    } catch {}
  }

  // 4) Replace 0ms scheduler.postTask busy-wait yields in the streaming uploader (50ms fg / 250ms bg)
  // A hidden tab gets a native Worker tick instead of setTimeout, since Chrome clamps hidden timers to 1s
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
        const delayMs = document.hidden ? 250 : 50;
        return new Promise((resolve) => {
          setTimeout(() => resolve(callback()), delayMs);
        });
      }
      return origPostTask(callback, options);
    };
  }

  // A tiny Worker keeps its own timer budget, so hidden tabs pace accurately instead of stalling at Chrome's 1s clamp.
  try {
    const bgWorker = new Worker(
      URL.createObjectURL(
        new Blob(['self.onmessage=e=>setTimeout(()=>self.postMessage(1),e.data);'], { type: 'text/javascript' }),
      ),
    );
    let bgTickPending = false;

    scheduleHiddenWait = (waitMs) => {
      if (!bgTickPending) {
        bgTickPending = true;
        bgWorker.postMessage(Math.max(1, Math.min(waitMs, 500)));
      }
    };

    bgWorker.onmessage = () => {
      bgTickPending = false;
      drainSliceQueue();
    };

    document.addEventListener('visibilitychange', () => {
      if (sliceQueue.length) {
        drainSliceQueue();
      }
    });
  } catch {}

  // 5) Cap chartjs-plugin-streaming rAF redraws on /upload to 1fps (matching 1000ms data refresh)
  const origRAF = window.requestAnimationFrame?.bind(window);
  const origCancelRAF = window.cancelAnimationFrame?.bind(window);
  if (origRAF && origCancelRAF) {
    const chartTimers = new Map();
    let nextFakeId = -1;

    window.requestAnimationFrame = function (callback) {
      if (typeof callback === 'function') {
        const src = callback.toString();
        if (src.includes('nextRefresh') && src.includes('frameRequestID')) {
          if (document.hidden) {
            return origRAF(callback);
          }
          const id = nextFakeId--;
          const tid = setTimeout(() => {
            chartTimers.delete(id);
            callback(performance.now());
          }, 1000);
          chartTimers.set(id, tid);
          return id;
        }
      }
      return origRAF(callback);
    };

    window.cancelAnimationFrame = function (id) {
      if (chartTimers.has(id)) {
        clearTimeout(chartTimers.get(id));
        chartTimers.delete(id);
        return;
      }
      return origCancelRAF(id);
    };
  }
})();

