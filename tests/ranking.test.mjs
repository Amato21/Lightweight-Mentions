// Plain-Node regression test (no test framework dependency) for the mention
// suggestion ranking logic in main.ts. Bundles main.ts with esbuild (already
// a devDependency) and stubs the "obsidian" module, since rankCandidates/
// hasStrongMatch are pure functions that don't need a real Obsidian runtime.

import esbuild from "esbuild";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

async function loadMainExports() {
	const result = await esbuild.build({
		entryPoints: [path.join(__dirname, "..", "main.ts")],
		bundle: true,
		format: "cjs",
		platform: "node",
		external: ["obsidian"],
		write: false,
	});

	const code = result.outputFiles[0].text;
	const mod = { exports: {} };
	const obsidianStub = {
		Plugin: class {},
		EditorSuggest: class {
			constructor(app) {
				this.app = app;
			}
		},
		PluginSettingTab: class {
			constructor() {}
		},
		FuzzySuggestModal: class {
			constructor(app) {
				this.app = app;
			}
		},
		Modal: class {
			constructor(app) {
				this.app = app;
				this.contentEl = { createEl: () => ({}), createDiv: () => ({}), createSpan: () => ({}), empty: () => {} };
			}
		},
		TFile: class {},
		TFolder: class {},
		Notice: class {},
		Setting: class {},
		normalizePath: (p) => p,
		prepareFuzzySearch: () => () => null,
	};
	const fakeRequire = (id) => (id === "obsidian" ? obsidianStub : require(id));
	const fn = new Function("module", "exports", "require", code);
	fn(mod, mod.exports, fakeRequire);
	return mod.exports;
}

/** Simple real subsequence matcher, standing in for Obsidian's fuzzy search:
 * matches if every character of `query` appears in `label`, in order,
 * anywhere -- including scattered across unrelated words. This is exactly
 * the kind of match that produced the reported bug ("Vivien" fuzzy-matching
 * "Vivy - Fluorite Eye's Song"). */
function subsequenceFuzzy(query) {
	const lowerQuery = query.toLowerCase();
	return (label) => {
		const lowerLabel = label.toLowerCase();
		let qi = 0;
		for (let li = 0; li < lowerLabel.length && qi < lowerQuery.length; li++) {
			if (lowerLabel[li] === lowerQuery[qi]) qi++;
		}
		return qi === lowerQuery.length ? { score: -label.length } : null;
	};
}

const {
	rankCandidates,
	hasStrongMatch,
	templatesInFolder,
	mergeTemplateContent,
	parseAliases,
	dedupeByKey,
	findMentionTrigger,
	rewriteLinksInContent,
	aggregateUnresolvedLinks,
} = await loadMainExports();

function test(name, fn) {
	try {
		fn();
		console.log(`ok - ${name}`);
	} catch (err) {
		console.error(`FAIL - ${name}`);
		console.error(err);
		process.exitCode = 1;
	}
}

test("fuzzy-only noise does not count as a strong match", () => {
	const candidates = [{ item: "vivy", label: "Vivy - Fluorite Eye's Song" }];
	const ranked = rankCandidates(candidates, "Vivien", subsequenceFuzzy("Vivien"));

	assert.equal(ranked.length, 1, "the noisy fuzzy match should still be ranked (as a fallback)");
	assert.equal(ranked[0].tier, 0, "a pure fuzzy subsequence match must be the weakest tier");
	assert.equal(
		hasStrongMatch(ranked),
		false,
		"fuzzy-only noise must not be treated as a strong match -- otherwise \"create\" gets buried behind it"
	);
});

test("a real substring match outranks unrelated fuzzy noise", () => {
	const candidates = [
		{ item: "vivy", label: "Vivy - Fluorite Eye's Song" },
		{ item: "vivien", label: "Vivien Dupont" },
	];
	const ranked = rankCandidates(candidates, "Vivien", subsequenceFuzzy("Vivien"));

	assert.equal(ranked[0].item, "vivien", "the real match must be ranked first, not the fuzzy noise");
	assert.equal(hasStrongMatch(ranked), true);
});

