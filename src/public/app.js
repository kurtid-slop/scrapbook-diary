// Scrapbook Diary client. No framework/build step — this is a single plain
// script that owns the whole page: it renders the entries list, the
// per-entry scrapbook canvas (draggable photos/notes/music), and the
// site-wide "Style Lab" custom-CSS editor, and talks to the Express API in
// server.js for persistence. Everything reads/writes the `state` object
// below and re-renders via a handful of render*()/apply*() functions rather
// than a virtual DOM — see the "canvas rendering" section for the one place
// that does incremental DOM diffing (it matters there because a naive full
// rebuild would restart any playing YouTube embed).

// Washi-tape colors randomly assigned to new canvas items (purely decorative).
const WASHI_COLORS = ["#c98a6b", "#8c9b74", "#9b7fa6", "#c9a15a"];

// item.x/item.y are stored as percentages, but as of the scrollable canvas
// feature they're percentages of this FIXED reference height (matching the
// canvas's original fixed height, so existing saved items land in exactly
// the same spot), not of the canvas element's actual current height. That's
// what lets the canvas grow to fit content without every existing item's
// vertical position shifting each time it grows — see growCanvasToFitContent.
const CANVAS_UNIT_HEIGHT = 560;

// Selectable fonts for note/caption text, keyed by a short name stored on
// the item (item.font) and mapped to an actual CSS font-family here.
const FONT_OPTIONS = [
  { key: "handwritten", family: '"Caveat", cursive' },
  { key: "serif", family: '"Lora", serif' },
  { key: "mono", family: '"Space Mono", monospace' },
];

// Canned custom-CSS snippets offered as one-click buttons in the Style Lab.
const PRESETS = [
  {
    name: "Midnight ink",
    css: `.scrapbook-canvas {
  background-color: #1b2129;
  background-image: none;
}
.diary-title, .diary-date {
  color: #e8e2d0;
}
.note-card {
  background: #2a3038;
  color: #e8e2d0;
}
.polaroid {
  background: #2a3038;
}`,
  },
  {
    name: "Typewriter",
    css: `.note-card, .diary-title {
  font-family: "Space Mono", monospace !important;
}
.note-card {
  background: #f7f3e8;
  border-radius: 2px;
}`,
  },
  {
    name: "Extra washi",
    css: `.washi {
  height: 34px;
  width: 90px;
}`,
  },
];

// Selector -> description pairs shown in the Style Lab's "available hooks"
// panel, documenting which CSS classes a user can target with custom CSS.
const CHEAT_SHEET = [
  [".scrapbook-canvas", "the whole paper background"],
  [".diary-title", "the handwritten title text"],
  [".note-card", "each sticky note card"],
  [".note-card.note-style-paper", "notes set to the graph-paper look"],
  [".note-card.note-style-sticky", "notes set to the sticky-note look"],
  [".polaroid", "each photo frame"],
  [".polaroid img", "the photo itself"],
  [".washi", "the tape strip on each item"],
  [".entry-card", "each entry on the home page"],
  [".yt-player-card", "the music player card"],
];

/** Shorthand for document.getElementById, used everywhere UI code needs a DOM node. */
const el = (id) => document.getElementById(id);

// Single global mutable store for what's currently on screen: which top-level
// view is showing, the entries list summary, the fully-loaded entry being
// edited (if any), which item on its canvas is selected, and the live text
// of the site-wide custom CSS. There's no framework here — DOM code reads
// and mutates this object directly, then calls a render function to sync
// the screen.
const state = {
  view: "list",
  entries: [],
  activeEntry: null,
  // Which canvas item(s) are selected. A Set rather than a single id so
  // shift-click can build up a multi-selection (see startMove) — size 1 is
  // the common case and gets the full per-item toolbar; size > 1 just gets
  // a visual outline plus the ability to drag the whole group together,
  // preserving each item's position relative to the others.
  selectedItemIds: new Set(),
  customCss: "",
};

let saveEntryTimer = null; // debounce timer id for scheduleSaveEntry
let saveCssTimer = null; // debounce timer id for scheduleSaveCss
let zCounter = 10; // monotonically increasing z-index source for canvas items
let dragInfo = null; // in-progress drag/rotate state, or null when idle

/**
 * @param {number} ts - Unix ms timestamp.
 * @returns {string} Locale-formatted date, e.g. "Aug 3, 2026".
 */
function formatDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Update the small "saving…"/"saved" indicator in the top-right of the tab bar.
 * @param {string} text
 */
function setSaveIndicator(text) {
  el("save-indicator").textContent = text;
}

// ---------- view switching ----------

/**
 * Switch which top-level view is visible, and keep the tab buttons' active
 * state in sync. Purely a DOM/visibility toggle — does not load or change
 * any data. The "readonly" view (the published/preview page) also hides
 * the tab bar entirely, since it isn't part of the editing SPA's navigation.
 * @param {"list"|"entry"|"lab"|"readonly"} view
 */
function showView(view) {
  state.view = view;
  el("view-list").hidden = view !== "list";
  el("view-entry").hidden = view !== "entry";
  el("view-lab").hidden = view !== "lab";
  el("view-readonly").hidden = view !== "readonly";
  el("tabs").hidden = view === "readonly";
  el("tab-diary").classList.toggle("active", view !== "lab");
  el("tab-lab").classList.toggle("active", view === "lab");
}

el("tab-diary").addEventListener("click", () => {
  showView(state.activeEntry ? "entry" : "list");
});
el("tab-lab").addEventListener("click", () => showView("lab"));
el("back-btn").addEventListener("click", async () => {
  resetCanvasState();
  state.activeEntry = null;
  // Re-fetch the list so a renamed title, new photo, or item-count change
  // made in the entry we're leaving shows up immediately, instead of the
  // grid staying stuck on whatever it looked like at boot / last visit.
  await loadEntries();
  showView("list");
});

// ---------- entries list ----------

/**
 * Fetch the lightweight entries summary from the server and re-render the
 * home page grid. Called on boot and after creating/deleting an entry.
 * @returns {Promise<void>}
 */
async function loadEntries() {
  const res = await fetch("/api/entries");
  state.entries = await res.json();
  renderEntriesGrid();
}

/**
 * Rebuild the home page's entry-card grid from state.entries (full wipe and
 * redraw — the list is small enough that this is cheap, unlike the canvas
 * renderer which diffs). Each card shows a preview photo (or "no photo"),
 * title, date/item-count, and a delete button.
 */
function renderEntriesGrid() {
  const grid = el("entries-grid");
  grid.innerHTML = "";
  el("entries-empty").hidden = state.entries.length !== 0;

  for (const en of state.entries) {
    const card = document.createElement("div");
    card.className = "entry-card";
    card.addEventListener("click", () => openEntry(en.id));

    const del = document.createElement("button");
    del.className = "delete-btn";
    del.textContent = "\u2715";
    del.title = "Delete entry";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      await fetch(`/api/entries/${en.id}`, { method: "DELETE" });
      await loadEntries();
    });

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
    meta.textContent = `${formatDate(en.date)} \u00b7 ${en.itemCount} item${en.itemCount === 1 ? "" : "s"}`;

    card.append(del, thumb, title, meta);
    grid.appendChild(card);
  }
}

el("new-entry-btn").addEventListener("click", async () => {
  const res = await fetch("/api/entries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "New entry" }),
  });
  const entry = await res.json();
  await loadEntries();
  openEntry(entry.id);
});

// ---------- single entry ----------

/**
 * Load one entry by id and show its canvas view. Tears down whatever was
 * previously open first (destroys any playing YouTube players, clears the
 * item DOM cache) so nothing from the last entry leaks into this one.
 * @param {string} id - Entry id.
 * @returns {Promise<void>}
 */
async function openEntry(id) {
  const res = await fetch(`/api/entries/${id}`);
  if (!res.ok) return;
  resetCanvasState();
  state.activeEntry = await res.json();
  state.selectedItemIds.clear();
  zCounter = Math.max(10, ...(state.activeEntry.items || []).map((it) => it.z || 0)) + 1;
  el("entry-title-input").value = state.activeEntry.title;
  el("entry-date").textContent = formatDate(state.activeEntry.date);
  applyCanvasBackground();
  renderCanvas();
  showView("entry");
}

/**
 * Debounced autosave for the currently open entry: waits 500ms after the
 * last call before PUTting title/date/items/canvasBg to the server, so
 * rapid edits (typing, dragging) collapse into one request instead of one
 * per keystroke. Every mutation to state.activeEntry should call this
 * afterward. Updates the "saving\u2026"/"saved" indicator around the request.
 */
