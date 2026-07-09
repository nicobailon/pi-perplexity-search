import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import type { ExtractedContent } from "./extract.ts";
import type { SearchOptions, SearchResult, SearchResponse } from "./perplexity.ts";
import { getWebSearchConfigPath } from "./utils.ts";

// Bright Data exposes both SERP search and the Web Unlocker (scrape) through a
// single endpoint: POST /request with { url, zone, format, data_format }.
// Structured platform feeds use a separate trigger/poll API — see brightdata-feeds.ts.
const BRIGHTDATA_REQUEST_URL = "https://api.brightdata.com/request";
const CONFIG_PATH = getWebSearchConfigPath();
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_ZONE = "mcp_unlocker";
const MIN_USEFUL_CONTENT = 200;

interface WebSearchConfig {
	brightdataApiKey?: unknown;
	// `brightdataZone` is kept for back-compat and used as the Unlocker zone.
	brightdataZone?: unknown;
	brightdataUnlockerZone?: unknown;
	brightdataSerpZone?: unknown;
}

interface NormalizedDomainFilters {
	allowed: string[];
	blocked: string[];
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

function normalizeString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

export function getBrightDataApiKey(): string | null {
	return normalizeString(process.env.BRIGHTDATA_API_TOKEN)
		?? normalizeString(process.env.BRIGHTDATA_API_KEY)
		?? normalizeString(loadConfig().brightdataApiKey);
}

// Bright Data uses distinct zone types: a Web Unlocker zone for scraping and a
// SERP zone for search. Both flow through POST /request with the zone name.
export function getBrightDataUnlockerZone(): string {
	return normalizeString(process.env.BRIGHTDATA_UNLOCKER_ZONE)
		?? normalizeString(process.env.BRIGHTDATA_ZONE)
		?? normalizeString(loadConfig().brightdataUnlockerZone)
		?? normalizeString(loadConfig().brightdataZone)
		?? DEFAULT_ZONE;
}

// SERP falls back to the Unlocker zone when no dedicated SERP zone is set
// (matches the Bright Data MCP, which routes search through the unlocker zone).
export function getBrightDataSerpZone(): string {
	return normalizeString(process.env.BRIGHTDATA_SERP_ZONE)
		?? normalizeString(loadConfig().brightdataSerpZone)
		?? getBrightDataUnlockerZone();
}

export function isBrightDataAvailable(): boolean {
	return !!getBrightDataApiKey();
}

function missingKeyError(): Error {
	return new Error(
		"Bright Data API token not found. Either:\n" +
		`  1. Create ${CONFIG_PATH} with { "brightdataApiKey": "your-token" }\n` +
		"  2. Set BRIGHTDATA_API_TOKEN environment variable\n" +
		"Get a token at https://brightdata.com/cp/setting/users",
	);
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Shared POST /request call. Returns the raw response body as text so callers
 * can parse JSON (SERP) or use the markdown directly (Unlocker).
 */
async function brightdataRequest(
	body: Record<string, unknown>,
	signal: AbortSignal | undefined,
	query: string,
): Promise<string> {
	const apiKey = getBrightDataApiKey();
	if (!apiKey) throw missingKeyError();

	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const response = await fetch(BRIGHTDATA_REQUEST_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
			signal: requestSignal(signal),
		});

		if (!response.ok) {
			activityMonitor.logError(activityId, `HTTP ${response.status}`);
			const errorText = await response.text();
			throw new Error(`Bright Data request error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		const text = await response.text();
		activityMonitor.logComplete(activityId, response.status);
		return text;
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

function normalizeDomainFilters(domainFilter: string[] | undefined): NormalizedDomainFilters {
	const filters: NormalizedDomainFilters = { allowed: [], blocked: [] };
	if (!domainFilter?.length) return filters;

	for (const raw of domainFilter) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? filters.blocked : filters.allowed;
		if (!target.includes(domain)) target.push(domain);
	}

	return filters;
}

function buildSearchQuery(query: string, filters: NormalizedDomainFilters): string {
	const parts = [query];
	if (filters.allowed.length === 1) {
		parts.push(`site:${filters.allowed[0]}`);
	} else if (filters.allowed.length > 1) {
		parts.push(filters.allowed.map(domain => `site:${domain}`).join(" OR "));
	}
	for (const domain of filters.blocked) {
		parts.push(`-site:${domain}`);
	}
	return parts.join(" ");
}

const RECENCY_TBS: Record<string, string> = {
	day: "qdr:d",
	week: "qdr:w",
	month: "qdr:m",
	year: "qdr:y",
};

function buildGoogleSearchUrl(query: string, options: SearchOptions): string {
	const filters = normalizeDomainFilters(options.domainFilter);
	const params = new URLSearchParams({ q: buildSearchQuery(query, filters) });
	const numResults = normalizeCount(options.numResults);
	// Ask Google for a little headroom so post-filtering still leaves enough.
	params.set("num", String(Math.min(numResults + 5, 20)));
	if (options.recencyFilter && RECENCY_TBS[options.recencyFilter]) {
		params.set("tbs", RECENCY_TBS[options.recencyFilter]);
	}
	return `https://www.google.com/search?${params.toString()}`;
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
	return hostname === domain || hostname.endsWith(`.${domain}`);
}

function matchesDomainFilters(url: string, filters: NormalizedDomainFilters): boolean {
	if (filters.allowed.length === 0 && filters.blocked.length === 0) return true;
	let hostname = "";
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (filters.allowed.length > 0 && !filters.allowed.some(domain => hostMatchesDomain(hostname, domain))) {
		return false;
	}
	return !filters.blocked.some(domain => hostMatchesDomain(hostname, domain));
}

interface GoogleOrganicEntry {
	link?: unknown;
	title?: unknown;
	description?: unknown;
}

/**
 * SERP search via the Bright Data Web Unlocker. Google is returned as parsed
 * JSON (`brd_json=1`), from which we read the `organic` array.
 */
export async function searchWithBrightData(
	query: string,
	options: SearchOptions = {},
): Promise<SearchResponse> {
	const numResults = normalizeCount(options.numResults);
	const filters = normalizeDomainFilters(options.domainFilter);
	const searchUrl = buildGoogleSearchUrl(query, options);

	const raw = await brightdataRequest(
		{
			url: `${searchUrl}&brd_json=1`,
			zone: getBrightDataSerpZone(),
			format: "raw",
			data_format: "parsed_light",
		},
		options.signal,
		`brightdata serp: ${query}`,
	);

	let payload: { organic?: GoogleOrganicEntry[] };
	try {
		payload = JSON.parse(raw) as { organic?: GoogleOrganicEntry[] };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Bright Data returned a non-JSON SERP response: ${message}`);
	}

	const organic = Array.isArray(payload.organic) ? payload.organic : [];
	const results: SearchResult[] = [];
	for (const entry of organic) {
		const url = typeof entry.link === "string" ? entry.link.trim() : "";
		const title = typeof entry.title === "string" ? entry.title.trim() : "";
		if (!url || !title || !matchesDomainFilters(url, filters)) continue;
		const snippet = typeof entry.description === "string" ? entry.description.trim() : "";
		results.push({ title, url, snippet });
		if (results.length >= numResults) break;
	}

	const answer = results
		.map((result) => {
			if (result.snippet) return `${result.snippet}\nSource: ${result.title} (${result.url})`;
			return `Source: ${result.title} (${result.url})`;
		})
		.join("\n\n");

	return { answer, results };
}

function titleFromMarkdown(markdown: string, url: string): string {
	const match = markdown.match(/^#{1,6}\s+(.+)/m);
	if (match) {
		const cleaned = match[1].replace(/[*`]+/g, "").trim();
		if (cleaned) return cleaned;
	}
	try {
		return new URL(url).pathname.split("/").filter(Boolean).pop() || url;
	} catch {
		return url;
	}
}

/**
 * Fetch a page through the Web Unlocker as a fetch_content fallback. Bypasses
 * bot detection / CAPTCHAs that defeat the direct-HTTP and Jina paths. Returns
 * null (never throws) so the caller can fall through to the next extractor.
 */
export async function scrapeWithBrightData(
	url: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	if (!isBrightDataAvailable()) return null;

	try {
		const markdown = await brightdataRequest(
			{
				url,
				zone: getBrightDataUnlockerZone(),
				format: "raw",
				data_format: "markdown",
			},
			signal,
			`brightdata unlocker: ${url}`,
		);

		const trimmed = markdown.trim();
		if (trimmed.length < MIN_USEFUL_CONTENT) return null;

		return { url, title: titleFromMarkdown(trimmed, url), content: trimmed, error: null };
	} catch {
		// Fall through to the next extractor in the chain.
		return null;
	}
}
