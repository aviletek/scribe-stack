# Scribe Stack

Free open source notes organizer and task manager that runs entirely in the browser with Encryption and privacy view mode (CTRL+SHIFT+ENTER).

**Try it live:** [scribe-stack.web.app](https://scribe-stack.web.app/)

Created by **Jose AVILES**.

## What it does

- **Notes in categories** — built-in Action, Archive and Private categories, plus your own.
- **Tasks** — due dates and progress tracking.
- **Rich text** — headers, lists, colors, code, links, images and tables.
- **Linked notes** — connect related notes and jump between them.
- **Attachments** — add files of any type to a note.
- **Save and open** — keep your notebook as a file on your own computer, with autosave.
- **Encryption** — export and import notebooks protected with AES-256.
- **Print** — a single note or the whole notebook.
- **Works offline** — your notes stay in your browser and on your computer.

## Running it yourself

No installation or build step is needed.

1. Download or clone this repository.
2. Open `index.html` in a web browser, or serve the folder with any static web server.

An internet connection is needed the first time, because the page loads the Quill editor and the Inter font from public CDNs.

## Files

| File | Purpose |
|---|---|
| `index.html` | The page |
| `app.js` | Application code |
| `styles.css` | Styling |

## Analytics

`index.html` contains a Firebase Analytics block with placeholder values (`YOUR_API_KEY` and so on). Analytics stays off until you replace them with your own Firebase project settings. You can also delete the block.

## Third-party components

These are loaded from public CDNs and are not included in this repository:

- [Quill](https://quilljs.com/) rich text editor — BSD-3-Clause
- [Inter](https://fonts.google.com/specimen/Inter) font — SIL Open Font License

## Copyright

Copyright (c) 2026 Jose AVILES. All rights reserved.

The source code is published here for viewing. No license to use, copy, modify or distribute it is granted.