function scheduleSaveEntry() {
  setSaveIndicator("saving\u2026");
  clearTimeout(saveEntryTimer);
  saveEntryTimer = setTimeout(async () => {
    const { id, title, date, items, canvasBg } = state.activeEntry;
    await fetch(`/api/entries/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, date, items, canvasBg }),
    });
    setSaveIndicator("saved");
  }, 500);
}

el("entry-title-input").addEventListener("input", (e) => {
  state.activeEntry.title = e.target.value;
  scheduleSaveEntry();
});

/**
 * Compute a canvas position (%) for the center of whatever part of the
 * canvas is currently visible in the viewport, regardless of scroll
 * position. Used so items added via the toolbar (as opposed to the
 * right-click menu, which already places at the click point) land where
 * the user is actually looking — the canvas can be many times taller than
 * the viewport now (see the endless-scroll section), so a fixed
 * near-the-top default could land far out of view. A small random jitter
 * keeps repeated clicks from stacking new items exactly on top of each other.
 * @returns {{x: number, y: number}}
 */
function getViewportCenterCanvasPos() {
  const rect = el("canvas").getBoundingClientRect();
  const jitter = () => (Math.random() - 0.5) * 10;
  const x = Math.min(96, Math.max(4, ((window.innerWidth / 2 - rect.left) / rect.width) * 100 + jitter()));
  const y = Math.max(2, ((window.innerHeight / 2 - rect.top) / CANVAS_UNIT_HEIGHT) * 100 + jitter());
  return { x, y };
}

/**
 * Add a new sticky note item to the open entry and save.
 * @param {{x: number, y: number}} pos - Canvas position as percentages
 *   (0-100) to place the note at — the right-click menu passes the click
 *   point, the toolbar button passes getViewportCenterCanvasPos().
 */
function createNoteItem(pos) {
  const item = {
    id: `note-${Date.now()}`,
    type: "note",
    x: pos.x,
    y: pos.y,
    rot: Math.round((Math.random() * 10 - 5) * 10) / 10,
    w: 200,
    text: "Write here...",
    color: WASHI_COLORS[Math.floor(Math.random() * WASHI_COLORS.length)],
    z: ++zCounter,
  };
  state.activeEntry.items.push(item);
  renderCanvas();
  scheduleSaveEntry();
}
el("add-note-btn").addEventListener("click", () => createNoteItem(getViewportCenterCanvasPos()));

/**
 * Add a new free-floating text box to the open entry and save. Unlike a
 * note, a text box has no card background or washi tape — just styled text
 * sitting directly on the canvas, positionable anywhere. Reuses the same
 * rich-text engine as notes (font/size/color/highlight, per-selection).
 * @param {{x: number, y: number}} pos - Canvas position (%) — see createNoteItem.
 */
function createTextItem(pos) {
  const item = {
    id: `text-${Date.now()}`,
    type: "text",
    x: pos.x,
    y: pos.y,
    rot: 0,
    w: 160,
    text: "Type here...",
    z: ++zCounter,
  };
  state.activeEntry.items.push(item);
  renderCanvas();
  scheduleSaveEntry();
}
el("add-text-btn").addEventListener("click", () => createTextItem(getViewportCenterCanvasPos()));

// Where a photo picked via triggerPhotoPick() should be placed once the user
// finishes the file-picker + crop-modal flow. Stashed here because the
// browser's file input is a single shared, stateless element.
let pendingPhotoPos = null;

/**
 * Open the browser's native file picker for a new photo. The eventual
 * upload lands wherever `pos` says (see createNoteItem for the same pattern).
 * @param {{x: number, y: number}} pos - Target canvas position (%).
 */
function triggerPhotoPick(pos) {
  pendingPhotoPos = pos;
  el("photo-file-input").click();
}
el("add-photo-btn").addEventListener("click", () => triggerPhotoPick(getViewportCenterCanvasPos()));

// Fires once the user picks a file (or cancels) from the native dialog
// opened by triggerPhotoPick(). Hands the file off to the crop modal rather
// than uploading it directly.
el("photo-file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  const pos = pendingPhotoPos;
  pendingPhotoPos = null;
  e.target.value = "";
  if (!file) return;
  openCropModal(file, pos);
});

/**
 * Upload an already-cropped photo blob to the current entry's uploads
 * folder, then add a photo item pointing at the returned URL.
 * @param {Blob} blob - The cropped square JPEG from openCropModal.
 * @param {{x: number, y: number}} pos - Target canvas position (%).
 * @returns {Promise<void>}
 */
async function uploadCroppedPhoto(blob, pos) {
  const form = new FormData();
  form.append("photo", blob, "photo.jpg");
  const res = await fetch(`/api/entries/${state.activeEntry.id}/uploads`, { method: "POST", body: form });
  if (!res.ok) return;
  const { url } = await res.json();
  const item = {
    id: `photo-${Date.now()}`,
    type: "photo",
    x: pos.x,
    y: pos.y,
    rot: Math.round((Math.random() * 12 - 6) * 10) / 10,
    w: 190,
    img: url,
    caption: "",
    color: WASHI_COLORS[Math.floor(Math.random() * WASHI_COLORS.length)],
    z: ++zCounter,
  };
  state.activeEntry.items.push(item);
  renderCanvas();
  scheduleSaveEntry();
}

// ---------- photo crop modal ----------
// Crops client-side to a 1:1 square (to match the polaroid frame) before
// anything is uploaded, so the server only ever stores square photos.

const CROP_VIEWPORT_SIZE = 320; // on-screen size (px) of the square crop preview
const CROP_OUTPUT_SIZE = 800; // pixel size of the final square photo we upload

/**
 * Open a modal that lets the user pan, zoom, and rotate a just-picked image
 * file, then crop it to a 1:1 square and upload the result as a new photo
 * item. Self-contained: builds its own DOM, owns its own local state
 * (pan/zoom/rotation), and tears itself down (removes the overlay, revokes
 * the object URL, drops its listeners) when cancelled or confirmed.
 * @param {File} file - The image file picked from disk.
 * @param {{x: number, y: number}} pos - Canvas position (%) to place the
 *   resulting photo item at once cropping finishes.
 */
function openCropModal(file, pos) {
  const objectUrl = URL.createObjectURL(file);

  const overlay = document.createElement("div");
  overlay.className = "crop-overlay";

  const modal = document.createElement("div");
  modal.className = "crop-modal";

  const heading = document.createElement("div");
  heading.className = "crop-heading diary-title";
  heading.textContent = "Crop your photo";

  const viewport = document.createElement("div");
  viewport.className = "crop-viewport";
  const img = document.createElement("img");
  img.className = "crop-img";
  img.draggable = false;
  viewport.appendChild(img);

  const rotateBtn = document.createElement("button");
  rotateBtn.className = "crop-rotate-btn";
  rotateBtn.type = "button";
  rotateBtn.title = "Rotate 90°";
  rotateBtn.textContent = "⟳";
  viewport.appendChild(rotateBtn);

  const zoomRow = document.createElement("div");
  zoomRow.className = "crop-zoom-row";
  const zoomIcon = document.createElement("span");
  zoomIcon.className = "crop-zoom-icon";
  zoomIcon.textContent = "🔍";
  const zoomSlider = document.createElement("input");
  zoomSlider.type = "range";
  zoomSlider.className = "crop-zoom-slider";
  zoomSlider.min = "1";
  zoomSlider.max = "3";
  zoomSlider.step = "0.01";
  zoomSlider.value = "1";
  zoomRow.append(zoomIcon, zoomSlider);

  const actions = document.createElement("div");
  actions.className = "crop-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn";
  cancelBtn.textContent = "Cancel";
  const useBtn = document.createElement("button");
  useBtn.className = "btn btn-accent";
  useBtn.textContent = "Use Photo";
  actions.append(cancelBtn, useBtn);

  modal.append(heading, viewport, zoomRow, actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  let naturalW = 0;
  let naturalH = 0;
  let baseScale = 1;
  let zoom = 1;
  let offsetX = 0;
  let offsetY = 0;
  let panInfo = null;
  let rotationDeg = 0;

  // Rotation is baked into a canvas bitmap up front, so the pan/zoom/crop
  // math below never has to think about rotation — it always just works
  // with whatever `img` currently shows, the same as the unrotated case.
  const sourceImg = new Image();
  sourceImg.src = objectUrl;

  function renderRotatedSource() {
    if (rotationDeg === 0) {
      img.src = objectUrl;
      return;
    }
    const swap = rotationDeg % 180 !== 0;
    const w = sourceImg.naturalWidth;
    const h = sourceImg.naturalHeight;
    const canvas = document.createElement("canvas");
    canvas.width = swap ? h : w;
    canvas.height = swap ? w : h;
    const ctx = canvas.getContext("2d");
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotationDeg * Math.PI) / 180);
    ctx.drawImage(sourceImg, -w / 2, -h / 2);
    img.src = canvas.toDataURL("image/jpeg", 0.92);
  }

  sourceImg.addEventListener("load", renderRotatedSource);

  rotateBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  rotateBtn.addEventListener("click", () => {
    rotationDeg = (rotationDeg + 90) % 360;
    renderRotatedSource(); // img's own "load" listener recenters pan/zoom
  });

  function applyTransform() {
    const scale = baseScale * zoom;
    img.style.width = `${naturalW * scale}px`;
    img.style.height = `${naturalH * scale}px`;
    img.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
  }

  function clampOffsets() {
    const scale = baseScale * zoom;
    const dispW = naturalW * scale;
    const dispH = naturalH * scale;
    offsetX = Math.min(0, Math.max(CROP_VIEWPORT_SIZE - dispW, offsetX));
    offsetY = Math.min(0, Math.max(CROP_VIEWPORT_SIZE - dispH, offsetY));
  }

  img.addEventListener("load", () => {
    naturalW = img.naturalWidth;
    naturalH = img.naturalHeight;
    baseScale = CROP_VIEWPORT_SIZE / Math.min(naturalW, naturalH);
    zoom = 1;
    zoomSlider.value = "1";
    offsetX = (CROP_VIEWPORT_SIZE - naturalW * baseScale) / 2;
    offsetY = (CROP_VIEWPORT_SIZE - naturalH * baseScale) / 2;
    clampOffsets();
    applyTransform();
  });

  zoomSlider.addEventListener("input", (e) => {
    zoom = Number(e.target.value);
    clampOffsets();
    applyTransform();
  });

  function onPan(e) {
    if (!panInfo) return;
    offsetX = panInfo.origX + (e.clientX - panInfo.startX);
    offsetY = panInfo.origY + (e.clientY - panInfo.startY);
    clampOffsets();
    applyTransform();
  }

  function onPanEnd() {
    panInfo = null;
    viewport.classList.remove("dragging");
    window.removeEventListener("pointermove", onPan);
    window.removeEventListener("pointerup", onPanEnd);
  }

  viewport.addEventListener("pointerdown", (e) => {
    panInfo = { startX: e.clientX, startY: e.clientY, origX: offsetX, origY: offsetY };
    viewport.classList.add("dragging");
    window.addEventListener("pointermove", onPan);
    window.addEventListener("pointerup", onPanEnd);
  });

  function onKeydown(e) {
    if (e.key === "Escape") cleanup();
  }
  document.addEventListener("keydown", onKeydown);

  function cleanup() {
    overlay.remove();
    URL.revokeObjectURL(objectUrl);
    document.removeEventListener("keydown", onKeydown);
    window.removeEventListener("pointermove", onPan);
    window.removeEventListener("pointerup", onPanEnd);
  }

  cancelBtn.addEventListener("click", cleanup);
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) cleanup();
  });

  useBtn.addEventListener("click", () => {
    useBtn.disabled = true;
    useBtn.textContent = "Uploading…";
    const scale = baseScale * zoom;
    const srcX = -offsetX / scale;
    const srcY = -offsetY / scale;
    const srcSize = CROP_VIEWPORT_SIZE / scale;
    const canvas = document.createElement("canvas");
    canvas.width = CROP_OUTPUT_SIZE;
    canvas.height = CROP_OUTPUT_SIZE;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, CROP_OUTPUT_SIZE, CROP_OUTPUT_SIZE);
    canvas.toBlob(
      async (blob) => {
        if (blob) await uploadCroppedPhoto(blob, pos);
        cleanup();
      },
      "image/jpeg",
      0.9
    );
  });
}

/**
 * Pull an 11-character YouTube video id out of a pasted link, in whatever
 * form the user gives it (watch?v=, youtu.be/, /embed/, /shorts/, or a bare
 * id already).
 * @param {string} input - Raw pasted text.
 * @returns {string|null} The video id, or null if none could be found.
 */
function extractYouTubeId(input) {
  const trimmed = (input || "").trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  const match = trimmed.match(
    /(?:youtube\.com\/watch\?(?:.*&)?v=|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  );
  return match ? match[1] : null;
}

/**
 * Prompt for a YouTube link and, if valid, add a music (YouTube player)
 * item to the open entry.
 * @param {{x: number, y: number}} pos - Target canvas position (%).
 */
function addMusicItem(pos) {
  const url = window.prompt("Paste a YouTube link to embed:");
  if (!url) return;
  const videoId = extractYouTubeId(url);
  if (!videoId) {
    alert("Couldn't find a YouTube video in that link.");
    return;
  }
  const item = {
    id: `youtube-${Date.now()}`,
    type: "youtube",
    x: pos.x,
    y: pos.y,
    rot: Math.round((Math.random() * 8 - 4) * 10) / 10,
    w: 260,
    videoId,
    volume: 100,
    repeat: false,
    color: WASHI_COLORS[Math.floor(Math.random() * WASHI_COLORS.length)],
    z: ++zCounter,
  };
  state.activeEntry.items.push(item);
  renderCanvas();
  scheduleSaveEntry();
}
el("add-music-btn").addEventListener("click", () => addMusicItem(getViewportCenterCanvasPos()));

// Opens the published read-only view (see renderReadOnlyView) in a new tab,
// so the current editing session stays untouched. Anyone with the link can
// view — but not edit — that entry.
el("publish-btn").addEventListener("click", () => {
  window.open(`/view/${state.activeEntry.id}`, "_blank");
});

// ---------- YouTube music player engine ----------

let ytApiPromise = null; // memoized promise so the <script> tag is only ever injected once

/**
 * Lazily inject the YouTube IFrame API script and resolve once it's ready.
 * Safe to call many times — every caller shares the same promise, and
 * plays nicely with a pre-existing window.onYouTubeIframeAPIReady if the
 * page ever defines its own.
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
 * Look up a video's title/artist/thumbnail via YouTube's public oEmbed
 * endpoint (no API key required). Falls back to a generic title and the
 * standard thumbnail CDN URL if the request fails, so callers never need to
 * handle a rejected promise.
 * @param {string} videoId
 * @returns {Promise<{title: string, artist: string, thumb: string}>}
 */
async function fetchYoutubeMeta(videoId) {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`
    )}&format=json`;
    const res = await fetch(oembedUrl);
    if (!res.ok) throw new Error("oEmbed request failed");
    const data = await res.json();
    return { title: data.title || "Untitled", artist: data.author_name || "", thumb: data.thumbnail_url || "" };
  } catch {
    return { title: "Untitled", artist: "", thumb: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` };
  }
}

/**
 * @param {number} sec - Duration in seconds (fractional or negative allowed).
 * @returns {string} "m:ss" display, e.g. 75 -> "1:15".
 */
function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const ytPlayers = new Map(); // item.id -> { player: YT.Player, progressTimer: intervalId|null }
const ytCardRefs = new Map(); // item.id -> dom refs for live updates (pill, title, art, progress bar, ...)

/**
 * Tear down a music item's YT.Player instance and stop its progress polling.
 * Safe to call for an id with no active player (no-op). Called when an item
 * is deleted or the canvas is reset (e.g. navigating away from the entry).
 * @param {string} id - Item id.
 */
