import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import { sanitizeInlineDataUris } from "../data-uri-sanitize.ts";

const DATA_URI_MARKER_PREFIX = "[pi-web-access inline data URI omitted;";

function markerCount(text) {
	return text.split(DATA_URI_MARKER_PREFIX).length - 1;
}

function assertRequiredMarkerFields(markerText, ordinal, sourcePath) {
	assert.match(markerText, new RegExp(`ordinal=${ordinal}(?:;|\\])`));
	assert.ok(markerText.includes(`source=${sourcePath};`));
	assert.match(markerText, /mime=[a-z0-9!#$&^_.+\/-]+;/);
	assert.match(markerText, /encoding=(?:base64|percent-encoded);/);
	assert.match(markerText, /encodedBytes=\d+;/);
	assert.match(markerText, /decodedBytes=(?:\d+|unknown)(?:;|\])/);
	assert.match(markerText, /sha256=[a-f0-9]{64};/);
	assert.match(markerText, /digestBasis=(?:decoded|encoded);/);
	assert.match(markerText, /retrieval=not-retained\]/);
}

test("original 21-image failure shape collapses to bounded markers", { timeout: 20_000 }, () => {
	const encoded = Buffer.alloc(240 * 1024, 0xa5).toString("base64");
	const content = Array.from({ length: 21 }, (_, index) =>
		`Prose ${index} before ![OSF screenshot ${index}](data:image/png;base64,${encoded}) prose ${index} after.`,
	).join("\n\n");
	assert.ok(Buffer.byteLength(content, "utf8") > 4 * 1024 * 1024);

	const started = performance.now();
	const { text, omissions } = sanitizeInlineDataUris(content, "urls[0].content");
	const elapsedMs = performance.now() - started;

	assert.equal(omissions.length, 21);
	assert.equal(markerCount(text), 21);
	assert.doesNotMatch(text, /data:image\/png;base64,/i);
	for (let ordinal = 1; ordinal <= 21; ordinal++) {
		assertRequiredMarkerFields(text, ordinal, "urls[0].content");
	}
	assert.ok(Buffer.byteLength(text, "utf8") < 32 * 1024);
	assert.ok(elapsedMs < 15_000, `6-8 MiB sanitization took ${Math.round(elapsedMs)}ms`);
});

test("many individually small images have no per-payload exemption", { timeout: 20_000 }, () => {
	const count = 4_300;
	const encoded = Buffer.alloc(768, 0x5a).toString("base64");
	const content = Array.from(
		{ length: count },
		(_, index) => `Paragraph ${index} ![small ${index}](data:image/png;base64,${encoded}) end ${index}.`,
	).join("\n");

	const { text, omissions } = sanitizeInlineDataUris(content, "urls[0].content");
	assert.equal(omissions.length, count);
	assert.equal(markerCount(text), count);
	assert.doesNotMatch(text, /data:image\/png;base64,/i);
});

test("readable prose and Markdown alt text remain unchanged around replacements", () => {
	const input = "Before ![architecture diagram](data:image/png;base64,SGk=) between <img src=\"data:text/plain,hello%20world\" alt=\"inline\"> after.";
	const { text, omissions } = sanitizeInlineDataUris(input, "urls[0].content");
	assert.equal(omissions.length, 2);
	assert.ok(text.startsWith("Before ![architecture diagram]("));
	assert.ok(text.includes(") between <img src=\""));
	assert.ok(text.endsWith("\" alt=\"inline\"> after."));
	assert.ok(text.includes("architecture diagram"));
	assert.ok(text.includes("alt=\"inline\""));
	assert.equal(markerCount(text), 2);
	assert.doesNotMatch(text, /data:/i);
});

test("small legitimate SVG is explicitly omitted with decoded digest metadata", () => {
	const decoded = "<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 0\"/></svg>";
	const payload = encodeURIComponent(decoded);
	const { text, omissions } = sanitizeInlineDataUris(
		`Diagram: ![tiny vector](data:image/svg+xml;charset=utf-8,${payload}) done`,
		"urls[0].content",
	);
	assert.equal(omissions.length, 1);
	const omission = omissions[0];
	assert.equal(omission.mimeType, "image/svg+xml");
	assert.equal(omission.encoding, "percent-encoded");
	assert.equal(omission.encodedBytes, Buffer.byteLength(payload));
	assert.equal(omission.decodedBytes, Buffer.byteLength(decoded));
	assert.equal(omission.sha256, createHash("sha256").update(decoded).digest("hex"));
	assert.equal(omission.digestBasis, "decoded");
	assert.equal(omission.retrieval, "not-retained");
	assert.ok(text.includes("![tiny vector]("));
	assertRequiredMarkerFields(text, 1, "urls[0].content");
	assert.doesNotMatch(text, /data:/i);
});

