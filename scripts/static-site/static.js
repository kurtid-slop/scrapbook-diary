// Client script for the static, GitHub-Pages-friendly export of this diary
// (built by scripts/build-static.js into docs/). No server, no editing —
// every page here just fetches a JSON file sitting next to it and renders a
// read-only view. This file is copied byte-for-byte to docs/static.js and is
// shared by both docs/index.html (the entries list) and every generated
// docs/entries/<id>/index.html (one entry's read-only page); each page's
// markup determines which branch below runs.

const CANVAS_UNIT_HEIGHT = 560;
const CANVAS_CONTENT_PADDING = 150;
const STICKY_COLORS = ["#fff59d", "#ffcc80", "#ff8a80", "#a5d6a7", "#90caf9", "#ce93d8"];

// Mirrors app.js's bangarang constants — see there for the rationale.
const BANGARANG_MIN_DELAY = 30;
const BANGARANG_MAX_DELAY = 1000;
const BANGARANG_DEFAULT_DELAY = 150;

/** @param {number} ms @returns {number} `ms` clamped to the bangarang delay range. */
function clampBangarangDelay(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return BANGARANG_DEFAULT_DELAY;
  return Math.min(BANGARANG_MAX_DELAY, Math.max(BANGARANG_MIN_DELAY, n));
}
const FONT_OPTIONS = [
  { key: "handwritten", family: '"Caveat", cursive' },
  { key: "serif", family: '"Lora", serif' },
  { key: "mono", family: '"Space Mono", monospace' },
];

const el = (id) => document.getElementById(id);

// ---------- password protection: crypto ----------
// Mirrors the encrypt/decrypt half of src/public/app.js's crypto section
// (this file only ever decrypts — a static export can't be edited, so
// there's no lock/protect UI here). See that file for the full rationale:
// AES-GCM with a PBKDF2-derived key, entirely native SubtleCrypto so this
// works with zero server and zero dependencies, and a wrong password is
// just decrypt() throwing rather than a separate check.
const PBKDF2_ITERATIONS = 200000;

/** @param {string} str - base64 @returns {Uint8Array} */
function base64ToBytes(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * @param {string} password
 * @param {Uint8Array} salt
 * @returns {Promise<CryptoKey>}
 */
async function deriveEntryKey(password, salt) {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Try to decrypt entry.enc with a candidate password.
 * @param {string} password
 * @param {{salt: string, iv: string, data: string}} enc
 * @returns {Promise<object|null>} The decrypted `{items, canvasBg,
 *   canvasBgImage}` payload, or null if the password was wrong.
 */
async function decryptEntryPayload(password, enc) {
  try {
    const key = await deriveEntryKey(password, base64ToBytes(enc.salt));
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(enc.iv) }, key, base64ToBytes(enc.data));
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null; // wrong password (or corrupt data) — the AES-GCM auth tag failed
  }
}

/**
 * An encrypted payload stores a photo's URL as just its entry-relative
 * `uploads/<file>` tail (see absoluteImgToPortable in app.js) rather than
 * whatever host/path it was encrypted from — this page's own uploads/
 * folder (copied next to it by build-static.js) sits one level up from it.
 * @param {string} portable
 * @returns {string}
 */
function portableImgToRelative(portable) {
  return `./${portable}`;
}

/**
 * The reverse of app.js's itemImagesToPortable, run on a just-decrypted
 * payload here — applies portableImgToRelative to whichever image URL
 * field(s) an item actually has (a photo's `img`, or a bangarang's
 * `img1`/`img2`).
 * @param {object} item
 * @returns {object}
 */
function itemImagesToRelative(item) {
  if (item.type === "photo" && item.img) return { ...item, img: portableImgToRelative(item.img) };
  if (item.type === "bangarang") return { ...item, img1: portableImgToRelative(item.img1), img2: portableImgToRelative(item.img2) };
  return item;
}

