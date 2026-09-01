import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import initializeExtension from "../index.ts";
import { getActiveProxy, installGlobalProxyFetch, runWithProxy } from "../utils.ts";

const originalFetch = globalThis.fetch;
const originalPath = process.env.PATH;
const originalNoProxy = process.env.NO_PROXY;
const originalNoProxyLower = process.env.no_proxy;
const utilsUrl = new URL("../utils.ts", import.meta.url).href;

function runConfigProbe(dir, script) {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { getActiveProxy, runWithProxy } = await import(${JSON.stringify(utilsUrl)});
			${script}
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: dir },
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}

async function withFakeCurl(t, routes, fn) {
	const dir = await mkdtemp(join(tmpdir(), "pi-proxy-test-"));
	const logPath = join(dir, "curl-args.jsonl");
	const curlPath = join(dir, "curl");
	await writeFile(curlPath, `#!/usr/bin/env node
const fs = require("node:fs");
const routes = JSON.parse(process.env.PI_PROXY_TEST_ROUTES);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PI_PROXY_TEST_LOG, JSON.stringify(args) + "\\n");
function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}
const url = args[args.length - 1];
const route = routes[url];
if (!route) throw new Error("unexpected url " + url);
fs.writeFileSync(valueAfter("-D"), "HTTP/1.1 " + route.status + " " + route.statusText + "\\r\\n" + (route.location ? "Location: " + route.location + "\\r\\n" : "") + "\\r\\n");
fs.writeFileSync(valueAfter("--output"), route.body || "");
process.stdout.write(JSON.stringify({ url_effective: url, num_redirects: 0 }));
`);
	await chmod(curlPath, 0o755);
	process.env.PATH = `${dir}:${originalPath ?? ""}`;
	process.env.PI_PROXY_TEST_LOG = logPath;
	process.env.PI_PROXY_TEST_ROUTES = JSON.stringify(routes);
	process.env.NO_PROXY = "";
	process.env.no_proxy = "";
	globalThis.fetch = originalFetch;
	installGlobalProxyFetch();
	t.after(async () => {
		globalThis.fetch = originalFetch;
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalNoProxy === undefined) delete process.env.NO_PROXY;
		else process.env.NO_PROXY = originalNoProxy;
		if (originalNoProxyLower === undefined) delete process.env.no_proxy;
		else process.env.no_proxy = originalNoProxyLower;
		delete process.env.PI_PROXY_TEST_LOG;
		delete process.env.PI_PROXY_TEST_ROUTES;
		await rm(dir, { recursive: true, force: true });
	});
	const result = await fn(logPath);
	return result;
}