test("data URI variants are handled without payload-bearing errors", () => {
	const fixtures = {
		base64: "data:image/png;base64,SGVsbG8=",
		percent: "data:text/plain,hello%20world",
		missingMime: "data:;base64,SGk=",
		parameters: "data:text/plain;charset=utf-8,hello%2Cworld",
		quoted: "<img src='data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA=='>",
		quotedApostrophe: "<img src=\"data:text/plain,it's\">",
		markdown: "![alt](data:application/octet-stream;base64,AAEC)",
		invalidBase64: "data:image/png;base64,***not-base64***",
		mixedCase: "DATA:IMAGE/PNG;BASE64,UE5H",
	};
	const byKey = new Map();
	for (const [key, input] of Object.entries(fixtures)) {
		const result = sanitizeInlineDataUris(input, key);
		assert.equal(result.omissions.length, 1, `expected one omission for ${key}`);
		assert.doesNotMatch(result.text, /data:/i);
		byKey.set(key, { omission: result.omissions[0], text: result.text });
	}
	assert.equal(byKey.get("missingMime").omission.mimeType, "text/plain");
	assert.equal(byKey.get("missingMime").omission.encoding, "base64");
	assert.equal(byKey.get("parameters").omission.decodedBytes, 11);
	assert.equal(byKey.get("mixedCase").omission.mimeType, "image/png");
	const invalid = byKey.get("invalidBase64");
	assert.equal(invalid.omission.decodedBytes, null);
	assert.equal(invalid.omission.digestBasis, "encoded");
	assert.equal(invalid.omission.decodeError, "invalid-base64-character");
	assert.ok(invalid.text.includes("decodedBytes=unknown"));
	assert.ok(invalid.text.includes("decodeError=invalid-base64-character"));
	assert.ok(!invalid.text.includes("not-base64"));
});

test("malformed enclosed data URIs are wholly removed without payload suffix leakage", () => {
	const cases = [
		{
			input: '<img src="data:image/png;base64,QUFB QkJC">',
			forbidden: ["QUFB", "QkJC"],
			error: "invalid-base64-character",
		},
		{
			input: "![x](data:text/plain,abc(def)ghi)",
			forbidden: ["abc(def)ghi", "ghi)"],
			decodedBytes: 11,
		},
		{
			input: "data:text/plain,abc(def)ghi",
			forbidden: ["abc(def)ghi"],
			decodedBytes: 11,
		},
		{
			input: "![x](data:image/png;base64,SGVs\nbG8=)",
			forbidden: ["SGVs", "bG8="],
			error: "invalid-base64-character",
		},
		{
			input: '<img src="data:image/png;base64">',
			forbidden: ["data:image/png;base64"],
			error: "missing-comma",
			encodedBytes: Buffer.byteLength("image/png;base64"),
		},
	];

	for (const fixture of cases) {
		const result = sanitizeInlineDataUris(fixture.input, "urls[0].content");
		assert.equal(result.omissions.length, 1);
		assert.equal(markerCount(result.text), 1);
		assert.doesNotMatch(result.text, /data:/i);
		for (const fragment of fixture.forbidden) assert.ok(!result.text.includes(fragment));
		if (fixture.error) assert.equal(result.omissions[0].decodeError, fixture.error);
		if (fixture.encodedBytes !== undefined) assert.equal(result.omissions[0].encodedBytes, fixture.encodedBytes);
		if (fixture.decodedBytes !== undefined) assert.equal(result.omissions[0].decodedBytes, fixture.decodedBytes);
	}
	assert.equal(
		sanitizeInlineDataUris("ordinary data: value", "urls[0].content").text,
		"ordinary data: value",
	);
});

test("valid RFC MIME token characters are normalized without truncating the URI", () => {
	for (const mimeType of ["application/x.foo~bar", "application/x.foo*bar", "application/x.foo'bar"]) {
		const result = sanitizeInlineDataUris(`<img src=\"data:${mimeType},ok\">`, "urls[0].content");
		assert.equal(result.omissions.length, 1);
		assert.equal(result.omissions[0].mimeType, mimeType);
		assert.equal(result.omissions[0].decodedBytes, 2);
		assert.doesNotMatch(result.text, /data:/i);
	}
});

test("malformed comma-less candidates scale linearly and are explicitly marked", { timeout: 15_000 }, () => {
	function measure(count) {
		const input = Array.from({ length: count }, () => "data:x;").join(" ");
		const started = performance.now();
		const result = sanitizeInlineDataUris(input, "urls[0].content");
		const elapsedMs = performance.now() - started;
		assert.equal(result.omissions.length, count);
		assert.ok(result.omissions.every((item) => item.decodeError === "missing-comma"));
		assert.doesNotMatch(result.text, /data:/i);
		return elapsedMs;
	}
	const smallMs = measure(2_000);
	const largeMs = measure(4_000);
	assert.ok(largeMs < 10_000, `malformed scan took ${Math.round(largeMs)}ms`);
	assert.ok(largeMs <= smallMs * 4 + 500, `nonlinear malformed scan: ${smallMs}ms -> ${largeMs}ms`);
});

test("overlong headers are bounded and classified without retaining header or payload", () => {
	const header = `image/png;name=${"x".repeat(2_048)};base64`;
	const result = sanitizeInlineDataUris(`![x](data:${header},SGVsbG8=)`, "urls[0].content");
	assert.equal(result.omissions.length, 1);
	assert.equal(result.omissions[0].decodedBytes, null);
	assert.equal(result.omissions[0].decodeError, "header-too-long");
	assert.equal(result.omissions[0].digestBasis, "encoded");
	assert.ok(!result.text.includes("x".repeat(128)));
	assert.doesNotMatch(result.text, /data:/i);
});
