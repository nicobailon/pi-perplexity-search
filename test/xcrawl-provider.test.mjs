import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const xcrawlModuleUrl = new URL("../xcrawl.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;

async function createHome(config) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-xcrawl-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "XCRAWL_API_KEY", "OPENAI_API_KEY", "BRAVE_API_KEY",
		"TAVILY_API_KEY", "SERPER_API_KEY", "ANYSEARCH_API_KEY",
	]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

function serpEnvelope(overrides = {}) {
	return {
		search_metadata: { id: "01KMMKX1EC62VPCD7FW8YZ8QVS", status: "completed", total_time_taken: 2, ...(overrides.metadata ?? {}) },
		search_parameters: { engine: "google_search", q: "example query" },
		total_credits_used: 1,
		organic_results: overrides.organic ?? [
			{ position: 1, title: "First result", link: "https://www.example.com/first", snippet: "First result snippet." },
			{ position: 2, title: null, link: "https://sub.other-domain.org/second", snippet: "Second result snippet with no title." },
		],
		...(overrides.extra ?? {}),
	};
}

test("XCrawl sends Bearer credentials to the SERP endpoint, normalizes null titles, and supports explicit routing", async () => {
	const home = await createHome({ xcrawlApiKey: "xc-test-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) });
			return new Response(JSON.stringify(${JSON.stringify(serpEnvelope())}), { status: 200 });
		};
		const { searchWithXCrawl } = await import(${JSON.stringify(xcrawlModuleUrl)});
		const direct = await searchWithXCrawl("research", { numResults: 7 });
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const routed = await search("route", { provider: "xcrawl" });
		console.log(JSON.stringify({ calls, direct, routedProvider: routed.provider }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls[0].url, "https://run.xcrawl.com/v1/serp");
	assert.equal(output.calls[0].headers["authorization"], "Bearer xc-test-key");
	assert.deepEqual(output.calls[0].body, { engine: "google_search", q: "research" });
	assert.equal(output.direct.results.length, 2);
	assert.equal(output.direct.results[0].title, "First result");
	assert.equal(output.direct.results[0].url, "https://www.example.com/first");
	assert.equal(output.direct.results[1].title, "https://sub.other-domain.org/second");
	assert.equal(output.direct.results[0].snippet, "First result snippet.");
	assert.equal(output.routedProvider, "xcrawl");
});

test("XCrawl applies the shared domain filter client-side", async () => {
	const home = await createHome({ xcrawlApiKey: "xc-test-key" });
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify(${JSON.stringify(serpEnvelope())}), { status: 200 });
		const { searchWithXCrawl } = await import(${JSON.stringify(xcrawlModuleUrl)});
		const included = await searchWithXCrawl("q", { domainFilter: ["example.com"] });
		const excluded = await searchWithXCrawl("q", { domainFilter: ["-example.com"] });
		const fuzzyForms = await searchWithXCrawl("q", { domainFilter: [" https://www.Example.COM/path "] });
		console.log(JSON.stringify({
			includedUrls: included.results.map((r) => r.url),
			excludedUrls: excluded.results.map((r) => r.url),
			fuzzyUrls: fuzzyForms.results.map((r) => r.url),
		}));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.includedUrls, ["https://www.example.com/first"]);
	assert.deepEqual(output.excludedUrls, ["https://sub.other-domain.org/second"]);
	assert.deepEqual(output.fuzzyUrls, ["https://www.example.com/first"]);
});

