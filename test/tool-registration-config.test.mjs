import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const readmeSrc = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("web_search registration is gated by webSearch.enabled", () => {
	assert.match(indexSrc, /webSearch\?: \{\n\t\tenabled\?: boolean;\n\t\};/);
	assert.match(indexSrc, /if \(initConfig\.webSearch\?\.enabled !== false\) pi\.registerTool\(\{\n\t\tname: "web_search"/);
});

test("fetch tools remain registered outside the web_search gate", () => {
	const gateIndex = indexSrc.indexOf("if (initConfig.webSearch?.enabled !== false)");
	const fetchIndex = indexSrc.indexOf('name: "fetch_content"');
	assert.ok(gateIndex >= 0, "web_search gate not found");
	assert.ok(fetchIndex > gateIndex, "fetch_content registration should remain after web_search gate");
	assert.match(indexSrc, /\n\t}\);\n\n\tpi\.registerTool\(\{\n\t\tname: "fetch_content"/);
});

test("web activity widget uses a supported component factory", () => {
	assert.match(
		indexSrc,
		/ctx\.ui\.setWidget\("web-activity", \(\) => new Text\(lines\.join\("\\n"\), 0, 0\)\);/,
	);
	assert.doesNotMatch(
		indexSrc,
		/ctx\.ui\.setWidget\("web-activity", new Text/,
	);
});

test("README documents webSearch.enabled", () => {
	assert.match(readmeSrc, /"webSearch": \{\n    "enabled": true\n  \}/);
	assert.match(readmeSrc, /webSearch\.enabled` to `false` to unregister the `web_search` tool/);
});
