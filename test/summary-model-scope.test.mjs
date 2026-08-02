import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { findModelWithProviderRouting, loadEnabledModelPatterns, modelMatchesEnabledPatterns } from "../summary-model-scope.ts";
import { generateSummaryDraft, SUMMARY_GENERATION_DEADLINE_MS } from "../summary-review.ts";

const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const summarySrc = readFileSync(new URL("../summary-review.ts", import.meta.url), "utf8");

function summaryContext() {
	const model = { provider: "anthropic", id: "claude-haiku-4-5" };
	return {
		modelRegistry: {
			find: () => model,
			getAvailable: () => [model],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
		},
		cwd: process.cwd(),
		isProjectTrusted: () => false,
	};
}

const summaryResults = [{
	query: "test query",
	answer: "A test answer.",
	results: [{ title: "Test source", url: "https://example.com" }],
	error: null,
	provider: "test",
}];

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-access-summary-deadline-"));
await writeFile(join(testAgentDir, "settings.json"), JSON.stringify({ enabledModels: ["anthropic/claude-haiku-4-5"] }));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

test("never-settling summary completion returns a deterministic deadline fallback", async () => {
	let completionSignal;
	const neverSettles = new Promise(() => {});
	const startedAt = Date.now();
	const result = await generateSummaryDraft(
		summaryResults,
		summaryContext(),
		undefined,
		undefined,
		undefined,
		(_model, _request, options) => {
			completionSignal = options.signal;
			return neverSettles;
		},
		20,
	);

	assert.ok(Date.now() - startedAt < 500);
	assert.equal(result.meta.fallbackUsed, true);
	assert.equal(result.meta.fallbackReason, "summary-generation-timeout");
	assert.equal(result.meta.phase, "deterministic-fallback");
	assert.equal(completionSignal.aborted, true);
});

test("model resolution errors after the deadline return timeout fallback", async () => {
	const context = summaryContext();
	context.modelRegistry.getApiKeyAndHeaders = async () => {
		await new Promise(resolve => setTimeout(resolve, 30));
		throw new Error("late auth failure");
	};

	const result = await generateSummaryDraft(
		summaryResults,
		context,
		undefined,
		undefined,
		undefined,
		undefined,
		10,
	);

	assert.equal(result.meta.fallbackUsed, true);
	assert.equal(result.meta.fallbackReason, "summary-generation-timeout");
	assert.equal(result.meta.phase, "deterministic-fallback");
});

test("caller abort takes precedence over a pending summary completion", async () => {
	const controller = new AbortController();
	const neverSettles = new Promise(() => {});
	setTimeout(() => controller.abort(), 10);

	await assert.rejects(
		() => generateSummaryDraft(
			summaryResults,
			summaryContext(),
			controller.signal,
			undefined,
			undefined,
			() => neverSettles,
			1000,
		),
		/Aborted/,
	);
});

test("summary model scope matches nested provider model ids and thinking suffixes", () => {
	assert.equal(
		modelMatchesEnabledPatterns(
			{ provider: "openrouter", id: "nvidia/nemotron-3-super-120b-a12b:free" },
			["openrouter/nvidia/nemotron-3-super-120b-a12b:free"],
		),
		true,
	);
	assert.equal(
		modelMatchesEnabledPatterns(
			{ provider: "openrouter", id: "anthropic/claude-sonnet-4" },
			["openrouter/*:low"],
		),
		true,
	);
	assert.equal(
		modelMatchesEnabledPatterns(
			{ provider: "openrouter", id: "ai21/jamba-large-1.7" },
			["openrouter/nvidia/*"],
		),
		false,
	);
});

test("summary generation resolves preferred models through routed providers", async () => {
	const routedModel = { provider: "openrouter", id: "anthropic/claude-haiku-4-5" };
	let completeCalled = false;
	const result = await generateSummaryDraft(
		summaryResults,
		{
			modelRegistry: {
				find: () => undefined,
				getAvailable: () => [routedModel],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			},
			cwd: process.cwd(),
			isProjectTrusted: () => false,
		},
		undefined,
		undefined,
		undefined,
		() => {
			completeCalled = true;
			return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "Routed summary" }] });
		},
		1000,
	);

	assert.equal(completeCalled, true);
	assert.equal(result.meta.fallbackUsed, false);
	assert.equal(result.meta.model, "openrouter/anthropic/claude-haiku-4-5");
});

test("preferred models resolve through routed providers", () => {
	const routedModel = { provider: "openrouter", id: "anthropic/claude-haiku-4-5" };
	const registry = {
		find: () => undefined,
		getAvailable: () => [routedModel],
	};

	assert.equal(
		findModelWithProviderRouting(registry, "anthropic", "claude-haiku-4-5"),
		routedModel,
	);
});

test("model resolution preserves the direct registry fallback", () => {
	const configuredModel = { provider: "anthropic", id: "claude-haiku-4-5" };
	const registry = {
		find: () => configuredModel,
		getAvailable: () => [],
	};

	assert.equal(
		findModelWithProviderRouting(registry, "anthropic", "claude-haiku-4-5"),
		configuredModel,
	);
});

test("routed model resolution follows available-model ordering", () => {
	const firstRoute = { provider: "openrouter", id: "anthropic/claude-haiku-4-5" };
	const secondRoute = { provider: "requesty", id: "anthropic/claude-haiku-4-5" };
	const registry = {
		find: () => undefined,
		getAvailable: () => [firstRoute, secondRoute],
	};

	assert.equal(
		findModelWithProviderRouting(registry, "anthropic", "claude-haiku-4-5"),
		firstRoute,
	);
});

test("enabledModels loading uses trusted project settings over global settings", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-agent-"));
	const projectDir = await mkdtemp(join(tmpdir(), "pi-web-access-project-"));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["global/model"] }));
	await mkdir(join(projectDir, ".pi"));
	await writeFile(join(projectDir, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["project/model"] }));

	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		assert.deepEqual(
			loadEnabledModelPatterns({ cwd: projectDir, isProjectTrusted: () => true }),
			["project/model"],
		);
		assert.deepEqual(
			loadEnabledModelPatterns({ cwd: projectDir, isProjectTrusted: () => false }),
			["global/model"],
		);
	} finally {
		if (previous === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previous;
		}
	}
});

test("summary generation has a hard deadline and preserves caller cancellation", () => {
	assert.equal(SUMMARY_GENERATION_DEADLINE_MS, 30_000);
	assert.match(summarySrc, /Promise\.race\(contenders\)/);
	assert.match(summarySrc, /deadlineController\.abort\(\)/);
	assert.match(summarySrc, /void operation\.then\(\(\) => undefined, \(\) => undefined\)/);
});

test("summary generation no longer uses catalog fallback or first available model", () => {
	assert.doesNotMatch(summarySrc, /getModel/);
	assert.doesNotMatch(indexSrc, /getModel/);
	assert.match(summarySrc, /findModelWithProviderRouting\(ctx\.modelRegistry, spec\.provider, spec\.id\)/);
	assert.match(indexSrc, /findModelWithProviderRouting\(ctx\.modelRegistry, provider, id\)/);
	assert.match(summarySrc, /modelMatchesEnabledPatterns\(model, enabledModelPatterns\)/);
	assert.doesNotMatch(indexSrc, /defaultSummaryModel = summaryModels\[0\]\.value/);
	assert.match(indexSrc, /modelMatchesEnabledPatterns\(model, enabledModelPatterns\)/);
});
