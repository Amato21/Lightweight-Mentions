# Lightweight Mentions

An Obsidian plugin for people who mention way more things than they want to
turn into full notes.

Type a trigger character (`@` by default) followed by a name:

- If a real note matches, it links straight to it.
- If nothing matches yet, it appends a heading to a single shared **stub
  file** (`Mentions.md` by default) and links to that heading instead of
  forcing you to create — and later manage — a whole new note.
- Whenever a stub deserves to become a real note, run **Promote mention to
  full note**: it extracts the heading into a new file (optionally through a
  template) and rewrites every existing link across the vault to point at
  the new note instead of the old heading.

---

## How to Install

### Manually
1. Download `main.js`, `manifest.json`, and `styles.css` from the
   [latest release](https://github.com/Amato21/Lightweight-Mentions/releases).
2. Copy them into `<vault>/.obsidian/plugins/lightweight-mentions/`.
3. Reload Obsidian and enable **Lightweight Mentions** in
   **Settings → Community plugins**.

### Via BRAT (beta builds)
1. Install **BRAT** from the Community Plugins store.
2. Add a Beta Plugin with this URL:
   `https://github.com/Amato21/Lightweight-Mentions`

This plugin isn't on the official Community Plugins list yet.

---

## Usage

### Mentioning something
Type `@` (configurable) followed by a name and pick a suggestion:

- An existing note → inserts `[[Note]]`.
- An existing stub heading → inserts `[[Mentions#Heading]]`.
- Nothing found → `Create "..."` appends `## Name` to the stub file and
  inserts `[[Mentions#Name]]`.

### Commands (Ctrl/Cmd + P)
- **Promote mention to full note** — run with the cursor either on a
  `[[Mentions#Heading]]` link anywhere in the vault, or inside that heading's
  section in the stub file itself. It:
  1. Creates a new note from the heading's content (through the configured
     template, if any).
  2. Removes the heading from the stub file.
  3. Rewrites every `[[Mentions#Heading]]` link across the vault to point at
     the new note.

### Configuration
Go to **Settings → Lightweight Mentions**:

- **Trigger character** — what you type to open the mention suggester
  (default `@`).
- **Stub file** — vault path of the shared file storing lightweight mentions
  as headings (default `Mentions.md`).
- **Promoted notes folder** — where new notes land when a mention is
  promoted (defaults to the stub file's own folder).
- **Template file** — optional template used on promotion, with `{{title}}`
  and `{{content}}` placeholders.

---

## Data access

To power the mention suggester, this plugin reads the list of every markdown
file in your vault (file names, not their content) plus the headings of the
stub file, on every keystroke while the suggester is open. It never reads any
other file's content, and nothing ever leaves your vault — no network
requests are made.

---

## Plugin review notes

Findings from the Obsidian plugin review, and how each was addressed:

| Finding | Status |
|---|---|
| Release name must include the `manifest.json` version | Fixed — release titles now include the version (e.g. "0.2.1 — ..."). |
| Unawaited promise (`main.ts`, command callback) | Fixed — wrapped with `void`. |
| Unsafe `any` assignment (`loadData()` into typed settings) | Fixed — result is cast to `Partial<LightweightMentionsSettings> \| null` before merging. |
| `EditorSuggest.selectSuggestion` returned `Promise<void>` instead of `void` | Fixed — split into a sync `void` method that fires a private async helper. |
| `builtin-modules` package flagged for replacement | Fixed — swapped for Node's own `module.builtinModules`. |
| Vault enumeration (`vault.getMarkdownFiles`, etc.) | Documented, not changed — see "Data access" above; required for the mention suggester to work. |

---

## Known limitations (v0.1.0)

- One global stub file — no per-topic/per-folder stub files yet.
- Heading matching for promotion is by exact text + heading level, so
  renaming a stub heading by hand before promoting can break the link
  rewrite.
- No alias support yet on file mentions.

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full version history.

## Development

```bash
npm install
npm run dev    # watch build
npm run build  # production build (main.js)
```
