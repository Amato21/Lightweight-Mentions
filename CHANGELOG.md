# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- On large vaults, the mention suggester could rank an unrelated note above (or
  instead of) the note you actually meant, because fuzzy subsequence matches
  (e.g. "Vivien" matching "Vivy - Fluorite Eye's Song" by picking out scattered
  letters) were never scored or sorted against exact/prefix/substring matches.
  Results are now ranked in tiers -- exact match, then "starts with", then
  "contains", with fuzzy matching only as a last-resort fallback -- and when
  nothing solid matches, "Create ..." is now offered first instead of being
  buried at the end of the list.

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
