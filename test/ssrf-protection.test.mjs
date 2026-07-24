import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchRemoteUrl, validateRemoteUrl } from "../ssrf-protection.ts";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

async function rejectsInternal(url) {
	await assert.rejects(
		validateRemoteUrl(url, { lookup: publicLookup }),
		/internal|Blocked/,
		`${url} should be blocked`,
	);
}

test("validateRemoteUrl blocks localhost, loopback, link-local, private, and metadata targets", async () => {
	await rejectsInternal("http://localhost/");
	await rejectsInternal("http://127.0.0.1/");
	await rejectsInternal("http://10.0.0.1/");
	await rejectsInternal("http://172.16.0.1/");
	await rejectsInternal("http://192.168.1.1/");
	await rejectsInternal("http://169.254.169.254/latest/meta-data/");
	await rejectsInternal("http://0.0.0.0/");
	await rejectsInternal("http://[::1]/");
	await rejectsInternal("http://[fe80::1]/");
	await rejectsInternal("http://[fd00::1]/");
	await rejectsInternal("http://[::ffff:127.0.0.1]/");
});

test("validateRemoteUrl blocks encoded and alternate loopback IPv4 forms", async () => {
	await rejectsInternal("http://2130706433/");
	await rejectsInternal("http://0177.0.0.1/");
	await rejectsInternal("http://0x7f.0.0.1/");
	await rejectsInternal("http://127.1/");
});

test("validateRemoteUrl blocks hostnames that resolve to private addresses", async () => {
	await assert.rejects(
		validateRemoteUrl("https://example.test/", {
			lookup: async () => [{ address: "192.168.0.2", family: 4 }],
		}),
		/Blocked internal address for example\.test: 192\.168\.0\.2/,
	);

	await assert.rejects(
		validateRemoteUrl("https://example.test/", {
			lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "fd00::1", family: 6 }],
		}),
		/Blocked internal address for example\.test: fd00::1/,
	);
});

test("validateRemoteUrl permits public HTTP and HTTPS targets", async () => {
	assert.equal((await validateRemoteUrl("https://example.com/path", { lookup: publicLookup })).hostname, "example.com");
	assert.equal((await validateRemoteUrl("http://93.184.216.34/")).hostname, "93.184.216.34");
	assert.equal((await validateRemoteUrl("https://[2606:2800:220:1:248:1893:25c8:1946]/")).hostname, "[2606:2800:220:1:248:1893:25c8:1946]");
});

test("fetchRemoteUrl validates redirect targets before following", async () => {
	const requested = [];
	const fetchImpl = async (url) => {
		requested.push(url.toString());
		return new Response("", {
			status: 302,
			headers: { location: "http://127.0.0.1/admin" },
		});
	};

	await assert.rejects(
		fetchRemoteUrl("https://example.com/", {}, { lookup: publicLookup, fetch: fetchImpl }),
		/Blocked internal address/,
	);
	assert.deepEqual(requested, ["https://example.com/"]);
});

test("fetchRemoteUrl follows validated public redirects manually", async () => {
	const requested = [];
	const fetchImpl = async (url) => {
		requested.push(url.toString());
		if (requested.length === 1) {
			return new Response("", {
				status: 301,
				headers: { location: "/next" },
			});
		}
		return new Response("ok", { status: 200 });
	};

	const response = await fetchRemoteUrl("https://example.com/start", {}, { lookup: publicLookup, fetch: fetchImpl });
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "ok");
	assert.deepEqual(requested, ["https://example.com/start", "https://example.com/next"]);
});

test("fake-IP block errors point to the allowRanges opt-in", async () => {
	const fakeIpLookup = async () => [{ address: "198.18.0.56", family: 4 }];

	await assert.rejects(
		validateRemoteUrl("https://example.test/", { lookup: fakeIpLookup }),
		/Blocked internal address for example\.test: 198\.18\.0\.56\..*TUN\/fake-IP proxies.*ssrf\.allowRanges.*198\.18\.0\.0\/15/,
	);
});

test("allowRanges exempts a synthetic fake-IP range (e.g. 198.18.0.0/15)", async () => {
	const fakeIpLookup = async () => [{ address: "198.18.0.56", family: 4 }];

	// Without the exemption this is blocked (the fake-IP proxy case).
	await assert.rejects(
		validateRemoteUrl("https://example.test/", { lookup: fakeIpLookup }),
		/Blocked internal address for example\.test: 198\.18\.0\.56/,
	);

	// With allowRanges it passes.
	const url = await validateRemoteUrl("https://example.test/", {
		lookup: fakeIpLookup,
		allowRanges: ["198.18.0.0/15"],
	});
	assert.equal(url.hostname, "example.test");

	// A bare literal IP in the range is also exempted.
	assert.equal((await validateRemoteUrl("http://198.18.0.99/", { allowRanges: ["198.18.0.0/15"] })).hostname, "198.18.0.99");
});

