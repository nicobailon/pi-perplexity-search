import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"XCRAWL_API_KEY",
		"OPENAI_API_KEY",
		"BRAVE_API_KEY",
		"PARALLEL_API_KEY",
		"TINYFISH_API_KEY",
		"TAVILY_API_KEY",
		"JINA_API_KEY",
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

test("web_search expands a JSON-array string in query into separate searches", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-317-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify({ xcrawlApiKey: "xc-test-key" }) + "\n", "utf8");

	// What a small/local model actually sends: the queries array serialized as a
	// JSON string inside the single-string `query` field.
	const brokenQuery = '["AGP version", "Compose BOM", "CameraX"]';

	const child = runChild(`
		const requests = [];
		globalThis.fetch = async (url, init) => {
			let q = null;
			try { q = JSON.parse(init.body).q; } catch {}
			requests.push({ url: String(url), q });
			return new Response(JSON.stringify({
				search_metadata: { status: "completed" },
				total_credits_used: 1,
				organic_results: [
					{ position: 1, title: "R1", link: "https://example.com/1", snippet: "s1" },
					{ position: 2, title: "R2", link: "https://example.com/2", snippet: "s2" },
				],
			}), { status: 200 });
		};
		const { default: initializeExtension } = await import(${JSON.stringify(indexUrl)});
		const tools = [];
		initializeExtension({
			registerTool(tool) { tools.push(tool); },
			registerCommand() {},
			registerShortcut() {},
			on() {},
			appendEntry() {},
			sendMessage() {},
			exec() { return { code: 0 }; },
		});
		const webSearch = tools.find((tool) => tool.name === "web_search");
		await webSearch.execute("call", {
			query: ${JSON.stringify(brokenQuery)},
			provider: "xcrawl",
			workflow: "none",
			numResults: 2,
		});
		console.log(JSON.stringify(requests));
	`, { PI_CODING_AGENT_DIR: home });

	assert.equal(child.status, 0, child.stderr);
	const requests = JSON.parse(child.stdout.trim());
	const queries = requests
		.filter((request) => request.url === "https://run.xcrawl.com/v1/serp")
		.map((request) => request.q);

	// Three independent backend queries, not one literal JSON-array string.
	assert.deepEqual(queries, ["AGP version", "Compose BOM", "CameraX"]);
});