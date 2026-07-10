import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

test("registers eagerly and loads content extraction on first use", () => {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildChildScript(indexUrl),
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
		timeout: 30_000,
	});

	assert.equal(
		child.status,
		0,
		"Lazy extraction regression child failed:\n" + errorSummary(child.stderr),
	);
});

function buildChildScript(moduleUrl) {
	return `
		import assert from "node:assert/strict";
		import { existsSync } from "node:fs";
		import { mkdtemp, writeFile } from "node:fs/promises";
		import { createServer } from "node:http";
		import { register } from "node:module";
		import { tmpdir } from "node:os";
		import { join } from "node:path";

		const tempDir = await mkdtemp(join(tmpdir(), "pi-web-access-lazy-"));
		const markerPath = join(tempDir, "extract-loaded");
		process.env.PI_CODING_AGENT_DIR = tempDir;
		await writeFile(
			join(tempDir, "web-search.json"),
			JSON.stringify({ ssrf: { allowRanges: ["127.0.0.0/8"] } }),
		);

		const hookSource = \`
			import { appendFileSync } from "node:fs";
			let markerPath;
			export function initialize(data) { markerPath = data.markerPath; }
			export async function load(url, context, nextLoad) {
				if (new URL(url).pathname.endsWith("/extract.ts")) {
					appendFileSync(markerPath, url + "\\\\n");
				}
				return nextLoad(url, context);
			}
		\`;
		register("data:text/javascript," + encodeURIComponent(hookSource), {
			parentURL: import.meta.url,
			data: { markerPath },
		});

		const { default: initializeExtension } = await import(${JSON.stringify(moduleUrl)});
		assert.equal(existsSync(markerPath), false, "extract.ts loaded during extension import");

		const tools = [];
		const commands = [];
		const shortcuts = [];
		const events = [];
		const pi = new Proxy({}, {
			get(_target, property) {
				if (property === "registerTool") return (tool) => tools.push(tool);
				if (property === "registerCommand") return (name) => commands.push(name);
				if (property === "registerShortcut") return (name) => shortcuts.push(name);
				if (property === "on") return (name) => events.push(name);
				return () => {};
			},
		});

		initializeExtension(pi);
		assert.deepEqual(
			tools.map((tool) => tool.name),
			["web_search", "fetch_content", "get_search_content"],
		);
		assert.ok(commands.includes("websearch"), "websearch command was not registered");
		assert.ok(shortcuts.length > 0, "shortcuts were not registered");
		assert.ok(events.includes("session_start"), "session handlers were not registered");
		assert.equal(existsSync(markerPath), false, "extract.ts loaded during registration");

		const articleText = "Lazy loading keeps extension startup responsive while preserving first-use extraction. ";
		const html = \`<!doctype html><html><head><title>Lazy extraction</title></head><body>
			<article><h1>Lazy extraction works</h1><p>\${articleText.repeat(20)}</p></article>
		</body></html>\`;
		const server = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(html);
		});
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = server.address();
			assert.ok(address && typeof address === "object");
			const fetchTool = tools.find((tool) => tool.name === "fetch_content");
			const result = await fetchTool.execute(
				"lazy-load-regression",
				{ url: \`http://127.0.0.1:\${address.port}/article\` },
				undefined,
				() => {},
			);

			assert.equal(existsSync(markerPath), true, "extract.ts did not load on first use");
			assert.equal(result.details.successful, 1);
			assert.match(result.content.at(-1).text, /preserving first-use extraction/);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	`;
}

function errorSummary(value, size = 2000) {
	return value.length > size ? value.slice(-size) : value;
}
