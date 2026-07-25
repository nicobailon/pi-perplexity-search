import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const firecrawlModuleUrl = new URL("../firecrawl.ts", import.meta.url).href;
const extractModuleUrl = new URL("../extract.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"FIRECRAWL_BASE_URL",
		"FIRECRAWL_API_KEY",
		"FIRECRAWL_API_VERSION",
		"PARALLEL_API_KEY",
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

async function configHome(prefix, config) {
	const home = await mkdtemp(join(tmpdir(), `pi-web-access-${prefix}-`));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config));
	return home;
}

/** A loopback Firecrawl instance is only reachable once its range is allowed. */
async function localInstance(prefix, extra = {}) {
	return configHome(prefix, {
		firecrawlBaseUrl: "http://127.0.0.1:3002",
		ssrf: { allowRanges: ["127.0.0.1"] },
		...extra,
	});
}

function homeEnv(home) {
	return { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home };
}

/** Resolves every hostname to a public address so tests never touch real DNS. */
const PUBLIC_LOOKUP = `async () => [{ address: "93.184.216.34", family: 4 }]`;

const SEARCH_V2_RESPONSE = `new Response(JSON.stringify({
	success: true,
	data: { web: [
		{ title: "GitHub", url: "https://github.com/nicobailon/pi-web-access", description: "repo" },
		{ title: "Gist", url: "https://gist.github.com/nicobailon/abc", description: "gist" },
		{ title: "Example", url: "https://example.com/nope", description: "example" },
	] },
}), { status: 200, headers: { "content-type": "application/json" } })`;

test("Firecrawl search defaults to the v2 endpoint and maps the v2 response shape", async () => {
	const home = await localInstance("firecrawl-v2");
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = Object.fromEntries(new Headers(init.headers).entries());
			capturedBody = JSON.parse(init.body);
			return ${SEARCH_V2_RESPONSE};
		};

		const { searchWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		const result = await searchWithFirecrawl("firecrawl test", {
			numResults: 5,
			recencyFilter: "month",
			domainFilter: ["github.com", "-gist.github.com"],
		});
		console.log(JSON.stringify({ capturedUrl, capturedHeaders, capturedBody, result }));
	`, { ...homeEnv(home), FIRECRAWL_API_KEY: "fc-test-key" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.capturedUrl, "http://127.0.0.1:3002/v2/search");
	assert.equal(output.capturedHeaders["authorization"], "Bearer fc-test-key");
	assert.equal(output.capturedBody.limit, 5);
	assert.equal(output.capturedBody.tbs, "qdr:m");
	assert.deepEqual(output.capturedBody.sources, [{ type: "web" }]);
	assert.deepEqual(output.capturedBody.includeDomains, ["github.com"]);
	assert.deepEqual(output.capturedBody.excludeDomains, ["gist.github.com"]);
	// Filters are re-applied client-side; the excluded gist and off-domain result are dropped.
	assert.deepEqual(output.result.results, [
		{ title: "GitHub", url: "https://github.com/nicobailon/pi-web-access", snippet: "repo" },
	]);
});

test("Firecrawl search on v1 uses the v1 endpoint and parses the flat data array", async () => {
	const home = await localInstance("firecrawl-v1", { firecrawlApiVersion: "v1" });
	const child = runChild(`
		let capturedUrl = "";
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				success: true,
				data: [
					{ title: "GitHub", url: "https://github.com/nicobailon/pi-web-access", description: "repo" },
					{ title: "Example", url: "https://example.com/nope", description: "example" },
				],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		const result = await searchWithFirecrawl("firecrawl test", { domainFilter: ["github.com"] });
		console.log(JSON.stringify({ capturedUrl, capturedBody, result }));
	`, homeEnv(home));

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.capturedUrl, "http://127.0.0.1:3002/v1/search");
	// v1 has no domain-filter parameters, so filtering happens only client-side.
	assert.equal(output.capturedBody.includeDomains, undefined);
	assert.deepEqual(output.result.results, [
		{ title: "GitHub", url: "https://github.com/nicobailon/pi-web-access", snippet: "repo" },
	]);
});

test("Firecrawl rejects an unsupported API version instead of guessing an endpoint", async () => {
	const child = runChild(`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls++; return new Response("{}", { status: 200 }); };

		const { searchWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		let error = null;
		try { await searchWithFirecrawl("q"); } catch (err) { error = err.message; }
		console.log(JSON.stringify({ error, fetchCalls }));
	`, { FIRECRAWL_BASE_URL: "https://crawl.example.com", FIRECRAWL_API_VERSION: "v3" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.fetchCalls, 0);
	assert.match(output.error, /Unsupported Firecrawl API version "v3"/);
});

test("Firecrawl reads base URL and key from the config file and omits auth when unset", async () => {
	const keyed = await localInstance("firecrawl-config-key", {
		firecrawlBaseUrl: "http://127.0.0.1:3002/",
		firecrawlApiKey: "fc-config-key",
	});
	const unkeyed = await localInstance("firecrawl-config-nokey");
	const script = `
		let capturedUrl = "";
		let capturedHeaders = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = Object.fromEntries(new Headers(init.headers).entries());
			return ${SEARCH_V2_RESPONSE};
		};

		const { searchWithFirecrawl, isFirecrawlAvailable } = await import(${JSON.stringify(firecrawlModuleUrl)});
		const available = isFirecrawlAvailable();
		await searchWithFirecrawl("q");
		console.log(JSON.stringify({ available, capturedUrl, authorization: capturedHeaders.authorization ?? null }));
	`;

	const withKey = runChild(script, homeEnv(keyed));
	assert.equal(withKey.status, 0, withKey.stderr);
	const keyedOutput = JSON.parse(withKey.stdout.trim());
	assert.equal(keyedOutput.available, true);
	// Trailing slash normalized away rather than producing a double slash.
	assert.equal(keyedOutput.capturedUrl, "http://127.0.0.1:3002/v2/search");
	assert.equal(keyedOutput.authorization, "Bearer fc-config-key");

	const withoutKey = runChild(script, homeEnv(unkeyed));
	assert.equal(withoutKey.status, 0, withoutKey.stderr);
	assert.equal(JSON.parse(withoutKey.stdout.trim()).authorization, null);
});

test("Firecrawl is unavailable and refuses to run when no base URL is configured", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-firecrawl-none-"));
	const child = runChild(`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls++; return new Response("{}", { status: 200 }); };

		const { isFirecrawlAvailable, searchWithFirecrawl, extractWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		const available = isFirecrawlAvailable();
		let searchError = null;
		let extractError = null;
		try { await searchWithFirecrawl("q"); } catch (err) { searchError = err.message; }
		try { await extractWithFirecrawl("https://example.com/a"); } catch (err) { extractError = err.message; }
		console.log(JSON.stringify({ available, searchError, extractError, fetchCalls }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.available, false);
	assert.equal(output.fetchCalls, 0);
	assert.match(output.searchError, /Firecrawl base URL not configured/);
	assert.match(output.extractError, /Firecrawl base URL not configured/);
});

