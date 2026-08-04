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

/**
 * Export one entry folder (src/data/entries/<id>/) into docs/entries/<id>/:
 * copies its uploads, rewrites photo URLs in its JSON, and writes its static
 * page from the entry.html template.
 * @param {string} id
 * @returns {{id: string, title: string, date: number, itemCount: number, previewUrl: string|null}}
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

  let previewUrl = null;
  for (const item of entry.items || []) {
    if (item.type === "photo" && item.img) {
      item.img = toRelativeUploadPath(item.img);
      if (!previewUrl) previewUrl = `entries/${id}/${item.img.slice(2)}`;
    }
  }

  fs.writeFileSync(path.join(outDir, "entry.json"), JSON.stringify(entry));
  fs.copyFileSync(path.join(TEMPLATE_DIR, "entry.html"), path.join(outDir, "index.html"));

  return {
    id,
    title: entry.title,
    date: entry.date,
    itemCount: (entry.items || []).length,
    previewUrl,
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