test("XCrawl preserves explicit www. labels in domain filters", async () => {
	const home = await createHome({ xcrawlApiKey: "xc-test-key" });
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify(${JSON.stringify(serpEnvelope({
			organic: [
				{ position: 1, title: "WWW result", link: "https://www.example.com/first", snippet: "WWW result snippet." },
				{ position: 2, title: "Blog result", link: "https://blog.example.com/second", snippet: "Blog result snippet." },
			],
		}))}), { status: 200 });
		const { searchWithXCrawl } = await import(${JSON.stringify(xcrawlModuleUrl)});
		const included = await searchWithXCrawl("q", { domainFilter: ["www.example.com"] });
		const excluded = await searchWithXCrawl("q", { domainFilter: ["-www.example.com"] });
		console.log(JSON.stringify({
			includedUrls: included.results.map((r) => r.url),
			excludedUrls: excluded.results.map((r) => r.url),
		}));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.includedUrls, ["https://www.example.com/first"]);
	assert.deepEqual(output.excludedUrls, ["https://blog.example.com/second"]);
});

test("XCrawl caps results to the requested numResults", async () => {
	const home = await createHome({ xcrawlApiKey: "xc-test-key" });
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify(${JSON.stringify(serpEnvelope({
			organic: [
				{ position: 1, title: "First result", link: "https://www.example.com/first", snippet: "First result snippet." },
				{ position: 2, title: "Second result", link: "https://www.example.com/second", snippet: "Second result snippet." },
				{ position: 3, title: "Third result", link: "https://www.example.com/third", snippet: "Third result snippet." },
			],
		}))}), { status: 200 });
		const { searchWithXCrawl } = await import(${JSON.stringify(xcrawlModuleUrl)});
		const response = await searchWithXCrawl("q", { numResults: 1 });
		console.log(JSON.stringify(response.results));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const results = JSON.parse(child.stdout.trim());
	assert.equal(results.length, 1);
	assert.equal(results[0].url, "https://www.example.com/first");
});

