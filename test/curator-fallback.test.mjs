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

test("curator add-search receives the active extension context", () => {
	assert.match(indexSrc, /openCuratorBrowser\(callId: string, pc: PendingCurate, ctx: ExtensionContext,/);
	assert.match(indexSrc, /openCuratorBrowser\(callId, pc, ctx, false\)/);
	assert.match(indexSrc, /extensionContext: ctx,/);
});

test("curator fallback helper is visible to the browser-open catch block", () => {
	const functionIndex = indexSrc.indexOf("async function openCuratorBrowser");
	const declarationIndex = indexSrc.indexOf("const sendCuratorFallbackUpdate", functionIndex);
	const tryIndex = indexSrc.indexOf("\n\t\ttry {\n\t\t\tpc.phase = \"curating\";", functionIndex);
	const catchCallIndex = indexSrc.indexOf("sendCuratorFallbackUpdate(\"Search curator is running, but the browser did not open automatically.\")", tryIndex);

	assert.ok(functionIndex >= 0);
	assert.ok(declarationIndex > functionIndex);
	assert.ok(tryIndex > declarationIndex, "fallback helper must be declared before the try block so catch can call it");
	assert.ok(catchCallIndex > tryIndex);
	assert.match(indexSrc.slice(declarationIndex, tryIndex), /if \(!handle\) return;/);
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

test("remote curator mode prints the manual URL unless auto-open is explicit", () => {
	assert.match(indexSrc, /function shouldAutoOpenCuratorBrowser\(config: WebSearchConfig\): boolean \{/);
	assert.match(indexSrc, /if \(resolveCuratorNetworkConfig\(\)\.enabled && config\.autoOpenBrowser !== true\) return false;/);
	assert.ok(indexSrc.includes('sendCuratorFallbackUpdate("Search curator is running. Open the curator URL manually.")'));
	assert.ok(indexSrc.includes('ctx.ui.notify(`Search curator is running. Open manually: ${handle.url}`, "info")'));
});

test("Linux curator browser launch detaches xdg-open but keeps immediate failures", () => {
	assert.match(indexSrc, /spawn\("xdg-open", \[url\], \{ detached: true, stdio: "ignore" \}\)/);
	assert.match(indexSrc, /child\.once\("error", \(err\) => \{/);
	assert.match(indexSrc, /child\.once\("exit", \(code\) => \{/);
	assert.match(indexSrc, /setTimeout\(resolve, 100\)/);
	assert.match(indexSrc, /child\.unref\(\);/);
});

test("README documents manual browser fallback", () => {
	assert.match(readmeSrc, /Docker, WSL, SSH, or headless environments/);
	assert.match(readmeSrc, /Copy it into a browser that can reach the Pi host/);
	assert.match(readmeSrc, /Remote curator sessions print the URL instead of trying to open a browser by default/);
});