function destroyYoutubePlayer(id) {
  const entry = ytPlayers.get(id);
  if (entry) {
    if (entry.progressTimer) clearInterval(entry.progressTimer);
    try {
      entry.player.destroy();
    } catch {
      /* player already gone */
    }
    ytPlayers.delete(id);
  }
  ytCardRefs.delete(id);
}

/**
 * Start (idempotently) a 500ms interval that refreshes a music item's
 * progress bar / elapsed-time display while it's playing.
 * @param {string} id - Item id.
 */
function startProgressPolling(id) {
  const entry = ytPlayers.get(id);
  if (!entry || entry.progressTimer) return;
  entry.progressTimer = setInterval(() => updateYoutubeProgress(id), 500);
  updateYoutubeProgress(id);
}

/**
 * Stop the progress-polling interval started by startProgressPolling, if any.
 * @param {string} id - Item id.
 */
function stopProgressPolling(id) {
  const entry = ytPlayers.get(id);
  if (!entry || !entry.progressTimer) return;
  clearInterval(entry.progressTimer);
  entry.progressTimer = null;
}

/**
 * Read the player's current time/duration and update that item's progress
 * bar fill and elapsed/duration text. Silently no-ops if the player isn't
 * ready yet (getCurrentTime/getDuration can throw before onReady fires).
 * @param {string} id - Item id.
 */
function updateYoutubeProgress(id) {
  const entry = ytPlayers.get(id);
  const refs = ytCardRefs.get(id);
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
 * YT.Player onStateChange handler: syncs the play/pause button and "Playing"/
 * "Paused"/"Ended" pill to the new state, starts or stops progress polling,
 * and — if the item has repeat enabled and the video just ended — seeks back
 * to 0 and replays it.
 * @param {string} id - Item id.
 * @param {number} stateVal - One of the window.YT.PlayerState.* constants.
 */
function onYoutubeStateChange(id, stateVal) {
  const YT = window.YT;
  const refs = ytCardRefs.get(id);
  const isPlaying = stateVal === YT.PlayerState.PLAYING;
  if (refs) {
    refs.playBtn.textContent = isPlaying ? "⏸" : "▶";
    refs.pill.textContent = isPlaying ? "Playing" : stateVal === YT.PlayerState.ENDED ? "Ended" : "Paused";
    refs.pill.classList.toggle("playing", isPlaying);
  }
  if (isPlaying) startProgressPolling(id);
  else stopProgressPolling(id);

  if (stateVal === YT.PlayerState.ENDED) {
    const item = getItem(id);
    const entry = ytPlayers.get(id);
    if (item && item.repeat && entry) {
      entry.player.seekTo(0, true);
      entry.player.playVideo();
    }
  }
}

/**
 * Create the actual YT.Player for a music item, mounted into its card's
 * tiny hidden `.yt-mount` element, and start it autoplaying at the item's
 * saved volume. No-ops if the item's DOM was removed (e.g. deleted) or a
 * player already exists for it (e.g. a duplicate call raced in) by the
 * time the async API load finishes.
 * @param {object} item - The youtube-type canvas item.
 * @returns {Promise<void>}
 */
async function initYoutubePlayer(item) {
  const YT = await loadYoutubeApi();
  if (!itemElCache.has(item.id) || ytPlayers.has(item.id)) return;
  const refs = ytCardRefs.get(item.id);
  if (!refs) return;
  const player = new YT.Player(refs.mount, {
    videoId: item.videoId,
    width: "2",
    height: "2",
    playerVars: { autoplay: 1, controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1 },
    events: {
      onReady: (e) => {
        e.target.setVolume(item.volume ?? 100);
        e.target.playVideo();
      },
      onStateChange: (e) => onYoutubeStateChange(item.id, e.data),
    },
  });
  ytPlayers.set(item.id, { player, progressTimer: null });
}

/**
 * Toggle a music item between playing and paused.
 * @param {string} id - Item id.
 */
function toggleYoutubePlay(id) {
  const entry = ytPlayers.get(id);
  if (!entry) return;
  const isPlaying = entry.player.getPlayerState() === window.YT.PlayerState.PLAYING;
  if (isPlaying) entry.player.pauseVideo();
  else entry.player.playVideo();
}

/**
 * Set a music item's playback volume, apply it live, and persist it.
 * @param {object} item - The youtube-type canvas item.
 * @param {number} volume - 0-100.
 */
function setYoutubeVolume(item, volume) {
  item.volume = volume;
  const entry = ytPlayers.get(item.id);
  if (entry) entry.player.setVolume(volume);
  scheduleSaveEntry();
}

/**
 * Flip a music item's repeat-on-end flag, update the repeat button's active
 * styling, and persist it.
 * @param {object} item - The youtube-type canvas item.
 * @param {HTMLElement} repeatBtn - The repeat toggle button to restyle.
 */
function toggleYoutubeRepeat(item, repeatBtn) {
  item.repeat = !item.repeat;
  repeatBtn.classList.toggle("active", item.repeat);
  scheduleSaveEntry();
}

/**
 * Seek a music item's playback forward or backward by a number of seconds,
 * clamped to not go negative.
 * @param {string} id - Item id.
 * @param {number} deltaSeconds - Positive to seek forward, negative to seek back.
 */
function seekYoutube(id, deltaSeconds) {
  const entry = ytPlayers.get(id);
  if (!entry) return;
  entry.player.seekTo(Math.max(0, entry.player.getCurrentTime() + deltaSeconds), true);
}

/**
 * Seek a music item's playback to a fraction of its total duration (used by
 * click-to-seek on the progress bar).
 * @param {string} id - Item id.
 * @param {number} ratio - 0 (start) to 1 (end).
 */
function seekYoutubeToRatio(id, ratio) {
  const entry = ytPlayers.get(id);
  if (!entry) return;
  const duration = entry.player.getDuration();
  if (duration) entry.player.seekTo(duration * ratio, true);
}

/**
 * Prompt for a replacement YouTube link, and if valid, swap the item's video
 * in place (same player instance, via loadVideoById) and refetch its
 * title/artist/thumbnail. Saves twice: immediately after the swap (so the
 * new video id isn't lost), and again once the fresh metadata arrives.
 * @param {object} item - The youtube-type canvas item.
 * @returns {Promise<void>}
 */
async function changeYoutubeSong(item) {
  const url = window.prompt("Paste a new YouTube link:");
  if (!url) return;
  const videoId = extractYouTubeId(url);
  if (!videoId) {
    alert("Couldn't find a YouTube video in that link.");
    return;
  }
  item.videoId = videoId;
  item.title = "";
  item.artist = "";
  item.thumb = "";
  const refs = ytCardRefs.get(item.id);
  if (refs) {
    refs.titleEl.textContent = "Loading…";
    refs.artistEl.textContent = "";
    refs.artImg.src = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
  }
  const playerEntry = ytPlayers.get(item.id);
  if (playerEntry) playerEntry.player.loadVideoById(videoId);
  scheduleSaveEntry();

  const meta = await fetchYoutubeMeta(videoId);
  Object.assign(item, meta);
  const freshRefs = ytCardRefs.get(item.id);
  if (freshRefs) {
    freshRefs.titleEl.textContent = item.title;
    freshRefs.artistEl.textContent = item.artist;
    if (item.thumb) freshRefs.artImg.src = item.thumb;
  }
  scheduleSaveEntry();
}

/**
 * @param {string} id - Item id.
 * @returns {object|undefined} The matching item from the open entry, or
 *   undefined if no such item exists (e.g. it was just deleted).
 */
function getItem(id) {
  return state.activeEntry.items.find((it) => it.id === id);
}

/**
 * Remove an item from the open entry, clear its selection if it was
 * selected, re-render, and save. (Any YouTube player/DOM cleanup for the
 * removed item happens inside renderCanvas's diffing pass, not here.)
 * @param {string} id - Item id.
 */
function deleteItem(id) {
  state.activeEntry.items = state.activeEntry.items.filter((it) => it.id !== id);
  state.selectedItemIds.delete(id);
  renderCanvas();
  scheduleSaveEntry();
}

/**
 * Raise an item above all others by giving it a fresh, higher z-index.
 * Only called from the right-click layering menu's "Bring to Front" — never
 * automatically on selection/drag, so stacking order stays exactly as the
 * user last set it.
 * @param {string} id - Item id.
 */
function bringToFront(id) {
  const item = getItem(id);
  item.z = ++zCounter;
}

// ---------- canvas rendering ----------
// Item DOM nodes are cached and updated in place (not rebuilt from scratch on
// every render) so a playing YouTube embed isn't torn down and restarted
// every time the canvas re-renders during a drag or selection change.

const itemElCache = new Map(); // item.id -> wrap element
const textElRefs = new Map(); // item.id -> the note/text-box editor or caption input element
const noteCardRefs = new Map(); // item.id -> the .note-card element (notes only)
const resizableElRefs = new Map(); // item.id -> the element item.h should be applied to (photo/text only)

/**
 * Tear down everything owned by the currently-open entry's canvas: destroy
 * any live YouTube players, clear the item DOM/ref caches, wipe the canvas
 * element, and close any open right-click menu. Called before loading a
 * different entry (or leaving to the list view) so nothing from the
 * previous entry lingers — including background audio.
 */
function resetCanvasState() {
  for (const id of [...ytPlayers.keys()]) destroyYoutubePlayer(id);
  itemElCache.clear();
  textElRefs.clear();
  noteCardRefs.clear();
  resizableElRefs.clear();
  const canvas = el("canvas");
  canvas.innerHTML = "";
  canvas.style.height = ""; // don't carry the previous entry's grown height over
  canvasScrollFloor = 0; // ...or how far it had been endless-scroll-extended
  closeContextMenu();
}

// ---------- canvas background ----------

const CANVAS_BG_PRESETS = ["#e9e2d0", "#1b2129", "#f3ebda", "#2e2216", "#dce8dc", "#e8d7e0"];

/**
 * Apply the open entry's saved canvas background (state.activeEntry.canvasBg)
 * to the canvas element. A custom color replaces the default paper texture
 * entirely (background-image: none); no color set reverts to the CSS
 * default (cream background + subtle radial-gradient texture).
 */
function applyCanvasBackground() {
  const canvas = el("canvas");
  const bg = state.activeEntry.canvasBg;
  canvas.style.backgroundColor = bg || "";
  canvas.style.backgroundImage = bg ? "none" : "";
}

/**
 * Set (or clear, with a falsy color) the open entry's canvas background,
 * apply it immediately, and save.
 * @param {string|null} color - A CSS color string, or null/undefined to
 *   reset to the default paper texture.
 */
function setCanvasBackground(color) {
  state.activeEntry.canvasBg = color || undefined;
  applyCanvasBackground();
  scheduleSaveEntry();
}

// ---------- right-click canvas menu ----------

let contextMenuEl = null; // the currently-open menu's DOM node, or null

/**
 * Close the right-click menu if one is open, and remove the document-level
 * listeners that were only needed while it was showing (outside-click and
 * Escape-to-close).
 */
function closeContextMenu() {
  if (!contextMenuEl) return;
  contextMenuEl.remove();
  contextMenuEl = null;
  document.removeEventListener("pointerdown", onDocPointerDownForMenu, true);
  document.removeEventListener("keydown", onDocKeydownForMenu);
}

/**
 * Document-level listener (capture phase) that closes the context menu when
 * a pointerdown lands outside of it.
 * @param {PointerEvent} e
 */
function onDocPointerDownForMenu(e) {
  if (contextMenuEl && !contextMenuEl.contains(e.target)) closeContextMenu();
}

/**
 * Document-level listener that closes the context menu on Escape.
 * @param {KeyboardEvent} e
 */
function onDocKeydownForMenu(e) {
  if (e.key === "Escape") closeContextMenu();
}

/**
 * Position an already-built (and already appended, so it has real
 * dimensions) context menu at a viewport point, nudged inward if it would
 * otherwise overflow the right or bottom edge of the window.
 * @param {HTMLElement} menu
 * @param {number} clientX - Viewport X to anchor at (typically the click).
 * @param {number} clientY - Viewport Y to anchor at.
 */
function positionContextMenu(menu, clientX, clientY) {
  const rect = menu.getBoundingClientRect();
  const left = Math.min(clientX, window.innerWidth - rect.width - 8);
  const top = Math.min(clientY, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

/**
 * Append a single clickable row to a context menu.
 * @param {HTMLElement} menu
 * @param {string} label - Row text (may include a leading emoji icon).
 * @param {() => void} onClick
 * @returns {HTMLButtonElement} The created button, in case the caller needs it.
 */
function addContextMenuItem(menu, label, onClick) {
  const btn = document.createElement("button");
  btn.className = "context-menu-item";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  menu.appendChild(btn);
  return btn;
}

/**
 * Render the context menu's top-level content (New note / New photo / Add
 * music / Canvas background) into an existing menu element. Each creation
 * action is placed at `pos` and closes the menu; "Canvas background"
 * instead swaps the menu's content to the background picker in place.
 * @param {HTMLElement} menu
 * @param {{x: number, y: number}} pos - Canvas position (%) the menu was
 *   opened at, used as the placement for anything created from it.
 */
function renderContextMenuMain(menu, pos) {
  menu.innerHTML = "";
  addContextMenuItem(menu, "📝  New note", () => {
    createNoteItem(pos);
    closeContextMenu();
  });
  addContextMenuItem(menu, "🖼️  New photo", () => {
    triggerPhotoPick(pos);
    closeContextMenu();
  });
  addContextMenuItem(menu, "🔤  New text box", () => {
    createTextItem(pos);
    closeContextMenu();
  });
  addContextMenuItem(menu, "🎵  Add music", () => {
    addMusicItem(pos);
    closeContextMenu();
  });

  const divider = document.createElement("div");
  divider.className = "context-menu-divider";
  menu.appendChild(divider);

  addContextMenuItem(menu, "🎨  Canvas background", () => renderContextMenuBackground(menu));
}

/**
 * Render the "Canvas background" sub-view into an existing menu element:
 * a row of preset color swatches, a native color input for any color, and a
 * reset-to-default action. Each control applies its color immediately on
 * pick and closes the menu (custom color input applies live as it changes,
 * without closing, so you can preview colors before moving on).
 * @param {HTMLElement} menu
 */
function renderContextMenuBackground(menu) {
  menu.innerHTML = "";

  const heading = document.createElement("div");
  heading.className = "context-menu-heading";
  heading.textContent = "Canvas background";
  menu.appendChild(heading);

  const swatchRow = document.createElement("div");
  swatchRow.className = "context-menu-swatch-row";
  CANVAS_BG_PRESETS.forEach((color) => {
    const swatch = document.createElement("button");
    swatch.className = "context-menu-swatch";
    swatch.style.background = color;
    swatch.title = color;
    swatch.addEventListener("click", () => {
      setCanvasBackground(color);
      closeContextMenu();
    });
    swatchRow.appendChild(swatch);
  });
  menu.appendChild(swatchRow);

  const customRow = document.createElement("div");
  customRow.className = "context-menu-item context-menu-custom-row";
  const customLabel = document.createElement("span");
  customLabel.textContent = "Custom:";
  const customInput = document.createElement("input");
  customInput.type = "color";
  customInput.value = state.activeEntry.canvasBg || "#e9e2d0";
  customInput.addEventListener("input", (e) => setCanvasBackground(e.target.value));
  customRow.append(customLabel, customInput);
  menu.appendChild(customRow);

  const divider = document.createElement("div");
  divider.className = "context-menu-divider";
  menu.appendChild(divider);

  addContextMenuItem(menu, "↺  Reset to default", () => {
    setCanvasBackground(null);
    closeContextMenu();
  });
}

/**
 * Open a right-click menu at a viewport point: closes any existing one
 * first, builds a fresh menu, hands it to `renderFn` to fill in, appends it
 * to the document, positions it, and (on a deferred tick, so the very
 * pointerdown/contextmenu event that opened it doesn't immediately close
 * it via onDocPointerDownForMenu) wires up outside-click and Escape to
 * close it. Shared by the canvas-background menu and the per-item
 * layering menu — they differ only in what they render.
 * @param {number} clientX - Viewport X to open at.
 * @param {number} clientY - Viewport Y to open at.
 * @param {(menu: HTMLElement) => void} renderFn - Fills the empty menu
 *   element with content (typically one of the renderContextMenu* functions).
 */
function showContextMenu(clientX, clientY, renderFn) {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu";
  renderFn(menu);
  document.body.appendChild(menu);
  positionContextMenu(menu, clientX, clientY);
  contextMenuEl = menu;
  setTimeout(() => {
    document.addEventListener("pointerdown", onDocPointerDownForMenu, true);
    document.addEventListener("keydown", onDocKeydownForMenu);
  }, 0);
}

/**
 * Open the right-click canvas menu (new note/photo/text/music + canvas
 * background) at a viewport point.
 * @param {number} clientX - Viewport X to open at.
 * @param {number} clientY - Viewport Y to open at.
 * @param {{x: number, y: number}} pos - Canvas position (%) corresponding
 *   to the click, passed through to whatever gets created from the menu.
 */
function openCanvasContextMenu(clientX, clientY, pos) {
  showContextMenu(clientX, clientY, (menu) => renderContextMenuMain(menu, pos));
}

el("canvas").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const rect = el("canvas").getBoundingClientRect();
  const x = Math.min(96, Math.max(4, ((e.clientX - rect.left) / rect.width) * 100));
  // y is % of the fixed CANVAS_UNIT_HEIGHT, not the canvas's live (possibly
  // grown) height — see its definition. No upper clamp, matching drag.
  const y = Math.max(2, ((e.clientY - rect.top) / CANVAS_UNIT_HEIGHT) * 100);
  openCanvasContextMenu(e.clientX, e.clientY, { x, y });
});

/**
 * Open the right-click layering menu (bring to front/forward, send
 * backward/to back) for a single canvas item at a viewport point.
 * @param {number} clientX - Viewport X to open at.
 * @param {number} clientY - Viewport Y to open at.
 * @param {object} item - The item that was right-clicked.
 */
function openItemContextMenu(clientX, clientY, item) {
  showContextMenu(clientX, clientY, (menu) => renderItemContextMenu(menu, item));
}

/**
 * Render the per-item right-click menu's content: the layering actions
 * (Bring to Front / Bring Forward / Send Backward / Send to Back), a
 * divider, then Delete. Each option applies its change (and, for the
 * layering ones, saves), then closes the menu.
 * @param {HTMLElement} menu
 * @param {object} item - The item the menu was opened for.
 */
function renderItemContextMenu(menu, item) {
  menu.innerHTML = "";
  addContextMenuItem(menu, "⬆️  Bring to Front", () => {
    bringToFront(item.id);
    renderCanvas();
    scheduleSaveEntry();
    closeContextMenu();
  });
  addContextMenuItem(menu, "🔼  Bring Forward", () => {
    bringItemForward(item);
    closeContextMenu();
  });
  addContextMenuItem(menu, "🔽  Send Backward", () => {
    sendItemBackward(item);
    closeContextMenu();
  });
  addContextMenuItem(menu, "⬇️  Send to Back", () => {
    sendItemToBack(item);
    closeContextMenu();
  });

  const divider = document.createElement("div");
  divider.className = "context-menu-divider";
  menu.appendChild(divider);

  addContextMenuItem(menu, "🗑️  Delete", () => {
    deleteItem(item.id);
    closeContextMenu();
  });
}

/**
 * Move an item one step back in stacking order by swapping z-index values
 * with whichever item is immediately below it (by current z). No-ops if
 * it's already the bottommost item.
 * @param {object} item - The item to move.
 */
function sendItemBackward(item) {
  const sorted = [...state.activeEntry.items].sort((a, b) => a.z - b.z);
  const idx = sorted.findIndex((it) => it.id === item.id);
  if (idx > 0) {
    const below = sorted[idx - 1];
    [item.z, below.z] = [below.z, item.z];
    renderCanvas();
    scheduleSaveEntry();
  }
}

/**
 * Move an item one step forward in stacking order by swapping z-index
 * values with whichever item is immediately above it (by current z).
 * No-ops if it's already the topmost item.
 * @param {object} item - The item to move.
 */
function bringItemForward(item) {
  const sorted = [...state.activeEntry.items].sort((a, b) => a.z - b.z);
  const idx = sorted.findIndex((it) => it.id === item.id);
  if (idx < sorted.length - 1) {
    const above = sorted[idx + 1];
    [item.z, above.z] = [above.z, item.z];
    renderCanvas();
    scheduleSaveEntry();
  }
}

/**
 * Send an item all the way to the back of the stacking order, below every
 * other item on the canvas.
 * @param {object} item - The item to move.
 */
function sendItemToBack(item) {
  const items = state.activeEntry.items;
  const minZ = Math.min(...items.map((it) => it.z));
  item.z = minZ - 1;
  renderCanvas();
  scheduleSaveEntry();
}

// A Range captured right before a color-picker click steals focus, so the
// text selection inside a note can be restored once a color is chosen.
let savedSelectionRange = null;

/**
 * Snapshot the current text selection inside a note editor (if any), so it
 * can be restored later after focus moves elsewhere (e.g. to a native color
 * picker input). Call this on pointerdown of a toolbar control, before the
 * click itself would steal focus and collapse the live selection.
 * @param {HTMLElement} editor - The note's contenteditable element.
 */
function saveSelectionRange(editor) {
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
    savedSelectionRange = sel.getRangeAt(0).cloneRange();
  }
}