test("Firecrawl search sends no tbs for a recency value it cannot express", async () => {
	const home = await localInstance("firecrawl-recency");
	const child = runChild(`
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedBody = JSON.parse(init.body);
			return ${SEARCH_V2_RESPONSE};
		};

		const { searchWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		await searchWithFirecrawl("q", { recencyFilter: "decade" });
		const withoutFilter = capturedBody;
		await searchWithFirecrawl("q", { recencyFilter: "day" });
		console.log(JSON.stringify({ unsupported: withoutFilter.tbs ?? null, supported: capturedBody.tbs }));
	`, homeEnv(home));

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.unsupported, null);
	assert.equal(output.supported, "qdr:d");
});

test("Firecrawl extraction returns scraped markdown from a private self-hosted instance", async () => {
	const home = await localInstance("firecrawl-scrape-v2");
	const child = runChild(`
		let capturedUrl = "";
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				success: true,
				data: { markdown: "# Title\\n\\nBody text", metadata: { title: "Scraped title" } },
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { extractWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		const result = await extractWithFirecrawl("https://example.com/article", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ capturedUrl, capturedBody, result }));
	`, homeEnv(home));

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	// The instance itself is private; only the scrape target is SSRF-checked.
	assert.equal(output.capturedUrl, "http://127.0.0.1:3002/v2/scrape");
	assert.equal(output.capturedBody.url, "https://example.com/article");
	assert.deepEqual(output.capturedBody.formats, ["markdown"]);
	assert.deepEqual(output.result, {
		url: "https://example.com/article",
		title: "Scraped title",
		content: "# Title\n\nBody text",
		error: null,
	});
});

test("Firecrawl extraction on v1 uses the v1 scrape endpoint", async () => {
	const home = await localInstance("firecrawl-scrape-v1", { firecrawlApiVersion: "v1" });
	const child = runChild(`
		let capturedUrl = "";
		globalThis.fetch = async (url) => {
			capturedUrl = String(url);
			return new Response(JSON.stringify({
				success: true,
				data: {
					markdown: "v1 body",
					links: [],
					metadata: { title: "v1 title", sourceURL: "https://example.com/article", statusCode: 200 },
				},
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { extractWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		const result = await extractWithFirecrawl("https://example.com/article", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ capturedUrl, result }));
	`, homeEnv(home));

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.capturedUrl, "http://127.0.0.1:3002/v1/scrape");
	assert.deepEqual(output.result, {
		url: "https://example.com/article",
		title: "v1 title",
		content: "v1 body",
		error: null,
	});
});