/**
 * Render an inline "enter password to continue" gate into `container`,
 * replacing whatever it currently shows — see the matching function in
 * app.js for the full rationale (shared verbatim, minus the editor-only
 * callers that file also has).
 * @param {HTMLElement} container
 * @param {(password: string) => Promise<boolean>} onSubmit
 */
function renderPasswordGate(container, onSubmit) {
  container.innerHTML = "";
  container.classList.add("password-gate");

  const icon = document.createElement("div");
  icon.className = "lock-icon";
  icon.textContent = "🔒";

  const label = document.createElement("div");
  label.className = "diary-date";
  label.textContent = "This entry is password protected.";

  const form = document.createElement("form");
  const input = document.createElement("input");
  input.type = "password";
  input.placeholder = "Password";
  input.autocomplete = "current-password";
  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "btn btn-accent";
  submitBtn.textContent = "Unlock";
  form.append(input, submitBtn);

  const error = document.createElement("div");
  error.className = "password-error";

  container.append(icon, label, form, error);
  input.focus();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!input.value) return;
    input.disabled = true;
    submitBtn.disabled = true;
    error.textContent = "";
    const ok = await onSubmit(input.value);
    if (!ok) {
      error.textContent = "Incorrect password.";
      input.disabled = false;
      submitBtn.disabled = false;
      input.value = "";
      input.focus();
    }
  });
}

/**
 * @param {number} ts - Unix ms timestamp.
 * @returns {string} Locale-formatted date, e.g. "Aug 3, 2026".
 */
function formatDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** @param {string|undefined} key @returns {string} */
function fontFamilyFor(key) {
  const found = FONT_OPTIONS.find((f) => f.key === key);
  return found ? found.family : "";
}

/**
 * @param {object} item
 * @param {HTMLElement} textEl
 */
function applyTextStyle(item, textEl) {
  textEl.style.fontFamily = fontFamilyFor(item.font);
  textEl.style.color = item.textColor || "";
  textEl.style.fontSize = item.fontSize ? `${item.fontSize}px` : "";
}

/**
 * @param {object} item
 * @param {HTMLElement} card
 */
function applyNoteBackground(item, card) {
  const isSticky = item.noteStyle === "sticky";
  card.classList.toggle("note-style-sticky", isSticky);
  card.classList.toggle("note-style-paper", !isSticky);
  card.style.background = isSticky ? item.noteColor || STICKY_COLORS[0] : "";
}

/** @param {string} str @returns {string} */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Strip anything actively dangerous out of a note's stored HTML before it's
 * set via innerHTML — same defensive backstop as the live app's sanitizer.
 * @param {string} html
 * @returns {string}
 */
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, iframe, object, embed").forEach((n) => n.remove());
  doc.querySelectorAll("*").forEach((node) => {
    [...node.attributes].forEach((attr) => {
      if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
      if ((attr.name === "href" || attr.name === "src") && /^\s*javascript:/i.test(attr.value)) {
        node.removeAttribute(attr.name);
      }
    });
  });
  return doc.body.innerHTML;
}

/** @param {object} item @returns {HTMLElement} */
function createReadOnlyPhotoCard(item) {
  const img = document.createElement("img");
  img.src = item.img;
  img.draggable = false;
  if (item.h) {
    img.style.height = `${item.h}px`;
    img.style.objectFit = item.frame === "none" ? "cover" : "fill";
  }
  if (item.flipH || item.flipV) {
    img.style.transform = `scale(${item.flipH ? -1 : 1}, ${item.flipV ? -1 : 1})`;
  }
  if (item.frame === "none") {
    img.className = "plain-photo-img" + (item.shadow === false ? " no-shadow" : "");
    return img;
  }
  const card = document.createElement("div");
  card.className = "polaroid" + (item.shadow === false ? " no-shadow" : "");
  const caption = document.createElement("div");
  caption.className = "caption-input";
  caption.textContent = item.caption || "";
  applyTextStyle(item, caption);
  card.append(img, caption);
  return card;
}

