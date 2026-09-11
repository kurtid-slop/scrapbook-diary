const express = require("express");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "src", "data");
const ENTRIES_DIR = path.join(DATA_DIR, "entries");
const LEGACY_UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const STYLE_FILE = path.join(DATA_DIR, "style.css");
const PUBLIC_DIR = path.join(__dirname, "src", "public");

/**
 * Resolve the on-disk directory that owns a single entry's data.
 * Each entry lives at entries/<id>/, holding entry.json plus an uploads/
 * subfolder, so the entry and every photo it references can be moved or
 * deleted together as one unit.
 * @param {string} id - Entry id (e.g. "entry-<timestamp>-<uuid>").
 * @returns {string} Absolute path to entries/<id>/.
 */
function entryDir(id) {
  // guard against path traversal via id
  const safeId = path.basename(id);
  return path.join(ENTRIES_DIR, safeId);
}

/**
 * @param {string} id - Entry id.
 * @returns {string} Absolute path to that entry's entry.json file.
 */
function entryJsonPath(id) {
  return path.join(entryDir(id), "entry.json");
}

/**
 * @param {string} id - Entry id.
 * @returns {string} Absolute path to that entry's own uploads/ folder,
 *   where its photos are stored (created on demand, not guaranteed to exist).
 */
function entryUploadsDir(id) {
  return path.join(entryDir(id), "uploads");
}

/**
 * One-time startup migration for pre-folder-structure data.
 * Older versions of this app stored every entry as a flat entries/<id>.json
 * file and every uploaded photo in one shared uploads/ folder. This finds
 * any leftover flat *.json files directly inside entries/, moves each into
 * its own entries/<id>/ folder (with its own entry.json), relocates any
 * photos it references from the old shared uploads/ folder into that new
 * per-entry uploads/ folder, and rewrites the photo URLs in its JSON to
 * match. Entries already in the new folder format are untouched. Safe to
 * run on every startup — once migrated, there are no more flat *.json files
 * left to find, so this becomes a no-op.
 * @returns {Promise<void>}
 */
async function migrateLegacyEntries() {
  const names = await fs.readdir(ENTRIES_DIR);
  const legacyFiles = names.filter((n) => n.endsWith(".json"));
  for (const file of legacyFiles) {
    const id = file.slice(0, -".json".length);
    const oldPath = path.join(ENTRIES_DIR, file);
    const newUploadsDir = entryUploadsDir(id);
    await fs.mkdir(newUploadsDir, { recursive: true });

    const entry = JSON.parse(await fs.readFile(oldPath, "utf-8"));
    for (const item of entry.items || []) {
      if (item.type === "photo" && item.img && item.img.startsWith("/uploads/")) {
        const filename = path.basename(item.img);
        const legacyImgPath = path.join(LEGACY_UPLOADS_DIR, filename);
        if (fssync.existsSync(legacyImgPath)) {
          await fs.rename(legacyImgPath, path.join(newUploadsDir, filename));
        }
        item.img = `/entries/${id}/uploads/${filename}`;
      }
    }

    await fs.writeFile(entryJsonPath(id), JSON.stringify(entry, null, 2));
    await fs.unlink(oldPath);
  }
}

/**
 * Prepare on-disk state before the server starts accepting requests:
 * make sure the entries/ directory and the shared style.css file exist,
 * then run the legacy-data migration.
 * @returns {Promise<void>}
 */
async function ensureDataFiles() {
  if (!fssync.existsSync(ENTRIES_DIR)) fssync.mkdirSync(ENTRIES_DIR, { recursive: true });
  if (!fssync.existsSync(STYLE_FILE)) fssync.writeFileSync(STYLE_FILE, "");
  await migrateLegacyEntries();
}

app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC_DIR));
// Serves each entry's folder directly (entry.json + its uploads/*), so a
// photo's stored URL (/entries/<id>/uploads/<file>) resolves straight to disk.
app.use("/entries", express.static(ENTRIES_DIR));

