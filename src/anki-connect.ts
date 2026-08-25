export const DEFAULT_ANKI_CONNECT_URL = "http://127.0.0.1:8765";

export type AnkiNoteInfo = {
  noteId: number;
  tags: string[];
  fields: Record<string, { value: string; order: number }>;
  modelName: string;
  cards: number[];
};

export type BasicCardUpdate = {
  noteId: number;
  front?: string;
  back?: string;
  tags?: string[];
};

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class AnkiConnectError extends Error {
  constructor(
    message: string,
    readonly action: string,
    readonly url: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AnkiConnectError";
  }
}

export function resolveAnkiUrl(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = override || env.ANKI_CONNECT_URL || DEFAULT_ANKI_CONNECT_URL;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new AnkiConnectError(`Invalid AnkiConnect URL: ${value}`, "config", value, { cause });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AnkiConnectError("AnkiConnect URL must use http or https", "config", value);
  }
  return parsed.toString().replace(/\/$/, "");
}

export async function ankiRequest<T>(
  action: string,
  params: Record<string, unknown> = {},
  options: { url?: string; signal?: AbortSignal; fetch?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<T> {
  const url = resolveAnkiUrl(options.url, options.env);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, version: 6, params }),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    throw new AnkiConnectError(`Could not reach AnkiConnect: ${cause instanceof Error ? cause.message : String(cause)}`, action, url, { cause });
  }

  if (!response.ok) {
    throw new AnkiConnectError(`HTTP ${response.status}: ${response.statusText}`, action, url);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new AnkiConnectError("AnkiConnect returned invalid JSON", action, url, { cause });
  }
  if (!payload || typeof payload !== "object" || !("result" in payload) || !("error" in payload)) {
    throw new AnkiConnectError("AnkiConnect returned a malformed response envelope", action, url);
  }

  const envelope = payload as { result: T; error: unknown };
  if (envelope.error !== null) {
    throw new AnkiConnectError(String(envelope.error), action, url);
  }
  return envelope.result;
}

export function noteFront(note: AnkiNoteInfo): string {
  return note.fields.Front?.value ?? "";
}

export function noteBack(note: AnkiNoteInfo): string {
  return note.fields.Back?.value ?? "";
}

export function formatNoteInfo(notes: AnkiNoteInfo[]): string {
  return notes.map((note) => {
    const tags = note.tags.length ? ` tags:${note.tags.join(",")}` : "";
    return `${note.noteId}${tags}\nFront: ${noteFront(note)}\nBack: ${noteBack(note)}`;
  }).join("\n\n") || "No note info returned";
}

export async function updateBasicCard(
  update: BasicCardUpdate,
  options: { url?: string; signal?: AbortSignal; fetch?: FetchLike } = {},
): Promise<void> {
  const fields: Record<string, string> = {};
  if (update.front !== undefined) fields.Front = update.front;
  if (update.back !== undefined) fields.Back = update.back;
  if (Object.keys(fields).length === 0 && update.tags === undefined) {
    throw new Error("Provide front, back, and/or tags to update.");
  }

  if (Object.keys(fields).length > 0) {
    await ankiRequest<null>("updateNoteFields", { note: { id: update.noteId, fields } }, options);
  }

  if (update.tags !== undefined) {
    const notes = await ankiRequest<AnkiNoteInfo[]>("notesInfo", { notes: [update.noteId] }, options);
    const note = notes.find((candidate) => candidate.noteId === update.noteId);
    if (!note) throw new Error(`Anki note ${update.noteId} was not found.`);

    if (note.tags.length > 0) {
      await ankiRequest<null>("removeTags", { notes: [update.noteId], tags: note.tags.join(" ") }, options);
    }
    if (update.tags.length > 0) {
      await ankiRequest<null>("addTags", { notes: [update.noteId], tags: update.tags.join(" ") }, options);
    }
  }
}
