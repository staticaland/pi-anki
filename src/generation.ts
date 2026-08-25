export type CardDraft = {
  deckName: string;
  front: string;
  back: string;
  tags: string[];
};

export type CardImprovementSuggestion = {
  noteId: number;
  issue: string;
  front: string;
  back: string;
  tags?: string[];
};

function extractJsonObject(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced ?? raw.trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    if (start < 0) throw new Error(`Model did not return JSON: ${raw.slice(0, 120)}`);
    for (let end = candidate.length; end > start; end--) {
      if (candidate[end - 1] !== "}") continue;
      try {
        return JSON.parse(candidate.slice(start, end));
      } catch {
        // Keep looking for the end of the first complete JSON object.
      }
    }
    throw new Error(`Model returned invalid JSON: ${raw.slice(0, 120)}`);
  }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Model response field ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    throw new Error("Model response tags must be an array of strings.");
  }
  return [...new Set(value.map((tag) => tag.trim()).filter(Boolean))];
}

export function parseCardDraft(raw: string, mode: "andy" | "quick"): CardDraft {
  const value = extractJsonObject(raw);
  if (!value || typeof value !== "object") throw new Error("Model response must be a JSON object.");
  const record = value as Record<string, unknown>;
  return {
    deckName: typeof record.deckName === "string" && record.deckName.trim() ? record.deckName.trim() : "Must know",
    front: nonEmptyString(record.front, "front"),
    back: nonEmptyString(record.back, "back"),
    tags: optionalTags(record.tags) ?? (mode === "andy" ? ["pi", "andy"] : ["pi"]),
  };
}

export function parseImprovementSuggestions(raw: string, allowedNoteIds: Iterable<number>): CardImprovementSuggestion[] {
  const value = extractJsonObject(raw);
  if (!value || typeof value !== "object") throw new Error("Model response must be a JSON object.");
  const suggestions = (value as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(suggestions)) throw new Error("Model response suggestions must be an array.");

  const allowed = new Set(allowedNoteIds);
  const seen = new Set<number>();
  const parsed: CardImprovementSuggestion[] = [];
  for (const item of suggestions) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (!Number.isSafeInteger(record.noteId) || !allowed.has(record.noteId as number) || seen.has(record.noteId as number)) continue;
    const noteId = record.noteId as number;
    seen.add(noteId);
    const tags = optionalTags(record.tags);
    parsed.push({
      noteId,
      issue: typeof record.issue === "string" && record.issue.trim() ? record.issue.trim() : "Suggested improvement",
      front: nonEmptyString(record.front, "front"),
      back: nonEmptyString(record.back, "back"),
      ...(tags !== undefined ? { tags } : {}),
    });
  }
  return parsed;
}
