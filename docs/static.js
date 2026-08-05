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
const FONT_OPTIONS = [
  { key: "handwritten", family: '"Caveat", cursive' },
  { key: "serif", family: '"Lora", serif' },
  { key: "mono", family: '"Space Mono", monospace' },
];

const el = (id) => document.getElementById(id);

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
  if (item.frame === "none") {
    img.className = "plain-photo-img";
    return img;
  }
  const card = document.createElement("div");
  card.className = "polaroid";
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

  const pill = document.createElement("div");
  pill.className = "yt-pill";
  pill.textContent = "Paused";

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

  card.append(pill, main, progress, controls, volumeRow, mount);

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
  return createReadOnlyNoteCard(item);
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
  canvas.style.backgroundColor = entry.canvasBg || "";
  if (entry.canvasBgImage) {
    canvas.style.backgroundImage = `url("${entry.canvasBgImage}")`;
    canvas.style.backgroundSize = "cover";
    canvas.style.backgroundPosition = "center";
    canvas.style.backgroundRepeat = "no-repeat";
  } else {
    canvas.style.backgroundImage = entry.canvasBg ? "none" : "";
  }

  let maxBottom = CANVAS_UNIT_HEIGHT;
  for (const item of entry.items || []) {
    const wrap = document.createElement("div");
    wrap.className = "sb-item readonly-item";
    wrap.style.left = `${item.x}%`;
    wrap.style.top = `${(item.y / 100) * CANVAS_UNIT_HEIGHT}px`;
    wrap.style.width = `${item.w}px`;
    wrap.style.zIndex = item.z;
    wrap.style.transform = `translate(-50%, -50%) rotate(${item.rot}deg)`;

    if (item.type !== "text") {
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
 * entry.json sitting next to this page and render it.
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
  renderReadOnlyCanvas(entry);
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
    thumb.className = "entry-thumb";
    if (en.previewUrl) {
      const img = document.createElement("img");
      img.src = en.previewUrl;
      thumb.appendChild(img);
    } else {
      thumb.textContent = "no photo";
    }

    const title = document.createElement("div");
    title.className = "entry-card-title diary-title";
    title.textContent = en.title || "Untitled";

    const meta = document.createElement("div");
    meta.className = "entry-card-meta diary-date";
    meta.textContent = `${formatDate(en.date)} · ${en.itemCount} item${en.itemCount === 1 ? "" : "s"}`;

    card.append(thumb, title, meta);
    grid.appendChild(card);
  }
}

if (el("readonly-canvas")) initStaticEntryPage();
else if (el("entries-grid")) initStaticListPage();
