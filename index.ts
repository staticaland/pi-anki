import type { UserMessage } from "@earendil-works/pi-ai";
import { BorderedLoader, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type Focusable, matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	ankiRequest,
	formatNoteInfo,
	noteBack,
	noteFront,
	updateBasicCard as applyBasicCardUpdate,
	type AnkiNoteInfo,
	type BasicCardUpdate,
} from "./src/anki-connect.ts";
import {
	parseCardDraft,
	parseImprovementSuggestions,
	type CardDraft,
	type CardImprovementSuggestion,
} from "./src/generation.ts";

type AddCardDetails = {
	action: "addBasicCard";
	deckName: string;
	modelName: string;
	front: string;
	back: string;
	tags: string[];
	noteId?: number;
	error?: string;
};

type ListDecksDetails = {
	action: "listDecks";
	decks: string[];
	error?: string;
};

type NotesInfoDetails = {
	action: "notesInfo";
	noteIds: number[];
	notes?: AnkiNoteInfo[];
	error?: string;
};

type UpdateBasicCardDetails = {
	action: "updateBasicCard";
	noteId: number;
	front?: string;
	back?: string;
	tags?: string[];
	error?: string;
};

type BulkUpdateBasicCardsDetails = {
	action: "updateBasicCardsBulk";
	requested: number;
	updated: number[];
	failed: { noteId: number; error: string }[];
};

const AnkiConfigParams = Type.Object({
	url: Type.Optional(Type.String({ description: "AnkiConnect URL. Defaults to http://127.0.0.1:8765" })),
});

const AddBasicCardParams = Type.Object({
	deckName: Type.Optional(Type.String({ description: "Anki deck name. Defaults to Must know." })),
	front: Type.String({ description: "Front side of the Basic card" }),
	back: Type.String({ description: "Back side of the Basic card" }),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Optional Anki tags" })),
	modelName: Type.Optional(Type.String({ description: "Anki note type. Defaults to Basic." })),
	allowDuplicate: Type.Optional(Type.Boolean({ description: "Allow adding if Anki reports duplicate. Defaults false." })),
	url: Type.Optional(Type.String({ description: "AnkiConnect URL override" })),
});

const FindNotesParams = Type.Object({
	query: Type.String({ description: "Anki browser search query, e.g. deck:\"Must know\" tag:pi" }),
	url: Type.Optional(Type.String({ description: "AnkiConnect URL override" })),
});

const NotesInfoParams = Type.Object({
	noteIds: Type.Array(Type.Integer({ minimum: 1, description: "Anki note IDs to inspect" }), { minItems: 1, maxItems: 100 }),
	url: Type.Optional(Type.String({ description: "AnkiConnect URL override" })),
});

const UpdateBasicCardParams = Type.Object({
	noteId: Type.Integer({ minimum: 1, description: "Anki note ID to update" }),
	front: Type.Optional(Type.String({ description: "New Front field value. Omit to leave unchanged." })),
	back: Type.Optional(Type.String({ description: "New Back field value. Omit to leave unchanged." })),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Replace note tags with these tags. Omit to leave unchanged." })),
	url: Type.Optional(Type.String({ description: "AnkiConnect URL override" })),
});

const BulkUpdateBasicCardsParams = Type.Object({
	updates: Type.Array(Type.Object({
		noteId: Type.Integer({ minimum: 1, description: "Anki note ID to update" }),
		front: Type.Optional(Type.String({ description: "New Front field value. Omit to leave unchanged." })),
		back: Type.Optional(Type.String({ description: "New Back field value. Omit to leave unchanged." })),
		tags: Type.Optional(Type.Array(Type.String(), { description: "Replace note tags with these tags. Omit to leave unchanged." })),
	}), { minItems: 1, maxItems: 100, description: "Basic note updates to apply" }),
	url: Type.Optional(Type.String({ description: "AnkiConnect URL override" })),
});

const FindAndReadNotesParams = Type.Object({
	query: Type.String({ description: "Anki browser search query, e.g. deck:\"Must know\" tag:pi" }),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum matching notes to read. Defaults to 25." })),
	url: Type.Optional(Type.String({ description: "AnkiConnect URL override" })),
});

