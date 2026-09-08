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

// A "bangarang" item flickers between two uploaded images forever, at a
// speed the delay slider on its bar controls — floor keeps setInterval from
// spinning absurdly fast, ceiling is the "max 1 second" the feature asks for.
const BANGARANG_MIN_DELAY = 30;
const BANGARANG_MAX_DELAY = 1000;
const BANGARANG_DEFAULT_DELAY = 150;

/**
 * @param {number} ms
 * @returns {number} `ms` clamped to [BANGARANG_MIN_DELAY, BANGARANG_MAX_DELAY],
 *   falling back to BANGARANG_DEFAULT_DELAY for anything not a positive number
 *   (e.g. a hand-edited or missing entry.json field).
 */
function clampBangarangDelay(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return BANGARANG_DEFAULT_DELAY;
  return Math.min(BANGARANG_MAX_DELAY, Math.max(BANGARANG_MIN_DELAY, n));
}

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
  [".bangarang-frame", "the box around a bangarang's two images"],
  [".bangarang-img", "each of a bangarang's two stacked images"],
];

// ---------- password protection: crypto ----------
// A password-protected entry's `items`/`canvasBg`/`canvasBgImage` are never
// written to disk in plaintext: instead entry.enc holds them AES-GCM
// encrypted with a key derived from the password via PBKDF2, and entry.locked
// is just a display flag. This has to work with no server involved at all —
// the static GitHub Pages export (see scripts/static-site/static.js, which
// mirrors this section) has none — so it's built entirely on the browser's
// native SubtleCrypto rather than a server-side check. A wrong password isn't
// verified separately: AES-GCM's built-in authentication tag makes decrypt()
// itself throw, and that failure *is* the "wrong password" signal.
const PBKDF2_ITERATIONS = 200000;

/** @param {ArrayBuffer|Uint8Array} bytes @returns {string} base64 */
function bytesToBase64(bytes) {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary);
}

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
 * Encrypt a locked entry's protected fields, ready to store as entry.enc.
 * @param {string} password
 * @param {object} payload - `{items, canvasBg, canvasBgImage}`, with any
 *   photo URLs already made portable (see absoluteImgToPortable) so the
 *   ciphertext doesn't hardcode which host/context it's decrypted in.
 * @returns {Promise<{v: number, salt: string, iv: string, data: string}>}
 */
async function encryptEntryPayload(password, payload) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveEntryKey(password, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { v: 1, salt: bytesToBase64(salt), iv: bytesToBase64(iv), data: bytesToBase64(cipher) };
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
 * A photo item's/canvasBgImage's URL is stored as an absolute,
 * server-rooted path (/entries/<id>/uploads/<file>) everywhere else in this
 * app, but that's meaningless once decrypted somewhere with no server (the
 * static export) — so encrypted payloads store just the entry-relative
 * `uploads/<file>` tail instead, and each context re-prefixes it however it
 * needs to at render time (see portableImgToAbsolute here, and
 * portableImgToRelative in static.js).
 * @param {string} url
 * @returns {string}
 */
function absoluteImgToPortable(url) {
  return `uploads/${url.split("/uploads/").pop()}`;
}

/**
 * @param {string} entryId
 * @param {string} portable - As produced by absoluteImgToPortable.
 * @returns {string} The absolute, server-rooted URL this app renders elsewhere.
 */
function portableImgToAbsolute(entryId, portable) {
  return `/entries/${entryId}/${portable}`;
}

/**
 * Apply absoluteImgToPortable to whichever image URL field(s) an item
 * actually has (a photo's `img`, or a bangarang's `img1`/`img2`) — used when
 * building a protected entry's payload to encrypt.
 * @param {object} item
 * @returns {object}
 */
function itemImagesToPortable(item) {
  if (item.type === "photo" && item.img) return { ...item, img: absoluteImgToPortable(item.img) };
  if (item.type === "bangarang") return { ...item, img1: absoluteImgToPortable(item.img1), img2: absoluteImgToPortable(item.img2) };
  return item;
}

/**
 * The reverse of itemImagesToPortable, run on a just-decrypted payload.
 * @param {string} entryId
 * @param {object} item
 * @returns {object}
 */
function itemImagesToAbsolute(entryId, item) {
  if (item.type === "photo" && item.img) return { ...item, img: portableImgToAbsolute(entryId, item.img) };
  if (item.type === "bangarang") return { ...item, img1: portableImgToAbsolute(entryId, item.img1), img2: portableImgToAbsolute(entryId, item.img2) };
  return item;
}

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

// The password for the currently-open entry, held only in memory for as long
// as it stays open and unlocked this session — used to re-encrypt on every
// autosave (see scheduleSaveEntry) so a protected entry's edits never touch
// disk as plaintext. Never sent to the server itself, only the ciphertext it
// produces. Reset to null in openEntry and whenever protection is removed.
let activeEntryPassword = null;

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
    // A locked entry's content (including any photo) never left the server
    // as plaintext, so there's no previewUrl to show \u2014 a badge instead, same
    // as the "no photo" placeholder.
    if (en.locked) {
      thumb.className = "entry-thumb locked";
      thumb.textContent = "\ud83d\udd12";
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
    meta.textContent = en.locked
      ? `${formatDate(en.date)} \u00b7 protected`
      : `${formatDate(en.date)} \u00b7 ${en.itemCount} item${en.itemCount === 1 ? "" : "s"}`;

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
  activeEntryPassword = null;
  state.selectedItemIds.clear();
  el("entry-title-input").value = state.activeEntry.title;
  el("entry-date").textContent = formatDate(state.activeEntry.date);
  showView("entry");
  if (state.activeEntry.locked) {
    showEntryLockGate();
  } else {
    zCounter = Math.max(10, ...(state.activeEntry.items || []).map((it) => it.z || 0)) + 1;
    setEntryToolbarEnabled(true);
    el("entry-lock-gate").hidden = true;
    applyCanvasBackground();
    renderCanvas();
  }
  updateLockButton();
}

