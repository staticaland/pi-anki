import { describe, expect, it, vi } from "vitest";
import {
  AnkiConnectError,
  ankiRequest,
  resolveAnkiUrl,
  updateBasicCard,
  type AnkiNoteInfo,
} from "../src/anki-connect.ts";

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("resolveAnkiUrl", () => {
  it("uses override, then environment, then the local default", () => {
    expect(resolveAnkiUrl("http://example.test:9999/", { ANKI_CONNECT_URL: "http://env.test" })).toBe("http://example.test:9999");
    expect(resolveAnkiUrl(undefined, { ANKI_CONNECT_URL: "http://env.test/" })).toBe("http://env.test");
    expect(resolveAnkiUrl(undefined, {})).toBe("http://127.0.0.1:8765");
  });

  it("rejects non-http protocols", () => {
    expect(() => resolveAnkiUrl("file:///tmp/anki")).toThrow(AnkiConnectError);
  });
});

describe("ankiRequest", () => {
  it("sends an AnkiConnect v6 request", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({ result: ["Default"], error: null }));
    await expect(ankiRequest<string[]>("deckNames", {}, { fetch })).resolves.toEqual(["Default"]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8765");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ action: "deckNames", version: 6, params: {} });
  });

  it("rejects HTTP, remote, invalid JSON, and malformed envelope failures", async () => {
    await expect(ankiRequest("x", {}, { fetch: async () => new Response("no", { status: 500, statusText: "Boom" }) })).rejects.toThrow("HTTP 500");
    await expect(ankiRequest("x", {}, { fetch: async () => jsonResponse({ result: null, error: "remote failed" }) })).rejects.toThrow("remote failed");
    await expect(ankiRequest("x", {}, { fetch: async () => new Response("not-json") })).rejects.toThrow("invalid JSON");
    await expect(ankiRequest("x", {}, { fetch: async () => jsonResponse({ result: null }) })).rejects.toThrow("malformed response envelope");
  });
});

describe("updateBasicCard", () => {
  it("replaces tags using supported notesInfo/removeTags/addTags actions", async () => {
    const actions: Array<{ action: string; params: Record<string, unknown> }> = [];
    const note: AnkiNoteInfo = {
      noteId: 42,
      tags: ["old", "keep-no"],
      fields: { Front: { value: "before", order: 0 }, Back: { value: "back", order: 1 } },
      modelName: "Basic",
      cards: [99],
    };
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { action: string; params: Record<string, unknown> };
      actions.push(request);
      return jsonResponse({ result: request.action === "notesInfo" ? [note] : null, error: null });
    });

    await updateBasicCard({ noteId: 42, front: "after", tags: ["new"] }, { fetch });

    expect(actions.map(({ action }) => action)).toEqual(["updateNoteFields", "notesInfo", "removeTags", "addTags"]);
    expect(actions[2]?.params).toEqual({ notes: [42], tags: "old keep-no" });
    expect(actions[3]?.params).toEqual({ notes: [42], tags: "new" });
  });

  it("rejects a no-op update", async () => {
    await expect(updateBasicCard({ noteId: 42 }, { fetch: vi.fn() })).rejects.toThrow("Provide front, back, and/or tags");
  });
});