const ReviewImprovementsGuiParams = Type.Object({
	query: Type.Optional(Type.String({ description: "Anki browser query for cards to review. Defaults to deck:\"Must know\"." })),
	noteIds: Type.Optional(Type.Array(Type.Integer({ minimum: 1, description: "Specific Anki note IDs to review" }), { minItems: 1, maxItems: 50 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum notes to review. Defaults to 10." })),
	url: Type.Optional(Type.String({ description: "AnkiConnect URL override" })),
});

const SyncParams = Type.Object({
	url: Type.Optional(Type.String({ description: "AnkiConnect URL override" })),
});

function stringEnum<T extends readonly string[]>(values: T, options?: { description?: string; default?: T[number] }) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}

const GenerateCardGuiParams = Type.Object({
	prompt: Type.Optional(Type.String({ description: "Seed prompt/topic to turn into an Anki card. If omitted, the GUI asks the user." })),
	mode: Type.Optional(stringEnum(["andy", "quick"] as const, { description: "Card generation style. Defaults to andy (Matuschak-style: atomic, why/how/contrast, misconception-aware). Use quick for a direct simple card." })),
});

type CardGenerationMode = "andy" | "quick";
type GeneratorResult =
	| { action: "cancel" }
	| { action: "generate"; prompt: string; draft?: CardDraft; instruction?: string }
	| { action: "add"; draft: CardDraft };

const QUICK_CARD_GENERATOR_SYSTEM_PROMPT = `You generate high-quality Anki Basic cards.
Return ONLY JSON with this exact shape:
{"deckName":"Must know","front":"concise question","back":"answer/explanation","tags":["pi"]}
Rules:
- Make exactly one atomic card.
- Front should be short and test one idea.
- Back should contain the useful answer/explanation.
- Default deckName is "Must know" unless the prompt clearly asks otherwise.
- Use short lowercase tags, no # prefix.`;

const ANDY_CARD_GENERATOR_SYSTEM_PROMPT = `You generate Andy Matuschak-style Anki Basic cards.
Internally do the card-forging work first: extract the smallest durable claim, split bundled ideas, prefer why/how/contrast prompts, and guard against likely misconceptions. Do NOT reveal this analysis.
Return ONLY JSON with this exact shape:
{"deckName":"Must know","front":"concise question","back":"answer/explanation","tags":["pi","andy"]}
Rules:
- Make exactly one atomic card: one prompt should test one idea.
- Prefer understanding prompts over labels: "why", "how", "what distinction", or "what misconception".
- Prefer contrast when useful (X vs Y) to create strong retrieval cues.
- The front must be specific enough to avoid guessing from vague topic words.
- The back should be concise but explanatory: answer, causal mechanism, and any crucial caveat.
- If the source contains multiple good ideas, choose the highest-value card rather than making a broad card.
- Default deckName is "Must know" unless the prompt clearly asks otherwise.
- Use short lowercase tags, no # prefix; include "andy" unless the user asks for quick/simple mode.`;

function cardGeneratorSystemPrompt(mode: CardGenerationMode): string {
	return mode === "quick" ? QUICK_CARD_GENERATOR_SYSTEM_PROMPT : ANDY_CARD_GENERATOR_SYSTEM_PROMPT;
}

async function anki<T>(action: string, params: Record<string, unknown> = {}, url?: string, signal?: AbortSignal): Promise<T> {
	return ankiRequest<T>(action, params, { ...(url !== undefined ? { url } : {}), ...(signal !== undefined ? { signal } : {}) });
}

function summarizeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function updateBasicCard(update: BasicCardUpdate, url?: string, signal?: AbortSignal): Promise<void> {
	await applyBasicCardUpdate(update, { ...(url !== undefined ? { url } : {}), ...(signal !== undefined ? { signal } : {}) });
}

function padVisible(s: string, width: number): string {
	return s + " ".repeat(Math.max(0, width - visibleWidth(s)));
}

class AnkiGenerateCardComponent implements Focusable {
	focused = false;
	private selected = 0;
	private prompt: { label: string; value: string; cursor: number; multiline: boolean };
	private instruction = { label: "Improve", value: "", cursor: 0, multiline: false };
	private draftFields = [
		{ label: "Deck", value: "Must know", cursor: "Must know".length, multiline: false },
		{ label: "Front", value: "", cursor: 0, multiline: true },
		{ label: "Back", value: "", cursor: 0, multiline: true },
		{ label: "Tags", value: "pi", cursor: "pi".length, multiline: false },
	];
	private message = "";

	constructor(private theme: Theme, private mode: CardGenerationMode, initialPrompt: string | undefined, initialDraft: CardDraft | undefined, initialInstruction: string | undefined, private done: (result: GeneratorResult) => void) {
		this.prompt = { label: "Prompt", value: initialPrompt ?? "", cursor: (initialPrompt ?? "").length, multiline: true };
		if (initialDraft) {
			this.setDraft(initialDraft);
			this.selected = this.fields().length - 1;
		}
		if (initialInstruction) {
			this.instruction.value = initialInstruction;
			this.instruction.cursor = initialInstruction.length;
		}
	}

	private setDraft(draft: CardDraft): void {
		const values = [draft.deckName || "Must know", draft.front || "", draft.back || "", (draft.tags || ["pi"]).join(" ")];
		for (let i = 0; i < this.draftFields.length; i++) {
			this.draftFields[i]!.value = values[i]!;
			this.draftFields[i]!.cursor = values[i]!.length;
		}
	}

	private get draft(): CardDraft {
		const [deck, front, back, tags] = this.draftFields;
		return {
			deckName: deck!.value.trim() || "Must know",
			front: front!.value.trim(),
			back: back!.value.trim(),
			tags: tags!.value.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean),
		};
	}

	private fields() {
		return [this.prompt, ...this.draftFields, this.instruction];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.done({ action: "cancel" });
		const fieldCount = this.fields().length;
		const actionStart = fieldCount;
		const max = actionStart + 2;
		if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) return void (this.selected = Math.max(0, this.selected - 1));
		if (matchesKey(data, "down") || matchesKey(data, "tab")) {
			const next = this.selected + 1;
			return void (this.selected = this.selected === actionStart - 1 && this.instruction.value.trim() && this.draft.front && this.draft.back ? actionStart + 1 : Math.min(max, next));
		}
		if (matchesKey(data, "return")) {
			if (this.selected === actionStart) return this.generate();
			if (this.selected === actionStart + 1) return this.improve();
			if (this.selected === actionStart + 2) return this.add();
			const field = this.fields()[this.selected]!;
			if (field === this.instruction && this.instruction.value.trim() && this.draft.front && this.draft.back) return this.improve();
			if (field.multiline) this.insert("\n");
			else this.selected = Math.min(max, this.selected + 1);
			return;
		}
		const field = this.fields()[this.selected];
		if (!field) return;
		if (matchesKey(data, "backspace")) {
			if (field.cursor > 0) {
				field.value = field.value.slice(0, field.cursor - 1) + field.value.slice(field.cursor);
				field.cursor--;
			}
		} else if (matchesKey(data, "left")) field.cursor = Math.max(0, field.cursor - 1);
		else if (matchesKey(data, "right")) field.cursor = Math.min(field.value.length, field.cursor + 1);
		else if (data.length === 1 && data.charCodeAt(0) >= 32) this.insert(data);
	}

	private insert(text: string): void {
		const field = this.fields()[this.selected];
		if (!field) return;
		field.value = field.value.slice(0, field.cursor) + text + field.value.slice(field.cursor);
		field.cursor += text.length;
	}

	private generate(): void {
		if (!this.prompt.value.trim()) {
			this.message = "Prompt is required.";
			return;
		}
		this.done({ action: "generate", prompt: this.prompt.value.trim() });
	}

	private improve(): void {
		if (!this.draft.front || !this.draft.back) return this.generate();
		if (!this.instruction.value.trim()) {
			this.message = "Add an improvement instruction first.";
			return;
		}
		this.done({ action: "generate", prompt: this.prompt.value.trim(), draft: this.draft, instruction: this.instruction.value.trim() });
	}

	private add(): void {
		if (!this.draft.front || !this.draft.back) {
			this.message = "Generate or fill Front and Back first.";
			return;
		}
		this.done({ action: "add", draft: this.draft });
	}

	render(width: number): string[] {
		const th = this.theme;
		const w = Math.max(2, Math.min(width, 100));
		const inner = w - 2;
		const lines: string[] = [];
		const row = (content = "") => th.fg("border", "│") + truncateToWidth(padVisible(content, inner), inner) + th.fg("border", "│");
		lines.push(th.fg("border", `╭${"─".repeat(inner)}╮`));
		const modeLabel = this.mode === "andy" ? "Andy Matuschak mode" : "quick mode";
		const modeHint = this.mode === "andy" ? "atomic • why/how/contrast • misconception-aware" : "draft → improve → add";
		lines.push(row(` ${th.fg("accent", `🃏 Generate Anki card`)} ${th.fg("dim", modeLabel)}`));
		lines.push(row(` ${th.fg("dim", modeHint)}`));
		lines.push(row());
		const allFields = this.fields();
		for (let i = 0; i < allFields.length; i++) {
			const field = allFields[i]!;
			const selected = i === this.selected;
			const label = selected ? th.fg("accent", `▶ ${field.label}`) : th.fg("muted", `  ${field.label}`);
			lines.push(row(` ${label}`));
			for (const part of this.renderValue(field.value, field.cursor, selected).split("\n")) lines.push(row(`    ${part || th.fg("dim", "…")}`));
			if (i === 0 || i === 4) lines.push(row());
		}
		const actionStart = allFields.length;
		const hasDraft = Boolean(this.draft.front && this.draft.back);
		const action = (idx: number, text: string, color: "accent" | "success" | "muted") => this.selected === idx ? th.fg(color, `▶ ${text}`) : th.fg("muted", `  ${text}`);
		lines.push(row(` ${action(actionStart, hasDraft ? "Regenerate draft" : "Generate draft", "accent")}   ${action(actionStart + 1, "Improve draft", "accent")}   ${action(actionStart + 2, "Add to Anki", "success")}`));
		if (this.message) lines.push(row(` ${th.fg("error", this.message)}`));
		lines.push(row(` ${th.fg("dim", "↑↓/Tab move • Enter edit/action • Esc cancel")}`));
		lines.push(th.fg("border", `╰${"─".repeat(inner)}╯`));
		return lines;
	}

	private renderValue(value: string, cursor: number, selected: boolean): string {
		if (!selected) return this.theme.fg("text", value);
		const before = value.slice(0, cursor);
		const cursorChar = cursor < value.length ? value[cursor] : " ";
		const after = value.slice(cursor + 1);
		const marker = this.focused ? CURSOR_MARKER : "";
		return this.theme.fg("text", `${before}${marker}\x1b[7m${cursorChar}\x1b[27m${after}`);
	}

	invalidate(): void {}
	dispose(): void {}
}