/**
 * Re-apply the Range captured by saveSelectionRange as the active window
 * selection. No-ops if nothing was ever saved.
 */
function restoreSelectionRange() {
  if (!savedSelectionRange) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(savedSelectionRange);
}

/**
 * Apply a rich-text formatting command (e.g. "foreColor", "hiliteColor") to
 * a note's saved text selection via document.execCommand, then persist the
 * resulting HTML. Falls back from "hiliteColor" to "backColor" since
 * browser support for the former is inconsistent.
 * @param {object} item - The note-type canvas item.
 * @param {HTMLElement} editor - The note's contenteditable element.
 * @param {string} command - An execCommand command name.
 * @param {string} value - The command's value argument (e.g. a hex color).
 */
function execOnNoteSelection(item, editor, command, value) {
  editor.focus();
  restoreSelectionRange();
  let ok = document.execCommand(command, false, value);
  if (!ok && command === "hiliteColor") ok = document.execCommand("backColor", false, value);
  item.text = editor.innerHTML;
  item.richText = true;
  scheduleSaveEntry();
}

/**
 * Set the font size of a note's saved text selection, or (if nothing was
 * selected) the note's overall base size. execCommand("fontSize") only
 * accepts the legacy 1-7 scale, not arbitrary pixel values, so this applies
 * a throwaway size="7" marker to the selection and immediately swaps it for
 * a real inline pixel size — the standard workaround for arbitrary-size
 * rich text via execCommand.
 * @param {object} item - The note-type canvas item.
 * @param {HTMLElement} editor - The note's contenteditable element.
 * @param {number} sizePx - Font size in pixels.
 */
function applyNoteFontSize(item, editor, sizePx) {
  const hasSelection = savedSelectionRange && !savedSelectionRange.collapsed;
  if (!hasSelection) {
    item.fontSize = sizePx;
    applyTextStyle(item, editor);
    scheduleSaveEntry();
    return;
  }
  editor.focus();
  restoreSelectionRange();
  document.execCommand("fontSize", false, "7");
  editor.querySelectorAll('font[size="7"]').forEach((f) => {
    f.removeAttribute("size");
    f.style.fontSize = `${sizePx}px`;
  });
  item.text = editor.innerHTML;
  item.richText = true;
  scheduleSaveEntry();
}

/**
 * Set the font family of a note/text-box's saved text selection, or (if
 * nothing was selected) the item's overall base font — mirrors
 * applyNoteFontSize's selection-vs-whole-item fallback exactly. Unlike the
 * font-size hack, execCommand("fontName") accepts an arbitrary font-family
 * string directly, so no marker-and-swap trick is needed here.
 * @param {object} item - The note- or text-type canvas item.
 * @param {HTMLElement} editor - The item's contenteditable element.
 * @param {string} fontKey - A FONT_OPTIONS key, or the same key the item
 *   already has (to toggle back to the default when nothing is selected).
 */
