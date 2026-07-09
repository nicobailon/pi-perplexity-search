import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const brightdataModuleUrl = new URL("../brightdata.ts", import.meta.url).href;
const feedsModuleUrl = new URL("../brightdata-feeds.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"OPENAI_API_KEY",
		"BRAVE_API_KEY",
		"PARALLEL_API_KEY",
		"TAVILY_API_KEY",
		"EXA_API_KEY",
		"PERPLEXITY_API_KEY",
		"GEMINI_API_KEY",
		"BRIGHTDATA_API_TOKEN",
		"BRIGHTDATA_API_KEY",
		"BRIGHTDATA_ZONE",
	]) {
		delete childEnv[key];
	}
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

test("isBrightDataAvailable reflects presence of a token", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-bd-avail-"));
	const child = runChild(`
		const { isBrightDataAvailable } = await import(${JSON.stringify(brightdataModuleUrl)});
		console.log(JSON.stringify({ available: isBrightDataAvailable() }));
	`, { HOME: home, USERPROFILE: home });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout.trim()).available, false);

	const child2 = runChild(`
		const { isBrightDataAvailable } = await import(${JSON.stringify(brightdataModuleUrl)});
		console.log(JSON.stringify({ available: isBrightDataAvailable() }));
	`, { HOME: home, USERPROFILE: home, BRIGHTDATA_API_TOKEN: "bd-token" });
	assert.equal(child2.status, 0, child2.stderr);
	assert.equal(JSON.parse(child2.stdout.trim()).available, true);
});

test("SERP search sends brd_json + bearer auth, parses organic, applies filters", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-bd-serp-"));
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				organic: [
					{ link: "https://github.com/nicobailon/pi-web-access", title: "Repo", description: "the repo" },
					{ link: "https://gist.github.com/x/abc", title: "Gist", description: "a gist" },
					{ link: "https://example.com/nope", title: "Example", description: "nope" },
				],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		const result = await searchWithBrightData("sdk docs", {
			domainFilter: ["github.com", "-gist.github.com"],
			recencyFilter: "week",
			numResults: 2,
		});
		console.log(JSON.stringify({ capturedUrl, capturedHeaders, capturedBody, results: result.results, answer: result.answer }));
	`, { HOME: home, USERPROFILE: home, BRIGHTDATA_API_TOKEN: "bd-token" });

	assert.equal(child.status, 0, child.stderr);
	const out = JSON.parse(child.stdout.trim());
	assert.equal(out.capturedUrl, "https://api.brightdata.com/request");
	assert.equal(out.capturedHeaders.Authorization, "Bearer bd-token");
	assert.equal(out.capturedBody.zone, "mcp_unlocker");
	assert.equal(out.capturedBody.format, "raw");
	assert.equal(out.capturedBody.data_format, "parsed_light");
	assert.match(out.capturedBody.url, /[?&]brd_json=1/);
	assert.match(out.capturedBody.url, /tbs=qdr%3Aw/);
	assert.match(decodeURIComponent(out.capturedBody.url), /site:github\.com/);
	assert.match(decodeURIComponent(out.capturedBody.url), /-site:gist\.github\.com/);
	// gist (blocked) and example (not allowed) are filtered out post-parse.
	assert.deepEqual(out.results.map((r) => r.url), ["https://github.com/nicobailon/pi-web-access"]);
	assert.match(out.answer, /the repo/);
});

test("SERP search honors a custom zone from config", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-bd-zone-"));
	const child = runChild(`
		const dir = ${JSON.stringify(home)};
		const { writeFileSync } = await import("node:fs");
		writeFileSync(dir + "/web-search.json", JSON.stringify({ brightdataApiKey: "cfg-token", brightdataZone: "my_zone" }));
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({ organic: [] }), { status: 200 });
		};
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		await searchWithBrightData("q");
		console.log(JSON.stringify({ zone: capturedBody.zone }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout.trim()).zone, "my_zone");
});

test("Web Unlocker scrape returns markdown; falls through (null) without a key or on error", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-bd-scrape-"));

	// Happy path: markdown returned.
	const ok = runChild(`
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedBody = JSON.parse(init.body);
			return new Response("# Title\\n\\n" + "content ".repeat(50), { status: 200 });
		};
		const { scrapeWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		const result = await scrapeWithBrightData("https://blocked.example.com/a");
		console.log(JSON.stringify({ data_format: capturedBody.data_format, title: result?.title, hasContent: !!result?.content, error: result?.error }));
	`, { HOME: home, USERPROFILE: home, BRIGHTDATA_API_TOKEN: "bd-token" });
	assert.equal(ok.status, 0, ok.stderr);
	const okOut = JSON.parse(ok.stdout.trim());
	assert.equal(okOut.data_format, "markdown");
	assert.equal(okOut.title, "Title");
	assert.equal(okOut.hasContent, true);
	assert.equal(okOut.error, null);

	// No key: returns null without any network call.
	const noKey = runChild(`
		let called = false;
		globalThis.fetch = async () => { called = true; return new Response("x", { status: 200 }); };
		const { scrapeWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		const result = await scrapeWithBrightData("https://blocked.example.com/a");
		console.log(JSON.stringify({ result, called }));
	`, { HOME: home, USERPROFILE: home });
	assert.equal(noKey.status, 0, noKey.stderr);
	const noKeyOut = JSON.parse(noKey.stdout.trim());
	assert.equal(noKeyOut.result, null);
	assert.equal(noKeyOut.called, false);

	// HTTP error: returns null (caller falls through to the next extractor).
	const err = runChild(`
		globalThis.fetch = async () => new Response("blocked", { status: 403 });
		const { scrapeWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		const result = await scrapeWithBrightData("https://blocked.example.com/a");
		console.log(JSON.stringify({ result }));
	`, { HOME: home, USERPROFILE: home, BRIGHTDATA_API_TOKEN: "bd-token" });
	assert.equal(err.status, 0, err.stderr);
	assert.equal(JSON.parse(err.stdout.trim()).result, null);
});