/** @param {object} item @returns {HTMLElement} */
function createReadOnlyNoteCard(item) {
  const card = document.createElement("div");
  card.className = "note-card";
  applyNoteBackground(item, card);
  const textDiv = document.createElement("div");
  textDiv.className = "note-text";
  textDiv.innerHTML = item.richText ? sanitizeHtml(item.text || "") : escapeHtml(item.text || "");
  applyTextStyle(item, textDiv);
  card.appendChild(textDiv);
  return card;
}

/** @param {object} item @returns {HTMLElement} */
function createReadOnlyTextCard(item) {
  const textDiv = document.createElement("div");
  textDiv.className = "text-box";
  textDiv.innerHTML = item.richText ? sanitizeHtml(item.text || "") : escapeHtml(item.text || "");
  applyTextStyle(item, textDiv);
  return textDiv;
}

let ytApiPromise = null; // memoized promise so the <script> tag is only ever injected once

/**
 * Lazily inject the YouTube IFrame API script and resolve once it's ready.
 * @returns {Promise<typeof window.YT>}
 */
function loadYoutubeApi() {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT);
      return;
    }
    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (prevReady) prevReady();
      resolve(window.YT);
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  });
  return ytApiPromise;
}

/**
 * @param {number} sec - Duration in seconds.
 * @returns {string} "m:ss" display, e.g. 75 -> "1:15".
 */
function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const readOnlyYtPlayers = new Map(); // item.id -> { player, progressTimer, muted }
const readOnlyYtCardRefs = new Map(); // item.id -> dom refs for live updates

/**
 * @param {object} item
 * @returns {HTMLElement} The same "Now Playing"-style card as the editor's
 *   music player (status pill, art/title/artist, progress bar, transport
 *   controls, volume) minus the "change song" button — driven by a real
 *   YT.Player started muted, since that's the only autoplay browsers
 *   reliably allow without a prior user gesture; the volume icon/slider
 *   unmute on first interaction.
 */