test("an exact match beats a prefix match", () => {
	const candidates = [
		{ item: "long", label: "Test Driven Development" },
		{ item: "exact", label: "Test" },
	];
	const ranked = rankCandidates(candidates, "Test", subsequenceFuzzy("Test"));

	assert.equal(ranked[0].item, "exact");
	assert.equal(ranked[0].tier, 3);
});

test("a query hiding mid-word in an unrelated title is not a strong match", () => {
	// Reported bug: querying "test" on a real vault surfaced "Fatestrange Fake"
	// (Fate/strange Fake) as if it were a real match, because "test" is a
	// literal (but coincidental) substring of "Fa-test-range". It shouldn't
	// count as "strong" just for containing the query mid-word.
	const candidates = [{ item: "fatestrange", label: "Fatestrange Fake" }];
	const ranked = rankCandidates(candidates, "test", subsequenceFuzzy("test"));

	assert.equal(hasStrongMatch(ranked), false, "a mid-word substring must not count as a strong match");
});

test("strong matches are never diluted with fuzzy noise", () => {
	// When at least one real match exists, weaker fuzzy-only matches (like the
	// "Fatestrange" false positive) must not also flood the result list.
	const candidates = [
		{ item: "real", label: "Test Plan" },
		{ item: "noise", label: "Fatestrange Fake" },
	];
	const ranked = rankCandidates(candidates, "test", subsequenceFuzzy("test"));

	assert.equal(ranked.length, 1, "the noisy fuzzy match must not be mixed in alongside a real match");
	assert.equal(ranked[0].item, "real");
});

test("a query matching the start of any word in the label is a strong match", () => {
	const candidates = [{ item: "song", label: "Fluorite Eye's Song - Vivy" }];
	const ranked = rankCandidates(candidates, "Vivy", subsequenceFuzzy("Vivy"));

	assert.equal(hasStrongMatch(ranked), true, "\"Vivy\" starts the last word of the label");
});

test("empty query returns all candidates unranked (tier 1, stable order)", () => {
	const candidates = [
		{ item: "a", label: "Alpha" },
		{ item: "b", label: "Beta" },
	];
	const ranked = rankCandidates(candidates, "", () => null);

	assert.equal(ranked.length, 2);
	assert.equal(ranked[0].item, "a");
	assert.equal(ranked[1].item, "b");
});

test("templatesInFolder only returns direct children of the configured folder", () => {
	const files = [
		{ path: "Templates/Person.md", parentPath: "Templates" },
		{ path: "Templates/Sub/Nested.md", parentPath: "Templates/Sub" },
		{ path: "Other/Thing.md", parentPath: "Other" },
	];

	assert.deepEqual(
		templatesInFolder(files, "Templates").map((f) => f.path),
		["Templates/Person.md"]
	);
});

test("templatesInFolder tolerates leading/trailing slashes in the setting", () => {
	const files = [{ path: "Templates/Person.md", parentPath: "Templates" }];
	assert.equal(templatesInFolder(files, "/Templates/").length, 1);
});

test("templatesInFolder returns nothing when no folder is configured", () => {
	const files = [{ path: "Templates/Person.md", parentPath: "Templates" }];
	assert.equal(templatesInFolder(files, "").length, 0);
});

test("mergeTemplateContent fills {{content}} when the template has it", () => {
	const result = mergeTemplateContent("# {{title}}\n\n{{content}}\n\n## Notes", "Vivien", "Met at the party.");
	assert.equal(result, "# Vivien\n\nMet at the party.\n\n## Notes");
});

test("mergeTemplateContent appends the body when the template has no {{content}} placeholder", () => {
	// Reported bug: a template without {{content}} silently dropped whatever
	// the user had written under the mention heading -- permanently, since
	// the heading is removed from the stub file right after promotion.
	const result = mergeTemplateContent("# {{title}}\n\n## Type\n- Person", "Vivien", "Met at the party.");
	assert.equal(result, "# Vivien\n\n## Type\n- Person\n\nMet at the party.");
});

