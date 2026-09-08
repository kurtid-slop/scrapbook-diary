// Builds a static, server-free export of every diary entry into docs/, ready
// to publish as-is via GitHub Pages (which only serves static files — see
// server.js for the live Express app this is exported *from*). Every page
// here is read-only and pre-baked: no /api calls, no editing, and (like the
// live app's /view/<id> route) each entry's scroll distance is capped to its
// actual content. Run with: node scripts/build-static.js
//
// Output layout:
//   docs/index.html                    static entries list
//   docs/entries-manifest.json         list summary the list page fetches
//   docs/styles.css, docs/static.js    shared assets (copied from src/public
//                                      and scripts/static-site respectively)
//   docs/entries/<id>/index.html       one entry's read-only page
//   docs/entries/<id>/entry.json       that entry's data (photo URLs
//                                      rewritten to ./uploads/<file>)
//   docs/entries/<id>/uploads/*        that entry's photos, copied verbatim

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ENTRIES_DIR = path.join(ROOT, "src", "data", "entries");
const PUBLIC_DIR = path.join(ROOT, "src", "public");
const TEMPLATE_DIR = path.join(__dirname, "static-site");
const OUT_DIR = path.join(ROOT, "docs");
// Link-preview crawlers (Discord, iMessage, Slack, ...) don't all reliably
// resolve relative og:image/twitter:image URLs, so those specifically need
// an absolute URL — this site's fixed, known GitHub Pages address.
const SITE_BASE_URL = "https://kurtid-design.github.io/scrapbook-diary/";

/**
 * Rewrite a photo item's server-relative URL (/entries/<id>/uploads/<file>)
 * to a path relative to that entry's own static page, which sits right next
 * to its own copied uploads/ folder.
 * @param {string} url
 * @returns {string}
 */
function toRelativeUploadPath(url) {
  return `./uploads/${path.basename(url)}`;
}

/** @param {string} str @returns {string} HTML-escaped for a safe attribute/text value. */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const MIME_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif" };

/** @param {string} filePath @returns {string} Best-guess image MIME type from its extension. */
function mimeTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "image/jpeg";
}

/**
 * Export one entry folder (src/data/entries/<id>/) into docs/entries/<id>/:
 * copies its uploads, rewrites photo URLs in its JSON, and writes its static
 * page from the entry.html template — with the entry's own title, and (if
 * it has a photo) that photo set as both the tab favicon and the page's
 * Open Graph/Twitter Card image, so a shared link's preview and the browser
 * tab both show the same "cover photo" the entries list already does.
 * A password-protected entry (entry.locked) has no plaintext `items` to read
 * a preview photo or rewrite upload URLs from — its real content lives only
 * as ciphertext in entry.enc, decryptable in-browser (no server involved,
 * which matters here since this export has none) once the viewer enters the
 * right password. This function doesn't need to treat that case specially:
 * `entry.items || []` is just empty, so the loop below is a no-op and
 * previewUrl stays null, same as any other entry with no photos. Its
 * uploads/ folder is still copied verbatim so those photos exist on disk for
 * the page to show once unlocked.
 * @param {string} id
 * @returns {{id: string, title: string, date: number, itemCount: number, previewUrl: string|null, locked: boolean}}
 */
function exportEntry(id) {
  const srcDir = path.join(ENTRIES_DIR, id);
  const entry = JSON.parse(fs.readFileSync(path.join(srcDir, "entry.json"), "utf-8"));
  const outDir = path.join(OUT_DIR, "entries", id);
  fs.mkdirSync(outDir, { recursive: true });

  const srcUploads = path.join(srcDir, "uploads");
  if (fs.existsSync(srcUploads)) {
    fs.cpSync(srcUploads, path.join(outDir, "uploads"), { recursive: true });
  }

  if (entry.canvasBgImage) {
    entry.canvasBgImage = toRelativeUploadPath(entry.canvasBgImage);
  }

  let previewUrl = null; // relative to docs/ root — used by the list page
  let pagePreviewImg = null; // relative to this entry's own page — used below
  for (const item of entry.items || []) {
    if (item.type === "photo" && item.img) {
      item.img = toRelativeUploadPath(item.img);
      if (!previewUrl) {
        previewUrl = `entries/${id}/${item.img.slice(2)}`;
        pagePreviewImg = item.img;
      }
    } else if (item.type === "bangarang") {
      if (item.img1) item.img1 = toRelativeUploadPath(item.img1);
      if (item.img2) item.img2 = toRelativeUploadPath(item.img2);
      if (!previewUrl && item.img1) {
        previewUrl = `entries/${id}/${item.img1.slice(2)}`;
        pagePreviewImg = item.img1;
      }
    }
  }

  fs.writeFileSync(path.join(outDir, "entry.json"), JSON.stringify(entry));

  const title = entry.title || "Untitled";
  const absPreviewUrl = previewUrl ? `${SITE_BASE_URL}${previewUrl}` : null;
  const headExtras = pagePreviewImg
    ? `<link rel="icon" href="${pagePreviewImg}" type="${mimeTypeFor(pagePreviewImg)}" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:type" content="website" />
<meta property="og:url" content="${SITE_BASE_URL}entries/${id}/" />
<meta property="og:image" content="${absPreviewUrl}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:image" content="${absPreviewUrl}" />`
    : `<meta property="og:title" content="${escapeHtml(title)}" />`;

  const html = fs
    .readFileSync(path.join(TEMPLATE_DIR, "entry.html"), "utf-8")
    .replace("<title>Scrapbook Diary</title>", `<title>${escapeHtml(title)}</title>`)
    .replace("<!--HEAD_INJECT-->", headExtras);
  fs.writeFileSync(path.join(outDir, "index.html"), html);

  return {
    id,
    title: entry.title,
    date: entry.date,
    itemCount: (entry.items || []).length,
    previewUrl,
    locked: !!entry.locked,
  };
}

function build() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, ".nojekyll"), "");

  fs.copyFileSync(path.join(PUBLIC_DIR, "styles.css"), path.join(OUT_DIR, "styles.css"));
  fs.copyFileSync(path.join(TEMPLATE_DIR, "static.js"), path.join(OUT_DIR, "static.js"));
  fs.copyFileSync(path.join(TEMPLATE_DIR, "list.html"), path.join(OUT_DIR, "index.html"));

  const ids = fs
    .readdirSync(ENTRIES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const manifest = ids.map(exportEntry).sort((a, b) => b.date - a.date);
  fs.writeFileSync(path.join(OUT_DIR, "entries-manifest.json"), JSON.stringify(manifest));

  console.log(`Exported ${manifest.length} entr${manifest.length === 1 ? "y" : "ies"} to ${OUT_DIR}`);
}

build();
