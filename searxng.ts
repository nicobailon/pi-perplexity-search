import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.ts";
import { getWebSearchConfigPath } from "./utils.ts";

const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 30_000;

interface WebSearchConfig {
	searxngBaseUrl?: unknown;
}

interface SearXNGResult {
	title?: string;
	url?: string;
	content?: string;
	publishedDate?: string | null;
	engine?: string;
}

interface SearXNGResponse {
	results?: SearXNGResult[];
	infoboxes?: unknown[];
	suggestions?: string[];
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const raw = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = JSON.parse(raw) as WebSearchConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

function normalizeUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim().replace(/\/+$/, "");
	return trimmed.length > 0 ? trimmed : null;
}

function getBaseUrl(): string | null {
	return (
		normalizeUrl(process.env.SEARXNG_BASE_URL) ??
		normalizeUrl(loadConfig().searxngBaseUrl)
	);
}

function normalizeCount(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 5;
	return Math.max(1, Math.min(Math.floor(value), 20));
}

function normalizeDomain(value: string): string | null {
	let input = value.trim().toLowerCase();
	if (!input) return null;
	if (input.startsWith("-")) input = input.slice(1).trim();
	if (!input) return null;
	try {
		const parsed = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
		input = parsed.hostname;
	} catch {
		input = input.split("/")[0]?.split(":")[0] ?? "";
	}
	input = input.replace(/^\.+|\.+$/g, "");
	return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
	return hostname === domain || hostname.endsWith(`.${domain}`);
}

function matchesDomainFilters(url: string, domainFilter: string[] | undefined): boolean {
	if (!domainFilter?.length) return true;
	const includes: string[] = [];
	const excludes: string[] = [];
	for (const raw of domainFilter) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		if (raw.trim().startsWith("-")) excludes.push(domain);
		else includes.push(domain);
	}

	let hostname = "";
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}

	if (includes.length > 0 && !includes.some(d => hostMatchesDomain(hostname, d))) return false;
	return !excludes.some(d => hostMatchesDomain(hostname, d));
}

function buildSearXNGQuery(query: string, domainFilter: string[] | undefined): string {
	if (!domainFilter?.length) return query;
	const includes: string[] = [];
	const excludes: string[] = [];
	for (const raw of domainFilter) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		if (raw.trim().startsWith("-")) excludes.push(domain);
		else includes.push(domain);
	}

	const parts = [query];
	if (includes.length > 0) parts.push(`(${includes.map(d => `site:${d}`).join(" OR ")})`);
	for (const d of excludes) parts.push(`-site:${d}`);
	return parts.join(" ");
}

function mapRecencyFilter(filter: string | undefined): string | undefined {
	if (!filter) return undefined;
	const map: Record<string, string> = {
		day: "day",
		week: "week",
		month: "month",
		year: "year",
	};
	return map[filter];
}

export function isSearXNGConfigured(): boolean {
	return !!getBaseUrl();
}

export async function searchWithSearXNG(
	query: string,
	options: SearchOptions = {},
): Promise<SearchResponse> {
	const baseUrl = getBaseUrl();
	if (!baseUrl) {
		throw new Error(
			"SearXNG base URL not configured. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "searxngBaseUrl": "http://localhost:4000" }\n` +
			"  2. Set SEARXNG_BASE_URL environment variable",
		);
	}

	const numResults = normalizeCount(options.numResults);
	const searchQuery = buildSearXNGQuery(query, options.domainFilter);
	const activityId = activityMonitor.logStart({ type: "api", query: searchQuery });

	const params = new URLSearchParams({
		q: searchQuery,
		format: "json",
		language: "en",
		categories: "general",
	});

	const recency = mapRecencyFilter(options.recencyFilter);
	if (recency) params.set("time_range", recency);

	try {
		const response = await fetch(`${baseUrl}/search?${params.toString()}`, {
			method: "GET",
			headers: {
				"Accept": "application/json",
			},
			signal: options.signal
				? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), options.signal])
				: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		});

		if (!response.ok) {
			activityMonitor.logError(activityId, `HTTP ${response.status}`);
			const errorText = await response.text();
			throw new Error(`SearXNG error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		const data = (await response.json()) as SearXNGResponse;
		activityMonitor.logComplete(activityId, response.status);

		const results: SearchResult[] = [];
		for (const item of data.results ?? []) {
			if (!item.url) continue;
			if (!matchesDomainFilters(item.url, options.domainFilter)) continue;
			results.push({
				title: item.title || item.url,
				url: item.url,
				snippet: item.content || "",
			});
			if (results.length >= numResults) break;
		}

		const answer = results
			.map(r => r.snippet ? `${r.snippet}\nSource: ${r.title} (${r.url})` : `Source: ${r.title} (${r.url})`)
			.join("\n\n");

		return { answer, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}
