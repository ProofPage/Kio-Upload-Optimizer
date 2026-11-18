# Kio Upload Optimizer

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Userscript](https://img.shields.io/badge/Userscript-Tampermonkey%20%7C%20Violentmonkey-green.svg)](#installation)

**Kio Upload Optimizer** is a lightweight userscript for [kio.ac](https://kio.ac) that eliminates unnecessary CPU, timer, and disk I/O spikes during both **file uploads** and **collection/large-file downloads** at full network speed without altering chunk hashing, integrity, pause/resume, or resumability.

---

## Key Features

### Upload Optimizations (`/upload` & `/c/*`)
- **Single-Read Chunk Reuse (No Duplicate Disk/Blob I/O & Zero OOM Risk)**:
  - Normally `kio.ac` reads every 16 MiB chunk twice through Chrome's Browser process (`Blob` IPC): once to compute `SHA-256` in `streaming-worker`, and a second time when uploading the `Blob`.
  - Transfers the already-hashed `ArrayBuffer` back from `streaming-worker` (zero-copy, strict `<= 96 MiB` / `6`-chunk LRU cache) and consumes entries immediately on `XHR.send(Uint8Array)` without retaining arbitrary `Blob.prototype.arrayBuffer()` reads in memory, preventing renderer `Out of Memory` crashes on multi-GiB uploads.

- **Native `XMLHttpRequest` Direct Transfers (Ad-Shield Compatible)**:
  - Disables the `Request.prototype.duplex` capability probe so `kio.ac` uses its built-in `XMLHttpRequest` (`Fh`) path instead of slicing every 16 MiB chunk into 256 × 64 KiB `ReadableStream` `arrayBuffer()` reads in JavaScript, while leaving `window.fetch` and `XMLHttpRequest.prototype.open` untouched so `kio.ac`'s Ad-Shield integrity loader and Turnstile never stall or hang.

- **Progress UI Update Throttling**:
  - Throttles `XMLHttpRequestUpload` `onprogress` callbacks to `500ms` intervals (matching `kio.ac`'s internal 500ms speed meter) while always forwarding final completion bytes immediately, cutting Svelte reactive DOM updates without affecting transferred byte accuracy.

- **0ms `postTask` Spin Elimination**:
  - Replaces the experimental streaming uploader's zero-delay `scheduler.postTask(() => {}, { priority: "user-visible" })` spin loop with a `50ms` foreground / `250ms` background yield, keeping idle waiting near 0% CPU while leaving active chunk queueing responsive.

- **Realtime Chart Frame-Rate Capping**:
  - Caps the `/upload` page `chartjs-plugin-streaming` `requestAnimationFrame` loop to `1fps` (`1000ms`, matching the chart's 1-second data refresh) in the foreground and lets the browser suspend it via native `rAF` when the tab is hidden, with full `cancelAnimationFrame` cleanup support.

### Download & Collection Optimizations (`/c/*`)
- **Shared `500ms` Speed-Ticker Coalescing**:
  - Kiosk constructs one `Li` task (and its own `setInterval(..., 500)`) up front for every `16 MiB` chunk of a download (e.g., ~894 intervals for a 14 GiB file, ~1,762 intervals for a 27.5 GiB collection).
  - Folds all `Li` speed-meter intervals into a single shared `500ms` ticker (`1000ms` in background tabs) and tears it down automatically when tasks finish.

- **Service Worker `BroadcastChannel` & Countdown `rAF` Throttling**:
  - Throttles numeric `BroadcastChannel` progress bursts from Service Worker ZIP/stream downloads to `250ms` (leading + trailing, flushing pending bytes on `close()` so `PH` completion promises never hang).
  - Paces the 5-second modal's `requestAnimationFrame` countdown loop to `250ms` instead of burning 60–144fps frames on `Math.floor` integer seconds.

---

## Installation

1. Install a userscript manager extension in your browser:
   - [Violentmonkey](https://violentmonkey.github.io/) (Recommended)
   - [Tampermonkey](https://www.tampermonkey.net/)
2. Open the userscript installation URL:
   - Click to install [`Kio_Upload_Optimizer.user.js`](https://cdn.jsdelivr.net/gh/ProofPage/Kio-Upload-Optimizer@2852f79d5c6848f0065b0225d7d43cbc97b64050/Kio_Upload_Optimizer.user.js) (jsDelivr, pinned to a commit so the exact published version is served; `@updateURL` keeps the moving `@main` alias).
3. Confirm the installation prompt in your userscript manager.
4. Refresh `https://kio.ac` before starting an upload or download. When active, a subtle `Kio: CPU & I/O Optimized` chip appears at the bottom-right.

For Tampermonkey 5.3+ in Chrome-based browsers, enable **Allow User Scripts** in the extension settings (Chrome 138+) or enable **Developer Mode**. See the [official permission instructions](https://www.tampermonkey.net/faq.php?q=Q209).

---

## Recommended Kiosk Settings

Configure these options at [`https://kio.ac/settings`](https://kio.ac/settings) for the lowest main-thread CPU usage:

| Setting | Recommended Value | Reason |
| :--- | :--- | :--- |
| **Experimental Uploader** | **ON** | Keeps 16 MiB SHA-256 chunk hashing in a background Web Worker (`crypto.subtle`) instead of hashing up to 12 chunks concurrently on the main thread. |
| **Upload thread** (`ul_th`) | `1`–`2` (default is `3`) | Fewer concurrent TLS streams reduce `NetworkService` CPU overhead on fast lines while keeping transfer throughput high. |
| **Parallel download thread number** (`dl_th`) | `2`–`4` (default is `4`) | Balances download throughput and disk write concurrency on multi-GiB files. |

---

## Technical Details

| Bottleneck | Original Behavior | Optimization |
| :--- | :--- | :--- |
| **Duplicate File/Blob Reads** | Reads each 16 MiB chunk twice via Browser `MojoBlobReader` (hash + upload) | Zero-copy recycles worker-hashed `ArrayBuffer` into `XHR.send(Uint8Array)` (strict `<= 96 MiB` 6-chunk LRU, immediate consume-on-send) |
| **64 KiB Stream Slicing** | `ReadableStream` copies 16 MiB chunks in 256 × 64 KiB `arrayBuffer()` slices | `Request.prototype.duplex` disabled → native `XMLHttpRequest` upload (without hooking `window.fetch` or `XHR.open`) |
| **Progress Reactivity Spam** | UI state updated per 64 KiB slice (hundreds–thousands/sec) | `XMLHttpRequestUpload` `onprogress` throttled to `500ms` |
| **Streaming Loop Spin** | `scheduler.postTask(() => {}, { priority: "user-visible" })` 0ms loop | Empty yield tasks paced to `50ms` (`250ms` in background) |
| **Realtime Speed Graph** | `requestAnimationFrame` wakes every vsync, redraws canvas at `30fps` | `nextRefresh`/`frameRequestID` loop capped to `1fps` (0fps in background) |
| **Per-Chunk Speed Timers** | Spawns one `setInterval(..., 500)` per 16 MiB chunk (e.g., 894 timers for 14 GiB) | Folds all `Li` 500ms speed timers into one shared ticker (`1000ms` in background) |
| **SW Zip Progress & Countdown** | Fires `BroadcastChannel` per packet and 60fps `rAF` for 5s countdown | Throttles `BroadcastChannel` to `250ms` (with completion flush on `close()`) and countdown `rAF` to `250ms` |

Note: `kio.ac` requires per-chunk `SHA-256` hashes and HTTPS (TLS) transmission, so a single disk read, WebCrypto hashing, and `NetworkService` TLS encryption remain active at your natural transfer speed.

### Verifying optimization counters

Start an upload or download and check `__kioUploadOptimizer.diag` in the DevTools console:
- `reusedBufs`: upload chunks sent directly from recycled memory without a second disk read.
- `throttledProgress`: redundant upload `onprogress` events suppressed by the 500ms limiter.
- `postTaskSaved`: 0ms busy-wait yields replaced with paced yields.
- `rafCapped`: upload chart redraw frames throttled to 1fps.
- `speedTimersCoalesced`: per-chunk 500ms speed intervals folded into the single shared ticker.
- `bcThrottled`: redundant Service Worker `BroadcastChannel` progress events suppressed.
- `countdownRafCapped`: 5-second modal countdown `rAF` frames throttled to 4fps.

---

## License

This project is licensed under the [MIT License](LICENSE).