/**
 * Build the `{items, canvasBg, canvasBgImage}` payload that gets AES-GCM
 * encrypted into entry.enc for a protected entry \u2014 same shape
 * decryptEntryPayload hands back, with photo URLs made portable first (see
 * absoluteImgToPortable).
 * @param {object} entry - state.activeEntry, already decrypted/editable.
 * @returns {object}
 */
function buildProtectedPayload(entry) {
  return {
    items: (entry.items || []).map(itemImagesToPortable),
    canvasBg: entry.canvasBg,
    canvasBgImage: entry.canvasBgImage ? absoluteImgToPortable(entry.canvasBgImage) : undefined,
  };
}

/**
 * Debounced autosave for the currently open entry: waits 500ms after the
 * last call before PUTting to the server, so rapid edits (typing, dragging)
 * collapse into one request instead of one per keystroke. Every mutation to
 * state.activeEntry should call this afterward. Updates the
 * "saving\u2026"/"saved" indicator around the request.
 *
 * For a protected entry this re-encrypts `items`/`canvasBg`/`canvasBgImage`
 * with the in-memory activeEntryPassword on every save (not just when the
 * password is first set), and sends those plaintext fields as cleared \u2014
 * so an in-progress edit never touches disk unencrypted, and a stale
 * plaintext copy from before it was locked can't linger either.
 */