test("allowRanges works for IPv6 ranges", async () => {
	const fakeIp6Lookup = async () => [{ address: "fd00::1", family: 6 }];

	await assert.rejects(
		validateRemoteUrl("https://example.test/", { lookup: fakeIp6Lookup }),
		/Blocked internal address for example\.test: fd00::1/,
	);

	const url = await validateRemoteUrl("https://example.test/", {
		lookup: fakeIp6Lookup,
		allowRanges: ["fd00::/8"],
	});
	assert.equal(url.hostname, "example.test");
});

test("allowRanges does not relax protection outside the listed range", async () => {
	// 10.0.0.1 is private; an unrelated exemption must NOT cover it.
	await assert.rejects(
		validateRemoteUrl("https://example.test/", {
			lookup: async () => [{ address: "10.0.0.1", family: 4 }],
			allowRanges: ["198.18.0.0/15"],
		}),
		/Blocked internal address for example\.test: 10\.0\.0\.1/,
	);

	// Exact /32 boundary: allowed in-range, blocked just outside.
	assert.equal((await validateRemoteUrl("http://198.18.0.0/", { allowRanges: ["198.18.0.0/31"] })).hostname, "198.18.0.0");
	assert.equal((await validateRemoteUrl("http://198.18.0.1/", { allowRanges: ["198.18.0.0/31"] })).hostname, "198.18.0.1");
	await assert.rejects(
		validateRemoteUrl("http://198.18.0.2/", { allowRanges: ["198.18.0.0/31"] }),
		/Blocked internal address/,
	);
});

test("allowRanges accepts a bare host (no prefix) and treats it as /32", async () => {
	assert.equal((await validateRemoteUrl("http://198.18.1.2/", { allowRanges: ["198.18.1.2"] })).hostname, "198.18.1.2");
});

test("allowRanges rejects an empty or non-numeric CIDR prefix instead of treating it as /0", async () => {
	// Regression: a trailing slash with no prefix (e.g. "198.18.0.0/") must NOT
	// become /0, which would exempt every address from the SSRF guard.
	for (const bad of ["198.18.0.0/", "198.18.0.0/ ", "fd00::/", "10.0.0.0/abc", "10.0.0.0/ 8"]) {
		await assert.rejects(
			validateRemoteUrl("http://198.18.0.5/", { allowRanges: [bad] }),
			/Invalid CIDR notation in ssrf\.allowRanges/,
			`${bad} should be rejected`,
		);
	}

	// The dangerous outcome is prevented: a metadata/private IP is not exempted
	// by a malformed "/" entry; the misconfiguration surfaces as an error.
	await assert.rejects(
		validateRemoteUrl("http://169.254.169.254/", { allowRanges: ["198.18.0.0/"] }),
		/Invalid CIDR notation in ssrf\.allowRanges/,
	);
});

test("allowRanges rejects all-address /0 CIDRs", async () => {
	await assert.rejects(
		validateRemoteUrl("http://169.254.169.254/", { allowRanges: ["0.0.0.0/0"] }),
		/Invalid CIDR notation in ssrf\.allowRanges/,
	);
	await assert.rejects(
		validateRemoteUrl("http://[fd00::1]/", { allowRanges: ["::/0"] }),
		/Invalid CIDR notation in ssrf\.allowRanges/,
	);
});

test("invalid allowRanges entries throw a descriptive error", async () => {
	for (const bad of ["not-an-ip", "198.18.0.0/33", "198.18.0.0/-1", "999.0.0.0/8", "fd00::/129"]) {
		await assert.rejects(
			validateRemoteUrl("http://198.18.0.5/", { allowRanges: [bad] }),
			new RegExp(`Invalid CIDR notation in ssrf\.allowRanges: "${bad.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\$&")}"`),
		);
	}
	await assert.rejects(
		validateRemoteUrl("http://198.18.0.5/", { allowRanges: "198.18.0.0/15" }),
		/ssrf\.allowRanges must be an array/,
	);
});

test("allowRanges flows through fetchRemoteUrl and its redirect targets", async () => {
	const requested = [];
	const fetchImpl = async (url) => {
		requested.push(url.toString());
		if (requested.length === 1) {
			return new Response("", { status: 302, headers: { location: "http://198.18.0.99/admin" } });
		}
		return new Response("ok", { status: 200 });
	};

	const response = await fetchRemoteUrl(
		"https://example.com/",
		{},
		{ lookup: publicLookup, fetch: fetchImpl, allowRanges: ["198.18.0.0/15"] },
	);
	assert.equal(response.status, 200);
	assert.deepEqual(requested, ["https://example.com/", "http://198.18.0.99/admin"]);
});
