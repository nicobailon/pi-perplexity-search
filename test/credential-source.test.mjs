import assert from "node:assert/strict";
import { test } from "node:test";

import {
	CredentialResolutionError,
	hasCredentialSource,
	resolveCredential,
} from "../credential-source.ts";

const fake = value => async () => ({ stdout: value });

function options(configuredValue, environmentValue) {
	return { provider: "Synthetic", configuredValue, environmentValue };
}

test("literal and legacy environment credentials preserve existing precedence", async () => {
	assert.equal(await resolveCredential(options("literal-value", "environment-value")), "environment-value");
	assert.equal(await resolveCredential(options("literal-value", undefined)), "literal-value");
	assert.equal(await resolveCredential(options(undefined, "environment-value")), "environment-value");
	assert.equal(await resolveCredential(options(undefined, undefined)), null);
});

test("explicit environment sources use only the named variable", async () => {
	assert.equal(await resolveCredential({
		...options("${SCOPED_SYNTHETIC_KEY}", "stale-legacy-value"),
		environment: { SCOPED_SYNTHETIC_KEY: "scoped-value" },
	}), "scoped-value");
	await assert.rejects(
		resolveCredential({
			...options("$SCOPED_SYNTHETIC_KEY", "stale-legacy-value"),
			environment: {},
		}),
		err => err instanceof CredentialResolutionError && err.category === "environment-empty",
	);
});

test("command sources override stale values, remain lazy, and rotate per resolution", async () => {
	let calls = 0;
	const runCommand = async (command, runOptions) => {
		calls += 1;
		assert.equal(command, "/trusted/read synthetic");
		assert.deepEqual(runOptions.environment, { HOME: "/synthetic/home", PATH: "/usr/bin:/bin" });
		return { stdout: calls === 1 ? "first-value\n" : "second-value\n" };
	};
	const commandOptions = {
		...options("!/trusted/read synthetic", "stale-environment-value"),
		runCommand,
		environment: {
			HOME: "/synthetic/home",
			PATH: "/usr/bin:/bin",
			EXA_API_KEY: "stale-provider-key-must-not-reach-command",
			NODE_OPTIONS: "--require=untrusted.js",
		},
	};

	assert.equal(hasCredentialSource(commandOptions), true);
	assert.equal(calls, 0);
	assert.equal(await resolveCredential(commandOptions), "first-value");
	assert.equal(await resolveCredential(commandOptions), "second-value");
	assert.equal(calls, 2);
});

test("command output must be one non-empty bounded value", async () => {
	for (const [stdout, category] of [
		["", "command-empty"],
		["one\ntwo\n", "command-invalid-output"],
		["x".repeat(16_385), "command-output-too-large"],
	]) {
		await assert.rejects(
			resolveCredential({ ...options("!ignored", undefined), runCommand: fake(stdout) }),
			err => err instanceof CredentialResolutionError && err.category === category,
		);
	}
});

test("command failures are categorized and redact command output", async () => {
	const secret = "SYNTHETIC_SECRET_MUST_NOT_ESCAPE";
	for (const [failure, category] of [
		[Object.assign(new Error(`spawn failed ${secret}`), { code: "ENOENT", stderr: secret }), "command-failed"],
		[Object.assign(new Error(`timed out ${secret}`), { killed: true, stderr: secret }), "command-timeout"],
		[Object.assign(new Error(`too large ${secret}`), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stderr: secret }), "command-output-too-large"],
	]) {
		await assert.rejects(
			resolveCredential({
				...options("!/trusted/read synthetic", "stale-value"),
				runCommand: async () => { throw failure; },
			}),
			err => {
				assert.equal(err instanceof CredentialResolutionError, true);
				assert.equal(err.category, category);
				assert.equal(err.message.includes(secret), false);
				assert.equal(err.message.includes("/trusted/read"), false);
				return true;
			},
		);
	}
});

test("malformed explicit sources fail closed instead of becoming literals", async () => {
	for (const source of ["!", "$BAD-NAME", "${UNCLOSED"]) {
		await assert.rejects(
			resolveCredential(options(source, "stale-value")),
			err => err instanceof CredentialResolutionError && err.category === "invalid-source",
		);
	}
});