function applyNoteFontFamily(item, editor, fontKey) {
  const hasSelection = savedSelectionRange && !savedSelectionRange.collapsed;
  if (!hasSelection) {
    item.font = item.font === fontKey ? undefined : fontKey;
    applyTextStyle(item, editor);
    scheduleSaveEntry();
    return;
  }
  editor.focus();
  restoreSelectionRange();
  document.execCommand("fontName", false, fontFamilyFor(fontKey));
  item.text = editor.innerHTML;
  item.richText = true;
  scheduleSaveEntry();
}

/**
 * Build a small "pick a color" control: a visible glyph button with a
 * colored underline bar (showing the last-picked color) that, on click,
 * opens a hidden native `<input type="color">`. Mirrors Word's font-color /
 * highlight-color tools: select text first, then click this to color just
 * that selection. The caller is responsible for saving the text selection
 * on the returned label's pointerdown (before the click opens the picker
 * and steals focus) — see createStyleBar for the usage pattern.
 * @param {object} opts
 * @param {string} opts.glyph - Icon/letter shown on the button (e.g. "A").
 * @param {string} opts.title - Tooltip text.
 * @param {string} opts.defaultColor - Initial swatch/input color.
 * @param {(color: string) => void} opts.onPick - Called with the new color
 *   whenever the user picks one.
 * @returns {HTMLElement} The assembled control (a wrapper div containing
 *   the label button and the hidden color input).
 */
function createSelectionColorButton({ glyph, title, defaultColor, onPick }) {
  const wrap = document.createElement("div");
  wrap.className = "style-color-btn";

  const label = document.createElement("button");
  label.type = "button";
  label.className = "style-color-btn-label";
  label.title = title;
  label.innerHTML = `<span class="style-color-btn-glyph">${glyph}</span><span class="style-color-btn-bar" style="background:${defaultColor}"></span>`;

  const input = document.createElement("input");
  input.type = "color";
  input.className = "style-color-btn-input";
  input.value = defaultColor;

  label.addEventListener("pointerdown", (e) => e.stopPropagation());
  input.addEventListener("pointerdown", (e) => e.stopPropagation());
  label.addEventListener("click", () => input.click());
  input.addEventListener("input", (e) => {
    label.querySelector(".style-color-btn-bar").style.background = e.target.value;
    onPick(e.target.value);
  });

  wrap.append(label, input);
  return wrap;
}

/**
 * Build the text-styling toolbar shown when a note, text box, or photo item
 * is selected: font-family buttons, a font-size field, and either (for
 * notes/text boxes) selection-based text-color + highlight buttons, or (for
 * photos) a single whole-caption color input — since a plain `<input>`
 * caption can't have per-character styling the way a contenteditable can.
 * @param {object} item - The note-, text-, or photo-type canvas item.
 * @param {string} defaultColor - Fallback color shown before anything's
 *   been picked (differs between notes/text boxes and photo captions).
 * @returns {HTMLElement} The assembled toolbar element.
 */
function createStyleBar(item, defaultColor) {
  const bar = document.createElement("div");
  bar.className = "item-style-bar";
  const isRichText = item.type === "note" || item.type === "text";
  const richEditor = isRichText ? textElRefs.get(item.id) : null;

  FONT_OPTIONS.forEach((opt) => {
    const btn = document.createElement("button");
    btn.className = "style-font-btn" + (item.font === opt.key ? " active" : "");
    btn.style.fontFamily = opt.family;
    btn.textContent = "Aa";
    btn.title = isRichText ? `${opt.key} (select text to font just that part)` : opt.key;
    btn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (richEditor) saveSelectionRange(richEditor);
    });
    btn.addEventListener("click", () => {
      if (isRichText && richEditor) {
        applyNoteFontFamily(item, richEditor, opt.key);
      } else {
        item.font = item.font === opt.key ? undefined : opt.key;
        const textEl = textElRefs.get(item.id);
        if (textEl) applyTextStyle(item, textEl);
        scheduleSaveEntry();
      }
      bar.querySelectorAll(".style-font-btn").forEach((b, i) => {
        b.classList.toggle("active", FONT_OPTIONS[i].key === item.font);
      });
    });
    bar.appendChild(btn);
  });

  const sizeInput = document.createElement("input");
  sizeInput.type = "number";
  sizeInput.className = "style-size-input";
  sizeInput.min = "8";
  sizeInput.max = "72";
  sizeInput.title = isRichText ? "Font size (select text to size just that part)" : "Font size";
  sizeInput.value = item.fontSize || (item.type === "photo" ? 18 : 14);

  if (isRichText) {
    const editor = textElRefs.get(item.id);
    sizeInput.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (editor) saveSelectionRange(editor);
    });
    // "change" (fires on blur/Enter), not "input" (per-keystroke) — applying
    // per keystroke would call editor.focus() while the user is still typing
    // digits into this field, stealing focus back mid-entry.
    sizeInput.addEventListener("change", (e) => {
      const val = Number(e.target.value);
      if (!val || !editor) return;
      applyNoteFontSize(item, editor, val);
    });
  } else {
    sizeInput.addEventListener("pointerdown", (e) => e.stopPropagation());
    sizeInput.addEventListener("input", (e) => {
      const val = Number(e.target.value);
      if (!val) return;
      item.fontSize = val;
      const textEl = textElRefs.get(item.id);
      if (textEl) applyTextStyle(item, textEl);
      scheduleSaveEntry();
    });
  }
  bar.appendChild(sizeInput);

  if (isRichText) {
    const editor = textElRefs.get(item.id);

    const textColorBtn = createSelectionColorButton({
      glyph: "A",
      title: "Color selected text",
      defaultColor: "#3a2c1a",
      onPick: (color) => execOnNoteSelection(item, editor, "foreColor", color),
    });
    const textColorLabel = textColorBtn.querySelector(".style-color-btn-label");
    textColorLabel.addEventListener("pointerdown", () => saveSelectionRange(editor));
    bar.appendChild(textColorBtn);

    const highlightBtn = createSelectionColorButton({
      glyph: "🪣",
      title: "Highlight selected text",
      defaultColor: "#fff59d",
      onPick: (color) => execOnNoteSelection(item, editor, "hiliteColor", color),
    });
    const highlightLabel = highlightBtn.querySelector(".style-color-btn-label");
    highlightLabel.addEventListener("pointerdown", () => saveSelectionRange(editor));
    bar.appendChild(highlightBtn);

    // A native <input type="color"> can't represent transparency (it's
    // opaque-only), so clearing a highlight back to "no color" needs its
    // own explicit action rather than being a pickable swatch.
    const clearHighlightBtn = document.createElement("button");
    clearHighlightBtn.type = "button";
    clearHighlightBtn.className = "style-clear-highlight-btn";
    clearHighlightBtn.title = "Clear highlight (see-through)";
    clearHighlightBtn.textContent = "🚫";
    clearHighlightBtn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      saveSelectionRange(editor);
    });
    clearHighlightBtn.addEventListener("click", () => execOnNoteSelection(item, editor, "hiliteColor", "transparent"));
    bar.appendChild(clearHighlightBtn);
  } else {
    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.className = "style-color-input";
    colorInput.value = item.textColor || defaultColor;
    colorInput.title = "Text color";
    colorInput.addEventListener("pointerdown", (e) => e.stopPropagation());
    colorInput.addEventListener("input", (e) => {
      item.textColor = e.target.value;
      const textEl = textElRefs.get(item.id);
      if (textEl) applyTextStyle(item, textEl);
      scheduleSaveEntry();
    });
    bar.appendChild(colorInput);
  }

  return bar;
}

const STICKY_COLORS = ["#fff59d", "#ffcc80", "#ff8a80", "#a5d6a7", "#90caf9", "#ce93d8"];

/**
 * Apply a note's background style (graph-paper default, or a solid
 * sticky-note color with a curled-corner look) to its card element by
 * toggling CSS classes and, for sticky notes, setting the inline background
 * color directly (since it's an arbitrary user-picked color, not a fixed
 * CSS class).
 * @param {object} item - The note-type canvas item.
 * @param {HTMLElement} card - That note's `.note-card` element.
 */
function applyNoteBackground(item, card) {
  const isSticky = item.noteStyle === "sticky";
  card.classList.toggle("note-style-sticky", isSticky);
  card.classList.toggle("note-style-paper", !isSticky);
  card.style.background = isSticky ? item.noteColor || STICKY_COLORS[0] : "";
}

/**
 * Build the background-style toolbar shown when a note is selected: a
 * toggle button that switches between graph-paper and sticky-note look,
 * and — only when sticky is active — a row of preset color swatches plus a
 * native color input for any color.
 * @param {object} item - The note-type canvas item.
 * @returns {HTMLElement} The assembled toolbar element.
 */
function createNoteBgBar(item) {
  const bar = document.createElement("div");
  bar.className = "item-note-bg-bar";

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "note-bg-toggle-btn";
  toggleBtn.textContent = item.noteStyle === "sticky" ? "🗒️" : "▦";
  toggleBtn.title = "Switch between graph paper and sticky note";
  toggleBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  toggleBtn.addEventListener("click", () => {
    item.noteStyle = item.noteStyle === "sticky" ? "paper" : "sticky";
    const card = noteCardRefs.get(item.id);
    if (card) applyNoteBackground(item, card);
    renderCanvas(); // rebuild the bar so the color swatches show/hide
    scheduleSaveEntry();
  });
  bar.appendChild(toggleBtn);

  if (item.noteStyle === "sticky") {
    STICKY_COLORS.forEach((color) => {
      const swatch = document.createElement("button");
      const isActive = (item.noteColor || STICKY_COLORS[0]) === color;
      swatch.className = "note-color-swatch" + (isActive ? " active" : "");
      swatch.style.background = color;
      swatch.addEventListener("pointerdown", (e) => e.stopPropagation());
      swatch.addEventListener("click", () => {
        item.noteColor = color;
        const card = noteCardRefs.get(item.id);
        if (card) applyNoteBackground(item, card);
        bar.querySelectorAll(".note-color-swatch").forEach((s) => s.classList.toggle("active", s === swatch));
        scheduleSaveEntry();
      });
      bar.appendChild(swatch);
    });

    const customInput = document.createElement("input");
    customInput.type = "color";
    customInput.className = "note-color-custom";
    customInput.value = item.noteColor || STICKY_COLORS[0];
    customInput.title = "Any color";
    customInput.addEventListener("pointerdown", (e) => e.stopPropagation());
    customInput.addEventListener("input", (e) => {
      item.noteColor = e.target.value;
      const card = noteCardRefs.get(item.id);
      if (card) applyNoteBackground(item, card);
      bar.querySelectorAll(".note-color-swatch").forEach((s) => s.classList.remove("active"));
      scheduleSaveEntry();
    });
    bar.appendChild(customInput);
  }

  return bar;
}

/**
 * Build the frame-style toolbar shown when a photo is selected: a single
 * toggle button that switches between the default polaroid frame (with
 * caption) and a bare, frameless image.
 * @param {object} item - The photo-type canvas item.
 * @returns {HTMLElement} The assembled toolbar element.
 */
function createPhotoFrameBar(item) {
  const bar = document.createElement("div");
  bar.className = "item-photo-frame-bar";

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "note-bg-toggle-btn";
  toggleBtn.textContent = item.frame === "none" ? "🖼️" : "▭";
  toggleBtn.title = item.frame === "none" ? "Add polaroid frame" : "Remove frame";
  toggleBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  toggleBtn.addEventListener("click", () => {
    item.frame = item.frame === "none" ? undefined : "none";
    // Switching frames changes this item's DOM shape (polaroid-card vs
    // bare <img>) enough that patching in place isn't worth it — drop its
    // cached wrap so renderCanvas rebuilds just this one item from scratch.
    forceRebuildItem(item.id);
    renderCanvas();
    scheduleSaveEntry();
  });
  bar.appendChild(toggleBtn);

  return bar;
}

/**
 * @param {string|undefined} key - A FONT_OPTIONS key ("handwritten"|"serif"|"mono").
 * @returns {string} The matching CSS font-family value, or "" (meaning
 *   "fall back to the element's stylesheet default") if key is unset/unknown.
 */
function fontFamilyFor(key) {
  const found = FONT_OPTIONS.find((f) => f.key === key);
  return found ? found.family : "";
}