function createReadOnlyYoutubeCard(item) {
  const card = document.createElement("div");
  card.className = "yt-player-card";

  const header = document.createElement("div");
  header.className = "yt-header";
  const pill = document.createElement("div");
  pill.className = "yt-pill";
  pill.textContent = "Paused";
  const collapseBtn = document.createElement("button");
  collapseBtn.className = "yt-collapse-btn";
  collapseBtn.textContent = "⌄";
  collapseBtn.title = "Hide controls";
  collapseBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  collapseBtn.addEventListener("click", () => {
    const collapsed = card.classList.toggle("collapsed");
    collapseBtn.title = collapsed ? "Show controls" : "Hide controls";
  });
  header.append(pill, collapseBtn);

  const main = document.createElement("div");
  main.className = "yt-main";
  const art = document.createElement("div");
  art.className = "yt-art";
  const artImg = document.createElement("img");
  artImg.src = item.thumb || `https://img.youtube.com/vi/${item.videoId}/hqdefault.jpg`;
  art.appendChild(artImg);
  const info = document.createElement("div");
  info.className = "yt-info";
  const titleEl = document.createElement("div");
  titleEl.className = "yt-title";
  titleEl.textContent = item.title || "";
  const artistEl = document.createElement("div");
  artistEl.className = "yt-artist";
  artistEl.textContent = item.artist || "";
  info.append(titleEl, artistEl);
  main.append(art, info);

  const progress = document.createElement("div");
  progress.className = "yt-progress";
  const track = document.createElement("div");
  track.className = "yt-track";
  const fill = document.createElement("div");
  fill.className = "yt-fill";
  track.appendChild(fill);
  track.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    const rect = track.getBoundingClientRect();
    seekReadOnlyYoutubeToRatio(item.id, Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
  });
  const times = document.createElement("div");
  times.className = "yt-times";
  const elapsedEl = document.createElement("span");
  elapsedEl.textContent = "0:00";
  const durationEl = document.createElement("span");
  durationEl.textContent = "0:00";
  times.append(elapsedEl, durationEl);
  progress.append(track, times);

  const controls = document.createElement("div");
  controls.className = "yt-controls";
  const rewindBtn = document.createElement("button");
  rewindBtn.className = "yt-ctrl-btn";
  rewindBtn.textContent = "⏪";
  rewindBtn.title = "Back 10s";
  rewindBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  rewindBtn.addEventListener("click", () => seekReadOnlyYoutube(item.id, -10));

  const playBtn = document.createElement("button");
  playBtn.className = "yt-ctrl-btn yt-play";
  playBtn.textContent = "▶";
  playBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  playBtn.addEventListener("click", () => toggleReadOnlyYoutubePlay(item.id));

  const forwardBtn = document.createElement("button");
  forwardBtn.className = "yt-ctrl-btn";
  forwardBtn.textContent = "⏩";
  forwardBtn.title = "Forward 10s";
  forwardBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  forwardBtn.addEventListener("click", () => seekReadOnlyYoutube(item.id, 10));

  const repeatBtn = document.createElement("button");
  repeatBtn.className = "yt-ctrl-btn yt-repeat" + (item.repeat ? " active" : "");
  repeatBtn.textContent = "\u{1F501}";
  repeatBtn.title = "Repeat";
  repeatBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  repeatBtn.addEventListener("click", () => {
    item.repeat = !item.repeat; // local-only toggle, not persisted
    repeatBtn.classList.toggle("active", item.repeat);
  });

  controls.append(rewindBtn, playBtn, forwardBtn, repeatBtn);

  const volumeRow = document.createElement("div");
  volumeRow.className = "yt-volume-row";
  const volumeIcon = document.createElement("span");
  volumeIcon.className = "yt-volume-icon";
  volumeIcon.textContent = "\u{1F507}";
  volumeIcon.title = "Muted for autoplay — click to unmute";
  volumeIcon.style.cursor = "pointer";
  volumeIcon.addEventListener("pointerdown", (e) => e.stopPropagation());
  volumeIcon.addEventListener("click", () => toggleReadOnlyYoutubeMute(item.id, volumeIcon));
  const volumeSlider = document.createElement("input");
  volumeSlider.type = "range";
  volumeSlider.className = "yt-volume-slider";
  volumeSlider.min = "0";
  volumeSlider.max = "100";
  volumeSlider.value = String(item.volume ?? 100);
  volumeSlider.addEventListener("pointerdown", (e) => e.stopPropagation());
  volumeSlider.addEventListener("input", (e) => setReadOnlyYoutubeVolume(item.id, Number(e.target.value), volumeIcon));
  volumeRow.append(volumeIcon, volumeSlider);

  const mount = document.createElement("div");
  mount.className = "yt-mount";

  const collapsible = document.createElement("div");
  collapsible.className = "yt-collapsible";
  collapsible.append(controls, volumeRow);

  card.append(header, main, progress, collapsible, mount);

  readOnlyYtCardRefs.set(item.id, { pill, fill, elapsedEl, durationEl, playBtn, mount, volumeIcon });
  initReadOnlyYoutubePlayer(item);

  return card;
}

/** @param {object} item @returns {Promise<void>} */
async function initReadOnlyYoutubePlayer(item) {
  const YT = await loadYoutubeApi();
  const refs = readOnlyYtCardRefs.get(item.id);
  if (!refs || readOnlyYtPlayers.has(item.id)) return;
  const player = new YT.Player(refs.mount, {
    videoId: item.videoId,
    width: "2",
    height: "2",
    playerVars: { autoplay: 1, mute: 1, controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1 },
    events: {
      onReady: (e) => {
        e.target.setVolume(item.volume ?? 100);
        e.target.mute();
        e.target.playVideo();
      },
      onStateChange: (e) => onReadOnlyYoutubeStateChange(item, e.data),
    },
  });
  readOnlyYtPlayers.set(item.id, { player, progressTimer: null, muted: true });
}

/** @param {string} id @returns {void} */
function startReadOnlyProgressPolling(id) {
  const entry = readOnlyYtPlayers.get(id);
  if (!entry || entry.progressTimer) return;
  entry.progressTimer = setInterval(() => updateReadOnlyYoutubeProgress(id), 500);
  updateReadOnlyYoutubeProgress(id);
}

