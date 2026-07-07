import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const readmeSrc = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("web_search curator auto-open failures keep the curator alive with a manual URL", () => {
	assert.match(indexSrc, /browserOpenError\?: string;/);
	assert.match(indexSrc, /phase: "curator-fallback"/);
	assert.match(indexSrc, /Search curator is running, but the browser did not open automatically\./);
	assert.match(indexSrc, /Open manually: \$\{handle\.url\}/);
	assert.match(indexSrc, /pc\.browserOpenError = message;/);
	assert.doesNotMatch(indexSrc, /Failed to open curator UI: \$\{message\}`\);\n\t\t\tif \(pendingCurates\.get\(callId\) === pc \|\| \(handle && activeCurators\.get\(callId\) === handle\)\) \{\n\t\t\t\tcloseCurator\(callId\);/);
});

test("curator fallback helper is declared at function scope so the catch block can reach it", () => {
	// Regression for a ReferenceError crash: sendCuratorFallbackUpdate was declared
	// with `const` inside the try block but called from the sibling catch block,
	// which threw "sendCuratorFallbackUpdate is not defined" whenever browser
	// auto-open failed (Docker/WSL/SSH/headless), taking down the whole process.
	const fnStart = indexSrc.indexOf("async function openCuratorBrowser(");
	assert.notEqual(fnStart, -1, "expected openCuratorBrowser to exist");

	const declIndex = indexSrc.indexOf("const sendCuratorFallbackUpdate =", fnStart);
	const tryIndex = indexSrc.indexOf("try {", fnStart);
	const callIndex = indexSrc.indexOf(
		'sendCuratorFallbackUpdate("Search curator is running, but the browser did not open automatically.")',
		fnStart,
	);

	assert.notEqual(declIndex, -1, "expected sendCuratorFallbackUpdate to be declared");
	assert.notEqual(tryIndex, -1, "expected a try block in openCuratorBrowser");
	assert.notEqual(callIndex, -1, "expected the fallback call inside the catch block");
	assert.ok(
		declIndex < tryIndex,
		"sendCuratorFallbackUpdate must be declared before the try block so the catch block can reference it",
	);
	assert.ok(callIndex > tryIndex, "expected the fallback call after the try block");
});

test("cancel diagnostics include curator URL and browser-open error", () => {
	assert.match(indexSrc, /curatorUrl\?: string;/);
	assert.match(indexSrc, /browserOpenError\?: string;/);
	assert.match(indexSrc, /curator: \$\{partial\.curatorUrl\}/);
	assert.match(indexSrc, /browser open error: \$\{partial\.browserOpenError\}/);
});

test("manual websearch command reports browser-open fallback without closing curator", () => {
	assert.match(indexSrc, /let browserOpenError: string \| null = null;/);
	assert.match(indexSrc, /ctx\.ui\.notify\(`Search curator is running, but the browser did not open automatically\. Open manually: \$\{handle\.url\}`/);
	assert.match(indexSrc, /if \(queries\.length > 0\) \{/);
});

test("README documents manual browser fallback", () => {
	assert.match(readmeSrc, /Docker, WSL, SSH, or headless environments/);
	assert.match(readmeSrc, /Copy it into a browser that can reach the Pi host/);
});
