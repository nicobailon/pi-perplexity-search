import assert from "node:assert/strict";
import { test } from "node:test";

import { findContent } from "../content-find.ts";

test("findContent supports exact, case-insensitive, and fuzzy matches", () => {
	const text = "Alpha configuration guide.\n\nThe server configuraton value is 42.";

	assert.equal(findContent(text, ["configuration"], "exact").matchCount, 1);
	assert.equal(findContent(text, ["ALPHA"], "case-insensitive").matchCount, 1);
	assert.equal(findContent(text, ["configuration value"], "fuzzy").matchCount, 1);
});

test("findContent caps the complete formatted response", () => {
	const query = "x".repeat(500);
	const text = Array.from(
		{ length: 30 },
		(_, index) => `${"a".repeat(500)} ${query} ${"b".repeat(500)} ${index}`,
	).join("\n\n");
	const result = findContent(text, [query], "exact");

	assert.equal(result.matchCount, 30);
	assert.ok(result.returnedMatches < result.matchCount);
	assert.ok(result.text.length <= 20_000);
});
