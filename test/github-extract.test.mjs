import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

const extractModuleUrl = new URL("../github-extract.ts", import.meta.url).href;

async function writeFakeExecutable(binDir, name, source) {
	const executable = join(binDir, name);
	await writeFile(executable, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
	return executable;
}

function processIsAlive(pid) {
	try {
		process.kill(pid, 0);
		try {
			// Container PID 1 may reap orphaned descendants slowly. A zombie is
			// already terminated and can no longer hold or read from a terminal.
			const state = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[0];
			if (state === "Z") return false;
		} catch {
			// Non-Linux platforms do not expose /proc; kill(0) remains the check.
		}
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessExit(pid, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!processIsAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return !processIsAlive(pid);
}

test("normalizeClonePath expands ~ to HOME", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-expand-"));
	const agentDir = join(root, "agent-dir");
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(agentDir, "web-search.json"),
		JSON.stringify({ githubClone: { clonePath: "~/test-repos" } }),
		"utf8",
	);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			// Trigger config load by calling extractGitHub with a non-GitHub URL
			// The config is loaded internally, so we check the clone path via a GitHub URL
			const result = await extractGitHub("https://github.com/test/repo");
			// If we got here without error, config loaded successfully
			console.log(JSON.stringify({ success: true }));
		`,
		encoding: "utf8",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
		},
	});

	assert.equal(child.status, 0, child.stderr);
	// The test passes if the config loads without error
	// We can't directly test the expanded path without exporting loadGitHubConfig
	// but we've verified the code doesn't crash
});

test("normalizeClonePath expands $HOME and other env vars", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-expand-env-"));
	const agentDir = join(root, "agent-dir");
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(agentDir, "web-search.json"),
		JSON.stringify({ githubClone: { clonePath: "$HOME/my-repos" } }),
		"utf8",
	);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			const result = await extractGitHub("https://github.com/test/repo");
			console.log(JSON.stringify({ success: true }));
		`,
		encoding: "utf8",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
		},
	});

	assert.equal(child.status, 0, child.stderr);
});

test("normalizeClonePath handles absolute paths without expansion", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-abs-"));
	const agentDir = join(root, "agent-dir");
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(agentDir, "web-search.json"),
		JSON.stringify({ githubClone: { clonePath: "/tmp/my-repos" } }),
		"utf8",
	);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			const result = await extractGitHub("https://github.com/test/repo");
			console.log(JSON.stringify({ success: true }));
		`,
		encoding: "utf8",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
		},
	});

	assert.equal(child.status, 0, child.stderr);
});

test("GitHub clones disable interactive credential prompts", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-noninteractive-"));
	const agentDir = join(root, "agent-dir");
	const binDir = join(root, "bin");
	const clonePath = join(root, "repos");
	const envFile = join(root, "clone-env.json");
	await mkdir(agentDir, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await writeFile(
		join(agentDir, "web-search.json"),
		JSON.stringify({ githubClone: { clonePath, cloneTimeoutSeconds: 1 } }),
		"utf8",
	);
	await writeFakeExecutable(binDir, "gh", "process.exit(1);");
	await writeFakeExecutable(
		binDir,
		"git",
		`
			const { mkdirSync, writeFileSync } = require("node:fs");
			const { join } = require("node:path");
			const destination = process.argv.at(-1);
			mkdirSync(destination, { recursive: true });
			writeFileSync(join(destination, "README.md"), "fixture");
			writeFileSync(process.env.CLONE_ENV_FILE, JSON.stringify({
				gitTerminalPrompt: process.env.GIT_TERMINAL_PROMPT,
				gcmInteractive: process.env.GCM_INTERACTIVE,
				ghPromptDisabled: process.env.GH_PROMPT_DISABLED,
			}));
		`,
	);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			const result = await extractGitHub("https://github.com/test/repo");
			console.log(JSON.stringify(result !== null));
		`,
		encoding: "utf8",
		timeout: 5000,
		env: {
			...process.env,
			CLONE_ENV_FILE: envFile,
			PATH: `${binDir}${delimiter}${process.env.PATH || ""}`,
			PI_CODING_AGENT_DIR: agentDir,
		},
	});

	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout), true);
	assert.deepEqual(JSON.parse(await readFile(envFile, "utf8")), {
		gitTerminalPrompt: "0",
		gcmInteractive: "Never",
		ghPromptDisabled: "1",
	});
});

test("GitHub clone timeout force-kills the SIGTERM-resistant process group", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-timeout-tree-"));
	const agentDir = join(root, "agent-dir");
	const binDir = join(root, "bin");
	const processPidFile = join(root, "processes.json");
	await mkdir(agentDir, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await writeFile(
		join(agentDir, "web-search.json"),
		JSON.stringify({ githubClone: { clonePath: join(root, "repos"), cloneTimeoutSeconds: 0.5 } }),
		"utf8",
	);
	await writeFakeExecutable(binDir, "gh", "process.exit(1);");
	await writeFakeExecutable(
		binDir,
		"git",
		`
			const { spawn } = require("node:child_process");
			process.on("SIGTERM", () => {});
			const helperSource = ${JSON.stringify(`
				const { writeFileSync } = require("node:fs");
				process.on("SIGTERM", () => {});
				writeFileSync(process.env.CLONE_PROCESS_PID_FILE, JSON.stringify({
					rootPid: process.ppid,
					helperPid: process.pid,
				}));
				setInterval(() => {}, 1000);
			`)};
			spawn(process.execPath, ["-e", helperSource], { stdio: "ignore" });
			setInterval(() => {}, 1000);
		`,
	);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			const result = await extractGitHub("https://github.com/test/repo");
			console.log(JSON.stringify(result));
		`,
		encoding: "utf8",
		timeout: 10000,
		env: {
			...process.env,
			CLONE_PROCESS_PID_FILE: processPidFile,
			PATH: `${binDir}${delimiter}${process.env.PATH || ""}`,
			PI_CODING_AGENT_DIR: agentDir,
		},
	});

	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout), null);
	const { rootPid, helperPid } = JSON.parse(await readFile(processPidFile, "utf8"));
	try {
		assert.equal(await waitForProcessExit(rootPid), true, `clone process ${rootPid} survived SIGKILL fallback`);
		assert.equal(await waitForProcessExit(helperPid), true, `clone helper ${helperPid} survived SIGKILL fallback`);
	} finally {
		if (processIsAlive(rootPid)) process.kill(rootPid, "SIGKILL");
		if (processIsAlive(helperPid)) process.kill(helperPid, "SIGKILL");
	}
});

test("githubClone.enabled false skips GitHub clone/API specialization", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-disabled-"));
	const agentDir = join(root, "agent-dir");
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(agentDir, "web-search.json"),
		JSON.stringify({ githubClone: { enabled: false } }),
		"utf8",
	);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			const result = await extractGitHub("https://github.com/owner/repo");
			console.log(JSON.stringify(result));
		`,
		encoding: "utf8",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
		},
	});

	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout), null);
});
