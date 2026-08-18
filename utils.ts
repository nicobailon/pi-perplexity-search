import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export function getWebSearchConfigDir(): string {
	if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
	if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "pi");
	return join(homedir(), ".pi");
}

export function getWebSearchConfigPath(): string {
	return join(getWebSearchConfigDir(), "web-search.json");
}

interface ApiBaseUrlOptions {
	configKey: string;
	configuredValue: unknown;
	defaultValue: string;
	environmentKey: string;
	environmentValue: string | undefined;
}

export function resolveApiBaseUrl(options: ApiBaseUrlOptions): string {
	const fromEnvironment = options.environmentValue !== undefined;
	const value = fromEnvironment ? options.environmentValue : options.configuredValue;
	if (value === undefined) return options.defaultValue;

	const source = fromEnvironment
		? options.environmentKey
		: `${options.configKey} in ${getWebSearchConfigPath()}`;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${source} must be an absolute HTTP(S) URL`);
	}

	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error(`${source} must be an absolute HTTP(S) URL`);
	}
	if (url.protocol !== "https:") {
		throw new Error(`${source} must be an absolute HTTPS URL`);
	}
	if (url.username || url.password) {
		throw new Error(`${source} must not include credentials`);
	}
	if (url.search || url.hash) {
		throw new Error(`${source} must not include query parameters or fragments`);
	}

	url.search = "";
	url.hash = "";
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString().replace(/\/+$/, "");
}

const API_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const API_REQUEST_BODY_HEADERS = ["Content-Encoding", "Content-Language", "Content-Location", "Content-Type"];
const MAX_API_REDIRECTS = 5;

export async function fetchWithCredentialRedirects(
	url: string,
	init: RequestInit,
	credentialHeaders: readonly string[],
): Promise<Response> {
	let current = new URL(url);
	let requestInit = init;

	for (let redirects = 0; ; redirects++) {
		const response = await fetch(current, { ...requestInit, redirect: "manual" });
		if (!API_REDIRECT_STATUSES.has(response.status)) return response;

		const location = response.headers.get("location");
		if (!location) return response;
		if (redirects === MAX_API_REDIRECTS) {
			throw new Error(`Too many API redirects from ${url}`);
		}

		const next = new URL(location, current);
		if (next.protocol !== "http:" && next.protocol !== "https:") {
			throw new Error(`API redirect from ${current.origin} must use HTTP(S)`);
		}
		const method = requestInit.method?.toUpperCase() ?? "GET";
		if (
			((response.status === 301 || response.status === 302) && method === "POST")
			|| (response.status === 303 && method !== "GET" && method !== "HEAD")
		) {
			const headers = new Headers(requestInit.headers);
			for (const name of API_REQUEST_BODY_HEADERS) headers.delete(name);
			const { body: _body, ...withoutBody } = requestInit;
			requestInit = { ...withoutBody, method: "GET", headers };
		}
		if (next.origin !== current.origin) {
			const headers = new Headers(requestInit.headers);
			for (const name of credentialHeaders) headers.delete(name);
			requestInit = { ...requestInit, headers };
		}
		current = next;
	}
}

export interface CuratorNetworkConfig {
	/** Whether remote access was opted into via curatorRemote. */
	enabled: boolean;
	host: string;
	bind: string;
}

const LOCAL_CURATOR_NETWORK_DEFAULTS: CuratorNetworkConfig = { enabled: false, host: "localhost", bind: "127.0.0.1" };

function trimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** Resolves the curator server bind address and URL host from `curatorRemote`. */
export function resolveCuratorNetworkConfig(): CuratorNetworkConfig {
	const configPath = getWebSearchConfigPath();
	if (!existsSync(configPath)) return LOCAL_CURATOR_NETWORK_DEFAULTS;

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configPath, "utf-8"));
	} catch {
		return LOCAL_CURATOR_NETWORK_DEFAULTS;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return LOCAL_CURATOR_NETWORK_DEFAULTS;

	const curatorRemote = (raw as Record<string, unknown>).curatorRemote;
	if (curatorRemote === true) return { enabled: true, host: hostname(), bind: "0.0.0.0" };

	if (curatorRemote && typeof curatorRemote === "object" && !Array.isArray(curatorRemote)) {
		const obj = curatorRemote as Record<string, unknown>;
		return {
			enabled: true,
			host: trimmedString(obj.host) ?? hostname(),
			bind: trimmedString(obj.bind) ?? "0.0.0.0",
		};
	}

	return LOCAL_CURATOR_NETWORK_DEFAULTS;
}

export function formatSeconds(s: number): string {
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
	return `${m}:${String(sec).padStart(2, "0")}`;
}

export function readExecError(err: unknown): { code?: string; stderr: string; message: string } {
	if (!err || typeof err !== "object") {
		return { stderr: "", message: String(err) };
	}
	const code = (err as { code?: string }).code;
	const message = (err as { message?: string }).message ?? "";
	const stderrRaw = (err as { stderr?: Buffer | string }).stderr;
	const stderr = Buffer.isBuffer(stderrRaw)
		? stderrRaw.toString("utf-8")
		: typeof stderrRaw === "string"
			? stderrRaw
			: "";
	return { code, stderr, message };
}

export function isTimeoutError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	if ((err as { killed?: boolean }).killed) return true;
	const name = (err as { name?: string }).name;
	const code = (err as { code?: string }).code;
	const message = (err as { message?: string }).message ?? "";
	return name === "AbortError" || code === "ETIMEDOUT" || message.toLowerCase().includes("timed out");
}

export function trimErrorText(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function mapFfmpegError(err: unknown): string {
	const { code, stderr, message } = readExecError(err);
	if (code === "ENOENT") return "ffmpeg is not installed. Install with: brew install ffmpeg";
	if (isTimeoutError(err)) return "ffmpeg timed out extracting frame";
	if (stderr.includes("403")) return "Stream URL returned 403 — may have expired, try again";
	const snippet = trimErrorText(stderr || message);
	return snippet ? `ffmpeg failed: ${snippet}` : "ffmpeg failed";
}
