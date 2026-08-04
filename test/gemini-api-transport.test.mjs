import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const videoModuleUrl = new URL("../video-extract.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of ["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL", "CLOUDFLARE_API_KEY"]) {
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

test("Gemini generate, upload, status, and delete use only shared header auth", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-transport-"));
	const mediaPath = join(root, "synthetic.webm");
	await writeFile(mediaPath, "synthetic media", "utf8");
	await writeFile(join(root, "web-search.json"), JSON.stringify({ geminiApiKey: "synthetic-gemini-key" }) + "\n", "utf8");

	const child = runChild(`
		const requests = [];
		globalThis.fetch = async (url, init = {}) => {
			const request = {
				url: String(url),
				method: init.method ?? "GET",
				headers: Object.fromEntries(new Headers(init.headers)),
			};
			requests.push(request);
			if (request.url.endsWith("/upload/v1beta/files")) {
				return new Response("", {
					status: 200,
					headers: { "x-goog-upload-url": "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=synthetic" },
				});
			}
			if (request.url.includes("upload_id=synthetic")) {
				return new Response(JSON.stringify({ file: { name: "files/synthetic", uri: "files/synthetic" } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (request.url.endsWith("/v1beta/files/synthetic") && request.method === "GET") {
				return new Response(JSON.stringify({ state: "ACTIVE" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (request.url.includes(":generateContent")) {
				return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "# Synthetic video" }] } }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (request.url.endsWith("/v1beta/files/synthetic") && request.method === "DELETE") {
				return new Response("", { status: 204 });
			}
			throw new Error("Unexpected fetch: " + request.url);
		};

		const { extractVideo } = await import(${JSON.stringify(videoModuleUrl)});
		const result = await extractVideo({
			absolutePath: ${JSON.stringify(mediaPath)},
			mimeType: "video/webm",
			sizeBytes: 15,
			maxSizeBytes: 50 * 1024 * 1024,
			withinUploadLimit: true,
		});
		await new Promise(resolve => setImmediate(resolve));
		console.log(JSON.stringify({ result, requests }));
	`, {
		HOME: root,
		USERPROFILE: root,
		PI_CODING_AGENT_DIR: root,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.result.content, "# Synthetic video");
	assert.deepEqual(output.requests.map(request => request.method), ["POST", "PUT", "GET", "POST", "DELETE"]);
	const generateRequest = output.requests.find(request => request.url.includes(":generateContent"));
	assert.equal(generateRequest.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent");
	for (const request of output.requests) {
		assert.equal(request.headers["x-goog-api-key"], "synthetic-gemini-key");
		const url = new URL(request.url);
		assert.equal(url.searchParams.has("key"), false);
		assert.equal(url.searchParams.has("api_key"), false);
		assert.equal(request.url.includes("synthetic-gemini-key"), false);
	}
});

test("Gemini video upload, status, and delete respect a configured geminiBaseUrl relay", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-relay-"));
	const mediaPath = join(root, "synthetic.webm");
	await writeFile(mediaPath, "synthetic media", "utf8");
	await writeFile(join(root, "web-search.json"), JSON.stringify({ geminiApiKey: "synthetic-gemini-key", geminiBaseUrl: "https://relay.example.com" }) + "\n", "utf8");

	const child = runChild(`
		const requests = [];
		globalThis.fetch = async (url, init = {}) => {
			const request = {
				url: String(url),
				method: init.method ?? "GET",
				headers: Object.fromEntries(new Headers(init.headers)),
			};
			requests.push(request);
			if (request.url.endsWith("/upload/v1beta/files")) {
				return new Response("", {
					status: 200,
					headers: { "x-goog-upload-url": "https://relay.example.com/upload/v1beta/files?upload_id=synthetic" },
				});
			}
			if (request.url.includes("upload_id=synthetic")) {
				return new Response(JSON.stringify({ file: { name: "files/synthetic", uri: "files/synthetic" } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (request.url.endsWith("/v1beta/files/synthetic") && request.method === "GET") {
				return new Response(JSON.stringify({ state: "ACTIVE" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (request.url.includes(":generateContent")) {
				return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "# Relay video" }] } }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (request.url.endsWith("/v1beta/files/synthetic") && request.method === "DELETE") {
				return new Response("", { status: 204 });
			}
			throw new Error("Unexpected fetch: " + request.url);
		};

		const { extractVideo } = await import(${JSON.stringify(videoModuleUrl)});
		const result = await extractVideo({
			absolutePath: ${JSON.stringify(mediaPath)},
			mimeType: "video/webm",
			sizeBytes: 15,
			maxSizeBytes: 50 * 1024 * 1024,
			withinUploadLimit: true,
		});
		await new Promise(resolve => setImmediate(resolve));
		console.log(JSON.stringify({ result, requests }));
	`, {
		HOME: root,
		USERPROFILE: root,
		PI_CODING_AGENT_DIR: root,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.result.content, "# Relay video");
	assert.deepEqual(output.requests.map(request => request.method), ["POST", "PUT", "GET", "POST", "DELETE"]);
	for (const request of output.requests) {
		assert.equal(new URL(request.url).origin, "https://relay.example.com", request.url);
		assert.equal(request.headers["x-goog-api-key"], "synthetic-gemini-key");
		assert.equal(request.url.includes("generativelanguage.googleapis.com"), false);
	}
});