async function readCurlCalls(logPath) {
	return (await readFile(logPath, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function headerValues(args) {
	const values = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "-H") values.push(args[index + 1]);
	}
	return values;
}

function registerSourceCheck() {
	const tools = [];
	initializeExtension({
		registerTool(tool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
		appendEntry() {},
	});
	return tools.find((tool) => tool.name === "source_check");
}

function registerFetchContent() {
	const tools = [];
	initializeExtension({
		registerTool(tool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
		appendEntry() {},
	});
	return tools.find((tool) => tool.name === "fetch_content");
}

function proxyArg(args) {
	const index = args.indexOf("-x");
	return index === -1 ? undefined : args[index + 1];
}

test("proxy curl redirects strip caller headers across origins", async (t) => {
	await withFakeCurl(t, {
		"https://origin.example/start": { status: 302, statusText: "Found", location: "https://other.example/final" },
		"https://other.example/final": { status: 200, statusText: "OK", body: "ok" },
	}, async (logPath) => {
		const response = await runWithProxy("http://proxy.example:8080", () => fetch("https://origin.example/start", {
			headers: {
				Authorization: "Bearer secret",
				Cookie: "session=secret",
				"X-Api-Key": "secret",
				Accept: "text/html",
			},
		}));

		assert.equal(await response.text(), "ok");
		assert.equal(response.url, "https://other.example/final");
		assert.equal(response.redirected, true);
		const calls = await readCurlCalls(logPath);
		assert.equal(calls.length, 2);
		assert.ok(headerValues(calls[0]).some((header) => /^authorization:/i.test(header)));
		assert.deepEqual(headerValues(calls[1]), []);
		assert.ok(calls.every((args) => !args.includes("--location")));
	});
});

test("configured proxy is scoped to web operations while empty string forces direct access", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-proxy-config-test-"));
	await writeFile(join(dir, "web-search.json"), JSON.stringify({ proxy: "http://global-proxy.example:8080" }));
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	assert.deepEqual(runConfigProbe(dir, `
		console.log(JSON.stringify([
			getActiveProxy(),
			runWithProxy(undefined, () => getActiveProxy()),
			runWithProxy("", () => getActiveProxy()),
			runWithProxy("http://call-proxy.example:8080", () => getActiveProxy()),
			getActiveProxy(),
		]));
	`), [
		null,
		"http://global-proxy.example:8080/",
		null,
		"http://call-proxy.example:8080/",
		null,
	]);
});

test("invalid configured proxy fails closed instead of direct fetching", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-proxy-invalid-config-test-"));
	await writeFile(join(dir, "web-search.json"), JSON.stringify({ proxy: "socks5://proxy.example:1080" }));
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	assert.match(runConfigProbe(dir, `
		let message = "";
		try {
			runWithProxy(undefined, () => getActiveProxy());
		} catch (error) {
			message = error.message;
		}
		console.log(JSON.stringify(message));
	`), /proxy.*must use the http:\/\/ or https:\/\/ scheme/);
});

test("proxy transport does not spawn curl for pre-aborted requests", async (t) => {
	await withFakeCurl(t, {
		"https://origin.example/abort": { status: 200, statusText: "OK", body: "late" },
	}, async (logPath) => {
		const controller = new AbortController();
		controller.abort();

		await assert.rejects(
			runWithProxy("http://proxy.example:8080", () => fetch("https://origin.example/abort", { signal: controller.signal })),
			/error.*abort/i,
		);
		await assert.rejects(readFile(logPath, "utf8"), /ENOENT/);
	});
});

test("proxy transport errors redact proxy credentials", async (t) => {
	await withFakeCurl(t, {}, async () => {
		await assert.rejects(
			runWithProxy("http://user:secret@proxy.example:8080", () => fetch("https://origin.example/missing")),
			(error) => {
				assert.match(error.message, /http:\/\/redacted:redacted@proxy\.example:8080\//);
				assert.doesNotMatch(error.message, /user:secret/);
				return true;
			},
		);
	});
});

test("proxy curl redirects keep caller headers on the same origin", async (t) => {
	await withFakeCurl(t, {
		"https://origin.example/start": { status: 302, statusText: "Found", location: "/final" },
		"https://origin.example/final": { status: 200, statusText: "OK", body: "ok" },
	}, async (logPath) => {
		await runWithProxy("http://proxy.example:8080", () => fetch("https://origin.example/start", {
			headers: { Authorization: "Bearer secret" },
		}));

		const calls = await readCurlCalls(logPath);
		assert.equal(calls.length, 2);
		assert.ok(headerValues(calls[1]).some((header) => /^authorization:/i.test(header)));
	});
});

test("proxy curl keeps manual redirects as redirect responses", async (t) => {
	await withFakeCurl(t, {
		"https://origin.example/start": { status: 302, statusText: "Found", location: "https://other.example/final" },
	}, async (logPath) => {
		const response = await runWithProxy("http://proxy.example:8080", () => fetch("https://origin.example/start", { redirect: "manual" }));

		assert.equal(response.status, 302);
		assert.equal(response.headers.get("location"), "https://other.example/final");
		assert.equal((await readCurlCalls(logPath)).length, 1);
	});
});

test("source_check fetchContent uses the explicit proxy for result pages", async (t) => {
	const previousKey = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = "source-check-proxy-test-key";
	t.after(() => {
		if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previousKey;
	});

	await withFakeCurl(t, {
		"https://api.openai.com/v1/responses": {
			status: 200,
			statusText: "OK",
			body: JSON.stringify({
				output: [{ type: "web_search_call", action: { sources: [{ title: "API docs", url: "https://example.com/api" }] } }],
			}),
		},
		"https://example.com/api": { status: 200, statusText: "OK", body: "<html><title>API docs</title><body>The API docs are available.</body></html>" },
	}, async (logPath) => {
		const tool = registerSourceCheck();
		assert.ok(tool);
		const response = await tool.execute("call", {
			claim: "API docs",
			provider: "openai",
			fetchContent: true,
			proxy: "http://call-proxy.example:8080",
		}, undefined, undefined, { modelRegistry: {} });

		assert.equal(response.details.sourceCount, 1);
		const calls = await readCurlCalls(logPath);
		const apiCall = calls.find((args) => args.at(-1) === "https://api.openai.com/v1/responses");
		const pageCall = calls.find((args) => args.at(-1) === "https://example.com/api");
		assert.ok(apiCall);
		assert.ok(pageCall);
		assert.ok(["http://call-proxy.example:8080", "http://call-proxy.example:8080/"].includes(proxyArg(apiCall)));
		assert.ok(["http://call-proxy.example:8080", "http://call-proxy.example:8080/"].includes(proxyArg(pageCall)));
	});
});

test("fetch_content passes the explicit proxy through queued extraction", async (t) => {
	await withFakeCurl(t, {
		"https://example.com/page": {
			status: 200,
			statusText: "OK",
			body: "<html><title>Proxy page</title><body>Fetched through the requested proxy.</body></html>",
		},
	}, async (logPath) => {
		const tool = registerFetchContent();
		assert.ok(tool);
		const response = await tool.execute("call", {
			url: "https://example.com/page",
			proxy: "http://call-proxy.example:8080",
		});

		assert.equal(response.details.successful, 1);
		const pageCall = (await readCurlCalls(logPath)).find((args) => args.at(-1) === "https://example.com/page");
		assert.ok(pageCall);
		assert.ok(["http://call-proxy.example:8080", "http://call-proxy.example:8080/"].includes(proxyArg(pageCall)));
	});
});
