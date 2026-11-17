# Kio Upload Optimizer

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Userscript](https://img.shields.io/badge/Userscript-Tampermonkey%20%7C%20Violentmonkey-green.svg)](#installation)

**Kio Upload Optimizer** is a lightweight userscript for [kio.ac](https://kio.ac) that eliminates unnecessary main-thread CPU usage during file uploads without altering chunk hashing, upload integrity, or resumability.

---

## Key Features

- **Single-Read Chunk Reuse (No Duplicate Disk/Blob I/O)**:
  - Normally `kio.ac` reads every 16 MiB chunk twice through Chrome's Browser process (`Blob` IPC): once to compute `SHA-256` inside `streaming-worker`, and a second time when uploading the `Blob`.
  - Transfers the already-hashed `ArrayBuffer` back from `streaming-worker` (zero-copy) and feeds it directly to `XMLHttpRequest.send(Uint8Array)` (bounded LRU cache, max 10 chunks), cutting Chrome Browser process Blob I/O in half with automatic fallback to normal `Blob` reads.

- **Native `XMLHttpRequest` Direct Transfers**:
  - Disables the `fetch` `duplex: "half"` capability probe so `kio.ac` automatically uses its built-in `XMLHttpRequest` fallback instead of slicing every 16 MiB chunk into 256 × 64 KiB `ReadableStream` `arrayBuffer()` reads in JavaScript.
  - Includes a `/edge/v4/upload` `fetch` guard so streaming uploads never fall back into the 64 KiB slicing loop.

- **Upload Speed Cap (110 Mbps by default)**:
  - Works as installed: the cap is **110 Mbps** and no console command or settings page is needed. The current mode is shown in a small chip at the bottom-right of the page.
  - To change it, edit the single `LIMIT_MBPS` constant near the top of the script in your userscript manager (`0` = no cap).
  - Chunks are released from a single shared queue, so concurrent upload threads cannot exceed the cap together and chunks are never sent out of order. Each chunk still travels as one `PUT`, so server-side hash checks and retries keep working.

- **Background Upload Support**:
  - Chrome clamps hidden-tab timers to 1 second and suspends `requestAnimationFrame`, which stalls the chunk queue once the tab is hidden. The queue is now driven by a tiny dedicated Worker that keeps its own timer budget, so uploads continue while you work in another tab.
  - While the tab is hidden the cap is lifted automatically (`UNLIMITED_IN_BACKGROUND = true`) so the upload finishes at full speed. Set it to `false` in the script to keep the Mbps limit everywhere.

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
   - Click to install [`Kio_Upload_Optimizer.user.js`](https://cdn.jsdelivr.net/gh/ProofPage/Kio-Upload-Optimizer@401844599fa51bf7b58b3aaceacd7331184c57ce/Kio_Upload_Optimizer.user.js) (jsDelivr, pinned to a commit so the exact published version is served; `@updateURL` keeps the moving `@main` alias).
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
| **Upload thread** | `1`–`2` | Controls concurrent chunk transfers and browser Blob I/O pressure on high-speed connections. |

---

## Technical Details

| Bottleneck | Original Behavior | Optimization |
| :--- | :--- | :--- |
| **Duplicate File/Blob Reads** | Reads each 16 MiB chunk twice via Browser `MojoBlobReader` (hash + upload) | Zero-copy recycles hashed `ArrayBuffer` into `XHR.send(Uint8Array)` (10-chunk LRU) |
| **Speed Spikes (100–150 Mbps)** | All upload threads send full speed with no shared budget | One 16 MiB-chunk queue paced by a `250ms` byte window, on by default at `110` Mbps |
| **Hidden-Tab Stalls** | Chrome clamps hidden timers to 1s, so queueing stops when the tab is backgrounded | Queue released by a dedicated Worker timer, cap lifted automatically in the background |
| **64 KiB Stream Slicing** | `ReadableStream` copies 16 MiB chunks in 256 × 64 KiB `arrayBuffer()` slices | `Request.prototype.duplex` disabled → native `XMLHttpRequest` upload |
| **Progress Reactivity Spam** | UI state updated per 64 KiB slice (hundreds–thousands/sec) | `/edge/v4/upload` `onprogress` throttled to `500ms` |
| **Streaming Loop Spin** | `scheduler.postTask(() => {}, { priority: "user-visible" })` 0ms loop | Empty yield tasks paced to `50ms` (`250ms` in background) |
| **Realtime Speed Graph** | `requestAnimationFrame` wakes every vsync, redraws canvas at `30fps` | `nextRefresh`/`frameRequestID` loop capped to `1fps` (0fps in background) |

Note: `kio.ac` requires per-chunk `SHA-256` hashes and HTTPS (TLS) transmission, so a single disk read, WebCrypto hashing, and `NetworkService` TLS encryption remain active at network upload speed.

---

## License

This project is licensed under the [MIT License](LICENSE).
