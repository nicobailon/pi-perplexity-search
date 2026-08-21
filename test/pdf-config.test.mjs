import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readPDFResponseBuffer } from "../extract.ts";

const pdfModuleUrl = new URL("../pdf-extract.ts", import.meta.url).href;

test("pdf.enabled defaults to true and accepts false", () => {
	assert.equal(readConfig(undefined).enabled, true);
	assert.equal(readConfig({ pdf: { enabled: false } }).enabled, false);
	assert.equal(readConfig({ pdf: { enabled: "false" } }).enabled, true);
});

test("pdf config reloads after the config file changes", () => {
	assert.deepEqual(readConfigSequence([{ pdf: { enabled: false } }, { pdf: { enabled: true } }]), [false, true]);
});

test("pdf.maxSizeMB defaults to 20 and accepts values through 50", () => {
	assert.equal(readConfig(undefined).maxSizeMB, 20);
	assert.equal(readConfig({ pdf: { maxSizeMB: 30 } }).maxSizeMB, 30);
	assert.equal(readConfig({ pdf: { maxSizeMB: 50 } }).maxSizeMB, 50);
});

test("pdf.maxSizeMB caps values above 50 and rejects invalid values", () => {
	assert.equal(readConfig({ pdf: { maxSizeMB: 80 } }).maxSizeMB, 50);
	assert.equal(readConfig({ pdf: { maxSizeMB: 0 } }).maxSizeMB, 20);
	assert.equal(readConfig({ pdf: { maxSizeMB: -1 } }).maxSizeMB, 20);
	assert.equal(readConfig({ pdf: { maxSizeMB: "50" } }).maxSizeMB, 20);
});

test("pdf.maxPages defaults to 100 and accepts positive integer values", () => {
	assert.equal(readConfig(undefined).maxPages, 100);
	assert.equal(readConfig({ pdf: { maxPages: 25 } }).maxPages, 25);
	assert.equal(readConfig({ pdf: { maxPages: 2.8 } }).maxPages, 2);
	assert.equal(readConfig({ pdf: { maxPages: 0 } }).maxPages, 100);
	assert.equal(readConfig({ pdf: { maxPages: -1 } }).maxPages, 100);
	assert.equal(readConfig({ pdf: { maxPages: "25" } }).maxPages, 100);
});

test("pdf.provider defaults to auto and validates explicit providers", () => {
	assert.equal(readConfig(undefined).provider, "auto");
	assert.equal(readConfig({ pdf: { provider: "gemini" } }).provider, "gemini");
	assert.equal(
		readConfig({ pdf: { provider: "datalab" } }).provider,
		"datalab",
	);
	assert.equal(readConfig({ pdf: { provider: "unpdf" } }).provider, "unpdf");
	assert.equal(readConfig({ pdf: { provider: "gemini2" } }).provider, "auto");
});

test("pdf.datalabMode defaults to balanced and validates modes", () => {
	assert.equal(readConfig(undefined).datalabMode, "balanced");
	assert.equal(
		readConfig({ pdf: { datalabMode: "fast" } }).datalabMode,
		"fast",
	);
	assert.equal(
		readConfig({ pdf: { datalabMode: "accurate" } }).datalabMode,
		"accurate",
	);
	assert.equal(
		readConfig({ pdf: { datalabMode: "ultra" } }).datalabMode,
		"balanced",
	);
});

test("pdf.datalabTimeoutMs defaults to 120000 and caps at 300000", () => {
	assert.equal(readConfig(undefined).datalabTimeoutMs, 120000);
	assert.equal(
		readConfig({ pdf: { datalabTimeoutMs: 5000 } }).datalabTimeoutMs,
		5000,
	);
	assert.equal(
		readConfig({ pdf: { datalabTimeoutMs: 999999 } }).datalabTimeoutMs,
		300000,
	);
	assert.equal(
		readConfig({ pdf: { datalabTimeoutMs: -1 } }).datalabTimeoutMs,
		120000,
	);
});

test("PDF streamed byte enforcement allows the exact limit", async () => {
	const bytes = Uint8Array.from([1, 2]);
	const maxSizeMB = bytes.byteLength / 1024 / 1024;
	const response = new Response(bytes, {
		headers: { "content-type": "application/pdf" },
	});

	const buffer = await readPDFResponseBuffer(response, maxSizeMB);
	assert.deepEqual(new Uint8Array(buffer), bytes);
});

test("PDF streamed byte enforcement rejects a headerless response above the limit", async () => {
	const maxSizeMB = 2 / 1024 / 1024;
	const response = new Response(Uint8Array.from([1, 2, 3]), {
		headers: { "content-type": "application/pdf" },
	});

	await assert.rejects(
		readPDFResponseBuffer(response, maxSizeMB),
		/PDF exceeds configured pdf\.maxSizeMB limit/,
	);
});

function readConfig(config) {
	return readConfigSequence([config]);
}

function readConfigSequence(configs) {
	const configDir = mkdtempSync(join(tmpdir(), "pi-web-access-pdf-config-"));
	try {
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				import { writeFileSync } from "node:fs";
				import { join } from "node:path";
				process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(configDir)};
				delete process.env.DATALAB_MODE;
				const configs = ${JSON.stringify(configs)};
				const { loadPDFConfig } = await import(${JSON.stringify(pdfModuleUrl)});
				const values = [];
				for (const config of configs) {
					if (config !== null) writeFileSync(join(${JSON.stringify(configDir)}, "web-search.json"), JSON.stringify(config));
					values.push(loadPDFConfig().enabled);
				}
				if (configs.length === 1) console.log(JSON.stringify(loadPDFConfig()));
				else console.log(JSON.stringify(values));
			`,
			encoding: "utf8",
			env: { ...process.env, PI_CODING_AGENT_DIR: configDir },
		});
		assert.equal(child.status, 0, child.stderr);
		return JSON.parse(child.stdout.trim());
	} finally {
		rmSync(configDir, { recursive: true, force: true });
	}
}