/**
 * Apply an item's whole-element text styling (font family, base text color,
 * base font size) as inline styles. This is the "default"/fallback layer —
 * for notes, per-selection color/highlight/size (applied via execCommand)
 * take precedence over these on whatever text they cover.
 * @param {object} item - A note or photo item (reads item.font, .textColor, .fontSize).
 * @param {HTMLElement} textEl - The note's contenteditable, or the photo's caption input.
 */
function applyTextStyle(item, textEl) {
  textEl.style.fontFamily = fontFamilyFor(item.font);
  textEl.style.color = item.textColor || "";
  textEl.style.fontSize = item.fontSize ? `${item.fontSize}px` : "";
}

/**
 * @param {string} str - Plain text.
 * @returns {string} The same text with HTML special characters escaped, safe
 *   to set as innerHTML without it being interpreted as markup.
 */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Strip anything actively dangerous out of a note's stored HTML before it's
 * ever set via innerHTML: script/style/iframe/object/embed tags, inline
 * event-handler attributes (onclick etc.), and javascript: URLs. Notes store
 * rich HTML once edited (for per-selection color/highlight), and that HTML
 * only ever comes from our own execCommand calls or plain-text escaping —
 * but this is a defensive backstop against a hand-edited entry file.
 * @param {string} html
 * @returns {string} Sanitized HTML.
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

/**
 * Build a photo item's visual content. Two frame styles: the default
 * polaroid (paper card, editable caption below the image) or, when
 * item.frame === "none", the bare image with no card/caption at all.
 * Registers the `<img>` in resizableElRefs either way, so the resize handle
 * can stretch it (via item.h + object-fit: fill) regardless of frame style.
 * Called once per item (its result is cached by the caller in itemElCache)
 * — the caption's live value is kept in sync via its own input listener,
 * not by re-calling this.
 * @param {object} item - The photo-type canvas item.
 * @returns {HTMLElement} The `.polaroid` card element, or (frame "none")
 *   the bare `<img>` itself.
 */
function createPhotoCard(item) {
  const img = document.createElement("img");
  img.src = item.img;
  img.draggable = false;
  // updateItemWrap applies item.h (if any) to this ref right after creation.
  resizableElRefs.set(item.id, img);

  // "none" frame: the bare image is the whole card — no caption, no
  // polaroid paper/shadow/padding, just the photo sitting on the page.
  if (item.frame === "none") {
    img.className = "plain-photo-img";
    return img;
  }

  const card = document.createElement("div");
  card.className = "polaroid";
  const caption = document.createElement("input");
  caption.className = "caption-input";
  caption.placeholder = "caption...";
  caption.value = item.caption || "";
  caption.addEventListener("pointerdown", (e) => e.stopPropagation());
  caption.addEventListener("input", (e) => {
    item.caption = e.target.value;
    scheduleSaveEntry();
  });
  applyTextStyle(item, caption);
  textElRefs.set(item.id, caption);
  card.append(img, caption);
  return card;
}

/**
 * Build a note item's visual content: a contenteditable `.note-text` div
 * (rich text, so per-selection color/highlight/size can work) inside a
 * `.note-card` whose background reflects its paper/sticky style. Loads
 * item.text as sanitized HTML if it's already rich text, or escaped plain
 * text otherwise (covers notes created before rich text existed). Called
 * once per item — live edits are synced via the editor's own input listener.
 * @param {object} item - The note-type canvas item.
 * @returns {HTMLElement} The `.note-card` element.
 */
function createNoteCard(item) {
  const card = document.createElement("div");
  card.className = "note-card";
  applyNoteBackground(item, card);
  noteCardRefs.set(item.id, card);
  const editor = document.createElement("div");
  editor.className = "note-text";
  editor.contentEditable = "true";
  editor.spellcheck = false;
  editor.innerHTML = item.richText ? sanitizeHtml(item.text || "") : escapeHtml(item.text || "");
  editor.addEventListener("pointerdown", (e) => e.stopPropagation());
  editor.addEventListener("input", () => {
    item.text = editor.innerHTML;
    item.richText = true;
    scheduleSaveEntry();
  });
  applyTextStyle(item, editor);
  textElRefs.set(item.id, editor);
  card.appendChild(editor);
  return card;
}

/**
 * Build a text box item's visual content: just a contenteditable div with
 * no background, padding, or shadow — styled text floating directly on the
 * canvas. Shares its rich-text engine (font/size/selection color/highlight,
 * sanitize-on-load) entirely with createNoteCard; the only difference is the
 * lack of any card chrome around it. Also registers itself in
 * resizableElRefs so the resize handle can stretch its height.
 * @param {object} item - The text-type canvas item.
 * @returns {HTMLElement} The contenteditable `.text-box` element.
 */
function createTextBoxCard(item) {
  const editor = document.createElement("div");
  editor.className = "text-box";
  editor.contentEditable = "true";
  editor.spellcheck = false;
  editor.innerHTML = item.richText ? sanitizeHtml(item.text || "") : escapeHtml(item.text || "");
  // Unlike a note (where the textarea sits inside a padded card you can
  // grab separately) or a photo caption, this editor IS the item's entire
  // visible area — there's no other surface to click to select/drag it.
  // So, unlike those, its pointerdown must bubble up to the wrap's own
  // handler rather than being stopped here.
  editor.addEventListener("input", () => {
    item.text = editor.innerHTML;
    item.richText = true;
    scheduleSaveEntry();
  });
  applyTextStyle(item, editor);
  textElRefs.set(item.id, editor);
  resizableElRefs.set(item.id, editor);
  return editor;
}

/**
 * Build a music item's "Now Playing"-style card: status pill, album art +
 * title/artist + "change song" button, a click-to-seek progress bar,
 * transport controls (rewind/play-pause/forward/repeat), a volume slider,
 * and the tiny hidden mount point the actual YT.Player attaches to. Also
 * kicks off fetching title/artist/thumbnail (if not already known) and
 * starting the YT.Player itself. Called once per item — playback state
 * updates flow back in through the refs stashed in ytCardRefs, not by
 * re-calling this.
 * @param {object} item - The youtube-type canvas item.
 * @returns {HTMLElement} The `.yt-player-card` element.
 */
function createYoutubeCard(item) {
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
  titleEl.textContent = item.title || "Loading\u2026";
  const artistEl = document.createElement("div");
  artistEl.className = "yt-artist";
  artistEl.textContent = item.artist || "";
  info.append(titleEl, artistEl);

  const changeBtn = document.createElement("button");
  changeBtn.className = "yt-change-btn";
  changeBtn.title = "Choose a different song";
  changeBtn.textContent = "\u22ef";
  changeBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  changeBtn.addEventListener("click", () => changeYoutubeSong(item));

  main.append(art, info, changeBtn);

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
    seekYoutubeToRatio(item.id, Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
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
  rewindBtn.textContent = "\u23ea";
  rewindBtn.title = "Back 10s";
  rewindBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  rewindBtn.addEventListener("click", () => seekYoutube(item.id, -10));

  const playBtn = document.createElement("button");
  playBtn.className = "yt-ctrl-btn yt-play";
  playBtn.textContent = "\u25b6";
  playBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  playBtn.addEventListener("click", () => toggleYoutubePlay(item.id));

  const forwardBtn = document.createElement("button");
  forwardBtn.className = "yt-ctrl-btn";
  forwardBtn.textContent = "\u23e9";
  forwardBtn.title = "Forward 10s";
  forwardBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  forwardBtn.addEventListener("click", () => seekYoutube(item.id, 10));

  const repeatBtn = document.createElement("button");
  repeatBtn.className = "yt-ctrl-btn yt-repeat" + (item.repeat ? " active" : "");
  repeatBtn.textContent = "\u{1F501}";
  repeatBtn.title = "Repeat";
  repeatBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  repeatBtn.addEventListener("click", () => toggleYoutubeRepeat(item, repeatBtn));

  controls.append(rewindBtn, playBtn, forwardBtn, repeatBtn);

  const volumeRow = document.createElement("div");
  volumeRow.className = "yt-volume-row";
  const volumeIcon = document.createElement("span");
  volumeIcon.className = "yt-volume-icon";
  volumeIcon.textContent = "\u{1F50A}";
  const volumeSlider = document.createElement("input");
  volumeSlider.type = "range";
  volumeSlider.className = "yt-volume-slider";
  volumeSlider.min = "0";
  volumeSlider.max = "100";
  volumeSlider.value = String(item.volume ?? 100);
  volumeSlider.addEventListener("pointerdown", (e) => e.stopPropagation());
  volumeSlider.addEventListener("input", (e) => setYoutubeVolume(item, Number(e.target.value)));
  volumeRow.append(volumeIcon, volumeSlider);

  const mount = document.createElement("div");
  mount.className = "yt-mount";

  card.append(pill, main, progress, controls, volumeRow, mount);

  ytCardRefs.set(item.id, { pill, titleEl, artistEl, artImg, fill, elapsedEl, durationEl, playBtn, mount });

  if (!item.title) {
    fetchYoutubeMeta(item.videoId).then((meta) => {
      Object.assign(item, meta);
      const refs = ytCardRefs.get(item.id);
      if (!refs) return; // item/card was removed while the fetch was in flight
      refs.titleEl.textContent = item.title;
      refs.artistEl.textContent = item.artist;
      if (item.thumb) refs.artImg.src = item.thumb;
      scheduleSaveEntry();
    });
  }

  initYoutubePlayer(item);

  return card;
}

/**
 * Build the outer draggable/rotatable wrapper for a canvas item: the washi
 * tape strip (skipped for text boxes) plus whichever type-specific card
 * applies, plus its right-click layering menu (bring to front/forward,
 * send backward/to back). Called exactly once per item's lifetime
 * (renderCanvas only calls this for ids it hasn't seen before) — everything
 * after creation is handled by updateItemWrap, which mutates this same
 * node rather than rebuilding it.
 * @param {object} item - Any canvas item (photo, note, text, or youtube).
 * @returns {HTMLElement} The `.sb-item` wrapper element.
 */
function createItemWrap(item) {
  const wrap = document.createElement("div");
  wrap.className = "sb-item";
  wrap.dataset.id = item.id;
  wrap.addEventListener("pointerdown", (e) => {
    // A right-click's pointerdown fires before its contextmenu event — route
    // it to plain single-item selection (for visual feedback) instead of
    // startMove, so opening the layering menu doesn't itself silently bump
    // the item to the front and corrupt the z-order baseline the menu acts
    // on. Right-click always collapses to just this item, ignoring/clearing
    // any active multi-selection — the layering menu operates on one item.
    if (e.button === 2) {
      e.stopPropagation();
      state.selectedItemIds.clear();
      state.selectedItemIds.add(item.id);
      renderCanvas();
      return;
    }
    startMove(e, item);
  });
  // stopPropagation so this doesn't also bubble up to the canvas's own
  // contextmenu listener and open the "new note/photo/..." menu underneath.
  wrap.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openItemContextMenu(e.clientX, e.clientY, item);
  });

  // Text boxes are meant to float free on the page, not look taped down —
  // skip the washi tape strip that every other item type gets.
  if (item.type !== "text") {
    const washi = document.createElement("div");
    washi.className = "washi";
    washi.style.background = item.color;
    wrap.appendChild(washi);
  }

  const card =
    item.type === "photo"
      ? createPhotoCard(item)
      : item.type === "youtube"
      ? createYoutubeCard(item)
      : item.type === "text"
      ? createTextBoxCard(item)
      : createNoteCard(item);
  wrap.appendChild(card);

  return wrap;
}

/**
 * Sync an existing item wrapper's position/size/rotation/stacking to the
 * item's current data, and rebuild its selection-only chrome to match
 * whether it's currently selected: the full per-item toolbar (delete/
 * rotate/resize/style bars) when it's the sole selected item, or just an
 * outline (via the "multi-selected" class) when it's part of a larger
 * shift-click selection — see createStyleBar and startMove. Called on
 * every render for every item — cheap because it only touches inline
 * styles and a small set of overlay buttons, never the item's actual
 * content (photo/note/player), which is what keeps a playing YouTube embed
 * from restarting on unrelated canvas changes.
 * @param {object} item - Any canvas item.
 * @param {HTMLElement} wrap - That item's `.sb-item` wrapper (from createItemWrap).
 */