test("XCrawl surfaces documented API errors without leaking the key", async () => {
	const home = await createHome({ xcrawlApiKey: "xc-secret-key" });
	const child = runChild(`
		let capturedAuthorization = "";
		globalThis.fetch = async (url, init) => {
			capturedAuthorization = new Headers(init.headers).get("authorization") ?? "";
			return new Response(JSON.stringify({ message: "invalid api key" }), { status: 401 });
		};
		const { searchWithXCrawl } = await import(${JSON.stringify(xcrawlModuleUrl)});
		try {
			await searchWithXCrawl("boom");
			console.log(JSON.stringify({ failed: false }));
		} catch (err) {
			console.log(JSON.stringify({ failed: true, message: String(err.message), capturedAuthorization }));
		}
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.failed, true);
	assert.match(output.message, /XCrawl API error \(401\): invalid api key/);
	assert.ok(!output.message.includes("xc-secret-key"));
	assert.equal(output.capturedAuthorization, "Bearer xc-secret-key");
});

test("XCrawl rejects unexpected envelope shapes instead of returning empty answers silently", async () => {
	const home = await createHome({ xcrawlApiKey: "xc-test-key" });
	const child = runChild(`
		const responses = [
			{ search_metadata: { status: "failed" } },
			{ search_metadata: { status: "completed" } },
		];
		globalThis.fetch = async () => new Response(JSON.stringify(responses.shift()), { status: 200 });
		const { searchWithXCrawl } = await import(${JSON.stringify(xcrawlModuleUrl)});
		const messages = [];
		for (const query of ["bad status", "missing results"]) {
			try {
				await searchWithXCrawl(query);
				messages.push("unexpected success");
			} catch (err) {
				messages.push(String(err.message));
			}
		}
		console.log(JSON.stringify(messages));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const messages = JSON.parse(child.stdout.trim());
	assert.equal(messages.length, 2);
	assert.match(messages[0], /invalid response/);
	assert.match(messages[1], /expected organic_results array/);
});

test("configured routing falls back when XCrawl hits its provider timeout", async () => {
	const home = await createHome({
		xcrawlApiKey: "xc-test-key",
		braveApiKey: "brave-test-key",
		searchRouting: { providers: ["xcrawl", "brave"], fallbackOn: ["network"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target === "https://run.xcrawl.com/v1/serp") {
				const error = new Error("The operation was aborted due to timeout");
				error.name = "TimeoutError";
				throw error;
			}
			if (target.startsWith("https://api.search.brave.com/res/v1/web/search")) {
				return new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com/brave", description: "fallback" }] } }), { status: 200 });
			}
			throw new Error("unexpected fetch " + target);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("timeout route", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, calls }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "brave");
	assert.equal(output.calls[0], "https://run.xcrawl.com/v1/serp");
	assert.ok(output.calls[1].startsWith("https://api.search.brave.com/res/v1/web/search"));
});

test("XCrawl is never part of auto fallback, even with credentials", async () => {
	const home = await createHome({ xcrawlApiKey: "xc-test-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error("unexpected auto provider"); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try {
			await search("auto", { provider: "auto" });
			console.log(JSON.stringify({ ok: true, calls }));
		} catch (err) {
			console.log(JSON.stringify({ ok: false, calls }));
		}
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.ok(output.calls.every((url) => !url.startsWith("https://run.xcrawl.com/")));
});

test('provider "all" does not fan out to XCrawl', async () => {
	const home = await createHome({ xcrawlApiKey: "xc-test-key", braveApiKey: "brave-test-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url).startsWith("https://run.xcrawl.com/")) throw new Error("XCrawl must not be part of all");
			return new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com/brave", description: "ok" }] } }), { status: 200 });
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("fan out", { provider: "all" });
		console.log(JSON.stringify({ provider: result.provider, calls }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "all");
	assert.ok(output.calls.every((url) => !url.startsWith("https://run.xcrawl.com/")));
});

test("XCrawl provider timeout is a retriable failure, not caller cancellation", async () => {
	const home = await createHome({ xcrawlApiKey: "xc-test-key" });
	const child = runChild(`
		globalThis.fetch = async () => {
			const e = new Error("The operation was aborted due to timeout");
			e.name = "TimeoutError";
			throw e;
		};
		const { searchWithXCrawl } = await import(${JSON.stringify(xcrawlModuleUrl)});
		try {
			await searchWithXCrawl("slow");
			console.log(JSON.stringify({ failed: false }));
		} catch (err) {
			console.log(JSON.stringify({ failed: true, message: String(err.message), name: err.name }));
		}
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.failed, true);
	assert.match(output.message, /timed out after 60s/);
	assert.ok(!/abort/i.test(output.message));
});

test("XCrawl preserves caller cancellation when a timeout rejection races with abort", async () => {
	const home = await createHome({ xcrawlApiKey: "xc-test-key" });
	const child = runChild(`
		const controller = new AbortController();
		globalThis.fetch = async () => {
			controller.abort();
			const error = new Error("The operation was aborted due to timeout");
			error.name = "TimeoutError";
			throw error;
		};
		const { searchWithXCrawl } = await import(${JSON.stringify(xcrawlModuleUrl)});
		try {
			await searchWithXCrawl("cancel", { signal: controller.signal });
			console.log(JSON.stringify({ failed: false }));
		} catch (error) {
			console.log(JSON.stringify({ failed: true, message: String(error.message), name: error.name }));
		}
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.failed, true);
	assert.match(output.message, /abort/i);
	assert.ok(!/timed out after 60s/i.test(output.message));
});

test("XCrawl is unavailable without credentials and never part of auto fallback", async () => {
	const home = await createHome({});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error("unexpected auto provider"); };
		const { isXcrawlAvailable } = await import(${JSON.stringify(xcrawlModuleUrl)});
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		let autoError = "";
		try { await search("auto", { provider: "auto" }); } catch (error) { autoError = String(error); }
		console.log(JSON.stringify({ available: isXcrawlAvailable(), calls, autoError }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.available, false);
	assert.ok(output.calls.every((url) => !url.startsWith("https://run.xcrawl.com/")));
	assert.doesNotMatch(output.autoError, /XCrawl/);
});
