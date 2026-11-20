# Kio Upload Optimizer

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Userscript](https://img.shields.io/badge/Userscript-Tampermonkey%20%7C%20Violentmonkey-green.svg)](#installation)

**Kio Upload Optimizer** is a lightweight userscript for [kio.ac](https://kio.ac) that eliminates unnecessary CPU, timer, and disk I/O spikes during both **file uploads** and **collection/large-file downloads** at full network speed without altering chunk hashing, integrity, pause/resume, or resumability.

---

## Key Features

### Upload Optimizations (`/upload` & `/c/*`)
- **Zero-RAM File-Backed `XMLHttpRequest` Transfers (No OOM & No 64 KiB Slicing)**:
  - Disables the `Request.prototype.duplex` capability probe so `kio.ac` uses its built-in `XMLHttpRequest` (`Fh`) path with file-backed `Blob` slices instead of slicing every 16 MiB chunk into 256 × 64 KiB `ReadableStream` `arrayBuffer()` allocations in JavaScript.
  - Keeps 0 bytes of `ArrayBuffer` chunks cached in the V8 heap and lets `streaming-worker` free each 16 MiB `ArrayBuffer` immediately after `SHA-256` hashing, completely preventing renderer `Out of Memory` crashes on multi-GiB uploads while leaving `window.fetch`, `XMLHttpRequest.prototype.open`/`send`, `Worker`, and `URL.createObjectURL` untouched for full Ad-Shield, Turnstile, and local file preview compatibility.

- **Progress UI Update Throttling**:
  - Throttles `XMLHttpRequestUpload` `onprogress` callbacks to `500ms` intervals (matching `kio.ac`'s internal 500ms speed meter) while always forwarding initial and final completion bytes immediately, cutting Svelte reactive DOM updates without affecting transferred byte accuracy.

- **0ms `postTask` Spin Elimination**:
  - Replaces the experimental streaming uploader's zero-delay `scheduler.postTask(() => {}, { priority: "user-visible" })` spin loop with a `50ms` foreground / `150ms` background yield (preserving abortable `signal` tasks untouched), keeping idle waiting near 0% CPU while leaving active chunk queueing responsive.

- **Realtime Chart Frame-Rate Capping**:
  - Caps the `/upload` page `chartjs-plugin-streaming` `requestAnimationFrame` loop to `1fps` (`1000ms`, matching the chart's 1-second data refresh) in the foreground and lets the browser suspend it via native `rAF` when the tab is hidden, with full `cancelAnimationFrame` cleanup support.

### Download & Collection Optimizations (`/c/*`)
- **Shared `500ms` Speed-Ticker Coalescing & Exact Terminal Cleanup**:
  - Kiosk constructs one `Li` task (and its own `setInterval(..., 500)`) up front for every `16 MiB` chunk of a download (e.g., ~894 intervals for a 14 GiB file, ~1,762 intervals for a 27.5 GiB collection), and only calls `clearInterval(this.interval)` inside its lazy getter `ended`.
  - Folds all `Li` speed-meter intervals into a single shared `500ms` ticker (`1000ms` in background tabs) and clears each task's interval strictly when it dispatches terminal `state` `4` (done) or `5` (aborted)—never affecting active, paused (`3`), queued (`1`), or retrying (`6`) tasks.
  - **Encrypted Download Buffer Leak Fix**: In password-protected downloads, Kiosk's `zH._startEncrypted()` allocates a 16 MiB `this._buffer` `Uint8Array` per chunk and never releases it after writing to disk. Releasing `this._buffer` immediately on chunk `state` `4`/`5` prevents multi-GiB RAM growth and `Out of Memory` crashes on large encrypted downloads.

- **Service Worker `BroadcastChannel` & Countdown `rAF` Throttling**:
  - Throttles numeric `BroadcastChannel` progress bursts from Service Worker ZIP/stream downloads to `250ms` (leading + trailing) and cleanly cancels pending trailing timers on `close()` so aborted channels never fire stale updates.
  - Paces the 5-second modal's `requestAnimationFrame` countdown loop to `250ms` instead of burning 60–144fps frames on `Math.floor` integer seconds.

### UI/UX Alignment & Spacing Fixes (Desktop & Mobile)
- **Floating Task Queue Widget (Bottom-Right)**:
  - Centers the collapse/expand chevron icon cleanly inside its `36×36` toggle button (fixing Kiosk's `ml-auto` + `rotate-180` + `py-4` clash that pushed the arrow 1px against the left edge), removes stray `ml-2` / `pb-4` spacing, adds an opaque elevated card surface so underlying buttons never bleed through, hides Kiosk's empty invisible pause button on completed tasks, caps tray list height to `min(35vh, 260px)` with smooth internal scroll, balances nested sub-task indentation, and respects mobile `env(safe-area-inset-bottom)`.
- **`/upload` Staging Layout & Table Alignment**:
  - Strictly scopes all `/upload` staging selectors (`:has(> div > .min-w-80)`) and FileExplorer table rules so no other `kio.ac` routes (`/history`, `/settings`, `/p2p`, `/c/*`, dropzone, or done views) are ever unintentionally altered.
  - Expands the desktop right options panel & `업로드 & 링크 생성` button horizontally (`clamp(368px, 26vw, 440px)`) with tight balanced `16px` outer/column margins matching the floating task card width.
  - Keeps the desktop `업로드 & 링크 생성` CTA block (and optional Turnstile widget) anchored at the **very bottom** of the right column, dynamically lifts the floating task tray **`12px` directly above the upload CTA** on `/upload`, and reserves matching spacing below the scrollable upper options panel so neither options nor the upload button are ever overlapped (while automatically returning the tray to `bottom: 16px` on all other routes and mobile).
  - Fixes mobile `/upload` layout issues: replaces Kiosk's 576px empty `min-h-144` file box with a compact scrollable `220px–46dvh` area, keeps mobile progress bars full-width, unifies `16px` horizontal padding across stats and options, prevents `.min-w-80` overflow on narrow 320–360px phones, bumps `datetime-local` to `16px` to stop iOS Safari auto-zoom, and enlarges primary CTA/task buttons to comfortable touch targets (`44px` / `36px`).
  - Aligns file explorer `이름` and `크기` column headers to exact `0px` offset with their row values, centers file icons in a 40px first column, applies `tabular-nums` to sizes/stats, fixes `py-4` padding clash on option accordion headers (`제목 & 설명`, `비밀번호`), harmonizes section spacing, centers `datetime-local` text, and adds right padding on password inputs so typed text never runs under the visibility toggle icon.

---

## Installation

1. Install a userscript manager extension in your browser:
   - [Violentmonkey](https://violentmonkey.github.io/) (Recommended)
   - [Tampermonkey](https://www.tampermonkey.net/)
2. Open the userscript installation URL:
   - Click to install [`Kio_Upload_Optimizer.user.js`](https://github.com/ProofPage/Kio-Upload-Optimizer/raw/main/Kio_Upload_Optimizer.user.js) (or jsDelivr `@main`).
3. Confirm the installation prompt in your userscript manager.
4. Refresh `https://kio.ac` before starting an upload or download. You can verify it is active anytime via `window.__kioUploadOptimizer.diag` in DevTools.

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
| **64 KiB Stream Slicing & RAM Churn** | `ReadableStream` copies 16 MiB chunks in 256 × 64 KiB `arrayBuffer()` slices | `Request.prototype.duplex` disabled → native file-backed `XMLHttpRequest.send(Blob)` (0 MiB V8 heap retention) |
| **Progress Reactivity Spam** | UI state updated per 64 KiB slice (hundreds–thousands/sec) | `XMLHttpRequestUpload` `onprogress` throttled to `500ms` |
| **Streaming Loop Spin** | `scheduler.postTask(() => {}, { priority: "user-visible" })` 0ms loop | Empty yield tasks paced to `50ms` (`150ms` in background) |
| **Realtime Speed Graph** | `requestAnimationFrame` wakes every vsync, redraws canvas at `30fps` | `nextRefresh`/`frameRequestID` loop capped to `1fps` (0fps in background) |
| **Per-Chunk Speed Timers & Encrypted Buffer Leak** | Spawns one `setInterval(..., 500)` per 16 MiB chunk and never clears `zH._buffer` (16 MiB each) after write | Folds all `Li` 500ms speed timers into one shared ticker; frees completed/aborted chunk timers and `zH._buffer` strictly on `state` `4`/`5` |
| **SW Zip Progress & Countdown** | Fires `BroadcastChannel` per packet and 60fps `rAF` for 5s countdown | Throttles `BroadcastChannel` to `250ms` (cancels pending timer on `close()`) and countdown `rAF` to `250ms` |

Note: `kio.ac` requires per-chunk `SHA-256` hashes and HTTPS (TLS) transmission, so disk reads, WebCrypto hashing, and `NetworkService` TLS encryption remain active at your natural transfer speed.

### Verifying optimization counters

Start an upload or download and check `__kioUploadOptimizer.diag` in the DevTools console:
- `throttledProgress`: redundant upload `onprogress` events suppressed by the 500ms limiter.
- `postTaskSaved`: 0ms busy-wait yields replaced with paced yields.
- `rafCapped`: upload chart redraw frames throttled to 1fps.
- `speedTimersCoalesced` / `speedTimersAutoFreed`: per-chunk 500ms speed intervals folded and completed/aborted chunk timers released.
- `encryptedBuffersFreed`: 16 MiB `zH._buffer` arrays released immediately after encrypted download chunks finish or abort.
- `bcThrottled`: redundant Service Worker `BroadcastChannel` progress events suppressed.
- `countdownRafCapped`: 5-second modal countdown `rAF` frames throttled to 4fps.

---

## License

This project is licensed under the [MIT License](LICENSE).
