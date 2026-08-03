import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const extractUrl = new URL("../extract.ts", import.meta.url).href;

async function runExtract(config, urls, optionsByUrl = []) {
	const root = await mkdtemp(join(tmpdir(), "pi-domain-policy-extract-"));
	await writeFile(join(root, "web-search.json"), JSON.stringify(config), "utf8");
	const childEnv = { ...process.env, PI_CODING_AGENT_DIR: root, HOME: root, USERPROFILE: root };
	for (const key of ["GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY", "CLOUDFLARE_API_KEY", "PARALLEL_API_KEY", "TINYFISH_API_KEY", "FIRECRAWL_BASE_URL", "FIRECRAWL_API_KEY", "BRIGHTDATA_API_KEY", "KAGI_API_KEY", "OLLAMA_API_KEY", "BRIGHTDATA_UNLOCKER_ZONE"]) delete childEnv[key];
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			let fetchCalls = [];
			globalThis.fetch = async (url) => {
				fetchCalls.push(String(url));
				return new Response(\`<!doctype html><html><head><title>Allowed</title></head><body><article><h1>Allowed</h1><p>\${"Readable content. ".repeat(60)}</p></article></body></html>\`, { status: 200, headers: { "content-type": "text/html" } });
			};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const urls = ${JSON.stringify(urls)};
			const optionsByUrl = ${JSON.stringify(optionsByUrl)};
			const results = [];
			for (let index = 0; index < urls.length; index += 1) {
				results.push(await extractContent(urls[index], undefined, { ...optionsByUrl[index], lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));
			}
			console.log(JSON.stringify({ fetchCalls, results }));
		`,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

test("fetch_content enforces domain policy before target network requests", async () => {
	const output = await runExtract(
		{ fetchContent: { domainPolicy: { allow: ["allowed.example"], deny: ["blocked.example"] } } },
		["https://blocked.example/article", "https://allowed.example/article"],
	);
	assert.equal(output.fetchCalls.length, 1);
	assert.equal(output.fetchCalls[0], "https://allowed.example/article");
	assert.match(output.results[0].error, /Blocked hostname by fetch_content domain policy/);
	assert.equal(output.results[1].error, null);
	assert.equal(output.results[1].title, "Allowed");
});

test("fetch_content domain policy leaves local file inputs outside hostname checks", async () => {
	const output = await runExtract(
		{ fetchContent: { domainPolicy: { allow: ["only.example"] } } },
		["file:///tmp/not-a-web-source.txt"],
	);
	assert.deepEqual(output.fetchCalls, []);
	assert.doesNotMatch(output.results[0].error, /fetch_content domain policy/);
});

test("fetch_content domain policy blocks YouTube frame and timestamp branches before network helpers", async () => {
	const output = await runExtract(
		{ fetchContent: { domainPolicy: { deny: ["youtube.com"] } } },
		["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
		[{ frames: 1 }, { timestamp: "1" }],
	);
	assert.deepEqual(output.fetchCalls, []);
	assert.match(output.results[0].error, /Blocked hostname by fetch_content domain policy: www\.youtube\.com/);
	assert.match(output.results[1].error, /Blocked hostname by fetch_content domain policy: www\.youtube\.com/);
});

test("fetch_content rejects chunked oversized text responses while reading", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-oversized-text-extract-"));
	const childEnv = { ...process.env, PI_CODING_AGENT_DIR: root, HOME: root, USERPROFILE: root };
	for (const key of ["GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY", "CLOUDFLARE_API_KEY", "PARALLEL_API_KEY", "TINYFISH_API_KEY", "FIRECRAWL_BASE_URL", "FIRECRAWL_API_KEY"]) delete childEnv[key];
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			globalThis.fetch = async () => new Response(new ReadableStream({
				start(controller) {
					const chunk = new Uint8Array(1024 * 1024).fill(65);
					for (let i = 0; i < 6; i += 1) controller.enqueue(chunk);
					controller.close();
				},
			}), { status: 200, headers: { "content-type": "text/html" } });
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const result = await extractContent("https://allowed.example/article", undefined, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
			console.log(JSON.stringify(result));
		`,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout.trim());
	assert.match(result.error, /Response too large \(5MB\)/);
});
