import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.ts";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import { getWebSearchConfigPath } from "./utils.ts";

const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;
const EXTRACT_TIMEOUT_MS = 60_000;

interface WebSearchConfig {
	firecrawlBaseUrl?: unknown;
	firecrawlApiKey?: unknown;
}

interface FirecrawlSearchData {
	title?: string;
	url?: string;
	description?: string;
}

interface FirecrawlSearchResponse {
	success: boolean;
	data?: FirecrawlSearchData[];
	error?: string;
}

interface FirecrawlScrapeMetadata {
	title?: string;
	sourceURL?: string;
	[key: string]: unknown;
}

interface FirecrawlScrapeData {
	title?: string;
	url?: string;
	markdown?: string;
	metadata?: FirecrawlScrapeMetadata;
}

interface FirecrawlScrapeResponse {
	success?: boolean;
	data?: FirecrawlScrapeData;
	error?: string;
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

function normalizeApiKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function getBaseUrl(): string | null {
	return (
		normalizeUrl(process.env.FIRECRAWL_BASE_URL) ??
		normalizeUrl(loadConfig().firecrawlBaseUrl)
	);
}

/** Build headers for Firecrawl API calls, optionally with API key or HTTP Basic auth. */
function buildHeaders(): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };

	// API key takes precedence (Firecrawl v1)
	const apiKey = normalizeApiKey(process.env.FIRECRAWL_API_KEY) ?? normalizeApiKey(loadConfig().firecrawlApiKey);
	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`;
		return headers;
	}

	// HTTP Basic Auth fallback (for reverse-proxy setups, FIRECRAWL_BASIC_AUTH=user:pass)
	const basicAuth = normalizeApiKey(process.env.FIRECRAWL_BASIC_AUTH);
	if (basicAuth) {
		headers["Authorization"] = "Basic " + Buffer.from(basicAuth).toString("base64");
	}

	return headers;
}

function normalizeCount(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 5;
	return Math.max(1, Math.min(Math.floor(value), 20));
}

function hostMatches(host: string, domain: string): boolean {
	const h = host.toLowerCase();
	const d = domain.toLowerCase().replace(/^\.+/, "");
	return h === d || h.endsWith("." + d);
}

function applyDomainFilter(
	results: SearchResult[],
	includeDomains?: string[],
	excludeDomains?: string[],
): SearchResult[] {
	if (!includeDomains?.length && !excludeDomains?.length) return results;
	return results.filter(r => {
		let host: string | null = null;
		try { host = new URL(r.url).hostname; } catch { /* unparseable URL */ }
		if (includeDomains?.length && !(host && includeDomains.some(d => hostMatches(host!, d)))) return false;
		if (excludeDomains?.length && host && excludeDomains.some(d => hostMatches(host!, d))) return false;
		return true;
	});
}

/** Pick the first non-empty metadata value across candidate keys. */
function pickMeta(
	meta: Record<string, unknown> | undefined,
	keys: string[],
): string | undefined {
	if (!meta) return undefined;
	for (const k of keys) {
		const v = meta[k];
		if (typeof v === "string" && v.trim()) return v;
		if (Array.isArray(v) && typeof v[0] === "string" && v[0].trim()) return v[0];
	}
	return undefined;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Determine include/exclude domains from the SearchOptions-style domainFilter. */
function parseDomainFilter(domainFilter: string[] | undefined): { include_domains: string[]; exclude_domains: string[] } {
	const include_domains: string[] = [];
	const exclude_domains: string[] = [];
	if (!domainFilter?.length) return { include_domains, exclude_domains };
	for (const raw of domainFilter) {
		const domain = raw.trim().toLowerCase().replace(/^-/, "").replace(/^\.+|\.+$/g, "");
		if (!domain || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(domain)) continue;
		if (raw.trim().startsWith("-")) exclude_domains.push(domain);
		else include_domains.push(domain);
	}
	return { include_domains, exclude_domains };
}

// ─── Search ───

export function isFirecrawlConfigured(): boolean {
	return !!getBaseUrl();
}

export async function searchWithFirecrawl(
	query: string,
	options: SearchOptions = {},
): Promise<SearchResponse> {
	const baseUrl = getBaseUrl();
	if (!baseUrl) {
		throw new Error(
			"Firecrawl base URL not configured. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "firecrawlBaseUrl": "http://localhost:3002" }\n` +
			"  2. Set FIRECRAWL_BASE_URL environment variable",
		);
	}

	const numResults = normalizeCount(options.numResults);
	const { include_domains, exclude_domains } = parseDomainFilter(options.domainFilter);
	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const response = await fetch(`${baseUrl}/v1/search`, {
			method: "POST",
			headers: buildHeaders(),
			body: JSON.stringify({
				query,
				limit: numResults,
				scrapeOptions: { formats: [] },
			}),
			signal: options.signal
				? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), options.signal])
				: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		});

		if (!response.ok) {
			activityMonitor.logError(activityId, `HTTP ${response.status}`);
			const errorText = await response.text();
			throw new Error(`Firecrawl search error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		const data = (await response.json()) as FirecrawlSearchResponse;
		activityMonitor.logComplete(activityId, response.status);

		if (!data.success) {
			throw new Error(`Firecrawl search unsuccessful: ${data.error ?? "unknown error"}`);
		}

		let results: SearchResult[] = (data.data ?? []).slice(0, numResults).map(d => ({
			title: d.title ?? "",
			url: d.url ?? "",
			snippet: d.description ?? "",
		}));

		results = applyDomainFilter(results, include_domains, exclude_domains);

		const answer = results
			.map(r => r.snippet ? `${r.snippet}\nSource: ${r.title} (${r.url})` : `Source: ${r.title} (${r.url})`)
			.join("\n\n");

		return { answer, results };
	} catch (err) {
		const message = errorMessage(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

// ─── Content Extraction ───

/**
 * Extract content from a URL using Firecrawl's /v1/scrape endpoint.
 * Returns null when Firecrawl is not configured or the page can't be scraped.
 */
export async function extractWithFirecrawl(
	url: string,
	signal?: AbortSignal,
	options?: Pick<ExtractOptions, "timeoutMs">,
): Promise<ExtractedContent | null> {
	const baseUrl = getBaseUrl();
	if (!baseUrl) return null;

	const timeoutMs = options?.timeoutMs ?? EXTRACT_TIMEOUT_MS;
	const activityId = activityMonitor.logStart({ type: "api", query: `fc-scrape: ${url}` });

	try {
		const response = await fetch(`${baseUrl}/v1/scrape`, {
			method: "POST",
			headers: buildHeaders(),
			body: JSON.stringify({
				url,
				formats: ["markdown"],
			}),
			signal: AbortSignal.any([
				AbortSignal.timeout(timeoutMs),
				...(signal ? [signal] : []),
			]),
		});

		if (!response.ok) {
			activityMonitor.logComplete(activityId, response.status);
			return null;
		}

		const data = (await response.json()) as FirecrawlScrapeResponse;

		if (data.success === false) {
			activityMonitor.logComplete(activityId, 200);
			return null;
		}

		const doc = data.data;
		if (!doc) {
			activityMonitor.logComplete(activityId, 200);
			return null;
		}

		const rawContent = doc.markdown ?? "";
		if (!rawContent.trim()) {
			activityMonitor.logComplete(activityId, 200);
			return null;
		}

		const title = doc.metadata?.title ?? doc.title ?? "";
		const author = pickMeta(doc.metadata, ["author", "article:author", "dc.creator", "parsely-author"]);
		const publishedDate = pickMeta(doc.metadata, ["publishedTime", "article:published_time", "date"]);

		let content = rawContent;
		const wordCount = rawContent.split(/\s+/).filter(Boolean).length;

		activityMonitor.logComplete(activityId, response.status);

		return {
			url,
			title,
			content,
			error: null,
		};
	} catch (err) {
		const message = errorMessage(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}
