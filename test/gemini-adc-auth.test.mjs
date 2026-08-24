import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const geminiApiModuleUrl = new URL("../gemini-api.ts", import.meta.url).href;
const geminiAdcModuleUrl = new URL("../gemini-adc.ts", import.meta.url).href;
const geminiSearchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"GEMINI_API_KEY",
		"GOOGLE_GEMINI_BASE_URL",
		"CLOUDFLARE_API_KEY",
		"GOOGLE_APPLICATION_CREDENTIALS",
		"GOOGLE_CLOUD_PROJECT",
		"GOOGLE_CLOUD_LOCATION",
		"GCLOUD_PROJECT",
	]) {
		delete childEnv[key];
	}
	// macOS homedir() ignores HOME, so pin the ADC file explicitly so tests are hermetic.
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

function writeAdc(root, extra = {}) {
	return writeFile(
		join(root, "adc.json"),
		JSON.stringify({
			client_id: "synthetic-client-id",
			client_secret: "synthetic-client-secret",
			refresh_token: "synthetic-refresh-token",
			type: "authorized_user",
			universe_domain: "googleapis.com",
			...extra,
		}) + "\n",
		"utf8",
	);
}

test("Gemini search uses Vertex AI + ADC bearer auth when geminiAuth is adc", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-"));
	await writeAdc(root);
	await writeFile(
		join(root, "web-search.json"),
		JSON.stringify({
			geminiAuth: "adc",
			geminiProject: "ai-eng-sandbox",
			geminiLocation: "global",
		}) + "\n",
		"utf8",
	);

	const child = runChild(`
		const requests = [];
		globalThis.fetch = async (url, init = {}) => {
			const request = { url: String(url), method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers)) };
			requests.push(request);
			if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
				return new Response(JSON.stringify({ access_token: "synthetic-adc-token", expires_in: 3599 }), {
					status: 200, headers: { "content-type": "application/json" },
				});
			}
			if (String(url).includes(":generateContent")) {
				return new Response(JSON.stringify({
					candidates: [{
						content: { parts: [{ text: "Paris is the capital of France." }] },
						groundingMetadata: {
							groundingChunks: [{ web: { uri: "https://en.wikipedia.org/wiki/Paris", title: "Paris" } }],
						},
					}],
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			throw new Error("Unexpected fetch: " + request.url);
		};
		const { search } = await import(${JSON.stringify(geminiSearchModuleUrl)});
		const result = await search("what is the capital of France?", { provider: "gemini" });
		console.log(JSON.stringify({ result, requests }));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.ok(output.result, "expected a search result");
	assert.equal(output.result.answer, "Paris is the capital of France.");
	assert.equal(output.result.provider, "gemini");

	const tokenRequests = output.requests.filter(r => r.url.startsWith("https://oauth2.googleapis.com/token"));
	assert.equal(tokenRequests.length, 1, "expected one ADC token exchange");
	const generateRequests = output.requests.filter(r => r.url.includes(":generateContent"));
	assert.equal(generateRequests.length, 1);

	const generateRequest = generateRequests[0];
	assert.equal(generateRequest.url, "https://aiplatform.googleapis.com/v1/projects/ai-eng-sandbox/locations/global/publishers/google/models/gemini-3.6-flash:generateContent");
	assert.equal(generateRequest.headers["authorization"], "Bearer synthetic-adc-token");
	assert.ok(!generateRequest.headers["x-goog-api-key"], "must not send an API key in ADC mode");
});

test("Gemini ADC availability requires geminiAuth adc, project, location, and an ADC file", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-avail-"));
	await writeFile(join(root, "web-search.json"), JSON.stringify({ geminiAuth: "adc", geminiProject: "p", geminiLocation: "l" }) + "\n", "utf8");

	// ADC file does not exist yet -> not available.
	const child = runChild(`
		const { isGeminiApiAvailable } = await import(${JSON.stringify(geminiApiModuleUrl)});
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		console.log(JSON.stringify({ adcAvail: adc.isGeminiAdcAvailable(), apiAvail: isGeminiApiAvailable() }));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), { adcAvail: false, apiAvail: false });

	// Now write an ADC file; availability should flip on.
	await writeAdc(root);
	const child2 = runChild(`
		const { isGeminiApiAvailable } = await import(${JSON.stringify(geminiApiModuleUrl)});
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		console.log(JSON.stringify({ adcAvail: adc.isGeminiAdcAvailable(), apiAvail: isGeminiApiAvailable(), missingProject: (await import(${JSON.stringify(geminiAdcModuleUrl)})).getAdcProject() }));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") });
	assert.equal(child2.status, 0, child2.stderr);
	const avail = JSON.parse(child2.stdout.trim());
	assert.equal(avail.adcAvail, true);
	assert.equal(avail.apiAvail, true);
});

test("Gemini ADC never leaks the access token in errors", async () => {	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-redact-"));
	await writeAdc(root);
	await writeFile(
		join(root, "web-search.json"),
		JSON.stringify({ geminiAuth: "adc", geminiProject: "p", geminiLocation: "l" }) + "\n",
		"utf8",
	);

	const child = runChild(`
		globalThis.fetch = async (url, init = {}) => {
			if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
				return new Response(JSON.stringify({ access_token: "super-secret-adc-token-12345", expires_in: 3599 }), { status: 200 });
			}
			// Vertex returns 500 with a body that maliciously echoes the token.
			return new Response(JSON.stringify({ error: { message: "boom super-secret-adc-token-12345" } }), { status: 500 });
		};
		const { search } = await import(${JSON.stringify(geminiSearchModuleUrl)});
		let threw = null;
		try {
			await search("query", { provider: "gemini" });
		} catch (err) {
			threw = String(err.message);
		}
		console.log(JSON.stringify({ threw, leak: threw && threw.includes("super-secret-adc-token-12345") }));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.ok(output.threw, "expected an error");
	assert.equal(output.leak, false, "access token must not leak in error messages");
});

