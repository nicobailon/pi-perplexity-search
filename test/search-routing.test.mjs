import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;

async function createConfig(config) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-search-routing-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of ["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "OPENAI_API_KEY", "BRAVE_API_KEY", "PARALLEL_API_KEY", "TINYFISH_API_KEY", "SEARCH1API_KEY", "SEARCHINFINITY_API_KEY", "QUERIT_API_KEY", "TAVILY_API_KEY", "JINA_API_KEY", "SERPDIVE_API_KEY", "KAGI_API_KEY", "OLLAMA_API_KEY", "SERPBASE_API_KEY", "XAI_API_KEY", "BRIGHTDATA_API_KEY", "BRIGHTDATA_SERP_ZONE", "SEARXNG_BASE_URL", "EXA_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY"]) {
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

test("configured routing follows order after a selected network failure and returns the successful provider", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["brave", "tavily"], fallbackOn: ["network"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url).startsWith("https://api.search.brave.com/")) throw new TypeError("fetch failed");
			if (String(url) === "https://api.tavily.com/search") {
				return new Response(JSON.stringify({ answer: "Tavily route answer", results: [] }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + url);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("ordered route", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, answer: result.answer, calls }));
	`, {
		PI_CODING_AGENT_DIR: home,
		BRAVE_API_KEY: "brave-test-key",
		TAVILY_API_KEY: "tavily-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "tavily");
	assert.equal(output.answer, "Tavily route answer");
	assert.deepEqual(output.calls, ["https://api.search.brave.com/res/v1/web/search?q=ordered+route&count=5", "https://api.tavily.com/search"]);
});

test("configured routing fails closed on quota errors not selected by fallbackOn", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["brave", "tavily"], fallbackOn: ["network"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url).startsWith("https://api.search.brave.com/")) return new Response("quota", { status: 429 });
			if (String(url) === "https://api.tavily.com/search") throw new Error("Tavily must not run");
			throw new Error("Unexpected fetch " + url);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try {
			await search("quota route", { provider: "auto" });
			console.log(JSON.stringify({ ok: true, calls }));
		} catch (error) {
			console.log(JSON.stringify({ ok: false, error: String(error), calls }));
		}
	`, {
		PI_CODING_AGENT_DIR: home,
		BRAVE_API_KEY: "brave-test-key",
		TAVILY_API_KEY: "tavily-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.match(output.error, /brave search failed \(quota\)/);
	assert.deepEqual(output.calls, ["https://api.search.brave.com/res/v1/web/search?q=quota+route&count=5"]);
});

test("auth status fails closed even when the response text looks like quota", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["brave", "tavily"], fallbackOn: ["quota"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url).startsWith("https://api.search.brave.com/")) return new Response("quota exceeded", { status: 403 });
			if (String(url) === "https://api.tavily.com/search") throw new Error("Tavily must not run");
			throw new Error("Unexpected fetch " + url);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try {
			await search("auth route", { provider: "auto" });
			console.log(JSON.stringify({ ok: true, calls }));
		} catch (error) {
			console.log(JSON.stringify({ ok: false, error: String(error), calls }));
		}
	`, {
		PI_CODING_AGENT_DIR: home,
		BRAVE_API_KEY: "brave-test-key",
		TAVILY_API_KEY: "tavily-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.match(output.error, /brave search failed \(auth\)/);
	assert.deepEqual(output.calls, ["https://api.search.brave.com/res/v1/web/search?q=auth+route&count=5"]);
});

test("configured routing falls back from an xAI 403 quota-exhausted response", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["xai", "tavily"], fallbackOn: ["quota"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url) === "https://api.x.ai/v1/responses") return new Response("quota exhausted", { status: 403 });
			if (String(url) === "https://api.tavily.com/search") {
				return new Response(JSON.stringify({ answer: "Tavily fallback answer", results: [] }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + url);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("xai quota route", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, answer: result.answer, calls }));
	`, {
		PI_CODING_AGENT_DIR: home,
		XAI_API_KEY: "xai-test-key",
		TAVILY_API_KEY: "tavily-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "tavily");
	assert.equal(output.answer, "Tavily fallback answer");
	assert.deepEqual(output.calls, ["https://api.x.ai/v1/responses", "https://api.tavily.com/search"]);
});