async function generateCardDraft(ctx: ExtensionCommandContext | ExtensionContext, prompt: string, draft?: CardDraft, instruction?: string, signal?: AbortSignal, mode: CardGenerationMode = "andy"): Promise<CardDraft> {
	if (!ctx.model) throw new Error("No model selected");
	const text = instruction && draft
		? `Original prompt: ${prompt}\n\nCurrent draft JSON:\n${JSON.stringify(draft, null, 2)}\n\nImprove instruction: ${instruction}`
		: prompt;
	const userMessage: UserMessage = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
	const response = await ctx.modelRegistry.complete(ctx.model, { systemPrompt: cardGeneratorSystemPrompt(mode), messages: [userMessage] }, { signal });
	const raw = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
	return parseCardDraft(raw, mode);
}

async function generateCardImprovementSuggestions(ctx: ExtensionCommandContext | ExtensionContext, notes: AnkiNoteInfo[], signal?: AbortSignal): Promise<CardImprovementSuggestion[]> {
	if (!ctx.model) throw new Error("No model selected");
	const systemPrompt = `You improve existing Anki Basic cards using Andy Matuschak-style prompt-writing principles.
Return ONLY JSON with this exact shape:
{"suggestions":[{"noteId":123,"issue":"brief reason","front":"improved question","back":"improved answer","tags":["optional","tags"]}]}
Rules:
- Suggest an update only when it is a clear improvement.
- Keep one atomic unit of knowledge per card.
- Front must be precise, focused, tractable, and effortful.
- Put the exact answer first on Back; include brief explanatory context only if useful.
- Do not invent facts beyond the original card.
- If a card bundles two facts, improve the existing note for the highest-value fact; mention the split need in issue.
- Preserve the card's language unless there is a strong reason not to.`;
	const text = `Review these Anki notes and suggest no-brainer improvements:\n\n${formatNoteInfo(notes)}`;
	const userMessage: UserMessage = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
	const response = await ctx.modelRegistry.complete(ctx.model, { systemPrompt, messages: [userMessage] }, { signal });
	const raw = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
	return parseImprovementSuggestions(raw, notes.map((note) => note.noteId));
}

