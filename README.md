# Kio Upload Optimizer

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Userscript](https://img.shields.io/badge/Userscript-Tampermonkey%20%7C%20Violentmonkey-green.svg)](#installation)

**Kio Upload Optimizer** is a lightweight userscript for [kio.ac](https://kio.ac) that eliminates unnecessary CPU and disk I/O spikes during file uploads at full network speed without altering chunk hashing, upload integrity, or resumability.

---

## Key Features

- **Single-Read Chunk Reuse (No Duplicate Disk/Blob I/O)**:
  - Normally `kio.ac` reads every 16 MiB chunk twice through Chrome's Browser process (`Blob` IPC): once to compute `SHA-256` (in `streaming-worker` or the main thread in Legacy mode), and a second time when uploading the `Blob`.
  - Transfers the already-hashed `ArrayBuffer` back from `streaming-worker` (zero-copy, bounded 10-chunk LRU cache `<= 160 MiB`) and reuses cached buffers in `LegacyUploader` too, feeding `Uint8Array` directly to `XMLHttpRequest.send()` with automatic fallback to normal `Blob` reads on retries or cache misses.

- **Native `XMLHttpRequest` Direct Transfers**:
  - Disables the `fetch` `duplex: "half"` capability probe so `kio.ac` uses its built-in `XMLHttpRequest` (`Fh`) path instead of slicing every 16 MiB chunk into 256 × 64 KiB `ReadableStream` `arrayBuffer()` reads in JavaScript.
  - Includes an `/edge/v4/upload` `fetch` guard so streaming uploads never fall back into the 64 KiB slicing loop.

- **Progress UI Update Throttling**:
  - Throttles `/edge/v4/upload` `XMLHttpRequest.upload.onprogress` callbacks to `500ms` intervals (matching `kio.ac`'s internal 500ms speed meter) while always forwarding final completion bytes immediately, cutting Svelte reactive DOM updates without affecting transferred byte accuracy.

- **0ms Busy-Wait Loop Elimination**:
  - Replaces the experimental streaming uploader's zero-delay `scheduler.postTask(() => {}, { priority: "user-visible" })` spin loop with a `50ms` foreground / `250ms` background yield, keeping idle waiting near 0% CPU while leaving active chunk queueing responsive.

- **Realtime Chart Frame-Rate Capping**:
  - Caps the `/upload` page `chartjs-plugin-streaming` `requestAnimationFrame` loop to `1fps` (`1000ms`, matching the chart's 1-second data refresh) in the foreground and lets the browser suspend it via native `rAF` when the tab is hidden, with full `cancelAnimationFrame` cleanup support.

---

## Installation

1. Install a userscript manager extension in your browser:
   - [Violentmonkey](https://violentmonkey.github.io/) (Recommended)
   - [Tampermonkey](https://www.tampermonkey.net/)
2. Open the userscript installation URL:
   - Click to install [`Kio_Upload_Optimizer.user.js`](https://cdn.jsdelivr.net/gh/ProofPage/Kio-Upload-Optimizer@5d3f411dc94e06934613d7b7b63741901dc79829/Kio_Upload_Optimizer.user.js) (jsDelivr, pinned to a commit so the exact published version is served; `@updateURL` keeps the moving `@main` alias).
3. Confirm the installation prompt in your userscript manager.
4. Refresh `https://kio.ac/upload` before starting a new upload. When active, a subtle `Kio: CPU Optimized` chip appears at the bottom-right.

For Tampermonkey 5.3+ in Chrome-based browsers, enable **Allow User Scripts** in the extension settings (Chrome 138+) or enable **Developer Mode**. See the [official permission instructions](https://www.tampermonkey.net/faq.php?q=Q209).

---

## Recommended Kiosk Settings

Configure these options at [`https://kio.ac/settings`](https://kio.ac/settings) for the lowest main-thread CPU usage:

| Setting | Recommended Value | Reason |
| :--- | :--- | :--- |
| **Experimental Uploader** | **ON** | Keeps 16 MiB SHA-256 chunk hashing in a background Web Worker (`crypto.subtle`) instead of hashing up to 12 chunks concurrently on the main thread. |
| **Upload thread** (`ul_th`) | `1`–`2` (default is `3`) | Fewer concurrent TLS streams reduce `NetworkService` CPU overhead on fast lines while keeping transfer throughput high. |

---

## Technical Details

| Bottleneck | Original Behavior | Optimization |
| :--- | :--- | :--- |
| **Duplicate File/Blob Reads** | Reads each 16 MiB chunk twice via Browser `MojoBlobReader` (hash + upload) | Zero-copy recycles hashed `ArrayBuffer` into `XHR.send(Uint8Array)` (10-chunk LRU, Streaming & Legacy) |
| **64 KiB Stream Slicing** | `ReadableStream` copies 16 MiB chunks in 256 × 64 KiB `arrayBuffer()` slices | `Request.prototype.duplex` disabled → native `XMLHttpRequest` upload |
| **Progress Reactivity Spam** | UI state updated per 64 KiB slice (hundreds–thousands/sec) | `/edge/v4/upload` `onprogress` throttled to `500ms` |
| **Streaming Loop Spin** | `scheduler.postTask(() => {}, { priority: "user-visible" })` 0ms loop | Empty yield tasks paced to `50ms` (`250ms` in background) |
| **Realtime Speed Graph** | `requestAnimationFrame` wakes every vsync, redraws canvas at `30fps` | `nextRefresh`/`frameRequestID` loop capped to `1fps` (0fps in background) |

Note: `kio.ac` requires per-chunk `SHA-256` hashes and HTTPS (TLS) transmission, so a single disk read, WebCrypto hashing, and `NetworkService` TLS encryption remain active at your natural upload speed.

### Verifying optimization counters

Start an upload and check `__kioUploadOptimizer.diag` in the DevTools console:
- `reusedBufs`: chunks sent directly from recycled memory without a second disk read.
- `throttledProgress`: redundant `onprogress` events suppressed by the 500ms limiter.
- `postTaskSaved`: 0ms busy-wait yields replaced with paced yields.
- `rafCapped`: chart redraw frames throttled to 1fps.

---

## License

This project is licensed under the [MIT License](LICENSE).
