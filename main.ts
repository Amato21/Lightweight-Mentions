import {
	App,
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	FuzzySuggestModal,
	MarkdownFileInfo,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	normalizePath,
	prepareFuzzySearch,
} from "obsidian";

interface LightweightMentionsSettings {
	triggerChar: string;
	stubFilePath: string;
	promotedNotesFolder: string;
	templateFolderPath: string;
	stubHeadingLevel: number;
}

const DEFAULT_SETTINGS: LightweightMentionsSettings = {
	triggerChar: "@",
	stubFilePath: "Mentions.md",
	promotedNotesFolder: "",
	templateFolderPath: "",
	stubHeadingLevel: 2,
};

type MentionSuggestion =
	| { type: "file"; file: TFile; display: string }
	| { type: "heading"; stubFile: TFile; heading: string; display: string }
	| { type: "create"; query: string };

export interface RankedCandidate<T> {
	item: T;
	tier: number;
	score: number;
}

/** Splits a label into "words" on anything that isn't a letter or digit (in any
 * script/language), so "Fluorite Eye's Song - Vivy" becomes ["fluorite", "eye",
 * "s", "song", "vivy"]. Used to require a query to start an actual word, not
 * just appear as a substring anywhere -- "test" shouldn't count as a strong
 * match against "Fatestrange Fake" just because it's hiding mid-word. */