function scheduleSaveEntry() {
  setSaveIndicator("saving\u2026");
  clearTimeout(saveEntryTimer);
  saveEntryTimer = setTimeout(async () => {
    const { id, title, date, locked } = state.activeEntry;
    const body = locked
      ? { title, date, locked: true, enc: (state.activeEntry.enc = await encryptEntryPayload(activeEntryPassword, buildProtectedPayload(state.activeEntry))), items: [], canvasBg: null, canvasBgImage: null }
      : { title, date, locked: false, enc: null, items: state.activeEntry.items, canvasBg: state.activeEntry.canvasBg, canvasBgImage: state.activeEntry.canvasBgImage };
    await fetch(`/api/entries/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaveIndicator("saved");
  }, 500);
}

el("entry-title-input").addEventListener("input", (e) => {
  state.activeEntry.title = e.target.value;
  scheduleSaveEntry();
});

// ---------- password protection: UI ----------

/**
 * Enable/disable everything in the entry toolbar except the back button
 * while a protected entry's canvas is gated behind its password prompt (see
 * showEntryLockGate) \u2014 there's nothing valid to add notes/photos to, or a
 * title to save alongside, until it's been decrypted into state.activeEntry.
 * @param {boolean} enabled
 */
function setEntryToolbarEnabled(enabled) {
  for (const id of ["entry-title-input", "add-note-btn", "add-photo-btn", "add-text-btn", "add-music-btn", "publish-btn"]) {
    el(id).disabled = !enabled;
  }
}

/**
 * Reflect whether the open entry is protected on the toolbar's lock button.
 * Hidden entirely while a protected entry is still gated (nothing to change
 * yet \u2014 see showEntryLockGate), since there's no password in memory to
 * re-encrypt with until the right one has been entered once.
 */
function updateLockButton() {
  const entry = state.activeEntry;
  const btn = el("lock-btn");
  if (!entry) return;
  btn.hidden = entry.locked && !activeEntryPassword;
  btn.textContent = entry.locked ? "\ud83d\udd12 Protected" : "\ud83d\udd13 Protect";
  btn.title = entry.locked ? "Change or remove this entry's password" : "Password protect this entry";
}

/**
 * Render an inline "enter password to continue" gate into `container`,
 * replacing whatever it currently shows. Shared between the editor's locked
 * canvas, the live app's /view/<id> page, and the static export \u2014 each just
 * supplies its own onSubmit that tries decryptEntryPayload and, on success,
 * re-renders `container` with the real content (which naturally clears the
 * gate, since it's the same element).
 * @param {HTMLElement} container
 * @param {(password: string) => Promise<boolean>} onSubmit - Resolves true
 *   on a correct password (caller has already re-rendered `container`),
 *   false on a wrong one (the gate stays up and shows an error).
 */
function renderPasswordGate(container, onSubmit) {
  container.innerHTML = "";
  container.classList.add("password-gate");

  const icon = document.createElement("div");
  icon.className = "lock-icon";
  icon.textContent = "\ud83d\udd12";

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
 * Show the password gate in place of the editor's canvas for a protected
 * entry that hasn't been unlocked yet this session. On a correct password,
 * decrypts entry.enc into state.activeEntry's editable fields (converting
 * photo URLs back from their portable form), remembers the password in
 * activeEntryPassword for scheduleSaveEntry to re-encrypt with, and switches
 * over to the normal editable canvas.
 */
function showEntryLockGate() {
  setEntryToolbarEnabled(false);
  el("canvas-empty").hidden = true;
  el("canvas").hidden = true;
  el("entry-lock-gate").hidden = false;
  renderPasswordGate(el("entry-lock-gate"), async (password) => {
    const decrypted = await decryptEntryPayload(password, state.activeEntry.enc);
    if (!decrypted) return false;
    const entryId = state.activeEntry.id;
    state.activeEntry.items = (decrypted.items || []).map((it) => itemImagesToAbsolute(entryId, it));
    state.activeEntry.canvasBg = decrypted.canvasBg;
    state.activeEntry.canvasBgImage = decrypted.canvasBgImage ? portableImgToAbsolute(entryId, decrypted.canvasBgImage) : undefined;
    activeEntryPassword = password;
    zCounter = Math.max(10, ...state.activeEntry.items.map((it) => it.z || 0)) + 1;
    el("entry-lock-gate").hidden = true;
    el("canvas").hidden = false;
    setEntryToolbarEnabled(true);
    applyCanvasBackground();
    renderCanvas();
    updateLockButton();
    return true;
  });
}

/**
 * (Re-)encrypt the open entry's current content with `password` and mark it
 * protected \u2014 used both to protect a previously-open entry for the first
 * time and to change an already-protected one's password (it's the same
 * operation: re-encrypt what's currently in state.activeEntry).
 * @param {string} password
 * @returns {Promise<void>}
 */
async function lockActiveEntry(password) {
  const entry = state.activeEntry;
  entry.enc = await encryptEntryPayload(password, buildProtectedPayload(entry));
  entry.locked = true;
  activeEntryPassword = password;
  updateLockButton();
  scheduleSaveEntry();
}

/** Strip password protection from the open entry, saving it in the open like any other. */
function removeActiveEntryProtection() {
  const entry = state.activeEntry;
  entry.locked = false;
  entry.enc = null;
  activeEntryPassword = null;
  updateLockButton();
  scheduleSaveEntry();
}

/**
 * Open the modal for setting a new password on the open entry, changing its
 * existing one, or (if already protected) removing protection entirely.
 * Self-contained, same overlay/card structure as openCropModal.
 */
function openPasswordModal() {
  const entry = state.activeEntry;
  const isProtected = !!entry.locked;

  const overlay = document.createElement("div");
  overlay.className = "crop-overlay";
  const modal = document.createElement("div");
  modal.className = "crop-modal password-modal";

  const heading = document.createElement("div");
  heading.className = "crop-heading";
  heading.textContent = isProtected ? "Change password" : "Protect this entry";

  const newInput = document.createElement("input");
  newInput.type = "password";
  newInput.placeholder = "New password";
  newInput.autocomplete = "new-password";
  const confirmInput = document.createElement("input");
  confirmInput.type = "password";
  confirmInput.placeholder = "Confirm password";
  confirmInput.autocomplete = "new-password";

  const error = document.createElement("div");
  error.className = "password-error";

  const actions = document.createElement("div");
  actions.className = "crop-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn";
  cancelBtn.textContent = "Cancel";
  const submitBtn = document.createElement("button");
  submitBtn.className = "btn btn-accent";
  submitBtn.textContent = isProtected ? "Save" : "Protect";
  actions.append(cancelBtn, submitBtn);

  modal.append(heading, newInput, confirmInput, error, actions);

  if (isProtected) {
    const removeBtn = document.createElement("button");
    removeBtn.className = "btn password-remove-btn";
    removeBtn.textContent = "Remove password protection";
    removeBtn.addEventListener("click", () => {
      if (!confirm("Remove password protection from this entry? It'll be saved in the open, like any other entry.")) return;
      removeActiveEntryProtection();
      cleanup();
    });
    modal.appendChild(removeBtn);
  }

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  newInput.focus();

  function cleanup() {
    overlay.remove();
    document.removeEventListener("keydown", onKeydown);
  }
  function onKeydown(e) {
    if (e.key === "Escape") cleanup();
  }
  document.addEventListener("keydown", onKeydown);
  cancelBtn.addEventListener("click", cleanup);
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) cleanup();
  });

  submitBtn.addEventListener("click", async () => {
    if (!newInput.value) {
      error.textContent = "Enter a password.";
      return;
    }
    if (newInput.value !== confirmInput.value) {
      error.textContent = "Passwords don't match.";
      return;
    }
    submitBtn.disabled = true;
    await lockActiveEntry(newInput.value);
    cleanup();
  });
}

el("lock-btn").addEventListener("click", () => openPasswordModal());

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

// ---------- HEIC conversion ----------
// iPhones save Camera Roll photos as HEIC by default, which every browser
// except Safari flatly refuses to decode in an <img> — pick one as-is and it
// silently renders as a black box with a broken-image icon everywhere in
// this app (the crop preview, a bangarang, a drag/paste photo), with no
// error anywhere to explain why. Every image-intake path below converts one
// to a normal JPEG first, so from that point on it's just a normal image.

let heic2anyPromise = null; // memoized so the <script> tag is only ever injected once

/**
 * Lazily load heic2any (a WASM HEIC/HEIF-to-JPEG decoder) from a CDN — same
 * on-demand-script pattern as loadYoutubeApi, since most uploads are never
 * HEIC and this is a ~1.3MB script nobody should pay for otherwise.
 * @returns {Promise<Function>} The global `heic2any` conversion function.
 */
function loadHeic2Any() {
  if (heic2anyPromise) return heic2anyPromise;
  heic2anyPromise = new Promise((resolve, reject) => {
    if (window.heic2any) {
      resolve(window.heic2any);
      return;
    }
    const tag = document.createElement("script");
    tag.src = "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js";
    tag.onload = () => resolve(window.heic2any);
    tag.onerror = () => reject(new Error("Couldn't load the HEIC converter."));
    document.head.appendChild(tag);
  });
  return heic2anyPromise;
}

/**
 * @param {File|Blob} file - May lack a `.name` (e.g. a cross-origin-fetched
 *   drag-drop blob), so this never relies on that alone.
 * @returns {boolean}
 */
function looksLikeHeic(file) {
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  return type === "image/heic" || type === "image/heif" || name.endsWith(".heic") || name.endsWith(".heif");
}

/**
 * Convert a HEIC/HEIF file to a normal JPEG File before it reaches the crop
 * modal or an upload — a no-op (returns `file` unchanged) for anything else.
 * @param {File|Blob} file
 * @returns {Promise<File|Blob>}
 */
async function convertHeicIfNeeded(file) {
  if (!looksLikeHeic(file)) return file;
  const heic2any = await loadHeic2Any();
  const result = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
  const jpegBlob = Array.isArray(result) ? result[0] : result; // a multi-picture HEIC (e.g. Live Photo) decodes to several — just use the first
  const baseName = (file.name || "photo").replace(/\.\w+$/, "");
  return new File([jpegBlob], `${baseName}.jpg`, { type: "image/jpeg" });
}

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
el("photo-file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const pos = pendingPhotoPos;
  pendingPhotoPos = null;
  e.target.value = "";
  if (!file) return;
  let usable;
  try {
    usable = await convertHeicIfNeeded(file);
  } catch {
    alert("Couldn't read that HEIC photo — try exporting it as JPEG first.");
    return;
  }
  openCropModal(usable, pos);
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

// ---------- bangarang (two-image flicker loop) ----------

/**
 * Open a small modal with two "choose image" slots and an Add button
 * (enabled once both are filled), then upload both and add the bangarang
 * item on confirm. Deliberately not a single `<input multiple>` file
 * picker: relying on the user knowing to ⌘/Ctrl-click two files in one
 * dialog trip is easy to miss, and chaining a *second* programmatic
 * `.click()` on a file input after an `await` (i.e. after the first
 * upload finishes) risks landing outside the browser's transient
 * user-activation window and getting silently blocked — no dialog opens,
 * no error, item never gets created. Two buttons, each opening its own
 * input from a direct, synchronous click, sidesteps both problems.
 * @param {{x: number, y: number}} pos - Target canvas position (%).
 */
function openBangarangModal(pos) {
  const overlay = document.createElement("div");
  overlay.className = "crop-overlay";
  const modal = document.createElement("div");
  modal.className = "crop-modal bangarang-modal";

  const heading = document.createElement("div");
  heading.className = "crop-heading";
  heading.textContent = "⚡ Bangarang";

  const sub = document.createElement("div");
  sub.className = "bangarang-modal-sub";
  sub.textContent = "Pick two images to flicker between.";

  const slotsRow = document.createElement("div");
  slotsRow.className = "bangarang-slots-row";

  const files = [null, null];

  /**
   * @param {string} label
   * @returns {{el: HTMLElement, input: HTMLInputElement, setPreview: (file: File) => void, setBusy: (busy: boolean) => void}}
   */
  function createSlot(label) {
    const slotEl = document.createElement("div");
    slotEl.className = "bangarang-slot";

    const preview = document.createElement("div");
    preview.className = "bangarang-slot-preview";
    preview.textContent = "+";

    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.hidden = true;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn";
    btn.textContent = label;
    btn.addEventListener("click", () => input.click());

    slotEl.append(preview, input, btn);

    let currentLabel = label; // what setBusy(false) restores the button to
    return {
      el: slotEl,
      input,
      setPreview(file) {
        preview.style.backgroundImage = `url("${URL.createObjectURL(file)}")`;
        preview.textContent = "";
        currentLabel = "Change";
        btn.textContent = currentLabel;
      },
      // Shown while a HEIC pick is being converted (see wireSlot) — that can
      // take a moment for a large photo, and there's otherwise no feedback
      // that anything is happening between picking it and the preview appearing.
      setBusy(busy) {
        btn.disabled = busy;
        btn.textContent = busy ? "Converting…" : currentLabel;
      },
    };
  }

  const slot1 = createSlot("Choose first image");
  const slot2 = createSlot("Choose second image");
  slotsRow.append(slot1.el, slot2.el);

  const error = document.createElement("div");
  error.className = "password-error"; // same small red-text treatment

  const actions = document.createElement("div");
  actions.className = "crop-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn";
  cancelBtn.textContent = "Cancel";
  const addBtn = document.createElement("button");
  addBtn.className = "btn btn-teal";
  addBtn.textContent = "Add";
  addBtn.disabled = true;
  actions.append(cancelBtn, addBtn);

  modal.append(heading, sub, slotsRow, error, actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function wireSlot(slot, index) {
    slot.input.addEventListener("change", async () => {
      const file = slot.input.files[0];
      if (!file) return;
      slot.setBusy(true);
      let usable;
      try {
        usable = await convertHeicIfNeeded(file);
      } catch {
        error.textContent = "Couldn't read that HEIC photo — try exporting it as JPEG first.";
        slot.setBusy(false);
        return;
      }
      slot.setBusy(false);
      files[index] = usable;
      slot.setPreview(usable);
      addBtn.disabled = !(files[0] && files[1]);
    });
  }
  wireSlot(slot1, 0);
  wireSlot(slot2, 1);

  function cleanup() {
    overlay.remove();
    document.removeEventListener("keydown", onKeydown);
  }
  function onKeydown(e) {
    if (e.key === "Escape") cleanup();
  }
  document.addEventListener("keydown", onKeydown);
  cancelBtn.addEventListener("click", cleanup);
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) cleanup();
  });

  addBtn.addEventListener("click", async () => {
    addBtn.disabled = true;
    addBtn.textContent = "Adding…";
    error.textContent = "";
    const [url1, url2] = await Promise.all([uploadRawImage(files[0]), uploadRawImage(files[1])]);
    if (!url1 || !url2) {
      error.textContent = "Couldn't upload one of those images — try again.";
      addBtn.disabled = false;
      addBtn.textContent = "Add";
      return;
    }
    addBangarangItem(pos, url1, url2);
    cleanup();
  });
}
el("add-bangarang-btn").addEventListener("click", () => openBangarangModal(getViewportCenterCanvasPos()));

/**
 * Upload a raw, uncropped image file to the current entry's uploads folder
 * (no square-crop modal, unlike uploadCroppedPhoto — a bangarang just needs
 * two source images, not a polaroid-shaped one).
 * @param {File} file
 * @returns {Promise<string|null>} The stored URL, or null on failure.
 */
async function uploadRawImage(file) {
  const form = new FormData();
  form.append("photo", file, file.name || "photo.jpg");
  const res = await fetch(`/api/entries/${state.activeEntry.id}/uploads`, { method: "POST", body: form });
  if (!res.ok) return null;
  const { url } = await res.json();
  return url;
}

/**
 * Add a new bangarang item: an image that flickers between `img1` and
 * `img2` forever at `delay`ms, adjustable afterward via its bar's slider
 * (see createBangarangBar) up to BANGARANG_MAX_DELAY.
 * @param {{x: number, y: number}} pos - Target canvas position (%).
 * @param {string} img1
 * @param {string} img2
 */
function addBangarangItem(pos, img1, img2) {
  const item = {
    id: `bangarang-${Date.now()}`,
    type: "bangarang",
    x: pos.x,
    y: pos.y,
    rot: Math.round((Math.random() * 8 - 4) * 10) / 10,
    w: 200,
    img1,
    img2,
    delay: BANGARANG_DEFAULT_DELAY,
    color: WASHI_COLORS[Math.floor(Math.random() * WASHI_COLORS.length)],
    z: ++zCounter,
  };
  state.activeEntry.items.push(item);
  renderCanvas();
  scheduleSaveEntry();
}

// ---------- paste & drag-and-drop photos ----------
// A second, lighter-weight way to add a photo, alongside the +Photo
// button's deliberate crop-to-square-polaroid flow: pasting an image
// (Cmd/Ctrl+V after copying one elsewhere) or dragging one in from outside
// the page. Both skip the crop modal entirely and land as a frameless photo
// at its original aspect ratio — see handleIncomingImage. The user can
// still turn it into a polaroid afterward via the existing frame-toggle
// button; the polaroid frame's CSS (aspect-ratio: 1/1 + object-fit: cover
// on .polaroid img) crops it to square purely visually at that point,
// without touching the uploaded pixels.

/**
 * Upload an image obtained via paste or drag-and-drop (not the crop modal)
 * and add it as a new, frameless photo item at its original aspect ratio —
 * unlike uploadCroppedPhoto, nothing here forces it to a square crop.
 * @param {Blob|File} blob - The incoming image.
 * @param {{x: number, y: number}} pos - Target canvas position (%).
 * @returns {Promise<void>}
 */
async function handleIncomingImage(blob, pos) {
  if (!state.activeEntry || !blob || !blob.type || !blob.type.startsWith("image/")) return;
  let usable;
  try {
    usable = await convertHeicIfNeeded(blob);
  } catch {
    alert("Couldn't read that HEIC photo — try exporting it as JPEG first.");
    return;
  }
  const form = new FormData();
  form.append("photo", usable, usable.name || "photo.jpg");
  const res = await fetch(`/api/entries/${state.activeEntry.id}/uploads`, { method: "POST", body: form });
  if (!res.ok) return;
  const { url } = await res.json();
  const item = {
    id: `photo-${Date.now()}`,
    type: "photo",
    x: pos.x,
    y: pos.y,
    rot: Math.round((Math.random() * 12 - 6) * 10) / 10,
    w: 220,
    img: url,
    caption: "",
    color: WASHI_COLORS[Math.floor(Math.random() * WASHI_COLORS.length)],
    z: ++zCounter,
    frame: "none",
  };
  state.activeEntry.items.push(item);
  renderCanvas();
  scheduleSaveEntry();
}

// Pasting anywhere while an entry is open adds a clipboard image as a new
// photo item, as long as no crop modal is already open (that has its own,
// unrelated pointer/keyboard handling) — this deliberately does NOT check
// what's focused, so pasting an image while a note is focused still adds a
// photo instead of trying (and failing) to inline it into the note text.
// A paste with no image data (e.g. plain text into a note) is left alone.
document.addEventListener("paste", (e) => {
  if (state.view !== "entry" || !state.activeEntry) return;
  if (document.querySelector(".crop-overlay")) return;
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const dtItem of items) {
    if (dtItem.kind === "file" && dtItem.type.startsWith("image/")) {
      e.preventDefault();
      const file = dtItem.getAsFile();
      if (file) handleIncomingImage(file, getViewportCenterCanvasPos());
      break;
    }
  }
});

// Dragging a file over the canvas must call preventDefault on dragover, or
// the browser refuses to fire "drop" at all (its default action for a drop
// target is just to reject the drag). The window-level listeners are a
// safety net so a drop that misses the canvas doesn't navigate the whole
// app away to the dropped file/image.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

el("canvas").addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});

el("canvas").addEventListener("drop", async (e) => {
  e.preventDefault();
  if (!state.activeEntry) return;
  const rect = el("canvas").getBoundingClientRect();
  const x = Math.min(96, Math.max(4, ((e.clientX - rect.left) / rect.width) * 100));
  const y = Math.max(2, ((e.clientY - rect.top) / CANVAS_UNIT_HEIGHT) * 100);

  const files = [...(e.dataTransfer.files || [])].filter((f) => f.type.startsWith("image/"));
  if (files.length) {
    // Stagger multiple dropped images slightly so they don't land in an
    // exact stack on top of each other.
    for (let i = 0; i < files.length; i++) {
      await handleIncomingImage(files[i], { x: Math.min(96, x + i * 3), y: y + i * 3 });
    }
    return;
  }

  // No raw file bytes — this is likely an image dragged in from another
  // browser tab/webpage, which hands over a URL instead. Try to fetch it;
  // many sites block cross-origin image fetches (CORS), in which case this
  // silently does nothing rather than erroring.
  const uri = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
  if (uri && /^https?:\/\//i.test(uri)) {
    try {
      const res = await fetch(uri);
      const blob = await res.blob();
      if (blob.type.startsWith("image/")) await handleIncomingImage(blob, { x, y });
    } catch {
      /* cross-origin or network failure — nothing more we can do */
    }
  }
});

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
const resizableElRefs = new Map(); // item.id -> the element item.h should be applied to (photo/text/bangarang only)
const bangarangTimers = new Map(); // item.id -> setInterval id driving its flicker (bangarang only)

/**
 * Start (or restart, e.g. after the delay slider changes) a bangarang
 * item's flicker: toggles which of its two already-loaded `<img>` elements
 * is visible, forever. Both images are real DOM elements loaded once up
 * front (see createBangarangCard) rather than one `<img>` whose `src` gets
 * swapped every tick — swapping `src` would mean every single flip refetches
 * and redecodes a full-size image, which for anything bigger than a tiny
 * demo photo (e.g. a real 1920x1080 one) can't keep up with a fast delay at
 * all: the image just never finishes loading before the next swap fires,
 * so it visually never shows. Toggling opacity between two pre-loaded
 * elements is instant regardless of source image size or flicker speed.
 * @param {object} item
 * @param {HTMLImageElement} img1
 * @param {HTMLImageElement} img2
 */
function startBangarangTimer(item, img1, img2) {
  stopBangarangTimer(item.id);
  let showingFirst = true;
  bangarangTimers.set(
    item.id,
    setInterval(() => {
      showingFirst = !showingFirst;
      img1.style.opacity = showingFirst ? "1" : "0";
      img2.style.opacity = showingFirst ? "0" : "1";
    }, clampBangarangDelay(item.delay))
  );
}

/** @param {string} id - Item id. */
function stopBangarangTimer(id) {
  const timer = bangarangTimers.get(id);
  if (timer) {
    clearInterval(timer);
    bangarangTimers.delete(id);
  }
}

/**
 * Tear down everything owned by the currently-open entry's canvas: destroy
 * any live YouTube players and bangarang timers, clear the item DOM/ref
 * caches, wipe the canvas element, and close any open right-click menu.
 * Called before loading a different entry (or leaving to the list view) so
 * nothing from the previous entry lingers — including background audio.
 */
function resetCanvasState() {
  for (const id of [...ytPlayers.keys()]) destroyYoutubePlayer(id);
  for (const id of [...bangarangTimers.keys()]) stopBangarangTimer(id);
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
 * Apply the open entry's saved canvas background — either an uploaded image
 * (state.activeEntry.canvasBgImage, cover-fit and centered) or a solid color
 * (state.activeEntry.canvasBg) — to the canvas element. The two are mutually
 * exclusive (see setCanvasBackground/setCanvasBackgroundImage); an image
 * takes precedence if somehow both were set. No color/image set reverts to
 * the CSS default (cream background + subtle radial-gradient texture).
 */
function applyCanvasBackground() {
  const canvas = el("canvas");
  const bg = state.activeEntry.canvasBg;
  const bgImage = state.activeEntry.canvasBgImage;
  canvas.style.backgroundColor = bg || "";
  if (bgImage) {
    canvas.style.backgroundImage = `url("${bgImage}")`;
    canvas.style.backgroundSize = "cover";
    canvas.style.backgroundPosition = "center";
    canvas.style.backgroundRepeat = "no-repeat";
  } else {
    canvas.style.backgroundImage = bg ? "none" : "";
    canvas.style.backgroundSize = "";
    canvas.style.backgroundPosition = "";
    canvas.style.backgroundRepeat = "";
  }
  // The default look's inset box-shadow is a warm vignette meant to shade
  // the paper texture — left on, it darkens the edges of a custom color/
  // image too, which reads as "not actually solid". Suppress it whenever
  // either override is active.
  canvas.classList.toggle("custom-bg", !!(bg || bgImage));
}

/**
 * Set (or clear, with a falsy color) the open entry's solid-color canvas
 * background, apply it immediately, and save. Clears any background image —
 * the two are mutually exclusive, so picking a color always wins outright
 * rather than sitting invisibly underneath an image.
 * @param {string|null} color - A CSS color string, or null/undefined to
 *   reset to the default paper texture.
 */
function setCanvasBackground(color) {
  state.activeEntry.canvasBg = color || undefined;
  state.activeEntry.canvasBgImage = undefined;
  applyCanvasBackground();
  scheduleSaveEntry();
}

/**
 * Set (or clear, with a falsy url) the open entry's canvas background image,
 * apply it immediately, and save.
 * @param {string|null} url - An uploaded image URL, or null/undefined to remove it.
 */
function setCanvasBackgroundImage(url) {
  state.activeEntry.canvasBgImage = url || undefined;
  applyCanvasBackground();
  scheduleSaveEntry();
}

/**
 * Open the hidden file picker used to upload a canvas background image.
 */
function triggerCanvasBgImagePick() {
  el("canvas-bg-file-input").click();
}

// Fires once a file is picked (or the dialog is cancelled) for a canvas
// background image. Uploaded as-is (no crop step, unlike photo items) since
// background-size: cover already fits/crops it visually without needing to
// touch the original pixels.
el("canvas-bg-file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !state.activeEntry) return;
  const form = new FormData();
  form.append("photo", file, file.name || "background.jpg");
  const res = await fetch(`/api/entries/${state.activeEntry.id}/uploads`, { method: "POST", body: form });
  if (!res.ok) return;
  const { url } = await res.json();
  setCanvasBackgroundImage(url);
});

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

  const divider1 = document.createElement("div");
  divider1.className = "context-menu-divider";
  menu.appendChild(divider1);

  addContextMenuItem(menu, "🖼️  Upload background image", () => {
    triggerCanvasBgImagePick();
    closeContextMenu();
  });
  if (state.activeEntry.canvasBgImage) {
    addContextMenuItem(menu, "✕  Remove background image", () => {
      setCanvasBackgroundImage(null);
      closeContextMenu();
    });
  }

  const divider2 = document.createElement("div");
  divider2.className = "context-menu-divider";
  menu.appendChild(divider2);

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
 * (Bring to Front / Bring Forward / Send Backward / Send to Back); for a
 * photo specifically, a second section (flip horizontal/vertical, toggle
 * tape, toggle shadow — see createPhotoCard/updateItemWrap for how each is
 * applied); then a divider and Delete. Each option applies its change (and,
 * for the layering/photo ones, saves), then closes the menu.
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

  if (item.type === "photo") {
    const photoDivider = document.createElement("div");
    photoDivider.className = "context-menu-divider";
    menu.appendChild(photoDivider);

    addContextMenuItem(menu, "↔️  Flip horizontal", () => {
      item.flipH = !item.flipH;
      renderCanvas();
      scheduleSaveEntry();
      closeContextMenu();
    });
    addContextMenuItem(menu, "↕️  Flip vertical", () => {
      item.flipV = !item.flipV;
      renderCanvas();
      scheduleSaveEntry();
      closeContextMenu();
    });
    addContextMenuItem(menu, item.tape === false ? "🩹  Show tape" : "🩹  Hide tape", () => {
      item.tape = item.tape === false ? undefined : false;
      // The washi strip is only ever created inside createItemWrap (not
      // patched per-render in updateItemWrap), so toggling it needs a
      // rebuild-from-scratch, same as the frame toggle.
      forceRebuildItem(item.id);
      renderCanvas();
      scheduleSaveEntry();
      closeContextMenu();
    });
    addContextMenuItem(menu, item.shadow === false ? "🌗  Show shadow" : "🌗  Hide shadow", () => {
      item.shadow = item.shadow === false ? undefined : false;
      forceRebuildItem(item.id);
      renderCanvas();
      scheduleSaveEntry();
      closeContextMenu();
    });
  }

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
 * Build a bangarang item's visual content: a fixed-size frame holding both
 * of its images stacked on top of each other (each `object-fit: cover`, so
 * a mismatched pair doesn't make the box jump size on every flip), with
 * only one visible at a time via opacity — see startBangarangTimer for why
 * that's two pre-loaded elements rather than one `<img>` whose `src` gets
 * swapped. The frame (not either image) is registered in resizableElRefs,
 * so the resize handle stretches the whole box, same as a photo.
 *
 * The flicker itself doesn't start until the second image has actually
 * finished loading, so the first flip never lands on a still-blank `<img>`.
 * @param {object} item - The bangarang-type canvas item.
 * @returns {HTMLElement} The `.bangarang-frame` element.
 */
function createBangarangCard(item) {
  const frame = document.createElement("div");
  frame.className = "bangarang-frame";

  const img1 = document.createElement("img");
  img1.className = "bangarang-img bangarang-img-front";
  img1.src = item.img1;
  img1.draggable = false;

  const img2 = document.createElement("img");
  img2.className = "bangarang-img bangarang-img-back";
  img2.src = item.img2;
  img2.draggable = false;

  frame.append(img1, img2);
  resizableElRefs.set(item.id, frame);

  if (img2.complete) startBangarangTimer(item, img1, img2);
  else img2.addEventListener("load", () => startBangarangTimer(item, img1, img2), { once: true });

  return frame;
}

/**
 * The per-item bar for a selected bangarang: just its flicker-speed slider
 * (0.03–1s, per BANGARANG_MIN_DELAY/MAX_DELAY), live-updating both the
 * running timer and the ms label as it's dragged.
 * @param {object} item
 * @returns {HTMLElement}
 */
function createBangarangBar(item) {
  const bar = document.createElement("div");
  bar.className = "item-bangarang-bar";

  const icon = document.createElement("span");
  icon.className = "bangarang-bar-icon";
  icon.textContent = "⚡";
  icon.title = "Flicker delay";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "bangarang-delay-slider";
  slider.min = String(BANGARANG_MIN_DELAY);
  slider.max = String(BANGARANG_MAX_DELAY);
  slider.step = "10";
  slider.value = String(clampBangarangDelay(item.delay));

  const label = document.createElement("span");
  label.className = "bangarang-delay-label";
  label.textContent = `${slider.value}ms`;

  slider.addEventListener("pointerdown", (e) => e.stopPropagation());
  slider.addEventListener("input", (e) => {
    item.delay = clampBangarangDelay(e.target.value);
    label.textContent = `${item.delay}ms`;
    const frame = resizableElRefs.get(item.id);
    const img1 = frame && frame.querySelector(".bangarang-img-front");
    const img2 = frame && frame.querySelector(".bangarang-img-back");
    if (img1 && img2) startBangarangTimer(item, img1, img2); // restart at the new speed
    scheduleSaveEntry();
  });

  bar.append(icon, slider, label);
  return bar;
}

/**
 * Build the frame-style toolbar shown when a photo is selected: a single
 * toggle button that switches between the default polaroid frame (with
 * caption) and a bare, frameless image. Flip/tape/shadow live in the
 * right-click menu instead (see renderItemContextMenu) — right-click-only,
 * not duplicated here.
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
    // A prior resize's item.h means something different in each mode (a
    // proportional scale when frameless vs. a deliberate stretch inside a
    // polaroid — see startResize/updateItemWrap), so it doesn't carry
    // across the toggle: drop it and let the new frame fall back to its
    // own default (natural ratio frameless, or the polaroid's CSS-driven
    // square crop) rather than displaying a stale, mismatched stretch.
    item.h = undefined;
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
    img.className = "plain-photo-img" + (item.shadow === false ? " no-shadow" : "");
    return img;
  }

  const card = document.createElement("div");
  card.className = "polaroid" + (item.shadow === false ? " no-shadow" : "");
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

  // Grouped so the "hide controls" toggle can collapse both at once — the
  // progress bar stays visible either way, since that's the part worth
  // seeing even with the card collapsed.
  const collapsible = document.createElement("div");
  collapsible.className = "yt-collapsible";
  collapsible.append(controls, volumeRow);

  card.append(header, main, progress, collapsible, mount);

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
  // skip the washi tape strip that every other item type gets. A photo can
  // also have its tape turned off individually (see createPhotoFrameBar).
  if (item.type !== "text" && !(item.type === "photo" && item.tape === false)) {
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
      : item.type === "bangarang"
      ? createBangarangCard(item)
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
const RESIZABLE_TYPES = new Set(["photo", "text", "bangarang"]);

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
    // A polaroid's resize is a deliberate stretch (object-fit: fill); a
    // frameless photo's item.w/item.h are already kept in its natural ratio
    // by the resize handle itself (see startResize/onPointerMove), so
    // "cover" here is just a rounding safety net, never an actual crop.
    if (item.type === "photo") {
      resizeTarget.style.objectFit = item.h ? (item.frame === "none" ? "cover" : "fill") : "";
      // Flip is applied to the image itself, not the wrap — the wrap also
      // carries rotation/position for the washi tape and selection chrome,
      // which shouldn't mirror along with the photo (see renderItemContextMenu).
      resizeTarget.style.transform =
        item.flipH || item.flipV ? `scale(${item.flipH ? -1 : 1}, ${item.flipV ? -1 : 1})` : "";
    }
    // Frameless items (text boxes, "none"-frame photos) have no card
    // background of their own, so show a dashed outline while selected —
    // otherwise their bounds would be invisible. A bangarang's frame always
    // has a visible background/shadow of its own (see .bangarang-frame), but
    // gets the same outline anyway as plain selection feedback.
    if (item.type === "text" || item.frame === "none" || item.type === "bangarang") {
      resizeTarget.classList.toggle("selected-outline", isSoleSelection);
    }
  }

  wrap.querySelectorAll(".item-btn, .item-style-bar, .item-note-bg-bar, .item-photo-frame-bar, .item-bangarang-bar").forEach((n) => n.remove());
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
    } else if (item.type === "bangarang") {
      wrap.appendChild(createBangarangBar(item));
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
  stopBangarangTimer(id);
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
      stopBangarangTimer(id);
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
 * A frameless photo also records its natural width/height ratio (read
 * straight off the loaded <img>, so this works retroactively for any photo
 * with no schema change) — onPointerMove uses it to scale the image
 * uniformly instead of stretching it, since only a polaroid's crop is
 * meant to distort the image.
 * @param {PointerEvent} e - The pointerdown on the resize handle.
 * @param {object} item - The item being resized (photo or text box).
 */
function startResize(e, item) {
  e.stopPropagation();
  const contentEl = resizableElRefs.get(item.id);
  let aspectRatio = null;
  if (item.type === "photo" && item.frame === "none" && contentEl && contentEl.naturalWidth && contentEl.naturalHeight) {
    aspectRatio = contentEl.naturalWidth / contentEl.naturalHeight;
  }
  dragInfo = {
    id: item.id,
    mode: "resize",
    startX: e.clientX,
    startY: e.clientY,
    origW: item.w,
    origH: item.h || (contentEl ? contentEl.offsetHeight : 150),
    aspectRatio,
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
      item.h = dragInfo.aspectRatio
        ? Math.max(30, Math.round(item.w / dragInfo.aspectRatio))
        : Math.max(30, Math.round(dragInfo.origH + (e.clientY - dragInfo.startY)));
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
 * exist (e.g. a stale or mistyped link). A protected entry shows a password
 * gate in place of the canvas instead — decrypted fully client-side, same as
 * the static export, so the server here never sees the password either.
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
  if (entry.locked) {
    renderPasswordGate(el("readonly-canvas"), async (password) => {
      const decrypted = await decryptEntryPayload(password, entry.enc);
      if (!decrypted) return false;
      entry.items = (decrypted.items || []).map((it) => itemImagesToAbsolute(id, it));
      entry.canvasBg = decrypted.canvasBg;
      entry.canvasBgImage = decrypted.canvasBgImage ? portableImgToAbsolute(id, decrypted.canvasBgImage) : undefined;
      renderReadOnlyCanvas(entry);
      return true;
    });
  } else {
    renderReadOnlyCanvas(entry);
  }
}

/**
 * Build the read-only canvas: every item rendered statically (no drag,
 * selection, editing, or per-item controls of any kind), sized to fit
 * exactly as far down as the content goes. Unlike the editor's
 * growCanvasToFitContent, there's no endless-scroll buffer added here —
 * the published page's scroll distance is capped to its actual content.
 * @param {object} entry - Full entry record (title, date, items, canvasBg) —
 *   already decrypted if it was protected (see initReadOnlyView).
 */
function renderReadOnlyCanvas(entry) {
  const canvas = el("readonly-canvas");
  canvas.innerHTML = "";
  canvas.classList.remove("password-gate"); // in case this is replacing the gate
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
    // "readonly-item" overrides the interactive canvas's cursor:grab and
    // user-select:none (needed there to make dragging feel natural) — a
    // viewer should be able to select/copy text, not think it's draggable.
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
  if (item.type === "bangarang") return createReadOnlyBangarangCard(item);
  return createReadOnlyNoteCard(item);
}

/**
 * @param {object} item - The bangarang-type item.
 * @returns {HTMLElement} A `.bangarang-frame` holding both images stacked
 *   (each `object-fit: cover`), toggling which is visible forever — same
 *   pre-load-then-flip design as the editor's createBangarangCard, and for
 *   the same reason: swapping one `<img>`'s src every tick can't keep up
 *   with a real full-size photo at a fast delay. This page never gets torn
 *   down/rebuilt the way the editor's canvas does, so unlike
 *   startBangarangTimer there, this interval is just started once (as soon
 *   as both images are loaded) and left running for the page's lifetime.
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

/** @param {object} item - The photo-type item. @returns {HTMLElement} */
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
 * @returns {HTMLElement} The same "Now Playing"-style card as the editor's
 *   createYoutubeCard (status pill, art/title/artist, progress bar,
 *   transport controls, volume) minus the "change song" button — driven by
 *   a real YT.Player (see initReadOnlyYoutubePlayer), not a plain iframe, so
 *   it looks and behaves identically. It never calls scheduleSaveEntry
 *   (there's no server to save to on a read-only page); a repeat toggle
 *   here is a local, per-view preference, not a persisted one.
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
  // Autoplay only reliably works muted (browsers block unmuted autoplay
  // without a prior user gesture) — the icon reflects that starting state
  // and doubles as a one-click unmute, since the volume slider alone isn't
  // an obvious enough affordance that the player starts silent.
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

// A separate player/ref registry from the editor's ytPlayers/ytCardRefs —
// the read-only view never touches editor state (state.activeEntry is
// never set on the /view/<id> route) and must never call scheduleSaveEntry.
const readOnlyYtPlayers = new Map(); // item.id -> { player, progressTimer, muted }
const readOnlyYtCardRefs = new Map(); // item.id -> dom refs for live updates

/**
 * Create (idempotently) the real YT.Player for a read-only music item,
 * starting muted — the only autoplay approach real browsers reliably allow
 * without a prior user gesture — at the item's saved volume level, ready to
 * unmute the instant the viewer clicks the volume icon/slider.
 * @param {object} item
 * @returns {Promise<void>}
 */
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

/**
 * @param {string} id
 * @returns {void}
 */
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
 * Set a read-only music item's volume and, since a nonzero volume clearly
 * signals the viewer wants to hear it, unmute if this is the first time
 * they've touched the slider.
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
