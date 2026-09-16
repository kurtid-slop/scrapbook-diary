# Scrapbook Diary

A scrapbook-style diary. Photos and notes can be dragged and rotated anywhere on the page, and a Style Lab tab lets you write custom CSS that restyles the whole site live.

## How it stores things

There's no database. Everything lives as plain files on disk under `src/data/`, created automatically the first time you run the server:

```
src/data/
  entries/        one JSON file per diary entry, e.g. entry-1706812345-a1b2c3d4.json
  uploads/        uploaded photo files (originals, resized client-side isn't done here)
  style.css       your custom CSS from the Style Lab
```

Open any entry's JSON file directly to see its shape — title, date, and a list of items (photos and notes) with position, rotation, and size.

A photo picked as HEIC/HEIF (the default format for an iPhone's Camera Roll) is converted to JPEG right in the browser before it's ever uploaded — every browser except Safari just renders a HEIC `<img>` as a broken image, so uploading it as-is would silently produce a photo, bangarang, or crop preview that never shows.

## Running it

```bash
npm install
npm start
```

Then open http://localhost:3000.

## API

| Method | Path              | Does |
|--------|-------------------|------|
| GET    | `/api/entries`        | List all entries (summary: title, date, item count, preview photo) |
| GET    | `/api/entries/:id`     | Full entry, including all items |
| POST   | `/api/entries`         | Create a new entry (optionally `{ layout: "laptop"\|"phone" }`) |
| PUT    | `/api/entries/:id`     | Update an entry's title, date, or items |
| DELETE | `/api/entries/:id`     | Delete an entry and its uploaded photos |
| POST   | `/api/uploads`         | Upload a photo (multipart `photo` field), returns its URL |
| GET    | `/api/style`           | Read the current custom CSS |
| PUT    | `/api/style`           | Save custom CSS |

## Password-protecting an entry

Click **🔓 Protect** in an entry's toolbar to set a password on it. From
then on, opening that entry — for editing, on the live app's `/view/<id>`
preview, or on the static GitHub Pages export — asks for the password
first.

This isn't just a UI gate: the entry's `items`/`canvasBg`/`canvasBgImage`
are AES-GCM encrypted (key derived from the password via PBKDF2) before
they're ever written to `entry.json`, so the file on disk (and the one
GitHub Pages serves) never holds a protected entry's content in plaintext —
only its title and date stay visible, so you can still find it in the list.
Decryption happens entirely in the browser via the Web Crypto API; there's
no password stored anywhere, live server included, so losing the password
means losing that entry's content.

Change or remove a password from the same **🔒 Protected** button once
you've unlocked the entry.

## Bangarang

Click **⚡ Bangarang**, choose two images (one button per image, so there's
no need to know about multi-selecting files), and Add — it becomes an item
that flickers between them forever. Select it to get a delay slider on its
bar, from 30ms up to 1 second, live-updating the speed as you drag. Works
the same in the editor, the live preview, and the static export.

## Laptop vs. smartphone entries

**+ New entry** first asks which kind of page this is — **Laptop** (the
original wide canvas, place things freely anywhere) or **Smartphone** (the
same endless-vertical-scroll canvas, just narrowed and centered to read
like a phone screen). It's a display-only choice made once at creation
(`entry.layout`, in the entry's JSON) — every item's position is already
stored as a percentage of the canvas's own width, so narrowing it needs no
data conversion and works the same in the editor, the live preview, and the
static export.

## Photo frames and background removal

When cropping a photo (the **+ Photo** flow), a **🪄 Remove Background**
button cuts out the subject before you crop — entirely in your browser via
a small ML model ([@imgly/background-removal](https://github.com/imgly/background-removal-js),
loaded from a CDN only when you click it, so most uploads never pay for it).
The first click downloads its model weights (tens of MB), which can take a
minute; after that, the crop exports as a transparent PNG instead of a
JPEG, so the cutout sits naturally on whatever frame you give it.

Once a photo's on the canvas, select it for a 3-way frame picker on its
bar: the classic polaroid, frameless, or a torn-paper border (a jagged
`clip-path` edge, not an actual different crop) — try the torn border with
a background-removed cutout for a real cut-and-pasted-onto-paper look.

## Saving an entry as one image

**⬇️ Save Image** — in the editor's toolbar, the live preview, and every
published page — rasterizes the whole entry to a single big PNG and
downloads it, via [html2canvas](https://html2canvas.hertzen.com/) (also
loaded from a CDN only on click). The editor's own version renders an
offscreen, read-only copy of the entry first rather than exporting its
live canvas directly — that one keeps an endless-scroll buffer below the
actual content and can have selection handles showing, neither of which
belongs in the exported image. A music item can't show a video playing in
a still image, so it exports as a plain "🎵" placeholder instead of trying
to capture its (cross-origin, uncapturable anyway) embed.

## Extending it

- `server.js` — all routes and file I/O
- `src/public/index.html` — page structure
- `src/public/styles.css` — base scrapbook look (paper texture, polaroid/note styles, tabs)
- `src/public/app.js` — all client-side behavior: drag/rotate, uploads, saving, the Style Lab

No build step or framework — open any of the three frontend files and edit directly, then refresh the browser.
