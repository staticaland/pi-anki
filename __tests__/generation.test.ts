import { describe, expect, it } from "vitest";
import { parseCardDraft, parseImprovementSuggestions } from "../src/generation.ts";

describe("parseCardDraft", () => {
  it("parses plain and fenced JSON", () => {
    expect(parseCardDraft('{"front":"Why?","back":"Because.","tags":["x","x"]}', "andy")).toEqual({
      deckName: "Must know",
      front: "Why?",
      back: "Because.",
      tags: ["x"],
    });
    expect(parseCardDraft('```json\n{"deckName":"D","front":"F","back":"B"}\n```', "quick")).toEqual({
      deckName: "D",
      front: "F",
      back: "B",
      tags: ["pi"],
    });
  });

  it("rejects malformed or empty card fields", () => {
    expect(() => parseCardDraft("not json", "andy")).toThrow("did not return JSON");
    expect(() => parseCardDraft('{"front":"","back":"B"}', "andy")).toThrow("front");
    expect(() => parseCardDraft('{"front":2,"back":"B"}', "andy")).toThrow("front");
  });
});

describe("parseImprovementSuggestions", () => {
  it("allows only unique IDs from the reviewed notes", () => {
    const raw = JSON.stringify({ suggestions: [
      { noteId: 1, issue: "clearer", front: "F1", back: "B1" },
      { noteId: 999, issue: "hallucinated", front: "Bad", back: "Bad" },
      { noteId: 1, issue: "duplicate", front: "Bad", back: "Bad" },
      { noteId: 2, front: "F2", back: "B2", tags: ["reviewed"] },
    ] });
    expect(parseImprovementSuggestions(raw, [1, 2])).toEqual([
      { noteId: 1, issue: "clearer", front: "F1", back: "B1" },
      { noteId: 2, issue: "Suggested improvement", front: "F2", back: "B2", tags: ["reviewed"] },
    ]);
  });
});
