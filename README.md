# pi-anki

Create, inspect, improve, and sync Anki cards from [Pi](https://pi.dev) through [AnkiConnect](https://foosoft.net/projects/anki-connect/).

`pi-anki` combines model-callable tools with interactive review flows. The default card-forging workflow generates one focused Andy Matuschak-style card, lets you edit it, and only adds it after confirmation.

## Install

### Requirements

- Node.js 20 or newer
- Pi
- Anki running locally
- The AnkiConnect add-on installed (`2055492159`)

Install the package:

```bash
pi install npm:pi-anki
```

Until the npm package is published, install from GitHub:

```bash
pi install git:github.com/staticaland/pi-anki
```

Restart Pi after installation. AnkiConnect listens at `http://127.0.0.1:8765` by default.

## Quick start

Ask Pi naturally:

```text
Make an Anki card about why prompt caching favors stable tool definitions.
```

Pi opens an interactive generator where you can:

1. review the generated draft;
2. edit the deck, front, back, and tags;
3. ask the model to improve it;
4. confirm before writing to Anki.

Or launch the flow directly:

```text
/anki-generate why active recall outperforms rereading
```

## Commands

| Command | Purpose |
|---|---|
| `/anki-generate [topic]` | Generate and review one Andy-style Basic card |
| `/anki-forge [topic]` | Alias for `/anki-generate` |
| `/anki-quick [topic]` | Generate a simpler direct card |
| `/anki` | Manually enter and add a Basic card |
| `/anki-decks` | Browse available decks |
| `/anki-review-improvements [query]` | Review suggested improvements for up to 10 matching cards |

Interactive commands require Pi's TUI mode.

## Tools

The extension registers tools for:

- interactive card generation and review;
- listing decks;
- adding Basic notes;
- finding and reading notes with Anki browser queries;
- updating one or many Basic notes;
- reviewing model-suggested improvements;
- syncing with AnkiWeb.

Direct mutation tools are intended for explicit requests or already-approved card content. Normal card creation prefers the review GUI.

## Configuration

Override the AnkiConnect endpoint with:

```bash
export ANKI_CONNECT_URL=http://127.0.0.1:8765
```

Every tool that talks to AnkiConnect also accepts a per-call `url` override.

Defaults:

- deck: `Must know`
- note type: `Basic`
- direct-add tag: `pi`
- duplicate notes: rejected

## Bundled skill

The package also ships the `anki-flashcards` skill. It helps Pi turn larger source material into focused card sets, including TSV output suitable for Anki import. The extension handles direct Anki operations and interactive single-card review.

## Safety and behavior

- Anki must be running for AnkiConnect requests to succeed.
- Model-generated improvements are restricted to the note IDs that were actually reviewed.
- Tag replacement uses AnkiConnect's documented `notesInfo`, `removeTags`, and `addTags` actions.
- Bulk updates can partially succeed; failures report which note IDs were updated before the error.
- Sync is only invoked when explicitly requested.
- Pi packages execute with your user permissions. Review third-party package source before installation.

## Development

The toolchain is pinned in `mise.toml`. With [mise](https://mise.jdx.dev/)
installed, `mise install` provides the Node version this project builds and
tests against; without it, use a Node matching `engines.node` in `package.json`.

```bash
git clone https://github.com/staticaland/pi-anki.git
cd pi-anki
mise install
npm install
npm run check
```

Try the local package without installing it globally:

```bash
pi -e .
```

The validation suite runs strict TypeScript checks, unit tests, extension registration checks, and an npm package dry run.

## Release checklist

1. Update `CHANGELOG.md` and the package version.
2. Run `npm run check`.
3. Inspect `npm pack --dry-run`.
4. Commit and tag the release.
5. Publish with npm provenance when publishing is configured.

## License

MIT