test("feed detection routes known platform URLs and ignores others", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-bd-detect-"));
	const child = runChild(`
		const { detectBrightDataFeed } = await import(${JSON.stringify(feedsModuleUrl)});
		const cases = {
			amazon: detectBrightDataFeed("https://www.amazon.com/Great-Thing/dp/B0ABCD1234")?.id ?? null,
			reddit: detectBrightDataFeed("https://www.reddit.com/r/rust/comments/abc/title/")?.id ?? null,
			npm: detectBrightDataFeed("https://www.npmjs.com/package/p-limit")?.id ?? null,
			pypi: detectBrightDataFeed("https://pypi.org/project/requests/")?.id ?? null,
			github: detectBrightDataFeed("https://github.com/nicobailon/pi-web-access/blob/main/index.ts")?.id ?? null,
			plain: detectBrightDataFeed("https://example.com/article")?.id ?? null,
			amazonHome: detectBrightDataFeed("https://www.amazon.com/")?.id ?? null,
		};
		console.log(JSON.stringify(cases));
	`, { HOME: home, USERPROFILE: home });
	assert.equal(child.status, 0, child.stderr);
	const out = JSON.parse(child.stdout.trim());
	assert.equal(out.amazon, "amazon_product");
	assert.equal(out.reddit, "reddit_posts");
	assert.equal(out.npm, "npm_package");
	assert.equal(out.pypi, "pypi_package");
	assert.equal(out.github, "github_repository_file");
	assert.equal(out.plain, null);
	assert.equal(out.amazonHome, null);
});

test("feed fetch triggers a snapshot, polls past 'building', and returns records", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-bd-feed-"));
	const child = runChild(`
		const calls = [];
		let triggerBody = null;
		let snapshotHits = 0;
		globalThis.fetch = async (url, init) => {
			const u = String(url);
			calls.push(u);
			if (u.startsWith("https://api.brightdata.com/datasets/v3/trigger")) {
				triggerBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ snapshot_id: "snap1" }), { status: 200 });
			}
			if (u.startsWith("https://api.brightdata.com/datasets/v3/snapshot/")) {
				snapshotHits++;
				if (snapshotHits === 1) return new Response(JSON.stringify({ status: "building" }), { status: 200 });
				return new Response(JSON.stringify([{ title: "p-limit", downloads: 123 }]), { status: 200 });
			}
			throw new Error("Unexpected fetch " + u);
		};
		const { detectBrightDataFeed, fetchBrightDataFeed } = await import(${JSON.stringify(feedsModuleUrl)});
		const feed = detectBrightDataFeed("https://www.npmjs.com/package/p-limit");
		const result = await fetchBrightDataFeed("https://www.npmjs.com/package/p-limit", feed);
		console.log(JSON.stringify({ calls, triggerBody, title: result?.title, containsDataset: result?.content.includes(feed.datasetId), containsRecord: result?.content.includes("p-limit"), error: result?.error }));
	`, { HOME: home, USERPROFILE: home, BRIGHTDATA_API_TOKEN: "bd-token", BRIGHTDATA_POLL_INTERVAL_MS: "0" });
	assert.equal(child.status, 0, child.stderr);
	const out = JSON.parse(child.stdout.trim());
	assert.ok(out.calls.some((c) => c.includes("/trigger?dataset_id=")));
	// npm uses package_name (not url) — the per-feed input mapping.
	assert.deepEqual(out.triggerBody, [{ package_name: "p-limit" }]);
	assert.equal(out.title, "npm package (structured)");
	assert.equal(out.containsDataset, true);
	assert.equal(out.containsRecord, true);
	assert.equal(out.error, null);
});

test("feed fetch returns null without a key (no network call)", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-bd-feed-nokey-"));
	const child = runChild(`
		let called = false;
		globalThis.fetch = async () => { called = true; return new Response("{}", { status: 200 }); };
		const { detectBrightDataFeed, fetchBrightDataFeed } = await import(${JSON.stringify(feedsModuleUrl)});
		const feed = detectBrightDataFeed("https://pypi.org/project/requests/");
		const result = await fetchBrightDataFeed("https://pypi.org/project/requests/", feed);
		console.log(JSON.stringify({ result, called }));
	`, { HOME: home, USERPROFILE: home });
	assert.equal(child.status, 0, child.stderr);
	const out = JSON.parse(child.stdout.trim());
	assert.equal(out.result, null);
	assert.equal(out.called, false);
});

test("auto provider falls through to Bright Data when it is the only key", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-bd-auto-"));
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			const u = String(url);
			calls.push(u);
			if (u === "https://mcp.exa.ai/mcp") return new Response("Exa unavailable", { status: 503 });
			if (u === "https://api.brightdata.com/request") {
				return new Response(JSON.stringify({
					organic: [{ link: "https://docs.rs/tokio", title: "Tokio", description: "async runtime" }],
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			throw new Error("Unexpected fetch " + u);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("rust async runtime", { provider: "auto" });
		console.log(JSON.stringify({ calls, provider: result.provider, answer: result.answer }));
	`, { HOME: home, USERPROFILE: home, BRIGHTDATA_API_TOKEN: "bd-token" });
	assert.equal(child.status, 0, child.stderr);
	const out = JSON.parse(child.stdout.trim());
	assert.ok(out.calls.includes("https://api.brightdata.com/request"));
	assert.equal(out.provider, "brightdata");
	assert.match(out.answer, /async runtime/);
});
