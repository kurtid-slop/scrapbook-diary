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

## Extending it

- `server.js` — all routes and file I/O
- `src/public/index.html` — page structure
- `src/public/styles.css` — base scrapbook look (paper texture, polaroid/note styles, tabs)
- `src/public/app.js` — all client-side behavior: drag/rotate, uploads, saving, the Style Lab

No build step or framework — open any of the three frontend files and edit directly, then refresh the browser.