test("Firecrawl extraction never sends a private target to the Firecrawl instance", async () => {
	const child = runChild(`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls++; return new Response("{}", { status: 200 }); };

		const { extractWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		const errors = [];
		for (const target of ["http://127.0.0.1:8080/admin", "http://localhost:8080/admin", "http://169.254.169.254/latest/meta-data"]) {
			try { await extractWithFirecrawl(target); } catch (err) { errors.push(err.message); }
		}
		// A public hostname that resolves into a private range must be blocked too.
		try {
			await extractWithFirecrawl("https://internal.example.com/", undefined, {
				lookup: async () => [{ address: "10.0.0.5", family: 4 }],
			});
		} catch (err) { errors.push(err.message); }
		console.log(JSON.stringify({ errors, fetchCalls }));
	`, { FIRECRAWL_BASE_URL: "https://crawl.example.com" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.errors.length, 4);
	assert.equal(output.fetchCalls, 0, "Firecrawl must not be invoked for private targets");
});

test("fetch_content extraction of a private URL never reaches Firecrawl", async () => {
	const child = runChild(`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls++; return new Response("{}", { status: 200 }); };

		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("http://127.0.0.1:8080/admin");
		console.log(JSON.stringify({ error: result.error, content: result.content, fetchCalls }));
	`, { FIRECRAWL_BASE_URL: "https://crawl.example.com" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.content, "");
	assert.match(output.error, /Blocked|private|internal/i);
	assert.equal(output.fetchCalls, 0, "no outbound request may be made for a blocked target");
});

test("Firecrawl extraction surfaces response failures instead of falling back silently", async () => {
	const home = await localInstance("firecrawl-failures");
	const cases = [
		{
			name: "http-error",
			response: `new Response("upstream exploded", { status: 502 })`,
			expect: /Firecrawl scrape error 502/,
		},
		{
			name: "invalid-json",
			response: `new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } })`,
			expect: /Firecrawl scrape returned invalid JSON/,
		},
		{
			name: "unsuccessful",
			response: `new Response(JSON.stringify({ success: false, error: "Blocked" }), { status: 200, headers: { "content-type": "application/json" } })`,
			expect: /Firecrawl scrape unsuccessful: Blocked/,
		},
		{
			name: "unexpected-shape",
			response: `new Response(JSON.stringify([{ markdown: "hi" }]), { status: 200, headers: { "content-type": "application/json" } })`,
			expect: /unexpected response shape/,
		},
	];

	for (const testCase of cases) {
		const child = runChild(`
			globalThis.fetch = async () => ${testCase.response};

			const { extractWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
			let error = null;
			try {
				await extractWithFirecrawl("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} });
			} catch (err) { error = err.message; }
			console.log(JSON.stringify({ error }));
		`, homeEnv(home));

		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.match(output.error ?? "", testCase.expect, testCase.name);
	}
});

test("Firecrawl extraction returns null when the scrape yields no markdown", async () => {
	const home = await localInstance("firecrawl-empty");
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({
			success: true,
			data: { markdown: "   ", metadata: { title: "Empty" } },
		}), { status: 200, headers: { "content-type": "application/json" } });

		const { extractWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		const result = await extractWithFirecrawl("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ result }));
	`, homeEnv(home));

	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout.trim()).result, null);
});

test("a private Firecrawl instance is refused until its range is allowed", async () => {
	const home = await configHome("firecrawl-unallowed", { firecrawlBaseUrl: "http://127.0.0.1:3002" });
	const child = runChild(`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls++; return new Response("{}", { status: 200 }); };

		const { extractWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		let error = null;
		try {
			await extractWithFirecrawl("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} });
		} catch (err) { error = err.message; }
		console.log(JSON.stringify({ error, fetchCalls }));
	`, homeEnv(home));

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.fetchCalls, 0);
	assert.match(output.error, /Blocked internal address/);
});

test("malformed SSRF config fails loud instead of silently skipping Firecrawl", async () => {
	const home = await configHome("firecrawl-bad-ssrf", {
		firecrawlBaseUrl: "http://127.0.0.1:3002",
		ssrf: { allowRanges: ["127.0.0.0/33"] },
	});
	const child = runChild(`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls++; return new Response("{}", { status: 200 }); };

		const { isFirecrawlAvailable } = await import(${JSON.stringify(firecrawlModuleUrl)});
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		let availabilityError = null;
		try { isFirecrawlAvailable(); } catch (err) { availabilityError = err.message; }
		const extracted = await extractContent("https://example.com/a", undefined, {
			lookup: ${PUBLIC_LOOKUP},
		});
		console.log(JSON.stringify({ availabilityError, extractError: extracted.error, fetchCalls }));
	`, homeEnv(home));

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.availabilityError, /Invalid CIDR notation in ssrf\.allowRanges/);
	assert.match(output.extractError, /Invalid CIDR notation in ssrf\.allowRanges/);
	assert.equal(output.fetchCalls, 0);
});