// The published read-only view is a client-side route within the same SPA
// shell (app.js inspects location.pathname on boot and renders a separate,
// non-interactive canvas — see renderReadOnlyView) rather than a distinct
// page, so it shares all the same item-rendering logic. This route just
// makes sure navigating straight to /view/<id> (a pasted link, a new tab)
// serves that same shell instead of a 404, same as any other SPA deep link.
app.get("/view/:id", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// multer config for photo uploads: writes into the target entry's own
// uploads/ folder (created on demand) under a random filename, and rejects
// anything that isn't an image.
const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      try {
        const dir = entryUploadsDir(req.params.id);
        await fs.mkdir(dir, { recursive: true });
        cb(null, dir);
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "") || ".jpg";
      cb(null, `${uuidv4()}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Only image files are allowed."));
    cb(null, true);
  },
});

/**
 * Read and parse a single entry's JSON from disk.
 * @param {string} id - Entry id.
 * @returns {Promise<object>} The parsed entry object.
 * @throws Rejects if entries/<id>/entry.json doesn't exist or isn't valid JSON
 *   (callers treat this as "entry not found" and respond with 404).
 */
async function readEntry(id) {
  const raw = await fs.readFile(entryJsonPath(id), "utf-8");
  return JSON.parse(raw);
}

/**
 * GET /api/entries
 * List every entry as a lightweight summary for the home page grid: id,
 * title, date, item count, and a preview photo URL (the first photo item
 * found, if any). Full item data is fetched separately per-entry via
 * GET /api/entries/:id, so this stays cheap even with many entries.
 */
app.get("/api/entries", async (req, res) => {
  try {
    const ids = (await fs.readdir(ENTRIES_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const entries = await Promise.all(
      ids.map(async (id) => {
        const entry = await readEntry(id);
        const preview = (entry.items || []).find((it) => it.type === "photo" || (it.type === "bangarang" && it.img1));
        return {
          id: entry.id,
          title: entry.title,
          date: entry.date,
          itemCount: (entry.items || []).length,
          previewUrl: preview ? (preview.type === "photo" ? preview.img : preview.img1) : null,
          locked: !!entry.locked,
          layout: entry.layout === "phone" ? "phone" : "laptop",
        };
      })
    );
    entries.sort((a, b) => b.date - a.date);
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: "Could not list entries." });
  }
});

/**
 * GET /api/entries/:id
 * Return one entry's full detail (title, date, and its complete items array).
 */
app.get("/api/entries/:id", async (req, res) => {
  try {
    res.json(await readEntry(req.params.id));
  } catch (err) {
    res.status(404).json({ error: "That entry could not be found." });
  }
});

/**
 * POST /api/entries
 * Create a new, empty entry: generates an id, creates its folder (and empty
 * uploads/ subfolder) on disk, writes entry.json, and returns the new entry.
 * Body: { title?: string, layout?: "laptop"|"phone" }
 */
app.post("/api/entries", async (req, res) => {
  const id = `entry-${Date.now()}-${uuidv4().slice(0, 8)}`;
  const layout = req.body && req.body.layout === "phone" ? "phone" : "laptop";
  const entry = { id, title: (req.body && req.body.title) || "New entry", date: Date.now(), items: [], layout };
  await fs.mkdir(entryUploadsDir(id), { recursive: true });
  await fs.writeFile(entryJsonPath(id), JSON.stringify(entry, null, 2));
  res.status(201).json(entry);
});

/**
 * PUT /api/entries/:id
 * Overwrite an entry's editable fields (title, date, items, canvasBg, ...)
 * with whatever the client sends, shallow-merged onto the existing record.
 * The id itself is never changed, even if the body includes one.
 *
 * A password-protected entry (entry.locked) is encrypted client-side before
 * it ever reaches this route: its `items`/`canvasBg`/`canvasBgImage` arrive
 * as empty/null and the real content lives, ciphertext-only, in `enc` (see
 * encryptEntryPayload in app.js) — this route has no idea an entry is
 * protected and just stores whatever fields it's given, same as always.
 */
app.put("/api/entries/:id", async (req, res) => {
  try {
    const existing = await readEntry(req.params.id);
    const updated = { ...existing, ...req.body, id: existing.id };
    await fs.writeFile(entryJsonPath(req.params.id), JSON.stringify(updated, null, 2));
    res.json(updated);
  } catch (err) {
    res.status(404).json({ error: "That entry could not be found." });
  }
});

/**
 * DELETE /api/entries/:id
 * Delete an entry and everything it owns in one shot: since entry.json and
 * its uploads/ folder both live under entries/<id>/, removing that single
 * directory is enough — no per-photo cleanup bookkeeping needed.
 */
app.delete("/api/entries/:id", async (req, res) => {
  try {
    await readEntry(req.params.id); // 404 if it doesn't exist
    await fs.rm(entryDir(req.params.id), { recursive: true, force: true });
    res.status(204).end();
  } catch (err) {
    res.status(404).json({ error: "That entry could not be found." });
  }
});

/**
 * POST /api/entries/:id/uploads
 * Accept one image file (multipart field "photo") and store it inside the
 * target entry's own uploads/ folder under a random filename. Returns the
 * URL the client should store on a photo item. 404s if the entry doesn't
 * exist yet (an entry must be created before it can own uploads).
 */
app.post("/api/entries/:id/uploads", async (req, res) => {
  try {
    await readEntry(req.params.id); // 404 if the entry doesn't exist
  } catch (err) {
    return res.status(404).json({ error: "That entry could not be found." });
  }
  upload.single("photo")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || "Upload failed." });
    if (!req.file) return res.status(400).json({ error: "No file received." });
    res.status(201).json({ url: `/entries/${req.params.id}/uploads/${req.file.filename}` });
  });
});

/**
 * GET /api/style
 * Return the raw contents of the site-wide custom CSS file (the "Style Lab"
 * text the user has saved), as plain text.
 */
app.get("/api/style", async (req, res) => {
  const css = await fs.readFile(STYLE_FILE, "utf-8");
  res.type("text/plain").send(css);
});

/**
 * PUT /api/style
 * Overwrite the site-wide custom CSS file with the raw request body text.
 * A non-string body (e.g. empty request) clears the file instead of erroring.
 */
app.put("/api/style", express.text({ type: "*/*", limit: "1mb" }), async (req, res) => {
  await fs.writeFile(STYLE_FILE, typeof req.body === "string" ? req.body : "");
  res.status(204).end();
});

/**
 * Entry point: prepare on-disk state (create dirs, run migrations), then
 * start listening for HTTP requests.
 * @returns {Promise<void>}
 */
async function start() {
  await ensureDataFiles();
  app.listen(PORT, () => {
    console.log(`Scrapbook diary running at http://localhost:${PORT}`);
    console.log(`Entries are stored as folders in ${ENTRIES_DIR}`);
  });
}
start();