async function openAnkiGeneratorGui(ctx: ExtensionCommandContext | ExtensionContext, initialPrompt?: string, mode: CardGenerationMode = "andy", hostSignal?: AbortSignal): Promise<{ added?: number; cancelled?: boolean; draft?: CardDraft; error?: string }> {
	if (ctx.mode !== "tui") return { error: "Anki card generator GUI requires interactive TUI mode" };
	let prompt = initialPrompt ?? "";
	let draft: CardDraft | undefined;
	let instruction = "";
	if (prompt.trim()) {
		draft = await ctx.ui.custom<CardDraft | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, `Generating ${mode === "andy" ? "Andy-style" : "quick"} card draft using ${ctx.model?.id ?? "model"}...`);
			loader.onAbort = () => done(null);
			const signal = hostSignal ? AbortSignal.any([loader.signal, hostSignal]) : loader.signal;
			generateCardDraft(ctx, prompt.trim(), undefined, undefined, signal, mode).then(done).catch((error) => {
				ctx.ui.notify(`Card generation error: ${summarizeError(error)}`, "error");
				done(null);
			});
			return loader;
		}, { overlay: true, overlayOptions: { width: "60%", minWidth: 50, anchor: "center" } }) ?? undefined;
	}
	while (true) {
		const result = await ctx.ui.custom<GeneratorResult>((tui, theme, _kb, done) => {
			const component = new AnkiGenerateCardComponent(theme, mode, prompt, draft, instruction, done);
			return {
				get focused() { return component.focused; },
				set focused(value: boolean) { component.focused = value; },
				render: (width: number) => component.render(width),
				invalidate: () => component.invalidate(),
				dispose: () => component.dispose(),
				handleInput: (data: string) => { component.handleInput(data); tui.requestRender(); },
			};
		}, { overlay: true, overlayOptions: { width: "90%", maxHeight: "95%", minWidth: 70, anchor: "center" } });
		if (result.action === "cancel") return { cancelled: true, ...(draft !== undefined ? { draft } : {}) };
		if (result.action === "add") {
			const noteId = await anki<number>("addNote", { note: { deckName: result.draft.deckName, modelName: "Basic", fields: { Front: result.draft.front, Back: result.draft.back }, options: { allowDuplicate: false }, tags: result.draft.tags } }, undefined, hostSignal);
			ctx.ui.notify(`Added Anki note ${noteId} to ${result.draft.deckName}`, "info");
			return { added: noteId, draft: result.draft };
		}
		prompt = result.prompt;
		if (result.instruction !== undefined) instruction = result.instruction;
		draft = await ctx.ui.custom<CardDraft | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, `${result.instruction ? "Improving" : "Generating"} ${mode === "andy" ? "Andy-style" : "quick"} card using ${ctx.model?.id ?? "model"}...`);
			loader.onAbort = () => done(null);
			const signal = hostSignal ? AbortSignal.any([loader.signal, hostSignal]) : loader.signal;
			generateCardDraft(ctx, result.prompt, result.draft, result.instruction, signal, mode).then(done).catch((error) => {
				ctx.ui.notify(`Card generation error: ${summarizeError(error)}`, "error");
				done(null);
			});
			return loader;
		}, { overlay: true, overlayOptions: { width: "60%", minWidth: 50, anchor: "center" } }) ?? draft;
	}
}

class AnkiAddCardComponent implements Focusable {
	focused = false;
	private selected = 1;
	private message = "";
	private saving = false;
	private fields = [
		{ label: "Deck", value: "Must know", cursor: "Must know".length, multiline: false },
		{ label: "Front", value: "", cursor: 0, multiline: true },
		{ label: "Back", value: "", cursor: 0, multiline: true },
		{ label: "Tags", value: "pi", cursor: "pi".length, multiline: false },
	];

	constructor(
		private theme: Theme,
		private done: (result: { deckName: string; front: string; back: string; tags: string[] } | undefined) => void,
	) {}

