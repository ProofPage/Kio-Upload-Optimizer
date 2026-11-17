# Kio Upload Optimizer

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Userscript](https://img.shields.io/badge/Userscript-Tampermonkey%20%7C%20Violentmonkey-green.svg)](#installation)

**Kio Upload Optimizer** is a lightweight userscript for [kio.ac](https://kio.ac) that eliminates unnecessary main-thread CPU usage during file uploads without altering chunk hashing, upload integrity, or resumability.

---

## Key Features

- **Single-Read Chunk Reuse (No Duplicate Disk/Blob I/O)**:
  - Normally `kio.ac` reads every 16 MiB chunk twice through Chrome's Browser process (`Blob` IPC): once to compute `SHA-256` inside `streaming-worker`, and a second time when uploading the `Blob` (or 256 × 64 KiB `ReadableStream` slices).
  - Transfers the already-hashed `ArrayBuffer` back from `streaming-worker` (zero-copy, bounded 10-chunk LRU cache) and serves both 64 KiB stream slices (capped foreground) and `XMLHttpRequest.send(Uint8Array)` (unlimited/background) directly from RAM with automatic fallback to normal `Blob` reads.

- **Smooth Upload Speed Cap (110 Mbps by default) + `kioUploadSpeed(mbps)`**:
  - Works as installed at **110 Mbps** and stays active even if you switch tabs or cover the browser window (`kioBackground(false)` by default). The current mode and active paced batch count are shown in the bottom-right chip.
  - To change the cap live in the DevTools console (saved in `localStorage`):
    - `kioUploadSpeed(110)` — cap at `110` Mbps (default)
    - `kioUploadSpeed(0)` — disable cap (unlimited)
    - `kioBackground(true)` — lift the cap while the tab is hidden (`false` keeps the cap everywhere)
  - While the cap is active, each `/edge/v4/upload` `ReadableStream` is paced in `256 KiB` batches through a single shared byte-budget queue (~19 ms per batch across all upload threads), keeping real-time speed steady at ~110 Mbps without 16 MiB network bursts.
  - When unlimited (`kioUploadSpeed(0)` or background tab with `kioBackground(true)`), `fetch` `duplex: "half"` is rejected so `kio.ac` falls back to single-`PUT` native `XMLHttpRequest` for lowest CPU usage.

- **Background Upload Support**:
  - Chrome clamps hidden-tab timers to 1 second and suspends `requestAnimationFrame`, which stalls paced queues once the tab is hidden.
  - By default (`kioBackground(false)`), the queue runs on an exact-delay Web Worker timer so the `110 Mbps` cap stays smooth even in a hidden tab. Run `kioBackground(true)` to lift the cap in the background and switch to full-speed native `XMLHttpRequest`.

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
   - Click to install [`Kio_Upload_Optimizer.user.js`](https://cdn.jsdelivr.net/gh/ProofPage/Kio-Upload-Optimizer@0fb3f7fbebc646ee38b57459013a53ce7dd6b1e8/Kio_Upload_Optimizer.user.js) (jsDelivr, pinned to a commit so the exact published version is served; `@updateURL` keeps the moving `@main` alias).
3. Confirm the installation prompt in your userscript manager.
4. Refresh `https://kio.ac/upload` before starting a new upload. The cap (110 Mbps) and background mode are already on.
   - Updating from an older version? Reload the `/upload` tab and restart the upload. Uploads already running keep the old speed, because `kio.ac` builds its uploader once per page load.

For Tampermonkey 5.3+ in Chrome-based browsers, enable **Allow User Scripts** in the extension settings (Chrome 138+) or enable **Developer Mode**. See the [official permission instructions](https://www.tampermonkey.net/faq.php?q=Q209).

---

## Recommended Kiosk Settings

Configure these options at [`https://kio.ac/settings`](https://kio.ac/settings) for the lowest CPU usage:

| Setting | Recommended Value | Reason |
| :--- | :--- | :--- |
| **Experimental Uploader** | **ON** | Keeps 16 MiB SHA-256 chunk hashing in a background Web Worker (`crypto.subtle`) instead of hashing up to 12 chunks concurrently on the main thread. |
| **Upload thread** (`ul_th`) | `1` (default is `3`) | This is how many chunks the page sends at once. Each one reaches the cap as a burst of up to 16 MiB, so a lower thread count keeps the average close to `110 Mbps` even on a fast line. Default choices are remembered per browser, so a previously saved value stays in effect. |

---

## Technical Details

| Bottleneck | Original Behavior | Optimization |
| :--- | :--- | :--- |
| **Duplicate File/Blob Reads** | Reads each 16 MiB chunk twice via Browser `MojoBlobReader` (hash + upload) | Zero-copy recycles hashed `ArrayBuffer` into RAM slice cache & `XHR.send(Uint8Array)` (10-chunk LRU) |
| **Speed Spikes (190+ Mbps)** | All upload threads send full speed or burst 16 MiB chunks | Shared `256 KiB` stream queue (`~19ms` turns across threads) keeps speed steady at `110` Mbps |
| **Hidden-Tab Stalls** | Chrome clamps hidden timers to 1s, so queueing stops when the tab is backgrounded | Cap lifted automatically in background (`XMLHttpRequest`), or paced via dedicated Worker timer |
| **64 KiB Disk Slice IPC** | `ReadableStream` issues 256 × `MojoBlobReader` IPC calls per chunk | `Blob.slice` reads served from cached `ArrayBuffer` in RAM; unlimited mode uses native `XMLHttpRequest` |
| **Progress Reactivity Spam** | UI state updated per 64 KiB slice (hundreds–thousands/sec) | `/edge/v4/upload` `onprogress` throttled to `500ms` |
| **Streaming Loop Spin** | `scheduler.postTask(() => {}, { priority: "user-visible" })` 0ms loop | Empty yield tasks paced to `50ms` (`250ms` in background) |
| **Realtime Speed Graph** | `requestAnimationFrame` wakes every vsync, redraws canvas at `30fps` | `nextRefresh`/`frameRequestID` loop capped to `1fps` (0fps in background) |

Note: `kio.ac` requires per-chunk `SHA-256` hashes and HTTPS (TLS) transmission, so a single disk read, WebCrypto hashing, and `NetworkService` TLS encryption remain active at network upload speed.

### Checking the cap on a live page

Start an upload and type `__kioUploadOptimizer` in the DevTools console. `diag.paced` counts chunks released through the queue, `diag.unlimited` counts chunks sent at full speed (background or cap `0`), `diag.hiddenUnlimited` tells you how many of those went out while the tab was hidden, and `diag.queuedPeak` is the deepest the queue ever got.

| What you see | What it means |
| :--- | :--- |
| `undefined` | This version of the script is not running in the tab, so reload `/upload`. |
| `paced` stays `< 2` after a few seconds | The page is not sending through the queue. Turn the experimental uploader off, or the upload went through a path the script does not wrap yet. |
| `paced` grows but `queuedPeak` stays `1` | No backlog builds, so the queue is not what sets the speed. That is the measured line speed or one chunk finishing, not the cap leaking. |
| `paced` grows fast and the transfer still runs faster than 110 Mbps | Check `queuedPeak`: at `1` the cap never had a second chunk to hold back, so the queue cannot slow the link. |
| 0 bytes counted but a transfer is clearly moving | The script was installed after the page loaded. Reload the tab and start the upload again. |

---

## License

This project is licensed under the [MIT License](LICENSE).
