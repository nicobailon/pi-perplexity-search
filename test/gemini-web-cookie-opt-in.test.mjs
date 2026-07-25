import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../gemini-web-config.ts", import.meta.url).href;
const geminiWebUrl = new URL("../gemini-web.ts", import.meta.url).href;

function runCookieAccessCheck(home, extraEnv = {}) {
	const env = { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv };
	delete env.PI_ALLOW_BROWSER_COOKIES;
	delete env.FEYNMAN_ALLOW_BROWSER_COOKIES;
	delete env.PI_CODING_AGENT_DIR;
	delete env.XDG_CONFIG_HOME;
	Object.assign(env, extraEnv);

	return spawnSync(process.execPath, ["--input-type=module"], {
		input: `const { isBrowserCookieAccessAllowed } = await import(${JSON.stringify(moduleUrl)}); console.log(String(isBrowserCookieAccessAllowed()));`,
		encoding: "utf8",
		env,
	});
}

test("Gemini Web never forwards browser cookies across origins", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	try {
		globalThis.fetch = async (url, init = {}) => {
			calls.push({ url: String(url), cookie: init.headers?.cookie, redirect: init.redirect });
			if (String(url).startsWith("https://gemini.google.com/") || String(url).startsWith("https://accounts.google.com/")) {
				return new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } });
			}
			throw new Error(`Unexpected cross-origin request: ${url}`);
		};

		const { getActiveGoogleEmail } = await import(geminiWebUrl);
		const email = await getActiveGoogleEmail({ "__Secure-1PSID": "sensitive-cookie" });
		assert.equal(email, null);
		assert.equal(calls.some((call) => call.url.startsWith("https://attacker.example/")), false);
		assert.equal(calls.every((call) => call.redirect === "manual"), true);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Gemini Web generation rejects automatic redirects", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async (url, init = {}) => {
			if (String(url) === "https://gemini.google.com/app") {
				return new Response('"SNlM0e":"test-token"', { status: 200 });
			}
			if (String(url).includes("BardFrontendService/StreamGenerate")) {
				assert.equal(init.redirect, "error");
				throw new Error("generation transport reached");
			}
			throw new Error(`Unexpected request: ${url}`);
		};

		const { queryWithCookies } = await import(geminiWebUrl);
		await assert.rejects(
			queryWithCookies("search", { "__Secure-1PSID": "cookie" }),
			/generation transport reached/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Gemini Web file uploads read the file and reject automatic redirects", async () => {
	const originalFetch = globalThis.fetch;
	const dir = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-upload-"));
	const filePath = join(dir, "sample.txt");
	await writeFile(filePath, "sample", "utf8");
	try {
		globalThis.fetch = async (url, init = {}) => {
			if (String(url) === "https://gemini.google.com/app") {
				return new Response('"SNlM0e":"test-token"', { status: 200 });
			}
			if (String(url) === "https://content-push.googleapis.com/upload") {
				assert.equal(init.redirect, "error");
				throw new Error("upload transport reached");
			}
			throw new Error(`Unexpected request: ${url}`);
		};

		const { queryWithCookies } = await import(geminiWebUrl);
		await assert.rejects(
			queryWithCookies("inspect file", { "__Secure-1PSID": "cookie" }, { files: [filePath] }),
			/upload transport reached/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("browser cookie access is disabled unless explicitly allowed", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-cookie-opt-in-"));

	let child = runCookieAccessCheck(home);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "false");

	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(join(home, ".pi", "web-search.json"), JSON.stringify({ allowBrowserCookies: true }) + "\n", "utf8");

	child = runCookieAccessCheck(home);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "true");

	const envHome = await mkdtemp(join(tmpdir(), "pi-web-access-cookie-env-"));
	child = runCookieAccessCheck(envHome, { PI_ALLOW_BROWSER_COOKIES: "1" });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "true");
});
