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
| POST   | `/api/entries`         | Create a new entry |
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

## Extending it

- `server.js` — all routes and file I/O
- `src/public/index.html` — page structure
- `src/public/styles.css` — base scrapbook look (paper texture, polaroid/note styles, tabs)
- `src/public/app.js` — all client-side behavior: drag/rotate, uploads, saving, the Style Lab

No build step or framework — open any of the three frontend files and edit directly, then refresh the browser.