	handleInput(data: string): void {
		if (this.saving) return;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.done(undefined);
		if (matchesKey(data, "up")) return void (this.selected = Math.max(0, this.selected - 1));
		if (matchesKey(data, "down") || matchesKey(data, "tab")) return void (this.selected = Math.min(this.fields.length, this.selected + 1));
		if (matchesKey(data, "shift+tab")) return void (this.selected = Math.max(0, this.selected - 1));
		if (matchesKey(data, "return")) {
			if (this.selected === this.fields.length) return this.submit();
			const field = this.fields[this.selected]!;
			if (field.multiline) this.insert("\n");
			else this.selected = Math.min(this.fields.length, this.selected + 1);
			return;
		}

		const field = this.fields[this.selected];
		if (!field) return;
		if (matchesKey(data, "backspace")) {
			if (field.cursor > 0) {
				field.value = field.value.slice(0, field.cursor - 1) + field.value.slice(field.cursor);
				field.cursor--;
			}
		} else if (matchesKey(data, "left")) {
			field.cursor = Math.max(0, field.cursor - 1);
		} else if (matchesKey(data, "right")) {
			field.cursor = Math.min(field.value.length, field.cursor + 1);
		} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.insert(data);
		}
	}

	private insert(text: string): void {
		const field = this.fields[this.selected];
		if (!field) return;
		field.value = field.value.slice(0, field.cursor) + text + field.value.slice(field.cursor);
		field.cursor += text.length;
	}

	private submit(): void {
		const [deck, front, back, tags] = this.fields;
		if (!front!.value.trim() || !back!.value.trim()) {
			this.message = "Front and Back are required.";
			return;
		}
		this.saving = true;
		this.done({
			deckName: deck!.value.trim() || "Must know",
			front: front!.value.trim(),
			back: back!.value.trim(),
			tags: tags!.value.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean),
		});
	}

	render(width: number): string[] {
		const th = this.theme;
		const w = Math.max(2, Math.min(width, 90));
		const inner = w - 2;
		const lines: string[] = [];
		const row = (content = "") => th.fg("border", "│") + truncateToWidth(padVisible(content, inner), inner) + th.fg("border", "│");
		lines.push(th.fg("border", `╭${"─".repeat(inner)}╮`));
		lines.push(row(` ${th.fg("accent", "🃏 Add Anki Basic card")} ${th.fg("dim", "→ Must know by default")}`));
		lines.push(row());
		for (let i = 0; i < this.fields.length; i++) {
			const field = this.fields[i]!;
			const selected = i === this.selected;
			const label = selected ? th.fg("accent", `▶ ${field.label}`) : th.fg("muted", `  ${field.label}`);
			lines.push(row(` ${label}`));
			const display = this.renderValue(field.value, field.cursor, selected);
			for (const part of display.split("\n")) lines.push(row(`    ${part || th.fg("dim", "…")}`));
		}
		lines.push(row());
		const submit = this.selected === this.fields.length ? th.fg("success", "▶ Add card") : th.fg("muted", "  Add card");
		lines.push(row(` ${submit}`));
		if (this.message) lines.push(row(` ${th.fg("error", this.message)}`));
		lines.push(row(` ${th.fg("dim", "↑↓/Tab move • Enter newline/submit • Esc cancel")}`));
		lines.push(th.fg("border", `╰${"─".repeat(inner)}╯`));
		return lines;
	}

	private renderValue(value: string, cursor: number, selected: boolean): string {
		if (!selected) return this.theme.fg("text", value);
		const before = value.slice(0, cursor);
		const cursorChar = cursor < value.length ? value[cursor] : " ";
		const after = value.slice(cursor + 1);
		const marker = this.focused ? CURSOR_MARKER : "";
		return this.theme.fg("text", `${before}${marker}\x1b[7m${cursorChar}\x1b[27m${after}`);
	}

	invalidate(): void {}
	dispose(): void {}
}

