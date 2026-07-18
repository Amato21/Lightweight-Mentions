import {
	App,
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
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
	templateFilePath: string;
	stubHeadingLevel: number;
}

const DEFAULT_SETTINGS: LightweightMentionsSettings = {
	triggerChar: "@",
	stubFilePath: "Mentions.md",
	promotedNotesFolder: "",
	templateFilePath: "",
	stubHeadingLevel: 2,
};

type MentionSuggestion =
	| { type: "file"; file: TFile; display: string }
	| { type: "heading"; stubFile: TFile; heading: string; display: string }
	| { type: "create"; query: string };

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

		await this.promoteHeading(stubFile, headingText);
	}

	async promoteHeading(stubFile: TFile, headingText: string) {
		const content = await this.app.vault.read(stubFile);
		const section = this.findHeadingSection(stubFile, headingText, this.settings.stubHeadingLevel, content);
		if (!section) {
			new Notice(`Could not find heading "${headingText}" in ${stubFile.basename}`);
			return;
		}

		let newContent = section.body;
		if (this.settings.templateFilePath) {
			const templateFile = this.app.vault.getAbstractFileByPath(
				normalizePath(this.settings.templateFilePath)
			);
			if (templateFile instanceof TFile) {
				const template = await this.app.vault.read(templateFile);
				newContent = template
					.replace(/{{\s*title\s*}}/gi, headingText)
					.replace(/{{\s*content\s*}}/gi, section.body);
			}
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
		const fuzzy = query ? prepareFuzzySearch(query) : null;
		const activeFile = context.file;

		const fileMatches: MentionSuggestion[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (activeFile && file.path === this.plugin.settings.stubFilePath) continue;
			const label = file.basename;
			if (!fuzzy) {
				fileMatches.push({ type: "file", file, display: label });
				continue;
			}
			const result = fuzzy(label);
			if (result) fileMatches.push({ type: "file", file, display: label });
		}

		const headingMatches: MentionSuggestion[] = [];
		const stubFile = this.app.vault.getAbstractFileByPath(
			normalizePath(this.plugin.settings.stubFilePath)
		);
		if (stubFile instanceof TFile) {
			const cache = this.app.metadataCache.getFileCache(stubFile);
			const headings = (cache?.headings ?? []).filter(
				(h) => h.level === this.plugin.settings.stubHeadingLevel
			);
			for (const h of headings) {
				if (!fuzzy || fuzzy(h.heading)) {
					headingMatches.push({ type: "heading", stubFile, heading: h.heading, display: h.heading });
				}
			}
		}

		const results = [...fileMatches, ...headingMatches].slice(0, 20);

		const exactExists = results.some(
			(r) => (r.type === "file" ? r.display : r.type === "heading" ? r.display : "").toLowerCase() ===
				query.toLowerCase()
		);
		if (query && !exactExists) {
			results.push({ type: "create", query });
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
			.setName("Template file")
			.setDesc("Optional template applied when promoting a mention. Use {{title}} and {{content}} placeholders.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.templateFilePath)
					.onChange(async (value) => {
						this.plugin.settings.templateFilePath = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