// Item types that support the resize (stretch) handle \u2014 a deliberately
// narrower set than every item type, since "note"/"youtube" cards have
// fixed-proportion internal layouts that a free-form stretch would break.
const RESIZABLE_TYPES = new Set(["photo", "text"]);

function updateItemWrap(item, wrap) {
  wrap.style.left = `${item.x}%`;
  // top is px, not %: item.y is a percentage of the FIXED CANVAS_UNIT_HEIGHT
  // (see its comment), not of the canvas's live height, so growing the
  // canvas never shifts existing items.
  wrap.style.top = `${(item.y / 100) * CANVAS_UNIT_HEIGHT}px`;
  wrap.style.width = `${item.w}px`;
  wrap.style.zIndex = item.z;
  wrap.style.transform = `translate(-50%, -50%) rotate(${item.rot}deg)`;

  const isSelected = state.selectedItemIds.has(item.id);
  // Multiple items selected at once (shift-click) get a plain outline and
  // can be dragged together, but skip the per-item toolbar — buttons like
  // delete/rotate/resize/style only make sense for a single item, and
  // showing them stacked across a whole group would be ambiguous. Narrow
  // the selection down to one item (a plain click) to get them back.
  const isSoleSelection = isSelected && state.selectedItemIds.size === 1;
  wrap.classList.toggle("multi-selected", isSelected && !isSoleSelection);

  const resizeTarget = resizableElRefs.get(item.id);
  if (resizeTarget) {
    resizeTarget.style.height = item.h ? `${item.h}px` : "";
    if (item.type === "photo") resizeTarget.style.objectFit = item.h ? "fill" : "";
    // Frameless items (text boxes, "none"-frame photos) have no card
    // background of their own, so show a dashed outline while selected —
    // otherwise their bounds would be invisible.
    if (item.type === "text" || item.frame === "none") {
      resizeTarget.classList.toggle("selected-outline", isSoleSelection);
    }
  }

  wrap.querySelectorAll(".item-btn, .item-style-bar, .item-note-bg-bar, .item-photo-frame-bar").forEach((n) => n.remove());
  if (isSoleSelection) {
    const delBtn = document.createElement("button");
    delBtn.className = "item-btn delete";
    delBtn.textContent = "\u2715";
    delBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    delBtn.addEventListener("click", () => deleteItem(item.id));
    wrap.appendChild(delBtn);

    // Photo/text items also get a resize handle at bottom-right, so their
    // rotate handle moves up to top-center to avoid the two overlapping.
    // Note/youtube cards keep rotate at its original bottom-right spot.
    const canResize = RESIZABLE_TYPES.has(item.type);
    const rotBtn = document.createElement("div");
    rotBtn.className = "item-btn rotate" + (canResize ? " top-center" : "");
    rotBtn.textContent = "\u27f2";
    rotBtn.addEventListener("pointerdown", (e) => startRotate(e, item));
    wrap.appendChild(rotBtn);

    if (canResize) {
      const resizeBtn = document.createElement("div");
      resizeBtn.className = "item-btn resize";
      resizeBtn.textContent = "\u2921";
      resizeBtn.title = "Drag to resize";
      resizeBtn.addEventListener("pointerdown", (e) => startResize(e, item));
      wrap.appendChild(resizeBtn);
    }

    if (item.type === "note") {
      wrap.appendChild(createStyleBar(item, "#3a2c1a"));
      wrap.appendChild(createNoteBgBar(item));
    } else if (item.type === "text") {
      wrap.appendChild(createStyleBar(item, "#3a2c1a"));
    } else if (item.type === "photo") {
      if (item.frame !== "none") wrap.appendChild(createStyleBar(item, "#4a3826"));
      wrap.appendChild(createPhotoFrameBar(item));
    }
  }
}

/**
 * Force a single item to be rebuilt from scratch on the next renderCanvas()
 * call, by evicting its cached wrap (and removing it from the DOM directly,
 * since renderCanvas's own cleanup pass only removes wraps for items no
 * longer in the entry at all — not ones still present but needing a
 * rebuild) and its associated refs. Use sparingly: only when an item's DOM
 * shape itself needs to change (e.g. toggling a photo's polaroid/frameless
 * style), not for ordinary data updates, which updateItemWrap already
 * patches in place far more cheaply.
 * @param {string} id - Item id.
 */
function forceRebuildItem(id) {
  const wrap = itemElCache.get(id);
  if (wrap) wrap.remove();
  itemElCache.delete(id);
  textElRefs.delete(id);
  noteCardRefs.delete(id);
  resizableElRefs.delete(id);
  destroyYoutubePlayer(id);
}

/**
 * The canvas's main render/diff pass: removes DOM (and cache entries, and
 * any YouTube player) for items no longer in state.activeEntry.items,
 * creates wrappers for any brand-new items, updates every remaining item in
 * place, then grows/shrinks the canvas to fit (growCanvasToFitContent).
 * Call this after any mutation to the item list, positions, selection, or
 * rotation. Deliberately never rebuilds an existing item's DOM subtree
 * wholesale — see the comment inside on why that matters for embedded
 * YouTube players.
 */
function renderCanvas() {
  const canvas = el("canvas");
  const items = state.activeEntry.items || [];
  el("canvas-empty").hidden = items.length !== 0;

  const currentIds = new Set(items.map((it) => it.id));
  for (const id of [...itemElCache.keys()]) {
    if (!currentIds.has(id)) {
      itemElCache.get(id).remove();
      itemElCache.delete(id);
      textElRefs.delete(id);
      noteCardRefs.delete(id);
      resizableElRefs.delete(id);
      destroyYoutubePlayer(id);
    }
  }

  for (const item of items) {
    let wrap = itemElCache.get(item.id);
    if (!wrap) {
      wrap = createItemWrap(item);
      itemElCache.set(item.id, wrap);
      // Only append brand-new nodes. Re-appending an existing child (even to
      // the same parent) detaches and reinserts it, which forces any nested
      // <iframe> — like the YouTube player — to unload and reload. Stacking
      // order is handled by z-index, so DOM sibling order doesn't matter.
      canvas.appendChild(wrap);
    }
    updateItemWrap(item, wrap);
  }

  growCanvasToFitContent(items);
}

// How far past the lowest item's bottom edge the canvas always extends
// (content-driven floor — see growCanvasToFitContent).
const CANVAS_CONTENT_PADDING = 150;
// How big a chunk to add when the user scrolls near the current bottom
// (scroll-driven floor — see extendCanvasForEndlessScroll), and how close
// to that bottom (in px) triggers adding another chunk.
const CANVAS_SCROLL_CHUNK = 1200;
const CANVAS_SCROLL_THRESHOLD = 600;

// The tallest the canvas has been extended to purely by the user scrolling
// near its bottom (not by content) — an endless-scroll floor layered on top
// of the content-fit height, so there's always room to scroll into (and
// drop new items onto) even where nothing has been placed yet. Reset
// per-entry in resetCanvasState, since it's exploration state, not data.
let canvasScrollFloor = 0;

/**
 * Set the canvas's actual height to the larger of (a) enough to fit its
 * lowest item plus padding — falling back to CANVAS_UNIT_HEIGHT when the
 * entry is empty or everything on it is near the top — and (b) however far
 * the user has already scroll-extended it (canvasScrollFloor). Runs after
 * every render (including every pointermove of a drag), so the canvas
 * grows live as an item is dragged toward its bottom edge and shrinks back
 * down toward the content-fit floor if items are moved back up or deleted
 * — but never below whatever the user has scrolled into, which is what
 * makes the page feel endless rather than snapping shut under them. Must
 * run after updateItemWrap so wrap.offsetHeight reflects this render's
 * sizes, not stale ones from before.
 * @param {object[]} items - The open entry's items (already fetched by the caller).
 */
function growCanvasToFitContent(items) {
  const canvas = el("canvas");
  let maxBottom = CANVAS_UNIT_HEIGHT;
  for (const item of items) {
    const wrap = itemElCache.get(item.id);
    const heightPx = wrap ? wrap.offsetHeight : 150;
    // wrap's own top is its vertical CENTER (translate(-50%, -50%)), so its
    // bottom edge is roughly half its height below that — approximate for
    // rotated items, but close enough to decide how much room to leave.
    const bottom = (item.y / 100) * CANVAS_UNIT_HEIGHT + heightPx / 2;
    if (bottom > maxBottom) maxBottom = bottom;
  }
  const contentHeight = maxBottom + CANVAS_CONTENT_PADDING;
  // Always keep at least a viewport's worth of extra room below the fold,
  // so the page is scrollable — and extendCanvasForEndlessScroll can ever
  // fire — even for a near-empty entry. Otherwise there's a chicken-and-egg
  // problem: nothing to scroll into until something's already been dragged
  // far enough down to force an overflow.
  const viewportFloor = window.innerHeight + 400;
  canvas.style.height = `${Math.max(contentHeight, canvasScrollFloor, viewportFloor)}px`;
}

/**
 * Endless-scroll driver: when the user scrolls within CANVAS_SCROLL_THRESHOLD
 * px of the canvas's current bottom edge, push canvasScrollFloor out by
 * another CANVAS_SCROLL_CHUNK and re-apply it, so the page never presents a
 * hard bottom to scroll into — more (empty) canvas is always just ahead.
 * No-ops outside the entry view. Cheap enough (a boundingClientRect read
 * plus, usually, nothing else) to run unthrottled on every scroll event.
 */
function extendCanvasForEndlessScroll() {
  if (state.view !== "entry" || !state.activeEntry) return;
  const canvas = el("canvas");
  const rect = canvas.getBoundingClientRect();
  const distanceToBottom = rect.bottom - window.innerHeight;
  if (distanceToBottom > CANVAS_SCROLL_THRESHOLD) return;
  canvasScrollFloor = Math.max(canvasScrollFloor, canvas.offsetHeight) + CANVAS_SCROLL_CHUNK;
  canvas.style.height = `${canvasScrollFloor}px`;
}
window.addEventListener("scroll", extendCanvasForEndlessScroll);

el("canvas").addEventListener("pointerdown", (e) => {
  if (e.target.id === "canvas") {
    state.selectedItemIds.clear();
    renderCanvas();
  }
});

/**
 * Begin dragging an item — or shift-click to add/remove it from a
 * multi-selection instead. Deliberately does NOT change z-index — stacking
 * order is only ever changed via the right-click layering menu, so merely
 * selecting or moving an item (or a whole group of them) never silently
 * reorders it. Registers window-level pointermove/up listeners (rather
 * than element-level) so the drag continues even if the pointer moves off
 * the item or the canvas mid-drag.
 * @param {PointerEvent} e - The pointerdown that started the drag.
 * @param {object} item - The item that was pointed down on.
 */
function startMove(e, item) {
  e.stopPropagation();

  if (e.shiftKey) {
    // Shift-click only ever toggles membership — it never itself starts a
    // drag, so building up a selection doesn't accidentally nudge anything.
    if (state.selectedItemIds.has(item.id)) state.selectedItemIds.delete(item.id);
    else state.selectedItemIds.add(item.id);
    renderCanvas();
    return;
  }

  // A plain click on an item already inside an active multi-selection keeps
  // the whole group selected (so it can be dragged together); clicking
  // anything else collapses the selection down to just that item.
  if (!state.selectedItemIds.has(item.id)) {
    state.selectedItemIds.clear();
    state.selectedItemIds.add(item.id);
  }
  renderCanvas();

  const canvasRect = el("canvas").getBoundingClientRect();
  // Snapshot every selected item's starting position (not just the one the
  // drag started on) so the same pointer delta can be applied to all of
  // them in onPointerMove — that's what keeps their relative positions
  // (their displacement from each other) unchanged while the group moves.
  const groupItems = [...state.selectedItemIds].map((id) => {
    const it = getItem(id);
    return { id, origX: it.x, origY: it.y };
  });
  dragInfo = {
    mode: "move",
    startX: e.clientX,
    startY: e.clientY,
    canvasW: canvasRect.width,
    items: groupItems,
  };
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
}

