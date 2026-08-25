import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import ankiExtension from "../index.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  keywords: string[];
  files: string[];
  pi: { extensions: string[]; skills: string[] };
};

describe("package manifest", () => {
  it("publishes the declared Pi extension and skill", () => {
    expect(manifest.keywords).toContain("pi-package");
    expect(manifest.pi).toEqual({ extensions: ["./index.ts"], skills: ["./skills"] });
    expect(manifest.files).toEqual(expect.arrayContaining(["index.ts", "src", "skills"]));
  });
});

describe("extension entry", () => {
  it("registers the public tools and commands", () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const pi = {
      registerTool: vi.fn((tool: { name: string }) => tools.push(tool.name)),
      registerCommand: vi.fn((name: string) => commands.push(name)),
    };

    ankiExtension(pi as never);

    expect(tools).toEqual(expect.arrayContaining([
      "anki_generate_card_gui",
      "anki_list_decks",
      "anki_add_basic_card",
      "anki_find_notes",
      "anki_find_and_read_notes",
      "anki_notes_info",
      "anki_update_basic_card",
      "anki_update_basic_cards_bulk",
      "anki_review_improvements_gui",
      "anki_sync",
    ]));
    expect(commands).toEqual(expect.arrayContaining(["anki", "anki-generate", "anki-forge", "anki-quick", "anki-decks"]));
  });
});
