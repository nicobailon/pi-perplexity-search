import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const utilsUrl = new URL("../utils.ts", import.meta.url).href;
const perplexityUrl = new URL("../perplexity.ts", import.meta.url).href;
const geminiApiUrl = new URL("../gemini-api.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	delete childEnv.PERPLEXITY_API_KEY;
	delete childEnv.GEMINI_API_KEY;
	delete childEnv.GOOGLE_GEMINI_BASE_URL;
	delete childEnv.CLOUDFLARE_API_KEY;
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) {
			delete childEnv[key];
		} else {
			childEnv[key] = value;
		}
	}
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
	});
}

test("web-search config path uses PI_CODING_AGENT_DIR before XDG_CONFIG_HOME", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-config-path-"));
	const agentDir = join(root, "agent-dir");
	const xdgDir = join(root, "xdg");
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(xdgDir, "pi"), { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ perplexityApiKey: "pplx-from-agent" }) + "\n", "utf8");
	await writeFile(join(xdgDir, "pi", "web-search.json"), JSON.stringify({}) + "\n", "utf8");

	const child = runChild(`
		const { getWebSearchConfigDir, getWebSearchConfigPath } = await import(${JSON.stringify(utilsUrl)});
		const { isPerplexityAvailable } = await import(${JSON.stringify(perplexityUrl)});
		console.log(JSON.stringify({
			dir: getWebSearchConfigDir(),
			path: getWebSearchConfigPath(),
			available: isPerplexityAvailable(),
		}));
	`, {
		PI_CODING_AGENT_DIR: agentDir,
		XDG_CONFIG_HOME: xdgDir,
		HOME: join(root, "home"),
		USERPROFILE: join(root, "home"),
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), {
		dir: agentDir,
		path: join(agentDir, "web-search.json"),
		available: true,
	});
});

test("web-search config path uses XDG_CONFIG_HOME pi directory when agent dir is unset", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-xdg-config-"));
	const xdgDir = join(root, "xdg");
	await mkdir(join(xdgDir, "pi"), { recursive: true });
	await writeFile(join(xdgDir, "pi", "web-search.json"), JSON.stringify({ geminiApiKey: "gemini-from-xdg" }) + "\n", "utf8");

	const child = runChild(`
		const { getWebSearchConfigDir, getWebSearchConfigPath } = await import(${JSON.stringify(utilsUrl)});
		const { isGeminiApiAvailable } = await import(${JSON.stringify(geminiApiUrl)});
		console.log(JSON.stringify({
			dir: getWebSearchConfigDir(),
			path: getWebSearchConfigPath(),
			available: isGeminiApiAvailable(),
		}));
	`, {
		PI_CODING_AGENT_DIR: undefined,
		XDG_CONFIG_HOME: xdgDir,
		HOME: join(root, "home"),
		USERPROFILE: join(root, "home"),
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), {
		dir: join(xdgDir, "pi"),
		path: join(xdgDir, "pi", "web-search.json"),
		available: true,
	});
});

test("Gemini base URL and Cloudflare auth use env before config", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-base-url-"));
	const agentDir = join(root, "agent-dir");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({
		geminiBaseUrl: "https://config.example.com/gemini/",
		cloudflareApiKey: "config-cf-key",
	}) + "\n", "utf8");

	const child = runChild(`
		const {
			getApiHost,
			getVersionedApiBase,
			buildAuthHeaders,
			isGeminiApiAvailable,
		} = await import(${JSON.stringify(geminiApiUrl)});
		console.log(JSON.stringify({
			host: getApiHost(),
			base: getVersionedApiBase(),
			headers: buildAuthHeaders(),
			available: isGeminiApiAvailable(),
		}));
	`, {
		PI_CODING_AGENT_DIR: agentDir,
		XDG_CONFIG_HOME: undefined,
		HOME: join(root, "home"),
		USERPROFILE: join(root, "home"),
		GOOGLE_GEMINI_BASE_URL: "https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio/",
		CLOUDFLARE_API_KEY: "env-cf-key",
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), {
		host: "https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio",
		base: "https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio/v1beta",
		headers: { "cf-aig-authorization": "Bearer env-cf-key" },
		available: true,
	});
});