test("Gemini ADC classifies only credential rejections as CredentialResolutionError", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-classify-"));
	await writeAdc(root);
	const env = { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") };

	const classify = (status, body) => runChild(`
		globalThis.fetch = async () => new Response(${JSON.stringify(body)}, { status: ${status} });
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		let threw = null;
		try {
			await adc.getAdcAccessToken();
		} catch (err) {
			threw = { name: err.name, category: err.category, message: err.message };
		}
		console.log(JSON.stringify({ threw }));
	`, env);

	// Credential rejections -> CredentialResolutionError.
	for (const status of [400, 401, 403]) {
		const out = classify(status, JSON.stringify({ error: "denied" }));
		assert.equal(out.status, 0, out.stderr);
		const { threw } = JSON.parse(out.stdout.trim());
		assert.equal(threw.name, "CredentialResolutionError", `status ${status}`);
		assert.equal(threw.category, "oauth-credential-rejected", `status ${status}`);
		assert.match(threw.message, /OAuth token exchange rejected/, `status ${status}`);
	}

	// Transient failures stay plain Errors so fallbacks still run.
	for (const status of [429, 404, 500, 502, 503]) {
		const out = classify(status, "upstream boom");
		assert.equal(out.status, 0, out.stderr);
		const { threw } = JSON.parse(out.stdout.trim());
		assert.equal(threw.name, "Error", `status ${status}`);
		assert.equal(threw.category, undefined, `status ${status}`);
		assert.match(threw.message, new RegExp(`token exchange failed \\(${status}\\)`), `status ${status}`);
	}
});

test("Gemini ADC does not advertise the Files-API (YouTube/video) path", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-video-"));
	await writeAdc(root);
	await writeFile(
		join(root, "web-search.json"),
		JSON.stringify({ geminiAuth: "adc", geminiProject: "p", geminiLocation: "l" }) + "\n",
		"utf8",
	);

	// ADC only: generate-content paths are available, the Files-API path is not.
	const adcOnly = runChild(`
		const api = await import(${JSON.stringify(geminiApiModuleUrl)});
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		console.log(JSON.stringify({
			adcAvail: adc.isGeminiAdcAvailable(),
			apiAvail: api.isGeminiApiAvailable(),
			videoAvail: api.isGeminiApiAvailableWithVideo(),
		}));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") });
	assert.equal(adcOnly.status, 0, adcOnly.stderr);
	assert.deepEqual(JSON.parse(adcOnly.stdout.trim()), {
		adcAvail: true,
		apiAvail: true,
		videoAvail: false,
	});

	// ADC + API key: the Files-API path becomes available again.
	await writeFile(
		join(root, "web-search.json"),
		JSON.stringify({ geminiAuth: "adc", geminiProject: "p", geminiLocation: "l", geminiApiKey: "synthetic-key" }) + "\n",
		"utf8",
	);
	const withKey = runChild(`
		const api = await import(${JSON.stringify(geminiApiModuleUrl)});
		console.log(JSON.stringify({
			apiAvail: api.isGeminiApiAvailable(),
			videoAvail: api.isGeminiApiAvailableWithVideo(),
		}));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") });
	assert.equal(withKey.status, 0, withKey.stderr);
	assert.deepEqual(JSON.parse(withKey.stdout.trim()), { apiAvail: true, videoAvail: true });
});