function wordsOf(label: string): string[] {
	return label.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Ranks candidates by how well their label matches the query: exact match, then
 * "starts with", then "a word in the label starts with the query", and only as
 * a last resort a fuzzy subsequence match (which can match letters scattered
 * anywhere in an unrelated label, e.g. querying "Vivien" fuzzy-matching "Vivy -
 * Fluorite Eye's Song"). Plain "contains anywhere" is deliberately excluded: on
 * a large vault it lets a query hiding mid-word inside an unrelated title (e.g.
 * "test" inside "Fatestrange Fake") count as a strong match, which then buries
 * the "create new" suggestion behind a pile of irrelevant results. When no
 * candidate reaches a strong tier, fuzzy fallback matches are returned on their
 * own (not mixed in alongside strong matches) so they don't dilute a good list.
 */
export function rankCandidates<T>(
	candidates: { item: T; label: string }[],
	query: string,
	fuzzyMatch: (label: string) => { score: number } | null
): RankedCandidate<T>[] {
	if (!query) {
		return candidates.map((c) => ({ item: c.item, tier: 1, score: 0 }));
	}

	const lowerQuery = query.toLowerCase();
	const strong: RankedCandidate<T>[] = [];
	const fuzzyFallback: RankedCandidate<T>[] = [];
	for (const c of candidates) {
		const lowerLabel = c.label.toLowerCase();
		if (lowerLabel === lowerQuery) {
			strong.push({ item: c.item, tier: 3, score: 0 });
		} else if (lowerLabel.startsWith(lowerQuery)) {
			strong.push({ item: c.item, tier: 2, score: -c.label.length });
		} else if (wordsOf(c.label).some((word) => word.startsWith(lowerQuery))) {
			strong.push({ item: c.item, tier: 1, score: -c.label.length });
		} else {
			const result = fuzzyMatch(c.label);
			if (result) fuzzyFallback.push({ item: c.item, tier: 0, score: result.score });
		}
	}

	if (strong.length > 0) {
		strong.sort((a, b) => (b.tier !== a.tier ? b.tier - a.tier : b.score - a.score));
		return strong;
	}

	fuzzyFallback.sort((a, b) => b.score - a.score);
	return fuzzyFallback;
}

export function hasStrongMatch<T>(ranked: RankedCandidate<T>[]): boolean {
	return ranked.some((r) => r.tier >= 1);
}

/** Filters markdown files down to the direct contents of `folderPath` (not
 * subfolders), for populating the template picker. Pure/testable: takes
 * plain `{ path, parentPath }` records instead of real TFile objects. */
export function templatesInFolder<T extends { parentPath: string | null }>(
	files: T[],
	folderPath: string
): T[] {
	const normalized = folderPath.replace(/^\/+|\/+$/g, "");
	if (!normalized) return [];
	return files.filter((f) => f.parentPath === normalized);
}

const FILENAME_FORBIDDEN = /[\\/:*?"<>|]/g;

function sanitizeFilename(name: string): string {
	return name.replace(FILENAME_FORBIDDEN, "").trim();
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default class LightweightMentionsPlugin extends Plugin {
	settings!: LightweightMentionsSettings;

	async onload() {
		await this.loadSettings();

		this.registerEditorSuggest(new MentionSuggest(this.app, this));

		this.addCommand({
			id: "promote-mention-to-note",
			name: "Promote mention to full note",
			editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
				if (ctx.file) void this.promoteMentionAtCursor(editor, ctx.file);
			},
		});

		this.addSettingTab(new LightweightMentionsSettingTab(this.app, this));
	}

	async loadSettings() {
		const data = (await this.loadData()) as Partial<LightweightMentionsSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async getStubFile(createIfMissing: boolean): Promise<TFile | null> {
		const path = normalizePath(this.settings.stubFilePath);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return existing;
		if (!createIfMissing) return null;

		const folder = path.contains("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (folder && !(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) {
			await this.app.vault.createFolder(folder);
		}
		return await this.app.vault.create(path, `# Mentions\n\nLightweight mentions live here as headings until they're worth their own note.\n`);
	}

	/** Appends a new heading for `name` to the stub file, creating the file if needed. Returns the stub file. */
	async addStubHeading(name: string): Promise<TFile> {
		const stubFile = await this.getStubFile(true);
		if (!stubFile) throw new Error("Could not create stub file");

		const level = "#".repeat(this.settings.stubHeadingLevel);
		const content = await this.app.vault.read(stubFile);
		const separator = content.endsWith("\n") ? "" : "\n";
		await this.app.vault.modify(stubFile, `${content}${separator}\n${level} ${name}\n`);
		return stubFile;
	}

	findHeadingSection(file: TFile, headingText: string, level: number, content: string) {
		const cache = this.app.metadataCache.getFileCache(file);
		const headings = cache?.headings ?? [];
		const idx = headings.findIndex(
			(h) => h.level === level && h.heading.toLowerCase() === headingText.toLowerCase()
		);
		if (idx === -1) return null;

		const lines = content.split("\n");
		const startLine = headings[idx].position.start.line;

		let endLine = lines.length;
		for (let i = idx + 1; i < headings.length; i++) {
			if (headings[i].level <= level) {
				endLine = headings[i].position.start.line;
				break;
			}
		}

		const bodyLines = lines.slice(startLine + 1, endLine);
		return {
			heading: headings[idx],
			startLine,
			endLine,
			body: bodyLines.join("\n").trim(),
		};
	}

	/** Finds a `[[path#heading|alias]]` style link whose range contains the cursor on the current line. */
	findLinkUnderCursor(editor: Editor, cursor: EditorPosition) {
		const line = editor.getLine(cursor.line);
		const linkRegex = /\[\[([^\]]+)\]\]/g;
		let match: RegExpExecArray | null;
		while ((match = linkRegex.exec(line)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			if (cursor.ch >= start && cursor.ch <= end) {
				const inner = match[1];
				const [pathAndHeading, alias] = inner.split("|");
				const [path, heading] = pathAndHeading.split("#");
				return { raw: match[0], start, end, path: path.trim(), heading: heading?.trim(), alias };
			}
		}
		return null;
	}

	async promoteMentionAtCursor(editor: Editor, activeFile: TFile) {
		const cursor = editor.getCursor();

		let stubFile: TFile | null = null;
		let headingText: string | null = null;

		const linkUnderCursor = this.findLinkUnderCursor(editor, cursor);
		if (linkUnderCursor?.heading) {
			const dest = this.app.metadataCache.getFirstLinkpathDest(linkUnderCursor.path, activeFile.path);
			if (dest) {
				stubFile = dest;
				headingText = linkUnderCursor.heading;
			}
		} else if (normalizePath(activeFile.path) === normalizePath(this.settings.stubFilePath)) {
			const cache = this.app.metadataCache.getFileCache(activeFile);
			const headings = (cache?.headings ?? []).filter((h) => h.level === this.settings.stubHeadingLevel);
			const enclosing = [...headings].reverse().find((h) => h.position.start.line <= cursor.line);
			if (enclosing) {
				stubFile = activeFile;
				headingText = enclosing.heading;
			}
		}

		if (!stubFile || !headingText) {
			new Notice("Place the cursor on a mention link or inside a heading in the stub file first.");
			return;
		}

		const templateFile = await this.pickTemplate();
		await this.promoteHeading(stubFile, headingText, templateFile);
	}

	/** Lists markdown files directly inside the configured template folder and lets
	 * the user pick one (or none). Resolves to `null` immediately if no template
	 * folder is configured or it's empty -- no picker shown in that case. */
	async pickTemplate(): Promise<TFile | null> {
		if (!this.settings.templateFolderPath) return null;

		const files = this.app.vault.getMarkdownFiles().map((f) => ({ file: f, parentPath: f.parent?.path ?? null }));
		const templates = templatesInFolder(files, this.settings.templateFolderPath).map((f) => f.file);
		if (templates.length === 0) return null;

		return new Promise((resolve) => {
			new TemplatePickerModal(this.app, templates, resolve).open();
		});
	}

	async promoteHeading(stubFile: TFile, headingText: string, templateFile: TFile | null) {
		const content = await this.app.vault.read(stubFile);
		const section = this.findHeadingSection(stubFile, headingText, this.settings.stubHeadingLevel, content);
		if (!section) {
			new Notice(`Could not find heading "${headingText}" in ${stubFile.basename}`);
			return;
		}

		let newContent = section.body;
		if (templateFile) {
			const template = await this.app.vault.read(templateFile);
			newContent = template
				.replace(/{{\s*title\s*}}/gi, headingText)
				.replace(/{{\s*content\s*}}/gi, section.body);
		}

		const folder = normalizePath(this.settings.promotedNotesFolder || stubFile.parent?.path || "");
		if (folder && !(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) {
			await this.app.vault.createFolder(folder);
		}

		let filename = sanitizeFilename(headingText);
		let targetPath = normalizePath(folder ? `${folder}/${filename}.md` : `${filename}.md`);
		let suffix = 2;
		while (this.app.vault.getAbstractFileByPath(targetPath)) {
			targetPath = normalizePath(folder ? `${folder}/${filename} (${suffix}).md` : `${filename} (${suffix}).md`);
			suffix++;
		}

		const newFile = await this.app.vault.create(targetPath, newContent);

		const lines = content.split("\n");
		const remaining = [
			...lines.slice(0, section.startLine),
			...lines.slice(section.endLine),
		].join("\n");
		await this.app.vault.modify(stubFile, remaining);

		const updatedCount = await this.rewriteLinksToNote(stubFile, headingText, newFile);

		new Notice(`Promoted "${headingText}" to ${newFile.basename}. Updated ${updatedCount} link(s).`);
	}

	/** Rewrites every `[[stubBasename#heading]]` (optionally with alias) link across the vault to point at `newFile`. */
	async rewriteLinksToNote(stubFile: TFile, headingText: string, newFile: TFile): Promise<number> {
		const stubBasename = escapeRegExp(stubFile.basename);
		const heading = escapeRegExp(headingText);
		const linkPattern = new RegExp(
			`\\[\\[${stubBasename}#${heading}(\\|[^\\]]+)?\\]\\]`,
			"gi"
		);

		let updated = 0;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const content = await this.app.vault.read(file);
			if (!linkPattern.test(content)) continue;
			linkPattern.lastIndex = 0;
			const replaced = content.replace(linkPattern, (_match, aliasGroup) => {
				updated++;
				return `[[${newFile.basename}${aliasGroup ?? ""}]]`;
			});
			await this.app.vault.modify(file, replaced);
		}
		return updated;
	}
}

/** Lets the user pick one template file out of the configured template folder
 * (or none, via Esc) when promoting a mention. */
class TemplatePickerModal extends FuzzySuggestModal<TFile> {
	private chosen = false;

	constructor(app: App, private templates: TFile[], private onChoose: (file: TFile | null) => void) {
		super(app);
		this.setPlaceholder("Choose a template for the promoted note (Esc for none)");
	}

	getItems(): TFile[] {
		return this.templates;
	}

	getItemText(item: TFile): string {
		return item.basename;
	}

	onChooseItem(item: TFile): void {
		this.chosen = true;
		this.onChoose(item);
	}

	onClose(): void {
		if (!this.chosen) this.onChoose(null);
	}
}

class MentionSuggest extends EditorSuggest<MentionSuggestion> {
	plugin: LightweightMentionsPlugin;

	constructor(app: App, plugin: LightweightMentionsPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
		const triggerChar = this.plugin.settings.triggerChar;
		const line = editor.getLine(cursor.line);
		const sub = line.slice(0, cursor.ch);
		const lastTriggerIdx = sub.lastIndexOf(triggerChar);
		if (lastTriggerIdx === -1) return null;

		const charBefore = lastTriggerIdx > 0 ? sub[lastTriggerIdx - 1] : "";
		if (charBefore && /[A-Za-z0-9_]/.test(charBefore)) return null;

		const query = sub.slice(lastTriggerIdx + triggerChar.length);
		if (query.includes("[[") || query.includes(triggerChar)) return null;
		if (/\s{2,}/.test(query) || query.length > 100) return null;

		return {
			start: { line: cursor.line, ch: lastTriggerIdx },
			end: cursor,
			query,
		};
	}

	getSuggestions(context: EditorSuggestContext): MentionSuggestion[] {
		const query = context.query.trim();
		const activeFile = context.file;

		type Candidate = { item: MentionSuggestion; label: string };
		const candidates: Candidate[] = [];

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (activeFile && file.path === this.plugin.settings.stubFilePath) continue;
			candidates.push({ item: { type: "file", file, display: file.basename }, label: file.basename });
		}

		const stubFile = this.app.vault.getAbstractFileByPath(
			normalizePath(this.plugin.settings.stubFilePath)
		);
		if (stubFile instanceof TFile) {
			const cache = this.app.metadataCache.getFileCache(stubFile);
			const headings = (cache?.headings ?? []).filter(
				(h) => h.level === this.plugin.settings.stubHeadingLevel
			);
			for (const h of headings) {
				candidates.push({
					item: { type: "heading", stubFile, heading: h.heading, display: h.heading },
					label: h.heading,
				});
			}
		}

		const fuzzy = query ? prepareFuzzySearch(query) : () => null;
		const ranked = rankCandidates(candidates, query, fuzzy);
		const results = ranked.slice(0, 20).map((r) => r.item);

		const exactExists = ranked.some((r) => r.tier === 3);
		if (query && !exactExists) {
			const createItem: MentionSuggestion = { type: "create", query };
			// Nothing solid matched (only weak fuzzy noise, or no candidates at all):
			// put "create" first so it's the one Enter picks, instead of noise.
			if (hasStrongMatch(ranked)) {
				results.push(createItem);
			} else {
				results.unshift(createItem);
			}
		}

		return results;
	}

	renderSuggestion(value: MentionSuggestion, el: HTMLElement): void {
		el.addClass("lightweight-mentions-suggestion");
		if (value.type === "file") {
			el.createSpan({ text: value.display });
			el.createSpan({ text: " note", cls: "lightweight-mentions-tag" });
		} else if (value.type === "heading") {
			el.createSpan({ text: value.display });
			el.createSpan({ text: " mention", cls: "lightweight-mentions-tag" });
		} else {
			el.createSpan({ text: `Create "${value.query}"` });
			el.createSpan({ text: " new mention", cls: "lightweight-mentions-tag" });
		}
	}

	selectSuggestion(value: MentionSuggestion, _evt: MouseEvent | KeyboardEvent): void {
		void this.applySuggestion(value);
	}

	private async applySuggestion(value: MentionSuggestion): Promise<void> {
		const context = this.context;
		if (!context) return;

		let linkText: string;
		if (value.type === "file") {
			linkText = `[[${value.file.basename}]]`;
		} else if (value.type === "heading") {
			linkText = `[[${value.stubFile.basename}#${value.heading}]]`;
		} else {
			const stubFile = await this.plugin.addStubHeading(value.query);
			linkText = `[[${stubFile.basename}#${value.query}]]`;
		}

		context.editor.replaceRange(linkText, context.start, context.end);
		const newCursorCh = context.start.ch + linkText.length;
		context.editor.setCursor({ line: context.start.line, ch: newCursorCh });
	}
}

class LightweightMentionsSettingTab extends PluginSettingTab {
	plugin: LightweightMentionsPlugin;

	constructor(app: App, plugin: LightweightMentionsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Trigger character")
			.setDesc("Type this character to open the mention suggester.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.triggerChar)
					.onChange(async (value) => {
						this.plugin.settings.triggerChar = value.slice(0, 1) || "@";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Stub file")
			.setDesc("Vault path of the shared file where lightweight mentions are stored as headings.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.stubFilePath)
					.onChange(async (value) => {
						this.plugin.settings.stubFilePath = value || DEFAULT_SETTINGS.stubFilePath;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Promoted notes folder")
			.setDesc("Folder new notes are created in when promoting a mention. Leave empty to use the stub file's folder.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.promotedNotesFolder)
					.onChange(async (value) => {
						this.plugin.settings.promotedNotesFolder = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Template folder")
			.setDesc(
				"Optional folder of templates. When promoting a mention, you'll be asked which template in this folder to apply (use {{title}} and {{content}} placeholders), or Esc for none. Leave empty to always promote without a template."
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.templateFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.templateFolderPath = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
