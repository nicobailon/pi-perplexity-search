import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createGeminiFetch, GEMINI_MAX_HEADER_SIZE, resolveGeminiFetch } from "../gemini-web.ts";

// Proxy env vars would route the dedicated EnvHttpProxyAgent (and the
// simulated host-agent dispatcher) away from the local test server.
const PROXY_ENV = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"http_proxy",
	"https_proxy",
	"ALL_PROXY",
	"all_proxy",
	"NO_PROXY",
	"no_proxy",
];

test("createGeminiFetch wires a dedicated agent with a >16 KiB header budget", async () => {
	const agentOpts = [];
	const agentInstances = [];
	const fetchCalls = [];
	const stubUndici = {
		EnvHttpProxyAgent: class {
			constructor(opts) {
				agentOpts.push(opts);
				agentInstances.push(this);
			}
		},
		fetch: async (input, init) => {
			fetchCalls.push({ input, init });
			return new Response("ok");
		},
	};

	const geminiFetch = createGeminiFetch(stubUndici);
	await geminiFetch("https://gemini.google.com/app", { headers: { cookie: "a=b" } });

	assert.equal(agentOpts.length, 1);
	const opts = agentOpts[0];
	assert.equal(opts.maxHeaderSize, GEMINI_MAX_HEADER_SIZE);
	// The whole point: Google frontend responses exceed undici's 16 KiB default
	// over HTTP/1.1, so the dedicated budget must be well above it.
	assert.ok(opts.maxHeaderSize > 16 * 1024, "header budget must exceed undici's 16 KiB default");
	assert.equal(opts.allowH2, false);
	assert.equal(opts.pipelining, 1);

	assert.equal(fetchCalls.length, 1);
	// Requests must go through the dedicated agent, not the ambient global dispatcher.
	assert.equal(fetchCalls[0].input, "https://gemini.google.com/app");
	assert.equal(fetchCalls[0].init.dispatcher, agentInstances[0]);
});

test("dedicated agent fetches oversized-header responses the pi-style global dispatcher rejects", async () => {
	const server = createServer((req, res) => {
		// ~85 KiB of response headers: Google's /app page routinely exceeds the
		// 16 KiB default maxHeaderSize when served over HTTP/1.1.
		for (let i = 0; i < 40; i++) res.setHeader(`X-Large-${i}`, "x".repeat(2048));
		res.end("payload-ok");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${server.address().port}/`;

	const undici = await import("undici");
	const savedDispatcher = undici.getGlobalDispatcher();
	const savedEnv = Object.fromEntries(PROXY_ENV.map((k) => [k, process.env[k]]));
	for (const k of PROXY_ENV) delete process.env[k];

	try {
		// Simulate the host agent (pi): an HTTP/1.1-only global dispatcher with
		// undici's default 16 KiB maxHeaderSize.
		undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({ allowH2: false }));

		// Control: the ambient global fetch must choke on the oversized headers.
		await assert.rejects(
			() => fetch(url).then((r) => r.text()),
			(err) => {
				const detail = String(err.cause?.code ?? err.message);
				assert.match(detail, /HEADERS_OVERFLOW|fetch failed/i);
				return true;
			},
		);

		// Fix: the dedicated agent returns the same response without error.
		const geminiFetch = createGeminiFetch(undici);
		const res = await geminiFetch(url);
		assert.equal(res.status, 200);
		assert.equal(await res.text(), "payload-ok");
	} finally {
		undici.setGlobalDispatcher(savedDispatcher);
		for (const k of PROXY_ENV) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
		server.close();
	}
});

test("resolveGeminiFetch falls back to the ambient global fetch when undici is not resolvable", () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-fallback-"));
	try {
		// Copy just the module graph (no node_modules) so the dynamic undici
		// import fails and the fallback path is exercised.
		for (const f of ["gemini-web.ts", "chrome-cookies.ts", "gemini-web-config.ts", "utils.ts"]) {
			copyFileSync(join(import.meta.dirname, "..", f), join(dir, f));
		}
		const script = [
			"import { resolveGeminiFetch } from './gemini-web.ts';",
			"const f = await resolveGeminiFetch();",
			"console.log('FETCH_KIND:' + (f === globalThis.fetch ? 'FALLBACK' : 'UNDICI'));",
		].join("\n");
		const r = spawnSync(process.execPath, ["-e", script], { cwd: dir, encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /FETCH_KIND:FALLBACK/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveGeminiFetch surfaces dedicated agent construction errors", () => {
	const env = { ...process.env, HTTPS_PROXY: "not a url" };
	const script = [
		`import { resolveGeminiFetch } from ${JSON.stringify(new URL("../gemini-web.ts", import.meta.url).href)};`,
		"await resolveGeminiFetch();",
	].join("\n");
	const result = spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env,
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Invalid URL/);
});