/** @param {string} id @returns {void} */
function stopReadOnlyProgressPolling(id) {
  const entry = readOnlyYtPlayers.get(id);
  if (!entry || !entry.progressTimer) return;
  clearInterval(entry.progressTimer);
  entry.progressTimer = null;
}

/** @param {string} id @returns {void} */
function updateReadOnlyYoutubeProgress(id) {
  const entry = readOnlyYtPlayers.get(id);
  const refs = readOnlyYtCardRefs.get(id);
  if (!entry || !refs) return;
  let current = 0;
  let duration = 0;
  try {
    current = entry.player.getCurrentTime() || 0;
    duration = entry.player.getDuration() || 0;
  } catch {
    return;
  }
  refs.fill.style.width = duration ? `${Math.min(100, (current / duration) * 100)}%` : "0%";
  refs.elapsedEl.textContent = formatTime(current);
  refs.durationEl.textContent = formatTime(duration);
}

/**
 * @param {object} item
 * @param {number} stateVal - A window.YT.PlayerState.* constant.
 * @returns {void}
 */
function onReadOnlyYoutubeStateChange(item, stateVal) {
  const YT = window.YT;
  const refs = readOnlyYtCardRefs.get(item.id);
  const isPlaying = stateVal === YT.PlayerState.PLAYING;
  if (refs) {
    refs.playBtn.textContent = isPlaying ? "⏸" : "▶";
    refs.pill.textContent = isPlaying ? "Playing" : stateVal === YT.PlayerState.ENDED ? "Ended" : "Paused";
    refs.pill.classList.toggle("playing", isPlaying);
  }
  if (isPlaying) startReadOnlyProgressPolling(item.id);
  else stopReadOnlyProgressPolling(item.id);

  if (stateVal === YT.PlayerState.ENDED && item.repeat) {
    const entry = readOnlyYtPlayers.get(item.id);
    if (entry) {
      entry.player.seekTo(0, true);
      entry.player.playVideo();
    }
  }
}

/** @param {string} id @returns {void} */
function toggleReadOnlyYoutubePlay(id) {
  const entry = readOnlyYtPlayers.get(id);
  if (!entry) return;
  const isPlaying = entry.player.getPlayerState() === window.YT.PlayerState.PLAYING;
  if (isPlaying) entry.player.pauseVideo();
  else entry.player.playVideo();
}

/**
 * @param {string} id
 * @param {number} deltaSeconds
 * @returns {void}
 */
function seekReadOnlyYoutube(id, deltaSeconds) {
  const entry = readOnlyYtPlayers.get(id);
  if (!entry) return;
  entry.player.seekTo(Math.max(0, entry.player.getCurrentTime() + deltaSeconds), true);
}

/**
 * @param {string} id
 * @param {number} ratio - 0 (start) to 1 (end).
 * @returns {void}
 */
function seekReadOnlyYoutubeToRatio(id, ratio) {
  const entry = readOnlyYtPlayers.get(id);
  if (!entry) return;
  const duration = entry.player.getDuration();
  if (duration) entry.player.seekTo(duration * ratio, true);
}

/**
 * @param {string} id
 * @param {number} volume - 0-100.
 * @param {HTMLElement} volumeIconEl
 * @returns {void}
 */
function setReadOnlyYoutubeVolume(id, volume, volumeIconEl) {
  const entry = readOnlyYtPlayers.get(id);
  if (!entry) return;
  entry.player.setVolume(volume);
  if (entry.muted) {
    entry.player.unMute();
    entry.muted = false;
    volumeIconEl.textContent = "\u{1F50A}";
    volumeIconEl.title = "Mute";
  }
}

/**
 * @param {string} id
 * @param {HTMLElement} volumeIconEl
 * @returns {void}
 */
