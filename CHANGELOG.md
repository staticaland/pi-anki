# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-25

### Added

- Installable Pi package with AnkiConnect tools and interactive TUI workflows.
- Andy-style and quick single-card generation modes.
- Search, note inspection, update, bulk update, review, deck listing, and sync tools.
- Bundled `anki-flashcards` skill for larger card-generation tasks.
- Strict TypeScript checks, unit tests, packaging checks, and GitHub Actions CI.

### Fixed

- Restrict generated improvement suggestions to reviewed note IDs.
- Replace unsupported tag mutation with documented AnkiConnect tag actions.
- Validate AnkiConnect envelopes, model-generated JSON, and bounded tool limits.
- Propagate tool failures through Pi's error semantics.

[Unreleased]: https://github.com/staticaland/pi-anki/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/staticaland/pi-anki/releases/tag/v0.1.0
