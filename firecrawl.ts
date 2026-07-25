import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import type { SearchOptions, SearchResult, SearchResponse } from "./perplexity.ts";
import { fetchRemoteUrl, loadSsrfConfig, validateRemoteUrl } from "./ssrf-protection.ts";
import { getWebSearchConfigPath } from "./utils.ts";

const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;
const EXTRACT_TIMEOUT_MS = 60_000;
const DEFAULT_API_VERSION = "v2";
const SUPPORTED_API_VERSIONS = ["v1", "v2"] as const;

type FirecrawlApiVersion = (typeof SUPPORTED_API_VERSIONS)[number];

export type FirecrawlExtractOptions = Pick<ExtractOptions, "timeoutMs" | "lookup">;

interface WebSearchConfig {
	firecrawlBaseUrl?: unknown;
	firecrawlApiKey?: unknown;
	firecrawlApiVersion?: unknown;
}

interface NormalizedDomainFilters {
	allowed: string[];
	blocked: string[];
}

interface FirecrawlSearchItem {
	title?: unknown;
	url?: unknown;
	description?: unknown;
}

interface FirecrawlScrapeMetadata {
	title?: unknown;
	sourceURL?: unknown;
	[key: string]: unknown;
}

interface FirecrawlScrapeData {
	title?: unknown;
	markdown?: unknown;
	metadata?: FirecrawlScrapeMetadata;
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

export function clearFirecrawlConfigCache(): void {
	cachedConfig = null;
}

function normalizeBaseUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.pathname = url.pathname.replace(/\/+$/, "");
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/+$/, "");
	} catch {
		return null;
	}
}

function normalizeApiKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function getBaseUrl(): string | null {
	return (
		normalizeBaseUrl(process.env.FIRECRAWL_BASE_URL) ??
		normalizeBaseUrl(loadConfig().firecrawlBaseUrl)
	);
}

function requireBaseUrl(): string {
	const baseUrl = getBaseUrl();
	if (!baseUrl) {
		throw new Error(
			"Firecrawl base URL not configured. Either:\n" +
			`  1. Set firecrawlBaseUrl in ${CONFIG_PATH} (e.g. { "firecrawlBaseUrl": "http://127.0.0.1:3002" })\n` +
			"  2. Set FIRECRAWL_BASE_URL environment variable",
		);
	}
	return baseUrl;
}

/** Resolve the Firecrawl API version. Mistyped values throw rather than silently
 *  falling back, so a typo does not quietly hit the wrong endpoint. */
function getApiVersion(): FirecrawlApiVersion {
	const raw = process.env.FIRECRAWL_API_VERSION ?? loadConfig().firecrawlApiVersion;
	if (raw === undefined || raw === null) return DEFAULT_API_VERSION;
	if (typeof raw !== "string") {
		throw new Error(`firecrawlApiVersion in ${CONFIG_PATH} must be a string ("v1" or "v2")`);
	}
	const normalized = raw.trim().toLowerCase();
	if (!normalized) return DEFAULT_API_VERSION;
	if (!SUPPORTED_API_VERSIONS.includes(normalized as FirecrawlApiVersion)) {
		throw new Error(`Unsupported Firecrawl API version "${raw}". Supported versions: ${SUPPORTED_API_VERSIONS.join(", ")}`);
	}
	return normalized as FirecrawlApiVersion;
}

/** Bearer auth via FIRECRAWL_API_KEY / firecrawlApiKey. Self-hosted instances
 *  commonly run without auth, so the header is omitted when no key is set. */
function buildHeaders(): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	const key =
		normalizeApiKey(process.env.FIRECRAWL_API_KEY) ??
		normalizeApiKey(loadConfig().firecrawlApiKey);
	if (key) headers["Authorization"] = `Bearer ${key}`;
	return headers;
}

function normalizeCount(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 5;
	return Math.max(1, Math.min(Math.floor(value), 20));
}

/** Firecrawl passes `tbs` through to the search backend using Google's syntax. */
const RECENCY_TO_TBS: Record<string, string> = {
	day: "qdr:d",
	week: "qdr:w",
	month: "qdr:m",
	year: "qdr:y",
};

