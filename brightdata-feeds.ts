import { activityMonitor } from "./activity.ts";
import type { ExtractedContent } from "./extract.ts";
import { getBrightDataApiKey, isBrightDataAvailable } from "./brightdata.ts";

// Bright Data structured "web_data_*" feeds are async snapshot jobs: POST a
// trigger with the input URL, receive a snapshot_id, then poll until the
// snapshot is ready. Unlike search/scrape (synchronous), these can take from a
// few seconds to a minute — so we cap the wait and fall through to normal
// extraction if it does not resolve in time.
const TRIGGER_URL = "https://api.brightdata.com/datasets/v3/trigger";
const SNAPSHOT_URL = "https://api.brightdata.com/datasets/v3/snapshot";

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Overridable via env primarily as a test seam (mirrors the Bright Data MCP's
// POLLING_TIMEOUT). Defaults are tuned for real snapshot latency.
const POLL_INTERVAL_MS = envInt("BRIGHTDATA_POLL_INTERVAL_MS", 2_000);
const POLL_TIMEOUT_MS = envInt("BRIGHTDATA_POLL_TIMEOUT_MS", 90_000);
const REQUEST_TIMEOUT_MS = 30_000;
const PENDING_STATUSES = new Set(["running", "building", "collecting", "pending", "scheduled"]);

/**
 * One row per supported platform. This is the extensible "socket": adding any
 * of Bright Data's other ~40 structured feeds is a single entry here — a
 * dataset id plus a URL pattern — with no other code changes. dataset ids are
 * Bright Data's stable identifiers (see their MCP `datasets` list).
 */
export interface FeedDefinition {
	/** Stable slug, matching Bright Data's dataset short id. */
	id: string;
	/** Bright Data dataset id (gd_...). */
	datasetId: string;
	/** Human-readable label used as the extracted title. */
	label: string;
	/** URL pattern that routes a fetch to this feed. */
	match: RegExp;
	/**
	 * Build the trigger input payload from the URL. Datasets have different
	 * required fields (most take `{ url }`, but npm/PyPI take `{ package_name }`),
	 * so each feed maps its own. Returns null when the URL lacks what the dataset
	 * needs, in which case the caller falls through to normal extraction.
	 */
	buildInput: (url: string) => Record<string, unknown> | null;
}

const urlInput = (url: string): Record<string, unknown> => ({ url });

function npmPackageInput(url: string): Record<string, unknown> | null {
	const match = url.match(/npmjs\.com\/package\/([^?#]+)/i);
	if (!match) return null;
	// Handle scoped packages (@scope/name) and strip any /v/<version> suffix.
	const name = decodeURIComponent(match[1].replace(/\/v\/.*$/, "").replace(/\/+$/, ""));
	return name ? { package_name: name } : null;
}

function pypiPackageInput(url: string): Record<string, unknown> | null {
	const match = url.match(/pypi\.org\/project\/([^/?#]+)/i);
	return match ? { package_name: decodeURIComponent(match[1]) } : null;
}

export const BRIGHTDATA_FEEDS: FeedDefinition[] = [
	{
		id: "amazon_product",
		datasetId: "gd_l7q7dkf244hwjntr0",
		label: "Amazon product (structured)",
		match: /^https?:\/\/(?:www\.)?amazon\.[a-z.]+\/(?:[^?#]*\/)?dp\/[A-Z0-9]/i,
		buildInput: urlInput,
	},
	{
		id: "reddit_posts",
		datasetId: "gd_lvz8ah06191smkebj4",
		label: "Reddit post (structured)",
		match: /^https?:\/\/(?:www\.)?reddit\.com\/r\/[^/]+\/comments\//i,
		buildInput: urlInput,
	},
	{
		id: "npm_package",
		datasetId: "gd_mk57m0301khq4jmsul",
		label: "npm package (structured)",
		match: /^https?:\/\/(?:www\.)?npmjs\.com\/package\//i,
		buildInput: npmPackageInput,
	},
	{
		id: "pypi_package",
		datasetId: "gd_mk57kc3t1wwgmnepp9",
		label: "PyPI package (structured)",
		match: /^https?:\/\/pypi\.org\/project\//i,
		buildInput: pypiPackageInput,
	},
	{
		// github handling in extract.ts (clone) runs first and is preferred; this
		// row documents the mapping and acts as a fallback only if that path is
		// ever disabled. It also demonstrates how a "code" feed plugs in.
		id: "github_repository_file",
		datasetId: "gd_lyrexgxc24b3d4imjt",
		label: "GitHub repository file (structured)",
		match: /^https?:\/\/github\.com\/[^/]+\/[^/]+\/blob\//i,
		buildInput: urlInput,
	},
];

/** Return the feed whose URL pattern matches, or null. */
export function detectBrightDataFeed(url: string): FeedDefinition | null {
	for (const feed of BRIGHTDATA_FEEDS) {
		if (feed.match.test(url)) return feed;
	}
	return null;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("Aborted"));
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function formatFeedData(feed: FeedDefinition, url: string, records: unknown): string {
	const pretty = JSON.stringify(records, null, 2);
	return [
		`# ${feed.label}`,
		`Source: ${url}`,
		`Dataset: ${feed.datasetId}`,
		"",
		"```json",
		pretty,
		"```",
	].join("\n");
}

/**
 * Trigger a feed snapshot for a URL and poll until it is ready. Returns null
 * (never throws) on any failure or timeout so the caller falls through to the
 * normal extraction chain.
 */
export async function fetchBrightDataFeed(
	url: string,
	feed: FeedDefinition,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	const apiKey = getBrightDataApiKey();
	if (!apiKey) return null;

	const input = feed.buildInput(url);
	if (!input) return null;

	const headers = {
		"Content-Type": "application/json",
		"Authorization": `Bearer ${apiKey}`,
	};
	const activityId = activityMonitor.logStart({ type: "api", query: `brightdata feed ${feed.id}: ${url}` });

	try {
		const triggerRes = await fetch(
			`${TRIGGER_URL}?dataset_id=${encodeURIComponent(feed.datasetId)}&include_errors=true`,
			{
				method: "POST",
				headers,
				body: JSON.stringify([input]),
				signal: requestSignal(signal),
			},
		);
		if (!triggerRes.ok) {
			activityMonitor.logError(activityId, `trigger HTTP ${triggerRes.status}`);
			return null;
		}

		const triggerData = await triggerRes.json() as { snapshot_id?: string };
		const snapshotId = triggerData?.snapshot_id;
		if (!snapshotId) {
			activityMonitor.logError(activityId, "no snapshot_id");
			return null;
		}

		const deadline = Date.now() + POLL_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (signal?.aborted) return null;
			await delay(POLL_INTERVAL_MS, signal);

			const snapshotRes = await fetch(
				`${SNAPSHOT_URL}/${encodeURIComponent(snapshotId)}?format=json`,
				{ method: "GET", headers, signal: requestSignal(signal) },
			);

			// 202 = snapshot still building.
			if (snapshotRes.status === 202) continue;
			if (!snapshotRes.ok) {
				activityMonitor.logError(activityId, `snapshot HTTP ${snapshotRes.status}`);
				return null;
			}

			const data = await snapshotRes.json() as unknown;
			const status = (data && typeof data === "object" && !Array.isArray(data))
				? (data as { status?: unknown }).status
				: undefined;
			if (typeof status === "string" && PENDING_STATUSES.has(status.toLowerCase())) continue;

			activityMonitor.logComplete(activityId, snapshotRes.status);
			return { url, title: feed.label, content: formatFeedData(feed, url, data), error: null };
		}

		activityMonitor.logError(activityId, "poll timeout");
		return null;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}