function toggleReadOnlyYoutubeMute(id, volumeIconEl) {
  const entry = readOnlyYtPlayers.get(id);
  if (!entry) return;
  if (entry.muted) {
    entry.player.unMute();
    entry.muted = false;
    volumeIconEl.textContent = "\u{1F50A}";
    volumeIconEl.title = "Mute";
  } else {
    entry.player.mute();
    entry.muted = true;
    volumeIconEl.textContent = "\u{1F507}";
    volumeIconEl.title = "Unmute";
  }
}

/** @param {object} item @returns {HTMLElement} */
function createReadOnlyCard(item) {
  if (item.type === "photo") return createReadOnlyPhotoCard(item);
  if (item.type === "youtube") return createReadOnlyYoutubeCard(item);
  if (item.type === "text") return createReadOnlyTextCard(item);
  if (item.type === "bangarang") return createReadOnlyBangarangCard(item);
  return createReadOnlyNoteCard(item);
}

/**
 * @param {object} item - The bangarang-type item.
 * @returns {HTMLElement} A `.bangarang-frame` holding both images stacked
 *   (each `object-fit: cover`), toggling which is visible forever — see the
 *   matching function in app.js for the full rationale (shared verbatim):
 *   swapping one `<img>`'s src every tick can't keep up with a real
 *   full-size photo at a fast delay, so both are pre-loaded up front and
 *   only their visibility toggles.
 */
function createReadOnlyBangarangCard(item) {
  const frame = document.createElement("div");
  frame.className = "bangarang-frame";
  if (item.h) frame.style.height = `${item.h}px`;

  const img1 = document.createElement("img");
  img1.className = "bangarang-img bangarang-img-front";
  img1.src = item.img1;
  img1.draggable = false;

  const img2 = document.createElement("img");
  img2.className = "bangarang-img bangarang-img-back";
  img2.src = item.img2;
  img2.draggable = false;

  frame.append(img1, img2);

  const start = () => {
    let showingFirst = true;
    setInterval(() => {
      showingFirst = !showingFirst;
      img1.style.opacity = showingFirst ? "1" : "0";
      img2.style.opacity = showingFirst ? "0" : "1";
    }, clampBangarangDelay(item.delay));
  };
  if (img2.complete) start();
  else img2.addEventListener("load", start, { once: true });

  return frame;
}

/**
 * Build the read-only canvas for one entry into #readonly-canvas: every item
 * rendered statically (no drag, selection, editing, or per-item controls),
 * sized to fit exactly as far down as the content goes — the page's scroll
 * distance is capped to its actual content, with no endless-scroll buffer.
 * @param {object} entry
 */
function renderReadOnlyCanvas(entry) {
  const canvas = el("readonly-canvas");
  canvas.innerHTML = "";
  canvas.classList.remove("password-gate"); // in case this is replacing the gate
  canvas.classList.toggle("layout-phone", entry.layout === "phone");
  canvas.style.backgroundColor = entry.canvasBg || "";
  if (entry.canvasBgImage) {
    canvas.style.backgroundImage = `url("${entry.canvasBgImage}")`;
    canvas.style.backgroundSize = "cover";
    canvas.style.backgroundPosition = "center";
    canvas.style.backgroundRepeat = "no-repeat";
  } else {
    canvas.style.backgroundImage = entry.canvasBg ? "none" : "";
  }
  canvas.classList.toggle("custom-bg", !!(entry.canvasBg || entry.canvasBgImage));

  let maxBottom = CANVAS_UNIT_HEIGHT;
  for (const item of entry.items || []) {
    const wrap = document.createElement("div");
    wrap.className = "sb-item readonly-item";
    wrap.style.left = `${item.x}%`;
    wrap.style.top = `${(item.y / 100) * CANVAS_UNIT_HEIGHT}px`;
    wrap.style.width = `${item.w}px`;
    wrap.style.zIndex = item.z;
    wrap.style.transform = `translate(-50%, -50%) rotate(${item.rot}deg)`;

    if (item.type !== "text" && !(item.type === "photo" && item.tape === false)) {
      const washi = document.createElement("div");
      washi.className = "washi";
      washi.style.background = item.color;
      wrap.appendChild(washi);
    }

    const card = createReadOnlyCard(item);
    wrap.appendChild(card);
    canvas.appendChild(wrap);

    const heightPx = card.offsetHeight || 150;
    const bottom = (item.y / 100) * CANVAS_UNIT_HEIGHT + heightPx / 2;
    if (bottom > maxBottom) maxBottom = bottom;
  }

  canvas.style.height = `${maxBottom + CANVAS_CONTENT_PADDING}px`;
}

