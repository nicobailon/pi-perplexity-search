import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { extractContent } from "../extract.ts";

const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const originalFetch = globalThis.fetch;

test("weak Readability output falls back to useful RSC content", async (t) => {
	t.after(() => { globalThis.fetch = originalFetch; });
	const article = "RSC article content survives the loading shell. ".repeat(20);
	const payload = `23:${JSON.stringify(["$", "article", null, { children: ["$", "p", null, { children: article }] }])}\n`;
	globalThis.fetch = async () => new Response(
		`<!doctype html><html><head><title>RSC article</title></head><body><article>Loading...</article><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></body></html>`,
		{
			status: 200,
			headers: {
				"content-type": "text/html",
				link: '</openapi.json>; rel="service-desc"',
			},
		},
	);

	const result = await extractContent("https://example.com/rsc", undefined, { lookup });
	assert.equal(result.error, null);
	assert.equal(result.title, "RSC article");
	assert.match(result.content, /RSC article content survives the loading shell/);
	assert.match(result.content, /https:\/\/example\.com\/openapi\.json/);
});

test("short non-RSC pages remain incomplete", async (t) => {
	t.after(() => { globalThis.fetch = originalFetch; });
	globalThis.fetch = async () => new Response(
		"<!doctype html><html><head><title>Short</title></head><body><article>Loading...</article></body></html>",
		{ status: 200, headers: { "content-type": "text/html" } },
	);

	const result = await extractContent("https://example.com/short", undefined, { lookup });
	assert.notEqual(result.error, null);
});

test("short RSC payloads remain incomplete", async (t) => {
	t.after(() => { globalThis.fetch = originalFetch; });
	const payload = `23:${JSON.stringify(["$", "article", null, { children: "Short RSC content" }])}\n`;
	globalThis.fetch = async () => new Response(
		`<!doctype html><html><head><title>Short RSC</title></head><body><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></body></html>`,
		{ status: 200, headers: { "content-type": "text/html" } },
	);

	const result = await extractContent("https://example.com/short-rsc", undefined, { lookup });
	assert.notEqual(result.error, null);
});

test("background fetch notification distinguishes full, partial, and failed content", () => {
	assert.match(indexSrc, /ok === fetched\.length\n\s*\? "Full page content now available\."/);
	assert.match(indexSrc, /ok > 0\n\s*\? "Partial page content now available\."/);
	assert.match(indexSrc, /"No page content was fetched\. Stored fetch diagnostics are available\."/);
	assert.match(indexSrc, /Content fetched for \$\{ok\}\/\$\{fetched\.length\} URLs \[\$\{fetchId\}\]\. \$\{availability\}/);
});