function recencyToTbs(filter: string | undefined): string | undefined {
	if (!filter) return undefined;
	return RECENCY_TO_TBS[filter.trim().toLowerCase()];
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
	if (filters.allowed.length > 0 && !filters.allowed.some(d => hostMatchesDomain(hostname, d))) return false;
	return !filters.blocked.some(d => hostMatchesDomain(hostname, d));
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/** POST to a Firecrawl endpoint and return the parsed envelope. Every failure —
 *  transport, HTTP status, malformed JSON, `success: false` — throws, so callers
 *  can report a real reason instead of an unexplained empty result. */
async function firecrawlFetch(
	endpoint: string,
	body: Record<string, unknown>,
	activity: { type: "api"; query: string },
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const url = `${requireBaseUrl()}/${getApiVersion()}/${endpoint}`;
	const activityId = activityMonitor.logStart(activity);

	let response: Response;
	try {
		response = await fetchRemoteUrl(url, {
			method: "POST",
			headers: buildHeaders(),
			body: JSON.stringify(body),
			signal: requestSignal(timeoutMs, signal),
		}, loadSsrfConfig());
	} catch (err) {
		if (isAbortError(err)) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, errorMessage(err));
		throw err;
	}

	if (!response.ok) {
		activityMonitor.logError(activityId, `HTTP ${response.status}`);
		const errorText = await response.text().catch(() => "");
		throw new Error(`Firecrawl ${endpoint} error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	let data: unknown;
	try {
		data = await response.json();
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`Firecrawl ${endpoint} returned invalid JSON: ${errorMessage(err)}`);
	}

	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`Firecrawl ${endpoint} returned an unexpected response shape`);
	}

	const envelope = data as Record<string, unknown>;
	if (envelope.success === false) {
		activityMonitor.logError(activityId, asString(envelope.error) ?? "unknown error");
		throw new Error(`Firecrawl ${endpoint} unsuccessful: ${asString(envelope.error) ?? "unknown error"}`);
	}

	activityMonitor.logComplete(activityId, response.status);
	return envelope;
}

// ─── Search ───

export function isFirecrawlAvailable(): boolean {
	if (!getBaseUrl()) return false;
	loadSsrfConfig(); // fail loud on malformed ssrf config rather than at request time
	return true;
}

/** v1 returns `data: [...]`; v2 returns `data: { web: [...], news: [...] }`. */
function collectSearchItems(data: unknown): FirecrawlSearchItem[] {
	if (Array.isArray(data)) return data as FirecrawlSearchItem[];
	if (typeof data !== "object" || data === null) return [];
	const items: FirecrawlSearchItem[] = [];
	for (const key of ["web", "news"]) {
		const bucket = (data as Record<string, unknown>)[key];
		if (Array.isArray(bucket)) items.push(...(bucket as FirecrawlSearchItem[]));
	}
	return items;
}

export async function searchWithFirecrawl(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const numResults = normalizeCount(options.numResults);
	const domainFilters = normalizeDomainFilters(options.domainFilter);
	const tbs = recencyToTbs(options.recencyFilter);
	const version = getApiVersion();

	const body: Record<string, unknown> = {
		query,
		limit: numResults,
		scrapeOptions: { formats: [] },
		...(tbs ? { tbs } : {}),
	};
	if (version === "v2") {
		body.sources = [{ type: "web" }];
		if (domainFilters.allowed.length) body.includeDomains = domainFilters.allowed;
		if (domainFilters.blocked.length) body.excludeDomains = domainFilters.blocked;
	}

	const envelope = await firecrawlFetch("search", body, { type: "api", query }, SEARCH_TIMEOUT_MS, options.signal);

	const results: SearchResult[] = [];
	for (const item of collectSearchItems(envelope.data)) {
		const url = asString(item.url);
		// Also applied client-side: v1 has no domain-filter parameters, and self-hosted
		// search backends do not always honour the v2 ones.
		if (!url || !matchesDomainFilters(url, domainFilters)) continue;
		results.push({
			title: asString(item.title) ?? "",
			url,
			snippet: asString(item.description) ?? "",
		});
		if (results.length >= numResults) break;
	}

	const answer = results
		.map(r => r.snippet ? `${r.snippet}\nSource: ${r.title} (${r.url})` : `Source: ${r.title} (${r.url})`)
		.join("\n\n");

	return { answer, results };
}

// ─── Content Extraction ───

/**
 * Extract a URL through Firecrawl's scrape endpoint (Playwright-rendered Markdown).
 *
 * The target is SSRF-validated here as well as in `extractContent`, because
 * Firecrawl fetches server-side: handing it a private URL would launder the
 * target past the local guard. The Firecrawl instance's own URL and redirects
 * are guarded too, so a private instance needs its range in `ssrf.allowRanges`
 * — same contract as SearXNG.
 *
 * Returns `null` only when the scrape produced no usable Markdown; every real
 * failure throws so the caller can report why this fallback did not work.
 */
export async function extractWithFirecrawl(
	url: string,
	signal?: AbortSignal,
	options?: FirecrawlExtractOptions,
): Promise<ExtractedContent | null> {
	requireBaseUrl();
	const ssrf = loadSsrfConfig();
	await validateRemoteUrl(url, {
		allowRanges: ssrf.allowRanges,
		trustEnvProxy: ssrf.trustEnvProxy,
		...(options?.lookup ? { lookup: options.lookup } : {}),
	});

	const envelope = await firecrawlFetch(
		"scrape",
		{ url, formats: ["markdown"], onlyMainContent: true },
		{ type: "api", query: `fc-scrape: ${url}` },
		options?.timeoutMs ?? EXTRACT_TIMEOUT_MS,
		signal,
	);

	const doc = envelope.data as FirecrawlScrapeData | undefined;
	const content = asString(doc?.markdown);
	if (!content) return null;

	return {
		url,
		title: asString(doc?.metadata?.title) ?? asString(doc?.title) ?? "",
		content,
		error: null,
	};
}