/**
 * Begin rotating an item via its rotate handle: records the item's center
 * in viewport coordinates (so onPointerMove can compute an angle from it)
 * and starts tracking pointer movement.
 * @param {PointerEvent} e - The pointerdown on the rotate handle.
 * @param {object} item - The item being rotated.
 */
function startRotate(e, item) {
  e.stopPropagation();
  const canvasRect = el("canvas").getBoundingClientRect();
  const cx = canvasRect.left + (item.x / 100) * canvasRect.width;
  // item.y is % of CANVAS_UNIT_HEIGHT (a fixed constant), not of the
  // canvas's live height — see updateItemWrap.
  const cy = canvasRect.top + (item.y / 100) * CANVAS_UNIT_HEIGHT;
  dragInfo = { id: item.id, mode: "rotate", cx, cy };
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
}

/**
 * Begin resizing (stretching) an item via its resize handle: records the
 * item's current on-screen width/height as the drag baseline. Height is
 * read off the item's actual resizable content element — the image for a
 * photo (not the whole polaroid card, which also includes the caption strip
 * and padding), or the editor div for a text box — via offsetHeight (which
 * ignores the wrap's rotation transform), rather than item.h directly,
 * since item.h starts undefined (natural/auto height) until the first resize.
 * @param {PointerEvent} e - The pointerdown on the resize handle.
 * @param {object} item - The item being resized (photo or text box).
 */
function startResize(e, item) {
  e.stopPropagation();
  const contentEl = resizableElRefs.get(item.id);
  dragInfo = {
    id: item.id,
    mode: "resize",
    startX: e.clientX,
    startY: e.clientY,
    origW: item.w,
    origH: item.h || (contentEl ? contentEl.offsetHeight : 150),
  };
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
}

/**
 * Window-level pointermove handler active during a drag, rotate, or resize
 * (started by startMove/startRotate/startResize): updates the item's (or,
 * for a group move, every selected item's) x/y, rotation angle, or width/
 * height, then re-renders. No-ops if no drag is in progress. x is a percent
 * of the canvas's live width, clamped to keep it from being dragged fully
 * off-canvas horizontally; y is a percent of the fixed CANVAS_UNIT_HEIGHT
 * with no upper clamp, since the canvas grows (via growCanvasToFitContent,
 * called from renderCanvas) to fit however far down an item gets dragged —
 * there's no horizontal equivalent since the canvas's width doesn't grow.
 * A group move applies the exact same dx/dy to every selected item's own
 * starting position, which is what keeps their relative positions
 * unchanged as a whole. Rotate and resize only ever act on a single item.
 * Resize deltas are applied directly in screen-space pixels without
 * compensating for the item's rotation — noticeable only at large rotation
 * angles, which this app's items rarely have.
 * @param {PointerEvent} e
 */
function onPointerMove(e) {
  if (!dragInfo) return;
  if (dragInfo.mode === "move") {
    const dx = ((e.clientX - dragInfo.startX) / dragInfo.canvasW) * 100;
    const dy = ((e.clientY - dragInfo.startY) / CANVAS_UNIT_HEIGHT) * 100;
    for (const entry of dragInfo.items) {
      const it = getItem(entry.id);
      if (!it) continue;
      it.x = Math.min(96, Math.max(4, entry.origX + dx));
      it.y = Math.max(2, entry.origY + dy);
    }
  } else {
    const item = getItem(dragInfo.id);
    if (!item) return;
    if (dragInfo.mode === "rotate") {
      const angle = (Math.atan2(e.clientY - dragInfo.cy, e.clientX - dragInfo.cx) * 180) / Math.PI;
      item.rot = Math.round(angle + 90);
    } else if (dragInfo.mode === "resize") {
      item.w = Math.max(60, Math.round(dragInfo.origW + (e.clientX - dragInfo.startX)));
      item.h = Math.max(30, Math.round(dragInfo.origH + (e.clientY - dragInfo.startY)));
    }
  }
  renderCanvas();
}

/**
 * Window-level pointerup handler that ends a drag/rotate started by
 * startMove/startRotate: clears the drag state, removes the window
 * listeners, and saves the item's new position/rotation.
 */
function onPointerUp() {
  dragInfo = null;
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  scheduleSaveEntry();
}

// ---------- style lab ----------

/**
 * Load the site-wide custom CSS from the server into state and the Style
 * Lab textarea, and apply it. Called once on boot.
 * @returns {Promise<void>}
 */
async function loadCss() {
  const res = await fetch("/api/style");
  state.customCss = await res.text();
  el("css-textarea").value = state.customCss;
  applyCss();
}

/**
 * Push state.customCss into the page's live `<style id="custom-style">` tag,
 * so edits in the Style Lab take effect immediately across every view.
 */
function applyCss() {
  el("custom-style").textContent = state.customCss;
}

/**
 * Debounced autosave for the custom CSS, mirroring scheduleSaveEntry's
 * pattern: waits 500ms after the last call before PUTting state.customCss
 * to the server, so rapid typing collapses into one request.
 */
function scheduleSaveCss() {
  setSaveIndicator("saving\u2026");
  clearTimeout(saveCssTimer);
  saveCssTimer = setTimeout(async () => {
    await fetch("/api/style", {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: state.customCss,
    });
    setSaveIndicator("saved");
  }, 500);
}

el("css-textarea").addEventListener("input", (e) => {
  state.customCss = e.target.value;
  applyCss();
  scheduleSaveCss();
});

/**
 * Rebuild the Style Lab's preset buttons row from the PRESETS list, plus a
 * "clear" button. Clicking a preset appends its CSS snippet to whatever
 * custom CSS already exists (rather than replacing it), so multiple presets
 * can be combined.
 */
function renderPresets() {
  const row = el("preset-row");
  row.innerHTML = "";
  for (const preset of PRESETS) {
    const btn = document.createElement("button");
    btn.className = "preset-btn";
    btn.textContent = `+ ${preset.name}`;
    btn.addEventListener("click", () => {
      state.customCss = state.customCss ? `${state.customCss}\n\n${preset.css}` : preset.css;
      el("css-textarea").value = state.customCss;
      applyCss();
      scheduleSaveCss();
    });
    row.appendChild(btn);
  }
  const clear = document.createElement("button");
  clear.className = "clear-btn";
  clear.textContent = "clear";
  clear.addEventListener("click", () => {
    state.customCss = "";
    el("css-textarea").value = "";
    applyCss();
    scheduleSaveCss();
  });
  row.appendChild(clear);
}

/**
 * Rebuild the Style Lab's "available hooks" cheat-sheet list from
 * CHEAT_SHEET, showing each themable CSS selector alongside a plain-English
 * description of what it controls.
 */
function renderHooks() {
  const list = el("hooks-list");
  list.innerHTML = "";
  for (const [sel, desc] of CHEAT_SHEET) {
    const item = document.createElement("div");
    item.className = "hook-item";
    const selEl = document.createElement("div");
    selEl.className = "sel";
    selEl.textContent = sel;
    const descEl = document.createElement("div");
    descEl.className = "desc";
    descEl.textContent = desc;
    item.append(selEl, descEl);
    list.appendChild(item);
  }
}

// ---------- published read-only view ----------
// A separate, minimal, non-interactive renderer for the /view/<id> route.
// Deliberately does NOT reuse the interactive createItemWrap/updateItemWrap
// pipeline — that machinery is built around drag/rotate/resize/selection/
// autosave, and retrofitting a "read-only" flag onto every one of those
// paths would risk missing one and leaving something editable on a page
// that's supposed to be strictly view-only. It does reuse the handful of
// pure, side-effect-free helpers (applyTextStyle, applyNoteBackground,
// sanitizeHtml/escapeHtml) that just compute styles/markup from item data
// without attaching any listeners or touching the server, so formatting
// (fonts, colors, highlights, sticky/paper backgrounds, frames) still
// matches the editor exactly.

/**
 * Load and render the published read-only view for one entry into
 * #view-readonly. Shows a "not found" message instead if the entry doesn't
 * exist (e.g. a stale or mistyped link).
 * @param {string} id - Entry id from the /view/<id> URL.
 * @returns {Promise<void>}
 */
async function initReadOnlyView(id) {
  showView("readonly");
  const res = await fetch(`/api/entries/${id}`);
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
 * Build the read-only canvas: every item rendered statically (no drag,
 * selection, editing, or per-item controls of any kind), sized to fit
 * exactly as far down as the content goes. Unlike the editor's
 * growCanvasToFitContent, there's no endless-scroll buffer added here —
 * the published page's scroll distance is capped to its actual content.
 * @param {object} entry - Full entry record (title, date, items, canvasBg).
 */
function renderReadOnlyCanvas(entry) {
  const canvas = el("readonly-canvas");
  canvas.innerHTML = "";
  canvas.style.backgroundColor = entry.canvasBg || "";
  canvas.style.backgroundImage = entry.canvasBg ? "none" : "";

  let maxBottom = CANVAS_UNIT_HEIGHT;
  for (const item of entry.items || []) {
    const wrap = document.createElement("div");
    // "readonly-item" overrides the interactive canvas's cursor:grab and
    // user-select:none (needed there to make dragging feel natural) — a
    // viewer should be able to select/copy text, not think it's draggable.
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

    // Measure after appending so offsetHeight reflects real layout.
    const heightPx = card.offsetHeight || 150;
    const bottom = (item.y / 100) * CANVAS_UNIT_HEIGHT + heightPx / 2;
    if (bottom > maxBottom) maxBottom = bottom;
  }

  canvas.style.height = `${maxBottom + CANVAS_CONTENT_PADDING}px`;
}

/**
 * @param {object} item - Any canvas item.
 * @returns {HTMLElement} A static, non-interactive visual for that item.
 */
function createReadOnlyCard(item) {
  if (item.type === "photo") return createReadOnlyPhotoCard(item);
  if (item.type === "youtube") return createReadOnlyYoutubeCard(item);
  if (item.type === "text") return createReadOnlyTextCard(item);
  return createReadOnlyNoteCard(item);
}

/** @param {object} item - The photo-type item. @returns {HTMLElement} */
function createReadOnlyPhotoCard(item) {
  const img = document.createElement("img");
  img.src = item.img;
  img.draggable = false;
  if (item.h) {
    img.style.height = `${item.h}px`;
    img.style.objectFit = "fill";
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

/** @param {object} item - The note-type item. @returns {HTMLElement} */
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

/** @param {object} item - The text-type item. @returns {HTMLElement} */
function createReadOnlyTextCard(item) {
  const textDiv = document.createElement("div");
  textDiv.className = "text-box";
  textDiv.innerHTML = item.richText ? sanitizeHtml(item.text || "") : escapeHtml(item.text || "");
  applyTextStyle(item, textDiv);
  return textDiv;
}

/**
 * @param {object} item - The youtube-type item.
 * @returns {HTMLElement} A card with album art/title/artist plus a plain
 *   YouTube embed using YouTube's own native controls — not this app's
 *   custom player (which is wired to autosave volume/repeat changes back
 *   to the entry, which a read-only page must never do).
 */
function createReadOnlyYoutubeCard(item) {
  const card = document.createElement("div");
  card.className = "yt-player-card";

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

  // Autoplay is attempted but browsers typically block it without a user
  // gesture — the native YouTube controls let the viewer press play themselves.
  const frame = document.createElement("iframe");
  frame.className = "yt-readonly-frame";
  frame.src = `https://www.youtube.com/embed/${item.videoId}?rel=0&autoplay=1`;
  frame.title = item.title || "YouTube video";
  frame.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
  frame.allowFullscreen = true;

  card.append(main, frame);
  return card;
}

// ---------- boot ----------

// Entry point, run immediately on script load. /view/<id> is the published
// read-only route — it skips the normal editing-app boot entirely (no
// entries list, no Style Lab CSS) and renders straight into that one
// entry's static view. Otherwise, render the Style Lab's static content
// (it doesn't depend on any fetched data), then load the entries list and
// custom CSS in parallel before showing the normal app.
(async function init() {
  const readOnlyMatch = location.pathname.match(/^\/view\/([^/]+)$/);
  if (readOnlyMatch) {
    await initReadOnlyView(decodeURIComponent(readOnlyMatch[1]));
    return;
  }
  renderPresets();
  renderHooks();
  await Promise.all([loadEntries(), loadCss()]);
  showView("list");
})();