/**
 * Boot for one entry's static page (docs/entries/<id>/index.html): fetch the
 * entry.json sitting next to this page and render it. A protected entry
 * shows a password gate in place of the canvas instead — this page has no
 * server at all, so decryption happens entirely in the visitor's browser.
 * @returns {Promise<void>}
 */
async function initStaticEntryPage() {
  const res = await fetch("./entry.json");
  if (!res.ok) {
    el("readonly-error").hidden = false;
    el("readonly-canvas").hidden = true;
    return;
  }
  const entry = await res.json();
  el("readonly-title").textContent = entry.title || "Untitled";
  el("readonly-date").textContent = formatDate(entry.date);
  if (entry.locked) {
    el("readonly-canvas").classList.toggle("layout-phone", entry.layout === "phone");
    renderPasswordGate(el("readonly-canvas"), async (password) => {
      const decrypted = await decryptEntryPayload(password, entry.enc);
      if (!decrypted) return false;
      entry.items = (decrypted.items || []).map(itemImagesToRelative);
      entry.canvasBg = decrypted.canvasBg;
      entry.canvasBgImage = decrypted.canvasBgImage ? portableImgToRelative(decrypted.canvasBgImage) : undefined;
      renderReadOnlyCanvas(entry);
      return true;
    });
  } else {
    renderReadOnlyCanvas(entry);
  }
}

/**
 * Boot for the static entries list page (docs/index.html): fetch the
 * manifest and render a grid of view-only cards linking into entries/<id>/.
 * @returns {Promise<void>}
 */
async function initStaticListPage() {
  const res = await fetch("./entries-manifest.json");
  const entries = await res.json();
  const grid = el("entries-grid");
  el("entries-empty").hidden = entries.length !== 0;

  for (const en of entries) {
    const card = document.createElement("a");
    card.className = "entry-card";
    card.href = `entries/${en.id}/`;
    // .entry-card is styled as a <div> everywhere else in styles.css (no
    // display rule of its own), so as an <a> it needs these set directly to
    // keep the same block layout instead of collapsing to inline.
    card.style.display = "block";
    card.style.textDecoration = "none";
    card.style.color = "inherit";

    const thumb = document.createElement("div");
    // A locked entry's content (including any photo) was never exported as
    // plaintext, so there's no previewUrl to show — a badge instead, same
    // as the "no photo" placeholder.
    if (en.locked) {
      thumb.className = "entry-thumb locked";
      thumb.textContent = "🔒";
    } else if (en.previewUrl) {
      thumb.className = "entry-thumb";
      const img = document.createElement("img");
      img.src = en.previewUrl;
      thumb.appendChild(img);
    } else {
      thumb.className = "entry-thumb";
      thumb.textContent = "no photo";
    }

    const title = document.createElement("div");
    title.className = "entry-card-title diary-title";
    title.textContent = en.title || "Untitled";

    const meta = document.createElement("div");
    meta.className = "entry-card-meta diary-date";
    const metaBase = en.locked
      ? `${formatDate(en.date)} · protected`
      : `${formatDate(en.date)} · ${en.itemCount} item${en.itemCount === 1 ? "" : "s"}`;
    meta.textContent = en.layout === "phone" ? `${metaBase} · 📱` : metaBase;

    card.append(thumb, title, meta);
    grid.appendChild(card);
  }
}

if (el("readonly-canvas")) initStaticEntryPage();
else if (el("entries-grid")) initStaticListPage();
