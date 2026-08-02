import assert from "node:assert/strict";
import { test } from "node:test";

import initializeExtension from "../index.ts";
import { clearResults, storeResult } from "../storage.ts";

function getContentTool() {
	clearResults();
	const tools = [];
	initializeExtension({
		registerTool(tool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
	});
	const tool = tools.find((registered) => registered.name === "get_search_content");
	assert.ok(tool, "get_search_content tool was not registered");
	return tool;
}

function storeFetchedContent(content) {
	storeResult("large-fetch", {
		id: "large-fetch",
		type: "fetch",
		timestamp: Date.now(),
		urls: [{
			url: "https://example.com/large",
			title: "Large Page",
			content,
			error: null,
		}],
	});
}

test("get_search_content returns a bounded first slice for large fetched content", async () => {
	const tool = getContentTool();
	storeFetchedContent("A".repeat(30_000) + "TAIL");

	const result = await tool.execute("call", { responseId: "large-fetch", urlIndex: 0 });
	const text = result.content[0].text;

	assert.equal(result.details.contentLength, 30_004);
	assert.equal(result.details.offset, 0);
	assert.equal(result.details.returnedChars, 30_000);
	assert.equal(result.details.nextOffset, 30_000);
	assert.equal(result.details.truncated, true);
	assert.match(text, /Showing chars 0-30000 of 30004/);
	assert.match(text, /offset: 30000/);
	assert.doesNotMatch(text, /TAIL/);
});

test("get_search_content returns requested fetched content slices", async () => {
	const tool = getContentTool();
	storeFetchedContent("A".repeat(30_000) + "BCDEFGHIJ");

	const result = await tool.execute("call", {
		responseId: "large-fetch",
		url: "https://example.com/large",
		offset: 30_000,
		limit: 5,
	});
	const text = result.content[0].text;

	assert.equal(result.details.offset, 30_000);
	assert.equal(result.details.limit, 5);
	assert.equal(result.details.returnedChars, 5);
	assert.equal(result.details.nextOffset, 30_005);
	assert.match(text, /BCDEF/);
	assert.doesNotMatch(text, /GHIJ/);
	assert.match(text, /urlIndex: 0, offset: 30005, limit: 5/);
});

test("get_search_content rejects unsafe fetched content ranges", async () => {
	const tool = getContentTool();
	storeFetchedContent("short content");

	const tooLarge = await tool.execute("call", { responseId: "large-fetch", urlIndex: 0, limit: 30_001 });
	assert.equal(tooLarge.details.error, "Invalid limit");
	assert.match(tooLarge.content[0].text, /limit must be an integer from 1 to 30000/);

	const invalidOffset = await tool.execute("call", { responseId: "large-fetch", urlIndex: 0, offset: 1.5 });
	assert.equal(invalidOffset.details.error, "Invalid offset");

	const outOfRange = await tool.execute("call", { responseId: "large-fetch", urlIndex: 0, offset: 99 });
	assert.equal(outOfRange.details.error, "Offset out of range");
});

test("get_search_content returns small fetched content without continuation noise", async () => {
	const tool = getContentTool();
	storeFetchedContent("small content");

	const result = await tool.execute("call", { responseId: "large-fetch", urlIndex: 0 });
	const text = result.content[0].text;

	assert.equal(result.details.returnedChars, "small content".length);
	assert.equal(result.details.nextOffset, null);
	assert.match(text, /small content/);
	assert.doesNotMatch(text, /Showing chars/);
});

test("get_search_content finds bounded passages in stored fetched content", async () => {
	const tool = getContentTool();
	storeFetchedContent(`prefix ${"A".repeat(2_000)} Installation requires Node 22. ${"B".repeat(2_000)} suffix`);

	const result = await tool.execute("call", {
		responseId: "large-fetch",
		urlIndex: 0,
		findText: "installation",
	});

	assert.equal(result.details.matchCount, 1);
	assert.equal(result.details.findMode, "case-insensitive");
	assert.match(result.content[0].text, /Installation requires Node 22/);
	assert.ok(result.content[0].text.length < 1_000);
});
