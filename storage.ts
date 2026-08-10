import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtractedContent } from "./extract.ts";
import type { SearchResult } from "./perplexity.ts";
import { getWebSearchConfigDir } from "./utils.ts";

const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_CACHE_DIR = "web-search-cache";
const FETCH_CACHE_VERSION = 1;
const CACHE_KEY_PATTERN = /^[A-Za-z0-9_-]+\.json$/;
const CACHE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_METADATA_TEXT = 8192;

export interface QueryResultData {
	query: string;
	answer: string;
	results: SearchResult[];
	error: string | null;
	provider?: string;
}

interface FetchCacheRef {
	version: typeof FETCH_CACHE_VERSION;
	key: string;
	storedAt: number;
}

interface StoredFetchUrlMetadata {
	url: string;
	title: string;
	error: string | null;
	contentLength: number;
	mimeType?: string;
	status?: number;
	duration?: number;
}

export interface StoredSearchData {
	id: string;
	type: "search" | "fetch" | "research";
	timestamp: number;
	queries?: QueryResultData[];
	urls?: ExtractedContent[];
	artifact?: unknown;
	fetchCache?: FetchCacheRef;
	urlMetadata?: StoredFetchUrlMetadata[];
	fetchCacheError?: string;
}

const storedResults = new Map<string, StoredSearchData>();

export function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function getFetchCacheDir(): string {
	return join(getWebSearchConfigDir(), FETCH_CACHE_DIR);
}

function fetchCachePath(key: string): string | null {
	if (!CACHE_KEY_PATTERN.test(key)) return null;
	return join(getFetchCacheDir(), key);
}

function cacheKeyForId(id: string): string {
	if (!CACHE_ID_PATTERN.test(id)) {
		throw new Error(`Invalid fetched content cache id: ${id}`);
	}
	return `${id}.json`;
}

function truncateMetadataText(value: string | undefined): string {
	if (!value) return "";
	return value.length > MAX_METADATA_TEXT ? `${value.slice(0, MAX_METADATA_TEXT)}...` : value;
}

function metadataForUrls(urls: ExtractedContent[]): StoredFetchUrlMetadata[] {
	return urls.map((url) => ({
		url: truncateMetadataText(url.url),
		title: truncateMetadataText(url.title),
		error: url.error ? truncateMetadataText(url.error) : null,
		contentLength: url.content.length,
		...(url.mimeType ? { mimeType: truncateMetadataText(url.mimeType) } : {}),
		...(typeof url.status === "number" ? { status: url.status } : {}),
		...(typeof url.duration === "number" ? { duration: url.duration } : {}),
	}));
}

function isFetchCacheRef(value: unknown): value is FetchCacheRef {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const ref = value as Record<string, unknown>;
	return ref.version === FETCH_CACHE_VERSION &&
		typeof ref.key === "string" && CACHE_KEY_PATTERN.test(ref.key) &&
		typeof ref.storedAt === "number" && Number.isFinite(ref.storedAt);
}

function isStoredFetchUrlMetadata(value: unknown): value is StoredFetchUrlMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const meta = value as Record<string, unknown>;
	return typeof meta.url === "string" &&
		typeof meta.title === "string" &&
		(meta.error === null || typeof meta.error === "string") &&
		typeof meta.contentLength === "number" && Number.isFinite(meta.contentLength) && meta.contentLength >= 0 &&
		(meta.mimeType === undefined || typeof meta.mimeType === "string") &&
		(meta.status === undefined || typeof meta.status === "number") &&
		(meta.duration === undefined || typeof meta.duration === "number");
}

function isInlineFetchedUrl(value: unknown): value is ExtractedContent {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const url = value as Record<string, unknown>;
	return typeof url.url === "string" &&
		typeof url.title === "string" &&
		typeof url.content === "string" &&
		(url.error === null || typeof url.error === "string");
}

function isInlineFetchData(data: StoredSearchData): data is StoredSearchData & { urls: ExtractedContent[] } {
	return data.type === "fetch" && Array.isArray(data.urls) && data.urls.every(isInlineFetchedUrl);
}

function writeFetchCache(data: StoredSearchData & { urls: ExtractedContent[] }): FetchCacheRef {
	const dir = getFetchCacheDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const key = cacheKeyForId(data.id);
	const finalPath = join(dir, key);
	const tmpPath = join(dir, `${key}.${process.pid}.${Date.now()}.tmp`);
	try {
		writeFileSync(tmpPath, JSON.stringify(data), { mode: 0o600 });
		renameSync(tmpPath, finalPath);
	} catch (err) {
		try { unlinkSync(tmpPath); } catch {}
		throw err;
	}
	return { version: FETCH_CACHE_VERSION, key, storedAt: Date.now() };
}

function cacheWriteError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return `Failed to write fetched content cache: ${message}`;
}

function createFetchSessionData(data: StoredSearchData & { urls: ExtractedContent[] }, ref: FetchCacheRef | null, cacheError?: string): StoredSearchData {
	return {
		id: data.id,
		type: "fetch",
		timestamp: data.timestamp,
		urlMetadata: metadataForUrls(data.urls),
		...(ref ? { fetchCache: ref } : {}),
		...(cacheError ? { fetchCacheError: truncateMetadataText(cacheError) } : {}),
	};
}