export default function ankiExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "anki_generate_card_gui",
		label: "Anki Card GUI",
		description: "Open an interactive GUI where the user can generate, edit, improve, confirm, and add one Anki Basic card. Defaults to Andy Matuschak-style card forging: atomic, why/how/contrast prompts, and misconception-aware wording.",
		promptSnippet: "Default Anki card creation flow: open an interactive Andy-style generate/edit/review/confirm GUI",
		promptGuidelines: [
			"Prefer anki_generate_card_gui as the default way to create/add Anki cards when the user asks the agent to make a card.",
			"anki_generate_card_gui defaults to mode='andy': use it for normal 'card about this' requests so the draft is atomic, why/how/contrast-oriented, and misconception-aware.",
			"Use anki_generate_card_gui with mode='quick' only when the user says quick card/simple card/direct card or clearly wants no ideation.",
			"Use anki_add_basic_card directly only when the user explicitly asks to add without review, has already approved exact Front/Back content, or the current mode has no TUI.",
			"Pass a concise prompt/topic if the conversation already contains what the card should be about; otherwise omit prompt and let the GUI ask the user.",
		],
		parameters: GenerateCardGuiParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const result = await openAnkiGeneratorGui(ctx, params.prompt, params.mode ?? "andy", signal);
			if (result.error) throw new Error(result.error);
			if (result.cancelled) return { content: [{ type: "text" as const, text: "Anki card GUI cancelled." }], details: result };
			return { content: [{ type: "text" as const, text: `Added Anki note ${result.added}` }], details: result };
		},
		renderResult(result, _opts, theme) {
			const details = result.details as { added?: number; cancelled?: boolean; error?: string } | undefined;
			if (details?.error) return new Text(theme.fg("error", details.error), 0, 0);
			if (details?.cancelled) return new Text(theme.fg("muted", "Anki card GUI cancelled"), 0, 0);
			return new Text(theme.fg("success", `✓ Added Anki card #${details?.added ?? "?"}`), 0, 0);
		},
	});

	pi.registerTool({
		name: "anki_list_decks",
		label: "Anki Decks",
		description: "List decks from local Anki through AnkiConnect.",
		promptSnippet: "List Anki decks via AnkiConnect",
		promptGuidelines: ["Use anki_list_decks when the user asks what Anki decks are available."],
		parameters: AnkiConfigParams,
		async execute(_id, params, signal) {
			const decks = await anki<string[]>("deckNames", {}, params.url, signal);
			return { content: [{ type: "text" as const, text: decks.join("\n") }], details: { action: "listDecks", decks } as ListDecksDetails };
		},
		renderResult(result, _opts, theme) {
			const details = result.details as ListDecksDetails | undefined;
			if (details?.error) return new Text(theme.fg("error", `Anki error: ${details.error}`), 0, 0);
			return new Text(theme.fg("success", `Found ${details?.decks.length ?? 0} Anki deck(s)`) + "\n" + (details?.decks ?? []).map((d) => `• ${d}`).join("\n"), 0, 0);
		},
	});

	pi.registerTool({
		name: "anki_add_basic_card",
		label: "Add Anki Card",
		description: "Add a Basic note/card directly to local Anki through AnkiConnect. Defaults to deck 'Must know'. Prefer the review GUI tool unless the user explicitly wants direct add or has already approved exact card content.",
		promptSnippet: "Directly add Basic cards to Anki; prefer the review GUI for normal user-requested card creation",
		promptGuidelines: [
			"Do not use anki_add_basic_card as the default card-creation path; prefer anki_generate_card_gui so the user can review first.",
			"Use anki_add_basic_card directly only when the user explicitly asks to add without review, has already approved exact Front/Back content, or the current mode has no TUI.",
			"For anki_add_basic_card, default deckName to Must know unless the user names another deck.",
			"For anki_add_basic_card, keep fronts concise and put the actual answer/explanation on the back.",
		],
		parameters: AddBasicCardParams,
		async execute(_id, params, signal) {
			const deckName = params.deckName || "Must know";
			const modelName = params.modelName || "Basic";
			const tags = params.tags || ["pi"];
			try {
				const noteId = await anki<number>(
					"addNote",
					{
						note: {
							deckName,
							modelName,
							fields: { Front: params.front, Back: params.back },
							options: { allowDuplicate: params.allowDuplicate ?? false },
							tags,
						},
					},
					params.url,
					signal,
				);
				return { content: [{ type: "text" as const, text: `Added Anki note ${noteId} to ${deckName}` }], details: { action: "addBasicCard", deckName, modelName, front: params.front, back: params.back, tags, noteId } as AddCardDetails };
			} catch (error) {
				throw new Error(`Could not add Anki card: ${summarizeError(error)}`, { cause: error });
			}
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("anki_add_basic_card ")) + theme.fg("accent", args.deckName || "Must know") + theme.fg("dim", ` “${args.front ?? ""}”`), 0, 0);
		},
		renderResult(result, _opts, theme) {
			const details = result.details as AddCardDetails | undefined;
			if (details?.error) return new Text(theme.fg("error", `Anki error: ${details.error}`), 0, 0);
			return new Text(theme.fg("success", "✓ Added Anki card ") + theme.fg("accent", `#${details?.noteId}`) + theme.fg("muted", ` to ${details?.deckName}`), 0, 0);
		},
	});

	pi.registerTool({
		name: "anki_find_notes",
		label: "Find Anki Notes",
		description: "Find Anki notes by Anki browser query through AnkiConnect.",
		promptSnippet: "Find Anki notes/cards by Anki search query",
		promptGuidelines: ["Use anki_find_notes before adding or updating cards when duplicate risk is high, or when the user asks to search Anki."],
		parameters: FindNotesParams,
		async execute(_id, params, signal) {
			const ids = await anki<number[]>("findNotes", { query: params.query }, params.url, signal);
			return { content: [{ type: "text" as const, text: ids.join("\n") || "No matching notes" }], details: { query: params.query, noteIds: ids } };
		},
	});

	pi.registerTool({
		name: "anki_find_and_read_notes",
		label: "Find + Read Anki Notes",
		description: "Find Anki notes with a browser query and immediately read their fields/tags through AnkiConnect.",
		promptSnippet: "Search Anki and inspect matching card contents in one tool call",
		promptGuidelines: [
			"Use anki_find_and_read_notes instead of separate find/read calls when reviewing existing cards.",
			"Set a small limit when scanning broad decks before proposing improvements.",
		],
		parameters: FindAndReadNotesParams,
		async execute(_id, params, signal) {
			const ids = await anki<number[]>("findNotes", { query: params.query }, params.url, signal);
			const limited = ids.slice(0, params.limit ?? 25);
			const notes = limited.length ? await anki<AnkiNoteInfo[]>("notesInfo", { notes: limited }, params.url, signal) : [];
			return { content: [{ type: "text" as const, text: formatNoteInfo(notes) }], details: { query: params.query, noteIds: limited, totalMatches: ids.length, notes } };
		},
		renderResult(result, _opts, theme) {
			const details = result.details as { notes?: AnkiNoteInfo[]; totalMatches?: number; error?: string } | undefined;
			if (details?.error) return new Text(theme.fg("error", `Anki error: ${details.error}`), 0, 0);
			return new Text(theme.fg("success", `Read ${details?.notes?.length ?? 0}/${details?.totalMatches ?? 0} matching Anki note(s)`), 0, 0);
		},
	});

	pi.registerTool({
		name: "anki_notes_info",
		label: "Anki Notes Info",
		description: "Read Anki note fields, tags, model names, and card IDs through AnkiConnect.",
		promptSnippet: "Inspect Anki note/card fields after anki_find_notes returns note IDs",
		promptGuidelines: [
			"Use anki_notes_info after anki_find_notes when the user asks to review or improve existing cards.",
			"Inspect existing Front/Back values before proposing or applying updates.",
		],
		parameters: NotesInfoParams,
		async execute(_id, params, signal) {
			try {
				const notes = await anki<AnkiNoteInfo[]>("notesInfo", { notes: params.noteIds }, params.url, signal);
				return { content: [{ type: "text" as const, text: formatNoteInfo(notes) }], details: { action: "notesInfo", noteIds: params.noteIds, notes } as NotesInfoDetails };
			} catch (error) {
				throw new Error(`Could not read Anki notes: ${summarizeError(error)}`, { cause: error });
			}
		},
		renderResult(result, _opts, theme) {
			const details = result.details as NotesInfoDetails | undefined;
			if (details?.error) return new Text(theme.fg("error", `Anki error: ${details.error}`), 0, 0);
			return new Text(theme.fg("success", `Found info for ${details?.notes?.length ?? 0} Anki note(s)`), 0, 0);
		},
	});

	pi.registerTool({
		name: "anki_update_basic_card",
		label: "Update Anki Card",
		description: "Update the Front/Back fields and optionally tags for an existing Anki Basic note through AnkiConnect.",
		promptSnippet: "Update existing Basic Anki cards by note ID",
		promptGuidelines: [
			"Use anki_update_basic_card when the user approves improvements to existing Basic cards or explicitly asks to modify cards.",
			"Prefer inspecting notes with anki_notes_info first unless the exact current card content is already known.",
			"Keep updates atomic: concise Front, exact answer first on Back, extra explanation only if useful.",
		],
		parameters: UpdateBasicCardParams,
		async execute(_id, params, signal) {
			try {
				await updateBasicCard(params, params.url, signal);
				return { content: [{ type: "text" as const, text: `Updated Anki note ${params.noteId}` }], details: { action: "updateBasicCard", noteId: params.noteId, front: params.front, back: params.back, tags: params.tags } as UpdateBasicCardDetails };
			} catch (error) {
				throw new Error(`Could not update Anki note ${params.noteId}: ${summarizeError(error)}`, { cause: error });
			}
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("anki_update_basic_card ")) + theme.fg("accent", String(args.noteId ?? "?")), 0, 0);
		},
		renderResult(result, _opts, theme) {
			const details = result.details as UpdateBasicCardDetails | undefined;
			if (details?.error) return new Text(theme.fg("error", `Anki error: ${details.error}`), 0, 0);
			return new Text(theme.fg("success", "✓ Updated Anki note ") + theme.fg("accent", `#${details?.noteId}`), 0, 0);
		},
	});

	pi.registerTool({
		name: "anki_update_basic_cards_bulk",
		label: "Bulk Update Anki Cards",
		description: "Update Front/Back fields and optionally tags for multiple existing Anki Basic notes through AnkiConnect.",
		promptSnippet: "Bulk-update existing Basic Anki cards by note ID",
		promptGuidelines: [
			"Use anki_update_basic_cards_bulk when applying multiple approved improvements to existing cards.",
			"Inspect cards first with anki_find_and_read_notes or anki_notes_info.",
		],
		parameters: BulkUpdateBasicCardsParams,
		async execute(_id, params, signal) {
			const updated: number[] = [];
			const failed: { noteId: number; error: string }[] = [];
			for (const update of params.updates) {
				try {
					await updateBasicCard(update, params.url, signal);
					updated.push(update.noteId);
				} catch (error) {
					if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
					failed.push({ noteId: update.noteId, error: summarizeError(error) });
				}
			}
			const details: BulkUpdateBasicCardsDetails = { action: "updateBasicCardsBulk", requested: params.updates.length, updated, failed };
			const text = `Updated ${updated.length}/${params.updates.length} Anki note(s)` + (failed.length ? `\nFailed:\n${failed.map((f) => `${f.noteId}: ${f.error}`).join("\n")}` : "");
			if (failed.length > 0) throw new Error(text);
			return { content: [{ type: "text" as const, text }], details };
		},
		renderResult(result, _opts, theme) {
			const details = result.details as BulkUpdateBasicCardsDetails | undefined;
			const failed = details?.failed.length ?? 0;
			const color = failed ? "error" : "success";
			return new Text(theme.fg(color, `Updated ${details?.updated.length ?? 0}/${details?.requested ?? 0} Anki note(s)`), 0, 0);
		},
	});

	pi.registerTool({
		name: "anki_review_improvements_gui",
		label: "Review Anki Improvements",
		description: "Generate no-brainer Andy-style improvements for existing Basic cards and review/apply them interactively.",
		promptSnippet: "Interactive review flow for improving existing Anki cards",
		promptGuidelines: [
			"Use anki_review_improvements_gui when the user wants to improve existing cards with review before applying.",
			"Prefer a specific query or noteIds and keep limits small for interactive review.",
		],
		parameters: ReviewImprovementsGuiParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") throw new Error("Anki improvement review requires interactive TUI mode.");
			try {
				const limit = params.limit ?? 10;
				const ids = params.noteIds?.length ? params.noteIds : (await anki<number[]>("findNotes", { query: params.query || "deck:\"Must know\"" }, params.url, signal)).slice(0, limit);
				const limited = ids.slice(0, limit);
				const notes = limited.length ? await anki<AnkiNoteInfo[]>("notesInfo", { notes: limited }, params.url, signal) : [];
				const suggestions = await ctx.ui.custom<CardImprovementSuggestion[] | null>((_tui, theme, _kb, done) => {
					const loader = new BorderedLoader(_tui, theme, `Reviewing ${notes.length} Anki card(s) using ${ctx.model?.id ?? "model"}...`);
					loader.onAbort = () => done(null);
					generateCardImprovementSuggestions(ctx, notes, loader.signal).then(done).catch((error) => {
						ctx.ui.notify(`Anki review error: ${summarizeError(error)}`, "error");
						done(null);
					});
					return loader;
				}, { overlay: true, overlayOptions: { width: "60%", minWidth: 50, anchor: "center" } }) ?? [];
				let applied = 0;
				for (const suggestion of suggestions) {
					const original = notes.find((n) => n.noteId === suggestion.noteId);
					const message = `Note ${suggestion.noteId}\nIssue: ${suggestion.issue}\n\nCurrent Front: ${original ? noteFront(original) : ""}\nCurrent Back: ${original ? noteBack(original) : ""}\n\nSuggested Front: ${suggestion.front}\nSuggested Back: ${suggestion.back}`;
					ctx.ui.notify(message, "info");
					const choice = await ctx.ui.select(`Apply improvement for note ${suggestion.noteId}?`, ["Accept", "Skip", "Stop"]);
					if (choice === "Stop") break;
					if (choice !== "Accept") continue;
					await updateBasicCard({ noteId: suggestion.noteId, front: suggestion.front, back: suggestion.back, ...(suggestion.tags !== undefined ? { tags: suggestion.tags } : {}) }, params.url, signal);
					applied++;
				}
				return { content: [{ type: "text" as const, text: `Applied ${applied}/${suggestions.length} suggested Anki improvement(s).` }], details: { reviewed: notes.length, suggested: suggestions.length, applied, suggestions } };
			} catch (error) {
				throw new Error(`Could not review Anki improvements: ${summarizeError(error)}`, { cause: error });
			}
		},
	});

	pi.registerTool({
		name: "anki_sync",
		label: "Anki Sync",
		description: "Ask local Anki to sync with AnkiWeb through AnkiConnect.",
		promptSnippet: "Sync local Anki with AnkiWeb",
		promptGuidelines: ["Use anki_sync when the user asks to sync Anki/AnkiWeb after card changes."],
		parameters: SyncParams,
		async execute(_id, params, signal) {
			await anki<null>("sync", {}, params.url, signal);
			return { content: [{ type: "text" as const, text: "Anki sync started/completed." }], details: { action: "sync" } };
		},
	});

	const openAndyCommand = async (args: string, ctx: ExtensionCommandContext) => {
		const result = await openAnkiGeneratorGui(ctx, args.trim() || undefined, "andy");
		if (result.error) ctx.ui.notify(result.error, "error");
		else if (result.cancelled) ctx.ui.notify("Anki card generator cancelled", "info");
	};

	pi.registerCommand("anki-generate", {
		description: "Open Andy Matuschak mode to generate, improve, confirm, and add an Anki Basic card",
		handler: openAndyCommand,
	});

	pi.registerCommand("anki-forge", {
		description: "Alias for /anki-generate: forge an Andy Matuschak-style Anki card",
		handler: openAndyCommand,
	});

	pi.registerCommand("anki-quick", {
		description: "Open quick mode to generate, improve, confirm, and add an Anki Basic card",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const result = await openAnkiGeneratorGui(ctx, args.trim() || undefined, "quick");
			if (result.error) ctx.ui.notify(result.error, "error");
			else if (result.cancelled) ctx.ui.notify("Anki quick card generator cancelled", "info");
		},
	});

	pi.registerCommand("anki", {
		description: "Open a custom UI to add a Basic card to Anki",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/anki requires interactive TUI mode", "error");
				return;
			}
			const card = await ctx.ui.custom<{ deckName: string; front: string; back: string; tags: string[] } | undefined>(
				(_tui, theme, _kb, done) => new AnkiAddCardComponent(theme, done),
				{ overlay: true, overlayOptions: { width: "80%", maxHeight: "90%", minWidth: 60, anchor: "center" } },
			);
			if (!card) return;
			try {
				const noteId = await anki<number>("addNote", { note: { deckName: card.deckName, modelName: "Basic", fields: { Front: card.front, Back: card.back }, options: { allowDuplicate: false }, tags: card.tags } });
				ctx.ui.notify(`Added Anki note ${noteId} to ${card.deckName}`, "info");
			} catch (error) {
				ctx.ui.notify(`Anki error: ${summarizeError(error)}`, "error");
			}
		},
	});

	pi.registerCommand("anki-review-improvements", {
		description: "Generate and interactively apply no-brainer improvements to existing Anki cards",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/anki-review-improvements requires interactive TUI mode", "error");
				return;
			}
			try {
				const query = args.trim() || "deck:\"Must know\"";
				const ids = (await anki<number[]>("findNotes", { query })).slice(0, 10);
				const notes = ids.length ? await anki<AnkiNoteInfo[]>("notesInfo", { notes: ids }) : [];
				const suggestions = await ctx.ui.custom<CardImprovementSuggestion[] | null>((tui, theme, _kb, done) => {
					const loader = new BorderedLoader(tui, theme, `Reviewing ${notes.length} Anki card(s) using ${ctx.model?.id ?? "model"}...`);
					loader.onAbort = () => done(null);
					generateCardImprovementSuggestions(ctx, notes, loader.signal).then(done).catch((error) => {
						ctx.ui.notify(`Anki review error: ${summarizeError(error)}`, "error");
						done(null);
					});
					return loader;
				}, { overlay: true, overlayOptions: { width: "60%", minWidth: 50, anchor: "center" } }) ?? [];
				let applied = 0;
				for (const suggestion of suggestions) {
					const original = notes.find((n) => n.noteId === suggestion.noteId);
					ctx.ui.notify(`Note ${suggestion.noteId}\n${suggestion.issue}\n\n${original ? noteFront(original) : ""}\n→ ${suggestion.front}\n\n${original ? noteBack(original) : ""}\n→ ${suggestion.back}`, "info");
					const choice = await ctx.ui.select(`Apply improvement for note ${suggestion.noteId}?`, ["Accept", "Skip", "Stop"]);
					if (choice === "Stop") break;
					if (choice !== "Accept") continue;
					await updateBasicCard({ noteId: suggestion.noteId, front: suggestion.front, back: suggestion.back, ...(suggestion.tags !== undefined ? { tags: suggestion.tags } : {}) });
					applied++;
				}
				ctx.ui.notify(`Applied ${applied}/${suggestions.length} Anki improvement(s)`, "info");
			} catch (error) {
				ctx.ui.notify(`Anki error: ${summarizeError(error)}`, "error");
			}
		},
	});

	pi.registerCommand("anki-decks", {
		description: "Show Anki decks from AnkiConnect",
		handler: async (_args, ctx) => {
			try {
				const decks = await anki<string[]>("deckNames");
				const picked = await ctx.ui.select("Anki decks", decks);
				if (picked) ctx.ui.notify(`Selected deck: ${picked}`, "info");
			} catch (error) {
				ctx.ui.notify(`Anki error: ${summarizeError(error)}`, "error");
			}
		},
	});
}