test("mergeTemplateContent does not append an empty trailing block when there is no body", () => {
	const result = mergeTemplateContent("# {{title}}\n\n## Type\n- Person", "Vivien", "");
	assert.equal(result, "# Vivien\n\n## Type\n- Person");
});

test("parseAliases handles a YAML list", () => {
	assert.deepEqual(parseAliases(["Viv", "Vivi"]), ["Viv", "Vivi"]);
});

test("parseAliases handles a comma-separated string", () => {
	assert.deepEqual(parseAliases("Viv, Vivi"), ["Viv", "Vivi"]);
});

test("parseAliases handles a single plain string", () => {
	assert.deepEqual(parseAliases("Viv"), ["Viv"]);
});

test("parseAliases returns an empty list for null/undefined/empty", () => {
	assert.deepEqual(parseAliases(undefined), []);
	assert.deepEqual(parseAliases(null), []);
	assert.deepEqual(parseAliases(""), []);
});

test("dedupeByKey keeps only the first occurrence of each key", () => {
	const items = [
		{ key: "a", label: "first" },
		{ key: "b", label: "only" },
		{ key: "a", label: "second" },
	];
	const result = dedupeByKey(items, (i) => i.key);
	assert.deepEqual(
		result.map((i) => i.label),
		["first", "only"]
	);
});

test("findMentionTrigger detects a trigger at the end of the line", () => {
	const match = findMentionTrigger("Hello @Viv", "@");
	assert.deepEqual(match, { start: 6, query: "Viv" });
});

test("findMentionTrigger returns null when there's no trigger", () => {
	assert.equal(findMentionTrigger("Hello world", "@"), null);
});

test("findMentionTrigger ignores a trigger glued to a preceding word character (e.g. an email)", () => {
	assert.equal(findMentionTrigger("test@Viv", "@"), null);
});

test("findMentionTrigger does not re-trigger inside a link it just inserted (issue #21)", () => {
	// Reported bug: picking a note named "@Amato" inserts "[[@Amato]]". The
	// "@" inside that closed link was being picked up again as a brand new
	// mention, because the old guard only checked for an unclosed "[[" ahead
	// of the trigger, never a closed "]]".
	assert.equal(findMentionTrigger("Hello [[@Amato]]", "@"), null);
});

test("findMentionTrigger stays suppressed while typing further after that link", () => {
	assert.equal(findMentionTrigger("Hello [[@Amato]] said", "@"), null);
});

test("findMentionTrigger blocks when the query itself contains an unclosed [[", () => {
	assert.equal(findMentionTrigger("Hello @foo [[bar", "@"), null);
});

test("rewriteLinksInContent rewrites every plain occurrence and counts them", () => {
	const { content, count } = rewriteLinksInContent(
		"See [[Sujet1]] and also [[Sujet1]] again.",
		"Sujet1",
		"Mentions#Sujet1"
	);
	assert.equal(content, "See [[Mentions#Sujet1]] and also [[Mentions#Sujet1]] again.");
	assert.equal(count, 2);
});

test("rewriteLinksInContent preserves an alias", () => {
	const { content, count } = rewriteLinksInContent("See [[Sujet1|Viv]].", "Sujet1", "Mentions#Sujet1");
	assert.equal(content, "See [[Mentions#Sujet1|Viv]].");
	assert.equal(count, 1);
});

test("rewriteLinksInContent leaves unrelated links untouched", () => {
	const { content, count } = rewriteLinksInContent("See [[Sujet1]] and [[Sujet2]].", "Sujet1", "Mentions#Sujet1");
	assert.equal(content, "See [[Mentions#Sujet1]] and [[Sujet2]].");
	assert.equal(count, 1);
});

test("aggregateUnresolvedLinks sums per-file counts for the same link text", () => {
	const totals = aggregateUnresolvedLinks({
		"Note A.md": { Sujet1: 3, Sujet2: 1 },
		"Note B.md": { Sujet1: 2 },
	});
	assert.equal(totals.get("Sujet1"), 5);
	assert.equal(totals.get("Sujet2"), 1);
});

test("aggregateUnresolvedLinks returns an empty map for no unresolved links", () => {
	assert.equal(aggregateUnresolvedLinks({}).size, 0);
});
