import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import initializeExtension from "../index.ts";
import { clearResults, getFetchCacheDir, restoreFromSession } from "../storage.ts";

const originalFetch = globalThis.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalDateNow = Date.now;

afterEach(() => {
	globalThis.fetch = originalFetch;
	Date.now = originalDateNow;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	clearResults();
});

async function useTempAgentDir() {
	const dir = await mkdtemp(join(tmpdir(), "pi-web-access-fetch-cache-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
}

function registerTools() {
	const tools = [];
	const entries = [];
	initializeExtension({
		registerTool(tool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
		appendEntry(type, data) { entries.push({ type, data }); },
	});
	return {
		entries,
		fetchTool: tools.find((tool) => tool.name === "fetch_content"),
		getContentTool: tools.find((tool) => tool.name === "get_search_content"),
	};
}

function restoreEntry(data) {
	restoreFromSession({
		sessionManager: {
			getBranch: () => [{ type: "custom", customType: "web-search-results", data }],
		},
	});
}

test("fetch_content stores full content in cache and writes a bounded session entry", async () => {
	await useTempAgentDir();
	const pageContent = "Cached page content. ".repeat(4_000);
	globalThis.fetch = async () => new Response(pageContent, { status: 200, headers: { "content-type": "text/plain" } });

	const { entries, fetchTool, getContentTool } = registerTools();
	assert.ok(fetchTool);
	assert.ok(getContentTool);

	const result = await fetchTool.execute("call", { url: "https://93.184.216.34/page" });
	const entry = entries.find((candidate) => candidate.type === "web-search-results");
	assert.ok(entry);
	assert.equal(entry.data.type, "fetch");
	assert.equal(entry.data.urls, undefined);
	assert.ok(entry.data.fetchCache?.key);
	assert.equal(entry.data.urlMetadata?.[0]?.contentLength, pageContent.length);

	const serialized = JSON.stringify(entry.data);
	assert.ok(serialized.length < 5_000, `session entry was ${serialized.length} chars`);
	assert.doesNotMatch(serialized, /Cached page content\. Cached page content\./);

	clearResults();
	restoreEntry(entry.data);
	const restored = await getContentTool.execute("call", {
		responseId: result.details.responseId,
		urlIndex: 0,
		offset: pageContent.length - 21,
		limit: 21,
	});
	assert.equal(restored.details.returnedChars, 21);
	assert.match(restored.content[0].text, /Cached page content\./);
});

test("legacy inline fetched session entries remain readable", async () => {
	await useTempAgentDir();
	const { getContentTool } = registerTools();
	assert.ok(getContentTool);
	const legacy = {
		id: "legacy-fetch",
		type: "fetch",
		timestamp: Date.now(),
		urls: [{ url: "https://example.com/legacy", title: "Legacy", content: "legacy inline content", error: null }],
	};

	restoreEntry(legacy);
	const result = await getContentTool.execute("call", { responseId: "legacy-fetch", urlIndex: 0 });
	assert.match(result.content[0].text, /legacy inline content/);
	assert.equal(result.details.contentLength, "legacy inline content".length);
});

test("loaded cached fetched content expires after the result lifetime", async () => {
	const startedAt = originalDateNow();
	Date.now = () => startedAt;
	await useTempAgentDir();
	const pageContent = "expiring cache-backed content";
	globalThis.fetch = async () => new Response(pageContent, { status: 200, headers: { "content-type": "text/plain" } });

	const { entries, fetchTool, getContentTool } = registerTools();
	assert.ok(fetchTool);
	assert.ok(getContentTool);
	const result = await fetchTool.execute("call", { url: "https://93.184.216.34/expiring-cache" });
	const entry = entries.find((candidate) => candidate.type === "web-search-results");
	assert.ok(entry?.data.fetchCache?.key);

	clearResults();
	restoreEntry(entry.data);
	const loaded = await getContentTool.execute("call", { responseId: result.details.responseId, urlIndex: 0 });
	assert.match(loaded.content[0].text, /expiring cache-backed content/);

	Date.now = () => startedAt + 60 * 60 * 1000;
	const expired = await getContentTool.execute("call", { responseId: result.details.responseId, urlIndex: 0 });
	assert.equal(expired.details.error, "Cached fetched content is missing or expired");
	assert.match(expired.content[0].text, /Cached fetched content is missing or expired/);
	assert.doesNotMatch(expired.content[0].text, /expiring cache-backed content/);
});

test("missing cache files return an actionable fetched-content error", async () => {
	const agentDir = await useTempAgentDir();
	const pageContent = "cache-backed content";
	globalThis.fetch = async () => new Response(pageContent, { status: 200, headers: { "content-type": "text/plain" } });

	const { entries, fetchTool, getContentTool } = registerTools();
	assert.ok(fetchTool);
	assert.ok(getContentTool);
	const result = await fetchTool.execute("call", { url: "https://93.184.216.34/missing-cache" });
	const entry = entries.find((candidate) => candidate.type === "web-search-results");
	assert.ok(entry?.data.fetchCache?.key);
	rmSync(join(getFetchCacheDir(), entry.data.fetchCache.key), { force: true });

	clearResults();
	restoreEntry(entry.data);
	const missing = await getContentTool.execute("call", { responseId: result.details.responseId, urlIndex: 0 });
	assert.equal(missing.details.error, "Cached fetched content is missing or expired");
	assert.match(missing.content[0].text, /Cached fetched content is missing or expired/);
	rmSync(agentDir, { recursive: true, force: true });
});