function fetchUrlMetadata(data: StoredSearchData): StoredFetchUrlMetadata[] {
	if (data.urlMetadata) return data.urlMetadata;
	return isInlineFetchData(data) ? metadataForUrls(data.urls) : [];
}

function unavailableFetchData(data: StoredSearchData, reason: string): StoredSearchData {
	return {
		...data,
		urls: fetchUrlMetadata(data).map((meta) => ({
			url: meta.url,
			title: meta.title,
			content: "",
			error: reason,
			...(meta.mimeType ? { mimeType: meta.mimeType } : {}),
			...(typeof meta.status === "number" ? { status: meta.status } : {}),
			...(typeof meta.duration === "number" ? { duration: meta.duration } : {}),
		})),
	};
}

function readCachedFetchData(data: StoredSearchData, now = Date.now()): StoredSearchData {
	if (data.type !== "fetch") return data;
	if (now - data.timestamp >= CACHE_TTL_MS) {
		return unavailableFetchData(data, "Cached fetched content is missing or expired");
	}
	if (isInlineFetchData(data)) return data;
	if (!data.fetchCache) {
		return unavailableFetchData(data, data.fetchCacheError ?? "Cached fetched content is unavailable");
	}
	const path = fetchCachePath(data.fetchCache.key);
	if (!path || !existsSync(path)) {
		return unavailableFetchData(data, "Cached fetched content is missing or expired");
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!isValidStoredData(parsed) || parsed.type !== "fetch" || parsed.id !== data.id || !isInlineFetchData(parsed)) {
			return unavailableFetchData(data, "Cached fetched content is invalid");
		}
		return { ...parsed, fetchCache: data.fetchCache, urlMetadata: data.urlMetadata };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return unavailableFetchData(data, `Cached fetched content could not be read: ${message}`);
	}
}

export function pruneExpiredFetchCache(now = Date.now()): void {
	const dir = getFetchCacheDir();
	if (!existsSync(dir)) return;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!CACHE_KEY_PATTERN.test(entry)) continue;
		const path = join(dir, entry);
		try {
			if (now - statSync(path).mtimeMs >= CACHE_TTL_MS) unlinkSync(path);
		} catch {}
	}
}

export function storeResult(id: string, data: StoredSearchData): void {
	storedResults.set(id, data);
}

export function storeFetchedContentResult(id: string, data: StoredSearchData & { type: "fetch"; urls: ExtractedContent[] }): StoredSearchData {
	pruneExpiredFetchCache();
	let ref: FetchCacheRef | null = null;
	let cacheError: string | undefined;
	try {
		ref = writeFetchCache(data);
	} catch (err) {
		cacheError = cacheWriteError(err);
	}
	storedResults.set(id, ref ? { ...data, fetchCache: ref, urlMetadata: metadataForUrls(data.urls) } : { ...data, fetchCacheError: cacheError });
	return createFetchSessionData(data, ref, cacheError);
}

export function getResult(id: string): StoredSearchData | null {
	const data = storedResults.get(id);
	if (!data) return null;
	const loaded = readCachedFetchData(data);
	if (loaded !== data) storedResults.set(id, loaded);
	return loaded;
}

export function getAllResults(): StoredSearchData[] {
	return Array.from(storedResults.values());
}

export function deleteResult(id: string): boolean {
	const data = storedResults.get(id);
	if (data?.fetchCache) {
		const path = fetchCachePath(data.fetchCache.key);
		if (path) try { unlinkSync(path); } catch {}
	}
	return storedResults.delete(id);
}

export function clearResults(): void {
	storedResults.clear();
}

function isValidStoredData(data: unknown): data is StoredSearchData {
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	if (typeof d.id !== "string" || !d.id) return false;
	if (d.type !== "search" && d.type !== "fetch" && d.type !== "research") return false;
	if (typeof d.timestamp !== "number") return false;
	if (d.type === "search" && !Array.isArray(d.queries)) return false;
	if (d.type === "fetch") {
		if (Array.isArray(d.urls)) return d.urls.every(isInlineFetchedUrl);
		if (!Array.isArray(d.urlMetadata) || !d.urlMetadata.every(isStoredFetchUrlMetadata)) return false;
		return d.fetchCache === undefined ? d.fetchCacheError === undefined || typeof d.fetchCacheError === "string" : isFetchCacheRef(d.fetchCache);
	}
	if (d.type === "research" && (!d.artifact || typeof d.artifact !== "object")) return false;
	return true;
}

export function restoreFromSession(ctx: ExtensionContext): void {
	storedResults.clear();
	const now = Date.now();
	pruneExpiredFetchCache(now);

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === "web-search-results") {
			const data = entry.data;
			if (isValidStoredData(data) && now - data.timestamp < CACHE_TTL_MS) {
				storedResults.set(data.id, data);
			}
		}
	}
}
