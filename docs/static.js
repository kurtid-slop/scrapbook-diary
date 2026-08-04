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

/** @param {object} item @returns {HTMLElement} */
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

  const frame = document.createElement("iframe");
  frame.className = "yt-readonly-frame";
  frame.src = `https://www.youtube.com/embed/${item.videoId}?rel=0`;
  frame.title = item.title || "YouTube video";
  frame.allow = "accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
  frame.allowFullscreen = true;

  card.append(main, frame);
  return card;
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
  canvas.style.backgroundImage = entry.canvasBg ? "none" : "";

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
