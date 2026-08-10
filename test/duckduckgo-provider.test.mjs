import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const duckDuckGoModuleUrl = new URL("../duckduckgo.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of ["PI_CODING_AGENT_DIR", "TAVILY_API_KEY"]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

async function createConfig(config) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-duckduckgo-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

const RESULT_HTML = `
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fa"> Example Docs </a><a class="result__snippet">First snippet</a></div>
<div class="result"><a class="result__a" href="https://example.net/b">Example Net</a><div class="result__snippet">Second snippet</div></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=javascript%3Aalert(1)">Bad</a><div class="result__snippet">Bad snippet</div></div>`;

test("DuckDuckGo uses the fixed HTML endpoint, decodes redirects, and caps results", () => {
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			return new Response(${JSON.stringify(RESULT_HTML)}, { status: 200 });
		};
		const { searchWithDuckDuckGo, isDuckDuckGoAvailable } = await import(${JSON.stringify(duckDuckGoModuleUrl)});
		const result = await searchWithDuckDuckGo("example search", { numResults: 1 });
		console.log(JSON.stringify({ capturedUrl, capturedHeaders, available: isDuckDuckGoAvailable(), result }));
	`);
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	const url = new URL(output.capturedUrl);
	assert.equal(url.origin + url.pathname, "https://html.duckduckgo.com/html/");
	assert.equal(url.searchParams.get("q"), "example search");
	assert.equal(output.capturedHeaders.Accept, "text/html");
	assert.match(output.capturedHeaders["User-Agent"], /Mozilla/);
	assert.equal(output.available, true);
	assert.deepEqual(output.result.results, [{ title: "Example Docs", url: "https://docs.example.com/a", snippet: "First snippet" }]);
});

test("DuckDuckGo enforces local domain filters and accepts filtered empty results", () => {
	const child = runChild(`
		globalThis.fetch = async () => new Response(${JSON.stringify(RESULT_HTML)}, { status: 200 });
		const { searchWithDuckDuckGo } = await import(${JSON.stringify(duckDuckGoModuleUrl)});
		const allowed = await searchWithDuckDuckGo("example", { domainFilter: ["example.net"], numResults: 3 });
		const filtered = await searchWithDuckDuckGo("example", { domainFilter: ["example.com", "-docs.example.com"] });
		console.log(JSON.stringify({ allowed, filtered }));
	`);
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.allowed.results, [{ title: "Example Net", url: "https://example.net/b", snippet: "Second snippet" }]);
	assert.deepEqual(output.filtered.results, []);
});

test("DuckDuckGo invalid HTML fails directly and falls through configured invalid-response routing", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["duckduckgo", "tavily"], fallbackOn: ["invalid-response"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url).startsWith("https://html.duckduckgo.com/html/")) return new Response("<html>blocked</html>", { status: 200 });
			if (String(url) === "https://api.tavily.com/search") return new Response(JSON.stringify({ answer: "fallback", results: [] }), { status: 200 });
			throw new Error("Unexpected fetch " + url);
		};
		const { searchWithDuckDuckGo } = await import(${JSON.stringify(duckDuckGoModuleUrl)});
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		let directError = "";
		try { await searchWithDuckDuckGo("blocked"); } catch (error) { directError = String(error); }
		const routed = await search("blocked", { provider: "auto" });
		console.log(JSON.stringify({ directError, routed, calls }));
	`, { PI_CODING_AGENT_DIR: home, TAVILY_API_KEY: "tavily-test-key" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.directError, /DuckDuckGo returned no parseable results/);
	assert.equal(output.routed.provider, "tavily");
	assert.deepEqual(output.calls, [
		"https://html.duckduckgo.com/html/?q=blocked",
		"https://html.duckduckgo.com/html/?q=blocked",
		"https://api.tavily.com/search",
	]);
});

test("DuckDuckGo 503 falls through configured transient routing", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["duckduckgo", "tavily"], fallbackOn: ["transient"] },
	});
	const child = runChild(`
		globalThis.fetch = async (url) => {
			if (String(url).startsWith("https://html.duckduckgo.com/html/")) return new Response("unavailable", { status: 503 });
			if (String(url) === "https://api.tavily.com/search") return new Response(JSON.stringify({ answer: "fallback", results: [] }), { status: 200 });
			throw new Error("Unexpected fetch " + url);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		console.log(JSON.stringify(await search("unavailable", { provider: "auto" })));
	`, { PI_CODING_AGENT_DIR: home, TAVILY_API_KEY: "tavily-test-key" });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout.trim()).provider, "tavily");
});
