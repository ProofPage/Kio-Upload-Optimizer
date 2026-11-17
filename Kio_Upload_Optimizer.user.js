// ==UserScript==
// @name         Kio Upload Optimizer
// @namespace    https://github.com/ProofPage/Kio-Upload-Optimizer
// @version      2.4.0
// @description  Eliminates upload CPU spikes on kio.ac by avoiding duplicate file reads, forcing native XHR transfers, capping upload Mbps, throttling progress UI updates, removing 0ms busy-wait loops, and capping chart redraws.
// @author       Page
// @match        https://kio.ac/*
// @homepageURL  https://github.com/ProofPage/Kio-Upload-Optimizer
// @supportURL   https://github.com/ProofPage/Kio-Upload-Optimizer/issues
// @updateURL    https://raw.githubusercontent.com/ProofPage/Kio-Upload-Optimizer/main/Kio_Upload_Optimizer.user.js
// @downloadURL  https://raw.githubusercontent.com/ProofPage/Kio-Upload-Optimizer/main/Kio_Upload_Optimizer.user.js
// @run-at       document-start
// @grant        none
// @noframes
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  if (window.__kioUploadOptimizerLoaded) return;
  window.__kioUploadOptimizerLoaded = true;

  // Bandwidth cap: whole chunks are released from one shared queue under a fixed byte window (Mbps, 0 = unlimited)
  const SLICE_BYTES = 16 * 1024 * 1024;
  const limit = { mbps: 0, windowMs: 250, windowStart: 0, windowBytes: 0 };
  const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  // Chrome throttles hidden-tab timers to 1s, so a background tab uses 4x wider windows
  const pacingWindowMs = () => (document.hidden ? limit.windowMs * 4 : limit.windowMs);

  function applyMbps(mbps) {
    const value = Number(mbps);
    limit.mbps = Number.isFinite(value) && value > 0 ? Math.min(value, 2000) : 0;
  }

  try {
    chrome.storage.local.get('kio_upload_mbps', (res) => applyMbps(res?.kio_upload_mbps));
  } catch {}

  // Console helper: `kioUploadSpeed(80)` caps the upload at 80 Mbps, `kioUploadSpeed(0)` removes the cap
  win.kioUploadSpeed = function (mbps) {
    applyMbps(mbps);
    try {
      chrome.storage.local.set({ kio_upload_mbps: limit.mbps });
    } catch {}
    return limit.mbps;
  };

  // One shared queue paced by the window budget, so chunks never exceed the cap and never go out of order
  const sliceQueue = [];

  function drainSliceQueue() {
    const now = performance.now();
    const windowMs = pacingWindowMs();
    if (!limit.windowStart || now - limit.windowStart >= windowMs) {
      limit.windowStart = now;
      limit.windowBytes = 0;
    }

    const budget = ((limit.mbps * 1024 * 1024) / 8) * (windowMs / 1000);
    while (sliceQueue.length && limit.windowBytes + SLICE_BYTES <= budget) {
      limit.windowBytes += SLICE_BYTES;
      sliceQueue.shift()();
    }

    if (sliceQueue.length) {
      setTimeout(drainSliceQueue, Math.max(1, windowMs - (now - limit.windowStart)));
    }
  }

  function paceSlice(sendSlice) {
    if (limit.mbps <= 0) {
      sendSlice();
      return;
    }
    sliceQueue.push(sendSlice);
    if (sliceQueue.length === 1) drainSliceQueue();
  }

  // Shared cache to avoid reading each 16 MiB chunk twice (once for SHA-256, once for XHR upload)
  const bufToBlob = new WeakMap();
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

  // 1) Track large chunk Blob -> ArrayBuffer reads and recycle hashed buffers from streaming-worker
  if (typeof Blob !== 'undefined' && typeof Blob.prototype.arrayBuffer === 'function') {
    const origArrayBuffer = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      const blob = this;
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

  // 2) Force native XMLHttpRequest uploads instead of 64 KiB ReadableStream slicing
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

    try {
      const OrigRequest = window.Request;
      window.Request = new Proxy(OrigRequest, {
        construct(target, args) {
          if (args[0] === '/' && args[1]?.duplex === 'half') {
            throw new TypeError('duplex probe disabled');
          }
          return new target(...args);
        },
      });
    } catch {}
  }

  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (init?.duplex === 'half' && url.includes('/edge/v4/upload')) {
        try {
          Promise.resolve(init.body?.cancel?.()).catch(() => {});
        } catch {}
        return Promise.reject(new TypeError('duplex disabled'));
      }
      return origFetch(input, init);
    };
  }

  // 3) Pace chunk uploads, reuse hashed buffers (no duplicate Blob read), throttle progress to 500ms
  if (typeof XMLHttpRequest !== 'undefined') {
    try {
      const throttledUploads = new WeakSet();
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url, async) {
        try {
          this.__kioOpen = [method, url, async];
          this.__kioHeaders = [];
          if (String(url).includes('/edge/v4/upload')) {
            throttledUploads.add(this.upload);
          } else {
            throttledUploads.delete(this.upload);
          }
        } catch {}
        return origOpen.apply(this, arguments);
      };

      const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        try {
          this.__kioHeaders?.push([name, value]);
        } catch {}
        return origSetRequestHeader.apply(this, arguments);
      };

      const origSend = XMLHttpRequest.prototype.send;

      // kio.ac creates the XHR inside the sender callback, so only here can open() + headers be copied over
      const startPacedSend = (origin, body) => {
        const [method, url, async] = origin.__kioOpen;
        const paced = new XMLHttpRequest();
        paced.open(method, url, async);
        paced.responseType = origin.responseType;
        paced.withCredentials = origin.withCredentials;
        paced.timeout = origin.timeout;
        paced.__kioPaced = true;

        for (const [name, value] of origin.__kioHeaders || []) paced.setRequestHeader(name, value);

        for (const prop of [
          'onloadstart',
          'onprogress',
          'onabort',
          'onerror',
          'onload',
          'ontimeout',
          'onloadend',
          'onreadystatechange',
        ]) {
          paced[prop] = origin[prop];
        }
        paced.upload.onprogress = origin.upload.onprogress;

        const cached = body instanceof Blob ? cachedBlobBufs.get(body) : null;
        const payload = cached && cached.byteLength === body.size ? new Uint8Array(cached) : body;
        if (payload !== body) paced.__kioCachedBlob = body;

        paced.addEventListener(
          'loadend',
          () => {
            const cachedBody = paced.__kioCachedBlob;
            if (cachedBody) {
              paced.__kioCachedBlob = null;
              if (paced.status >= 200 && paced.status < 300) cachedBlobBufs.delete(cachedBody);
            }
          },
          { once: true },
        );

        origin.__kioPaced = paced;
        paceSlice(() => paced.send(payload));
      };

      // Page code checks readyState and attaches listeners after send(), so it keeps seeing the real request
      function proxyXhr(origin) {
        return new Proxy(origin, {
          get(target, prop) {
            if (prop === 'send') return (body) => startPacedSend(target, body);
            const source = target.__kioPaced || target;
            const value = prop === 'upload' ? source.upload : source[prop];
            return typeof value === 'function' ? value.bind(source) : value;
          },
          set(target, prop, value) {
            const source = target.__kioPaced || target;
            if (prop in source) source[prop] = value;
            return true;
          },
        });
      }

      XMLHttpRequest.prototype.send = function (body) {
        if (throttledUploads.has(this.upload) && limit.mbps > 0) {
          const xhr = proxyXhr(this);
          xhr.send(body);
          return xhr;
        }

        if (body instanceof Blob) {
          const cached = cachedBlobBufs.get(body);
          if (cached && cached.byteLength === body.size) {
            const xhr = this;
            xhr.__kioCachedBlob = body;
            xhr.addEventListener(
              'loadend',
              () => {
                xhr.__kioCachedBlob = null;
                if (xhr.status >= 200 && xhr.status < 300) {
                  cachedBlobBufs.delete(body);
                }
              },
              { once: true },
            );
            return origSend.call(this, new Uint8Array(cached));
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
            if (typeof fn !== 'function' || !throttledUploads.has(this) || !this.__kioPaced) {
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