test("Gemini command source is lazy, overrides stale env, rotates, and uses header auth", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-command-"));
	const agentDir = join(root, "agent-dir");
	const commandPath = join(root, "read-key.sh");
	const counterPath = join(root, "counter");
	await mkdir(agentDir, { recursive: true });
	await writeFile(commandPath, `#!/bin/sh\ncount=0\n[ ! -f "$1" ] || count=$(cat "$1")\ncount=$((count + 1))\nprintf '%s' "$count" >"$1"\nprintf 'synthetic-gemini-%s\\n' "$count"\n`, "utf8");
	await chmod(commandPath, 0o700);
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({
		geminiApiKey: `!${commandPath} ${counterPath}`,
	}) + "\n", "utf8");

	const child = runChild(`
		import { existsSync } from "node:fs";
		const requests = [];
		globalThis.fetch = async (url, init) => {
			requests.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)) });
			return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const { isGeminiApiAvailable, queryGeminiApiWithVideo } = await import(${JSON.stringify(geminiApiUrl)});
		const available = isGeminiApiAvailable();
		const lazy = !existsSync(${JSON.stringify(counterPath)});
		await queryGeminiApiWithVideo("first", "files/one", { timeoutMs: 1000 });
		await queryGeminiApiWithVideo("second", "files/two", { timeoutMs: 1000 });
		console.log(JSON.stringify({ available, lazy, requests }));
	`, {
		PI_CODING_AGENT_DIR: agentDir,
		XDG_CONFIG_HOME: undefined,
		HOME: join(root, "home"),
		USERPROFILE: join(root, "home"),
		GEMINI_API_KEY: "stale-gemini-environment-value",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout);
	assert.equal(output.available, true);
	assert.equal(output.lazy, true);
	assert.deepEqual(output.requests.map(request => request.headers["x-goog-api-key"]), [
		"synthetic-gemini-1",
		"synthetic-gemini-2",
	]);
	for (const request of output.requests) {
		assert.equal(new URL(request.url).searchParams.has("key"), false);
		assert.equal(new URL(request.url).searchParams.has("api_key"), false);
		assert.equal(request.url.includes("stale-gemini-environment-value"), false);
	}
});

test("Gemini API helper rejects credential query parameters before fetch", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-query-reject-"));
	const child = runChild(`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls += 1; return new Response("ok"); };
		const { fetchGeminiApi } = await import(${JSON.stringify(geminiApiUrl)});
		let message = "";
		try {
			await fetchGeminiApi("https://generativelanguage.googleapis.com/v1beta/models/test?API_KEY=synthetic-secret", {}, "synthetic-secret");
		} catch (error) {
			message = error.message;
		}
		console.log(JSON.stringify({ fetchCalls, message }));
	`, {
		PI_CODING_AGENT_DIR: undefined,
		XDG_CONFIG_HOME: undefined,
		HOME: join(root, "home"),
		USERPROFILE: join(root, "home"),
	});
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout);
	assert.equal(output.fetchCalls, 0);
	assert.match(output.message, /query parameters are not allowed/);
	assert.equal(output.message.includes("synthetic-secret"), false);
});

test("Gemini provider and transport errors redact the resolved credential", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-redaction-"));
	const secret = "SYNTHETIC_GEMINI_SECRET_MUST_NOT_ESCAPE";
	const child = runChild(`
		let call = 0;
		globalThis.fetch = async () => {
			call += 1;
			if (call === 1) return new Response(${JSON.stringify("provider echoed SYNTHETIC_GEMINI_SECRET_MUST_NOT_ESCAPE")}, { status: 400 });
			throw new Error(${JSON.stringify("transport echoed SYNTHETIC_GEMINI_SECRET_MUST_NOT_ESCAPE")});
		};
		const { queryGeminiApiWithVideo } = await import(${JSON.stringify(geminiApiUrl)});
		const messages = [];
		for (let index = 0; index < 2; index += 1) {
			try { await queryGeminiApiWithVideo("describe", "files/test", { timeoutMs: 1000 }); }
			catch (error) { messages.push(error.message); }
		}
		console.log(JSON.stringify(messages));
	`, {
		PI_CODING_AGENT_DIR: undefined,
		XDG_CONFIG_HOME: undefined,
		HOME: join(root, "home"),
		USERPROFILE: join(root, "home"),
		GEMINI_API_KEY: secret,
	});
	assert.equal(child.status, 0, child.stderr);
	const messages = JSON.parse(child.stdout);
	assert.equal(messages.length, 2);
	for (const message of messages) {
		assert.equal(message.includes(secret), false);
		assert.equal(message.includes("[redacted]"), true);
	}
});

test("Gemini API requests include role and gateway auth headers", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-request-"));
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = Object.fromEntries(new Headers(init.headers));
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const { queryGeminiApiWithVideo } = await import(${JSON.stringify(geminiApiUrl)});
		const text = await queryGeminiApiWithVideo("Describe", "files/test", { model: "gemini-test", timeoutMs: 1000 });
		console.log(JSON.stringify({ text, capturedUrl, capturedHeaders, capturedBody }));
	`, {
		PI_CODING_AGENT_DIR: undefined,
		XDG_CONFIG_HOME: undefined,
		HOME: join(root, "home"),
		USERPROFILE: join(root, "home"),
		GOOGLE_GEMINI_BASE_URL: "https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio",
		CLOUDFLARE_API_KEY: "env-cf-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout);
	assert.equal(output.text, "ok");
	assert.equal(output.capturedUrl, "https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio/v1beta/models/gemini-test:generateContent");
	assert.equal(output.capturedHeaders["cf-aig-authorization"], "Bearer env-cf-key");
	assert.equal(output.capturedHeaders["content-type"], "application/json");
	assert.deepEqual(output.capturedBody.contents, [{
		role: "user",
		parts: [
			{ fileData: { fileUri: "files/test" } },
			{ text: "Describe" },
		],
	}]);
});
