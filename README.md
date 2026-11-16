# Kio Upload Optimizer

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Userscript](https://img.shields.io/badge/Userscript-Tampermonkey%20%7C%20Violentmonkey-green.svg)](#installation)

**Kio Upload Optimizer** is a lightweight userscript for [kio.ac](https://kio.ac) that eliminates unnecessary main-thread CPU usage during file uploads without altering chunk hashing, upload integrity, or resumability.

---

## Key Features

- **Native `XMLHttpRequest` Direct Blob Uploads**:
  - Disables the `fetch` `duplex: "half"` capability probe so `kio.ac` automatically uses its built-in `XMLHttpRequest` fallback instead of slicing every 16 MiB chunk into 256 × 64 KiB `ReadableStream` `arrayBuffer()` reads in JavaScript.
  - Includes a `/edge/v4/upload` `fetch` guard so streaming uploads never fall back into the 64 KiB slicing loop.

- **Progress UI Update Throttling**:
  - Throttles `/edge/v4/upload` `XMLHttpRequest.upload.onprogress` callbacks to `200ms` intervals while always forwarding final completion bytes immediately, cutting Svelte reactive DOM updates dramatically without affecting transferred byte accuracy.

- **0ms Busy-Wait Loop Elimination**:
  - Replaces the experimental streaming uploader's zero-delay `scheduler.postTask(() => {}, { priority: "user-visible" })` spin loop with a `25ms` yield, keeping idle waiting near 0% CPU while leaving active chunk queueing responsive.

- **Realtime Chart Frame-Rate Capping**:
  - Caps the `/upload` page `chartjs-plugin-streaming` `requestAnimationFrame` loop to `2fps` (`500ms`) in the foreground and lets the browser suspend it via native `rAF` when the tab is hidden, with full `cancelAnimationFrame` cleanup support.

---

## Installation

1. Install a userscript manager extension in your browser:
   - [Violentmonkey](https://violentmonkey.github.io/) (Recommended)
   - [Tampermonkey](https://www.tampermonkey.net/)
2. Open the userscript installation URL:
   - Click to install [`Kio_Upload_Optimizer.user.js`](https://raw.githubusercontent.com/ProofPage/Kio-Upload-Optimizer/main/Kio_Upload_Optimizer.user.js).
3. Confirm the installation prompt in your userscript manager.
4. Refresh `https://kio.ac/upload` before starting a new upload.

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
| **64 KiB Stream Slicing** | `ReadableStream` copies 16 MiB chunks in 256 × 64 KiB `arrayBuffer()` slices | `Request.prototype.duplex` disabled → native `XMLHttpRequest` `Blob` upload |
| **Progress Reactivity Spam** | UI state updated per 64 KiB slice (hundreds–thousands/sec) | `/edge/v4/upload` `onprogress` throttled to `200ms` |
| **Streaming Loop Spin** | `scheduler.postTask(() => {}, { priority: "user-visible" })` 0ms loop | Empty yield tasks paced to `25ms` |
| **Realtime Speed Graph** | `requestAnimationFrame` wakes every vsync, redraws canvas at `30fps` | `nextRefresh`/`frameRequestID` loop capped to `2fps` (0fps in background) |

Note: `kio.ac` requires per-chunk `SHA-256` hashes for server-side verification, so disk reads and hardware-accelerated WebCrypto hashing remain active at network upload speed.

---

## License

This project is licensed under the [MIT License](LICENSE).
