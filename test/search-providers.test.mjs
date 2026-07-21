import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const braveModuleUrl = new URL("../brave.ts", import.meta.url).href;
const exaModuleUrl = new URL("../exa.ts", import.meta.url).href;
const openaiModuleUrl = new URL("../openai-search.ts", import.meta.url).href;
const tavilyModuleUrl = new URL("../tavily.ts", import.meta.url).href;
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

test("Brave search applies domain filters in the query and returned results", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-brave-"));
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			return new Response(JSON.stringify({
				web: { results: [
					{ title: "GitHub", url: "https://github.com/nicobailon/pi-web-access", description: "repo" },
					{ title: "Gist", url: "https://gist.github.com/nicobailon/abc", description: "gist" },
					{ title: "Example", url: "https://example.com/nope", description: "example" },
				] },
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		const result = await searchWithBrave("sdk docs", {
			domainFilter: ["github.com", "-gist.github.com"],
			numResults: 2,
		});
		const parsedUrl = new URL(capturedUrl);
		console.log(JSON.stringify({
			q: parsedUrl.searchParams.get("q"),
			count: parsedUrl.searchParams.get("count"),
			token: capturedHeaders["X-Subscription-Token"],
			results: result.results,
		}));
	`, {
		HOME: home,
		USERPROFILE: home,
		BRAVE_API_KEY: "brave-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.q, /site:github\.com/);
	assert.match(output.q, /NOT site:gist\.github\.com/);
	assert.equal(output.count, "20");
	assert.equal(output.token, "brave-test-key");
	assert.deepEqual(output.results.map((result) => result.url), ["https://github.com/nicobailon/pi-web-access"]);
});

test("Tavily search uses bearer auth and maps filters/content", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-tavily-"));
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				answer: "Tavily answer",
				results: [{
					title: "Tavily Docs",
					url: "https://docs.tavily.com/search",
					content: "Search docs snippet",
					raw_content: "# Tavily Docs\\nFull content",
				}],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithTavily } = await import(${JSON.stringify(tavilyModuleUrl)});
		const result = await searchWithTavily("tavily search docs", {
			domainFilter: ["https://docs.tavily.com/search", "-reddit.com"],
			recencyFilter: "week",
			numResults: 4,
			includeContent: true,
		});
		console.log(JSON.stringify({ capturedUrl, capturedHeaders, capturedBody, result }));
	`, {
		HOME: home,
		USERPROFILE: home,
		TAVILY_API_KEY: "tvly-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.capturedUrl, "https://api.tavily.com/search");
	assert.equal(output.capturedHeaders.Authorization, "Bearer tvly-test-key");
	assert.deepEqual(output.capturedBody, {
		query: "tavily search docs",
		search_depth: "basic",
		max_results: 4,
		include_answer: "basic",
		include_raw_content: "markdown",
		time_range: "week",
		include_domains: ["docs.tavily.com"],
		exclude_domains: ["reddit.com"],
	});
	assert.equal(output.result.answer, "Tavily answer");
	assert.deepEqual(output.result.results, [{ title: "Tavily Docs", url: "https://docs.tavily.com/search", snippet: "Search docs snippet" }]);
	assert.deepEqual(output.result.inlineContent, [{ url: "https://docs.tavily.com/search", title: "Tavily Docs", content: "# Tavily Docs\nFull content", error: null }]);
});

test("auto provider falls through to Tavily after unavailable earlier providers", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-tavily-auto-"));
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			const urlText = String(url);
			calls.push(urlText);
			if (urlText === "https://mcp.exa.ai/mcp") {
				return new Response("Exa unavailable", { status: 503 });
			}
			if (urlText === "https://api.tavily.com/search") {
				return new Response(JSON.stringify({
					answer: "Auto Tavily answer",
					results: [{ title: "Tavily Auto", url: "https://docs.tavily.com/auto", content: "auto snippet" }],
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			throw new Error("Unexpected fetch " + urlText);
		};

		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("auto tavily docs", { provider: "auto" });
		console.log(JSON.stringify({ calls, result }));
	`, {
		HOME: home,
		USERPROFILE: home,
		TAVILY_API_KEY: "tvly-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.ok(output.calls.includes("https://mcp.exa.ai/mcp"));
	assert.ok(output.calls.includes("https://api.tavily.com/search"));
	assert.equal(output.result.provider, "tavily");
	assert.equal(output.result.answer, "Auto Tavily answer");
});

test("Exa direct API key ignores full legacy usage counter", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-paid-"));
	const child = runChild(`
		const dir = ${JSON.stringify(home)};
		const { readFileSync, writeFileSync } = await import("node:fs");
		writeFileSync(dir + "/web-search.json", JSON.stringify({ exaApiKey: "exa-paid-key" }));
		writeFileSync(dir + "/exa-usage.json", JSON.stringify({ month: new Date().toISOString().slice(0, 7), count: 1000 }));

		let capturedUrl = "";
		let capturedHeaders = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			return new Response(JSON.stringify({
				answer: "Paid Exa answer",
				citations: [{ title: "Exa Docs", url: "https://exa.ai/docs" }],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { isExaAvailable, searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		const available = isExaAvailable();
		const result = await searchWithExa("paid exa query");
		const usage = JSON.parse(readFileSync(dir + "/exa-usage.json", "utf8"));
		console.log(JSON.stringify({
			available,
			capturedUrl,
			apiKey: capturedHeaders["x-api-key"],
			result,
			usage,
		}));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.available, true);
	assert.equal(output.capturedUrl, "https://api.exa.ai/answer");
	assert.equal(output.apiKey, "exa-paid-key");
	assert.equal(output.result.answer, "Paid Exa answer");
	assert.deepEqual(output.result.results, [{ title: "Exa Docs", url: "https://exa.ai/docs", snippet: "" }]);
	assert.equal(output.usage.count, 1000);
});

test("Exa command source is lazy, overrides stale env, and rotates per request", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-command-"));
	const commandPath = join(home, "read-key.sh");
	const counterPath = join(home, "counter");
	await writeFile(commandPath, `#!/bin/sh\ncount=0\n[ ! -f "$1" ] || count=$(cat "$1")\ncount=$((count + 1))\nprintf '%s' "$count" >"$1"\nprintf 'synthetic-exa-%s\\n' "$count"\n`, "utf8");
	await chmod(commandPath, 0o700);
	await writeFile(join(home, "web-search.json"), JSON.stringify({
		exaApiKey: `!${commandPath} ${counterPath}`,
	}) + "\n", "utf8");

	const child = runChild(`
		import { existsSync } from "node:fs";
		const keys = [];
		globalThis.fetch = async (_url, init) => {
			keys.push(init.headers["x-api-key"]);
			return new Response(JSON.stringify({ answer: "ok", citations: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const { hasExaApiKey, searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		const available = hasExaApiKey();
		const lazy = !existsSync(${JSON.stringify(counterPath)});
		await searchWithExa("first");
		await searchWithExa("second");
		console.log(JSON.stringify({ available, lazy, keys }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		EXA_API_KEY: "stale-exa-environment-value",
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		available: true,
		lazy: true,
		keys: ["synthetic-exa-1", "synthetic-exa-2"],
	});
});

test("failed Exa command source is redacted and blocks MCP or provider fallback", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-command-failure-"));
	const commandPath = join(home, "fail-key.sh");
	await writeFile(commandPath, "#!/bin/sh\nprintf 'SYNTHETIC_SECRET_MUST_NOT_ESCAPE\\n' >&2\nexit 9\n", "utf8");
	await chmod(commandPath, 0o700);
	await writeFile(join(home, "web-search.json"), JSON.stringify({
		exaApiKey: `!${commandPath}`,
	}) + "\n", "utf8");

	const child = runChild(`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls += 1; throw new Error("unexpected fetch"); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		let message = "";
		try {
			await search("must fail closed", { provider: "auto" });
		} catch (error) {
			message = error.message;
		}
		console.log(JSON.stringify({ fetchCalls, message }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		EXA_API_KEY: "stale-exa-environment-value",
		TAVILY_API_KEY: "stale-alternate-provider-value",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.fetchCalls, 0);
	assert.match(output.message, /^Exa credential resolution failed: command-failed$/);
	assert.equal(output.message.includes("SYNTHETIC_SECRET_MUST_NOT_ESCAPE"), false);
	assert.equal(output.message.includes(commandPath), false);
});

test("Exa provider errors redact the resolved credential", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-redaction-"));
	const secret = "SYNTHETIC_EXA_SECRET_MUST_NOT_ESCAPE";
	const child = runChild(`
		globalThis.fetch = async () => new Response(${JSON.stringify("provider echoed SYNTHETIC_EXA_SECRET_MUST_NOT_ESCAPE")}, { status: 400 });
		const { searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		let message = "";
		try { await searchWithExa("redaction test"); }
		catch (error) { message = error.message; }
		console.log(JSON.stringify({ message }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		EXA_API_KEY: secret,
	});
	assert.equal(child.status, 0, child.stderr);
	const { message } = JSON.parse(child.stdout.trim());
	assert.equal(message.includes(secret), false);
	assert.equal(message.includes("[redacted]"), true);
});

test("failed Gemini command source is redacted and blocks browser fallback", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-command-failure-"));
	const commandPath = join(home, "fail-key.sh");
	await writeFile(commandPath, "#!/bin/sh\nprintf 'SYNTHETIC_GEMINI_SECRET_MUST_NOT_ESCAPE\\n' >&2\nexit 9\n", "utf8");
	await chmod(commandPath, 0o700);
	await writeFile(join(home, "web-search.json"), JSON.stringify({
		geminiApiKey: `!${commandPath}`,
	}) + "\n", "utf8");

	const child = runChild(`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls += 1; throw new Error("unexpected fetch"); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		let message = "";
		try {
			await search("must fail closed", { provider: "gemini" });
		} catch (error) {
			message = error.message;
		}
		console.log(JSON.stringify({ fetchCalls, message }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		GEMINI_API_KEY: "stale-gemini-environment-value",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.fetchCalls, 0);
	assert.match(output.message, /^Gemini credential resolution failed: command-failed$/);
	assert.equal(output.message.includes("SYNTHETIC_GEMINI_SECRET_MUST_NOT_ESCAPE"), false);
	assert.equal(output.message.includes(commandPath), false);
});

test("OpenAI search requires web_search and maps domain filters", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-openai-"));
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				output: [
					{
						type: "web_search_call",
						action: { sources: [{ title: "OpenAI Blog", url: "https://openai.com/blog?utm_source=openai" }] },
					},
					{
						type: "message",
						content: [{
							type: "output_text",
							text: "Answer from the web",
							annotations: [{
								type: "url_citation",
								start_index: 0,
								end_index: 6,
								url: "https://openai.com/docs?utm_source=openai",
								title: "OpenAI Docs",
							}],
						}],
					},
				],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithOpenAI } = await import(${JSON.stringify(openaiModuleUrl)});
		const result = await searchWithOpenAI("latest docs", {
			domainFilter: ["https://openai.com/docs", "-reddit.com"],
			numResults: 3,
		});
		console.log(JSON.stringify({
			url: capturedUrl,
			authorization: capturedHeaders.Authorization,
			body: capturedBody,
			results: result.results,
			answer: result.answer,
		}));
	`, {
		HOME: home,
		USERPROFILE: home,
		OPENAI_API_KEY: "sk-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.url, "https://api.openai.com/v1/responses");
	assert.equal(output.authorization, "Bearer sk-test-key");
	assert.equal(output.body.tool_choice, "required");
	assert.deepEqual(output.body.include, ["web_search_call.action.sources"]);
	assert.deepEqual(output.body.tools[0].filters, {
		allowed_domains: ["openai.com"],
		blocked_domains: ["reddit.com"],
	});
	assert.equal(output.answer, "Answer from the web");
	assert.deepEqual(output.results.map((result) => result.url), [
		"https://openai.com/docs",
		"https://openai.com/blog",
	]);
});
