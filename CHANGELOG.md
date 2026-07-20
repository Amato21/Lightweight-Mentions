# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- Picking a template in the promotion picker could silently produce an empty
  note (just the mention's name, no frontmatter or template content at all),
  because the modal's `onClose()` handler could run before `onChooseItem()`
  recorded the pick, resolving to "no template" first. The check is now
  deferred a tick so the actual choice is recorded before it's read.
- Promoting with a template that has no `{{content}}` placeholder silently
  discarded whatever the user had written under the mention heading -- lost
  for good, since the heading is removed from the stub file right after
  promotion. That text is now appended at the end of the note instead.

### Documentation
- Corrected 0.2.2's note which said Templater syntax in a template wouldn't
  be processed on promotion. It is, as long as Templater's own "Trigger
  Templater on new file creation" setting is enabled -- Templater processes
  any of its syntax already present in a newly created file, regardless of
  which plugin created it. See the README's updated "Templater note" under
  Commands.

## [0.2.2] - 2026-07-18

### Changed
- Replaced the single "Template file" setting with a "Template folder" one.
  Promoting a mention now asks which template in that folder to apply (or
  none, via Esc), instead of always using the same fixed template.

### Note
- The plugin does not run Templater syntax through Templater when applying a
  template on promotion -- see the README's "Templater note" under Commands.

## [0.2.1] - 2026-07-18

### Fixed
- A query hiding mid-word inside an unrelated title (e.g. "test" inside
  "Fatestrange Fake") no longer counts as a real match: matching now requires
  the query to start an actual word in the title (tokenizing on any
  non-letter/non-digit run), not just appear as a substring anywhere. This
  was still flooding results with irrelevant titles and, on vaults without a
  real match, still burying "Create ..." behind them.
- Fuzzy fallback matches are no longer mixed in alongside real (exact/prefix/
  word) matches -- they're now shown on their own, only when nothing real
  matched at all, so a good result list is never diluted with noise.

### Documentation
- Documented the plugin's vault-enumeration data access (reads every file
  name in the vault, plus stub file headings, to power the suggester; never
  reads other files' content and makes no network requests) in the README,
  per the Obsidian plugin review's recommendation.

## [0.2.0] - 2026-07-18

### Fixed
- On large vaults, the mention suggester could rank an unrelated note above (or
  instead of) the note you actually meant, because fuzzy subsequence matches
  (e.g. "Vivien" matching "Vivy - Fluorite Eye's Song" by picking out scattered
  letters) were never scored or sorted against exact/prefix/substring matches.
  Results are now ranked in tiers -- exact match, then "starts with", then
  "contains", with fuzzy matching only as a last-resort fallback -- and when
  nothing solid matches, "Create ..." is now offered first instead of being
  buried at the end of the list.
- A fire-and-forget promise, an unsafe `any` assignment on settings load, and
  an `EditorSuggest.selectSuggestion` override returning a `Promise` where the
  base class expects `void` -- all flagged by the Obsidian plugin review bot.
- Swapped the third-party `builtin-modules` package for Node's own
  `module.builtinModules`.

### Added
- `tests/ranking.test.mjs`: a regression test for the ranking fix above, run
  via `npm test`.

## [0.1.0] - 2026-07-18

### Added
- `@`-trigger (configurable) mention suggester: matches existing notes and
  existing stub headings, or offers to create a new one.
- Lightweight mentions: an unresolved mention appends a heading to a shared
  stub file (`Mentions.md` by default) instead of forcing a new note.
- **Promote mention to full note** command: extracts a stub heading into a
  new note (optionally through a template with `{{title}}`/`{{content}}`
  placeholders) and rewrites every existing `[[Mentions#Heading]]` link
  across the vault to point at the new note.
- Settings tab: trigger character, stub file path, promoted notes folder,
  template file.
