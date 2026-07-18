# Lightweight Mentions

Obsidian plugin: type a trigger character (`@` by default) to mention anything.

- If a real note matches, it links straight to it.
- If nothing matches yet, it creates a heading inside a single shared "stub" file
  (`Mentions.md` by default) and links to that heading instead of forcing you to
  create a whole new note.
- Whenever a stub deserves to become a real note, run the **Promote mention to
  full note** command: it extracts the heading into a new file (optionally
  through a template) and rewrites every existing link across the vault to
  point at the new note.

## Status

Early draft / proof of concept — not yet published to the community plugin list.

## Development

```bash
npm install
npm run dev    # watch build
npm run build  # production build (main.js)
```

Copy `manifest.json`, `main.js`, and `styles.css` into
`<vault>/.obsidian/plugins/lightweight-mentions/` to try it in a real vault.

## Settings

- **Trigger character** — what you type to open the mention suggester (default `@`).
- **Stub file** — vault path of the shared file storing lightweight mentions as headings.
- **Promoted notes folder** — where new notes land when a mention is promoted (defaults to the stub file's folder).
- **Template file** — optional template used on promotion, with `{{title}}` / `{{content}}` placeholders.

## Known limitations (MVP)

- One global stub file — no per-topic/per-folder stub files yet.
- Heading matching for promotion is by exact text + heading level, so renaming a stub heading by hand before promoting can break the link rewrite.
- No alias support yet on file mentions.