test("configured routing keeps an ordinary xAI 403 response classified as auth", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["xai", "tavily"], fallbackOn: ["quota"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url) === "https://api.x.ai/v1/responses") return new Response("invalid API key", { status: 403 });
			if (String(url) === "https://api.tavily.com/search") throw new Error("Tavily must not run");
			throw new Error("Unexpected fetch " + url);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try {
			await search("xai auth route", { provider: "auto" });
			console.log(JSON.stringify({ ok: true, calls }));
		} catch (error) {
			console.log(JSON.stringify({ ok: false, error: String(error), calls }));
		}
	`, {
		PI_CODING_AGENT_DIR: home,
		XAI_API_KEY: "xai-test-key",
		TAVILY_API_KEY: "tavily-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.match(output.error, /xai search failed \(auth\)/i);
	assert.deepEqual(output.calls, ["https://api.x.ai/v1/responses"]);
});

test("legacy single-provider config takes precedence over searchRouting", async () => {
	const home = await createConfig({
		provider: "perplexity",
		searchRouting: { providers: ["tavily", "brave"], fallbackOn: ["network"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url) === "https://api.perplexity.ai/chat/completions") {
				return new Response(JSON.stringify({ choices: [{ message: { content: "Perplexity answer" } }], citations: [] }), { status: 200 });
			}
			throw new Error("Routing provider must not run");
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("precedence", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, calls }));
	`, {
		PI_CODING_AGENT_DIR: home,
		PERPLEXITY_API_KEY: "perplexity-test-key",
		TAVILY_API_KEY: "tavily-test-key",
		BRAVE_API_KEY: "brave-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		provider: "perplexity",
		calls: ["https://api.perplexity.ai/chat/completions"],
	});
});

test("configured routing accepts SERPdive and detects its availability", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["serpdive"], fallbackOn: ["network"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url) === "https://api.serpdive.com/v1/search") {
				return new Response(JSON.stringify({ results: [{ url: "https://serpdive.example/source", title: "SERPdive source", content: "SERPdive content" }] }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + url);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("serpdive route", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, answer: result.answer, calls }));
	`, {
		PI_CODING_AGENT_DIR: home,
		SERPDIVE_API_KEY: "serpdive-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "serpdive");
	assert.match(output.answer, /SERPdive content/);
	assert.deepEqual(output.calls, ["https://api.serpdive.com/v1/search"]);
});

test("configured SERPdive provider remains strict instead of falling back to auto", async () => {
	const home = await createConfig({ provider: "serpdive" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url) === "https://api.serpdive.com/v1/search") {
				return new Response(JSON.stringify({ results: [{ url: "https://serpdive.example/source", title: "SERPdive source", content: "configured content" }] }), { status: 200 });
			}
			throw new Error("Auto fallback must not run: " + url);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("configured serpdive", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, answer: result.answer, calls }));
	`, {
		PI_CODING_AGENT_DIR: home,
		SERPDIVE_API_KEY: "serpdive-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "serpdive");
	assert.match(output.answer, /configured content/);
	assert.deepEqual(output.calls, ["https://api.serpdive.com/v1/search"]);
});

test("invalid searchRouting configuration fails loudly", async () => {
	const home = await createConfig({ searchRouting: { providers: ["auto"], fallbackOn: ["network"] } });
	const child = runChild(`
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try {
			await search("invalid route", { provider: "auto" });
			console.log(JSON.stringify({ ok: true }));
		} catch (error) {
			console.log(JSON.stringify({ ok: false, error: String(error) }));
		}
	`, { PI_CODING_AGENT_DIR: home });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.match(output.error, /searchRouting\.providers .*invalid provider: auto/);
});
