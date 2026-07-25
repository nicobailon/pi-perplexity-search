import { execFile } from "node:child_process";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, homedir, platform } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { isBrowserCookieAccessAllowed } from "./gemini-web-config.ts";

export type CookieMap = Record<string, string>;

interface BrowserConfig {
	name: string;
	baseDir: string;
	keychainService?: string;
	keychainAccount?: string;
	secretToolApp?: string;
}

type SqliteRow = Record<string, unknown>;
type SqliteFailure = "unavailable" | "query";

const GOOGLE_ORIGINS = [
	"https://gemini.google.com",
	"https://accounts.google.com",
	"https://www.google.com",
];

const ALL_COOKIE_NAMES = new Set([
	"__Secure-1PSID", "__Secure-1PSIDTS", "__Secure-1PSIDCC", "__Secure-1PAPISID", "NID", "AEC", "SOCS",
	"__Secure-BUCKET", "__Secure-ENID", "SID", "HSID", "SSID", "APISID", "SAPISID", "__Secure-3PSID",
	"__Secure-3PSIDTS", "__Secure-3PAPISID", "SIDCC",
]);

const MACOS_BROWSER_CONFIGS: BrowserConfig[] = [
	{ name: "Helium", baseDir: "Library/Application Support/net.imput.helium", keychainService: "Helium Storage Key", keychainAccount: "Helium" },
	{ name: "Chrome", baseDir: "Library/Application Support/Google/Chrome", keychainService: "Chrome Safe Storage", keychainAccount: "Chrome" },
	{ name: "Arc", baseDir: "Library/Application Support/Arc/User Data", keychainService: "Arc Safe Storage", keychainAccount: "Arc" },
];

const LINUX_BROWSER_CONFIGS: BrowserConfig[] = [
	{ name: "Chromium", baseDir: ".config/chromium", secretToolApp: "chromium" },
	{ name: "Chrome", baseDir: ".config/google-chrome", secretToolApp: "chrome" },
];

const browserPasswordCache = new Map<string, Promise<string | null>>();
let lastCookieDiagnostic: string | null = null;
let sqliteModule: typeof import("node:sqlite") | null = null;
let sqliteImportAttempted = false;

export function getLastGoogleCookieDiagnostic(): string | null {
	return lastCookieDiagnostic;
}

export async function getGoogleCookies(
	options?: { profile?: string; requiredCookies?: string[] },
): Promise<{ cookies: CookieMap; warnings: string[] } | null> {
	lastCookieDiagnostic = null;
	if (!isBrowserCookieAccessAllowed()) {
		lastCookieDiagnostic = "Browser cookie access is disabled; enable allowBrowserCookies to use Gemini Web cookies.";
		return null;
	}

	const currentPlatform = platform();
	const configs = currentPlatform === "darwin" ? MACOS_BROWSER_CONFIGS : currentPlatform === "linux" ? LINUX_BROWSER_CONFIGS : [];
	if (configs.length === 0) {
		lastCookieDiagnostic = "Chromium cookie extraction is unsupported on this platform.";
		return null;
	}

	const warningSet = new Set<string>();
	const rawProfile = typeof options?.profile === "string" ? options.profile.trim() : "";
	const requestedProfile = normalizeProfileName(options?.profile);
	if (rawProfile && !requestedProfile) {
		lastCookieDiagnostic = "Configured Chromium profile must be a profile directory name, not a path.";
		return null;
	}
	const requiredCookies = normalizeCookieNames(options?.requiredCookies);
	const hosts = GOOGLE_ORIGINS.map((origin) => new URL(origin).hostname);
	const home = homedir();
	let sawCookieDatabase = false;
	let sawRequiredCookies = false;
	let sawBackendFailure: SqliteFailure | undefined;
	let sawUnsafeProfilePath = false;

	for (const config of configs) {
		const profiles = requestedProfile ? [requestedProfile] : listBrowserProfiles(home, config);
		for (const profile of profiles) {
			const profilePath = resolveProfilePath(home, config, profile);
			if (profilePath === "outside-root") {
				sawUnsafeProfilePath = true;
				continue;
			}
			if (!profilePath) continue;
			const cookiesPath = join(profilePath, "Cookies");
			sawCookieDatabase = true;

			const tempDir = mkdtempSync(join(tmpdir(), "pi-chrome-cookies-"));
			try {
				const tempDb = join(tempDir, "Cookies");
				copyFileSync(cookiesPath, tempDb);
				copySidecar(cookiesPath, tempDb, "-wal");
				copySidecar(cookiesPath, tempDb, "-shm");

				if (requiredCookies?.length) {
					const preflight = await hasCookieNames(tempDb, hosts, requiredCookies);
					if (preflight.failure) sawBackendFailure = preflight.failure;
					if (!preflight.present) continue;
					sawRequiredCookies = true;
				}

				const password = await readBrowserPassword(config, currentPlatform);
				if (!password) {
					warningSet.add(`Could not read ${config.name} cookie encryption password`);
					continue;
				}

				const key = pbkdf2Sync(password, "saltysalt", currentPlatform === "darwin" ? 1003 : 1, 16, "sha1");
				const metaVersion = await readMetaVersion(tempDb);
				if (metaVersion.failure) sawBackendFailure = metaVersion.failure;
				if (metaVersion.value === null) continue;
				const rowsResult = await queryCookieRows(tempDb, hosts, ALL_COOKIE_NAMES);
				if (rowsResult.status === "failure") {
					sawBackendFailure = rowsResult.failure;
					continue;
				}

				const cookies: CookieMap = {};
				for (const row of rowsResult.rows) {
					const name = typeof row.name === "string" ? row.name : "";
					if (!ALL_COOKIE_NAMES.has(name) || cookies[name]) continue;
					let value = typeof row.value === "string" && row.value.length > 0 ? row.value : null;
					if (!value && typeof row.encrypted_value_hex === "string" && /^[0-9a-f]*$/i.test(row.encrypted_value_hex)) {
						value = decryptCookieValue(Buffer.from(row.encrypted_value_hex, "hex"), key, metaVersion.value >= 24);
					}
					if (value) cookies[name] = value;
				}

				if (requiredCookies?.length && !requiredCookies.every((name) => Boolean(cookies[name]))) continue;
				return { cookies, warnings: [...warningSet] };
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	}

	if (sawBackendFailure === "unavailable") {
		lastCookieDiagnostic = "SQLite backend unavailable: install sqlite3 or use a runtime with SQLite support.";
	} else if (sawBackendFailure === "query") {
		lastCookieDiagnostic = "SQLite query failed while reading the copied Chromium cookie database.";
	} else if (sawUnsafeProfilePath) {
		lastCookieDiagnostic = "Configured Chromium profile must resolve inside the browser profile root.";
	} else if (!sawCookieDatabase) {
		lastCookieDiagnostic = requestedProfile
			? `Chromium profile '${requestedProfile}' does not contain a cookie database.`
			: "No detected Chromium profile contains a cookie database.";
	} else if (requiredCookies?.length && !sawRequiredCookies) {
		lastCookieDiagnostic = "No detected Chromium profile contains the required Gemini cookies.";
	} else if (warningSet.size > 0) {
		lastCookieDiagnostic = [...warningSet][0];
	} else {
		lastCookieDiagnostic = "Required Gemini cookies were not available or could not be decrypted.";
	}
	return null;
}

function normalizeProfileName(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	if (!normalized) return undefined;
	if (isAbsolute(normalized) || normalized === "." || normalized === ".." || normalized.includes("/") || normalized.includes("\\")) {
		return undefined;
	}
	return normalized;
}

function resolveProfilePath(home: string, config: BrowserConfig, profile: string): string | "outside-root" | null {
	const basePath = join(home, config.baseDir);
	const profilePath = join(basePath, profile);
	const cookiesPath = join(profilePath, "Cookies");
	if (!existsSync(cookiesPath)) return null;
	try {
		const baseRealPath = realpathSync(basePath);
		const profileRealPath = realpathSync(profilePath);
		if (profileRealPath !== baseRealPath && !profileRealPath.startsWith(`${baseRealPath}${sep}`)) return "outside-root";
		return profileRealPath;
	} catch {
		return null;
	}
}

function normalizeCookieNames(names: string[] | undefined): string[] | undefined {
	if (!names?.length) return undefined;
	const normalized = names.filter((name): name is string => typeof name === "string").map((name) => name.trim()).filter(Boolean);
	return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

function listBrowserProfiles(home: string, config: BrowserConfig): string[] {
	const basePath = join(home, config.baseDir);
	if (!existsSync(basePath)) return ["Default"];
	const profiles = new Set<string>();
	try {
		for (const entry of readdirSync(basePath, { withFileTypes: true })) {
			if (entry.isDirectory() && existsSync(join(basePath, entry.name, "Cookies"))) profiles.add(entry.name);
		}
	} catch {
	}
	if (profiles.size === 0) return ["Default"];
	return [...profiles].sort(compareProfileNames);
}

function compareProfileNames(a: string, b: string): number {
	const key = (name: string): [number, number] => {
		if (name === "Default") return [0, 0];
		const profile = /^Profile\s+(\d+)$/i.exec(name);
		if (profile) return [1, Number(profile[1])];
		const person = /^Person\s+(\d+)$/i.exec(name);
		if (person) return [2, Number(person[1])];
		return [3, Number.MAX_SAFE_INTEGER];
	};
	const [ap, ai] = key(a);
	const [bp, bi] = key(b);
	return ap - bp || ai - bi || a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

function decryptCookieValue(encrypted: Uint8Array, key: Buffer, stripHash: boolean): string | null {
	const buf = Buffer.from(encrypted);
	if (buf.length < 3 || !/^v\d\d$/.test(buf.subarray(0, 3).toString("utf8"))) return null;
	const ciphertext = buf.subarray(3);
	if (!ciphertext.length) return "";
	try {
		const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
		decipher.setAutoPadding(false);
		const unpadded = removePkcs7Padding(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
		const bytes = stripHash && unpadded.length >= 32 ? unpadded.subarray(32) : unpadded;
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		let i = 0;
		while (i < decoded.length && decoded.charCodeAt(i) < 0x20) i++;
		return decoded.slice(i);
	} catch {
		return null;
	}
}

function removePkcs7Padding(buf: Buffer): Buffer {
	if (!buf.length) return buf;
	const padding = buf[buf.length - 1];
	return !padding || padding > 16 ? buf : buf.subarray(0, buf.length - padding);
}

function readBrowserPassword(config: BrowserConfig, currentPlatform: ReturnType<typeof platform>): Promise<string | null> {
	const cacheKey = `${currentPlatform}:${config.name}`;
	const cached = browserPasswordCache.get(cacheKey);
	if (cached) return cached;
	const passwordResult = currentPlatform === "darwin"
		? config.keychainAccount && config.keychainService
			? readKeychainPassword(config.keychainAccount, config.keychainService).then(password => ({ password, cacheable: Boolean(password) }))
			: Promise.resolve({ password: null, cacheable: false })
		: currentPlatform === "linux"
			? readLinuxPassword(config.secretToolApp)
			: Promise.resolve({ password: null, cacheable: false });
	const passwordPromise = passwordResult.then(({ password, cacheable }) => {
		if (!cacheable) browserPasswordCache.delete(cacheKey);
		return password;
	}, (error) => {
		browserPasswordCache.delete(cacheKey);
		throw error;
	});
	browserPasswordCache.set(cacheKey, passwordPromise);
	return passwordPromise;
}

function readKeychainPassword(account: string, service: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile("security", ["find-generic-password", "-w", "-a", account, "-s", service], { timeout: 5000 }, (err, stdout) => {
			if (err) { resolve(null); return; }
			resolve(stdout.trim() || null);
		});
	});
}

function readLinuxPassword(secretToolApp: string | undefined): Promise<{ password: string; cacheable: boolean }> {
	if (!secretToolApp) return Promise.resolve({ password: "peanuts", cacheable: true });
	return new Promise((resolve) => {
		execFile("secret-tool", ["lookup", "application", secretToolApp], { timeout: 5000 }, (err, stdout) => {
			if (err) { resolve({ password: "peanuts", cacheable: false }); return; }
			const password = stdout.trim();
			resolve(password ? { password, cacheable: true } : { password: "peanuts", cacheable: false });
		});
	});
}

async function importSqlite(): Promise<typeof import("node:sqlite") | null> {
	if (process.env.PI_WEB_ACCESS_DISABLE_NODE_SQLITE === "1") return null;
	if (sqliteImportAttempted) return sqliteModule;
	sqliteImportAttempted = true;
	const orig = process.emitWarning.bind(process);
	process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
		const msg = typeof warning === "string" ? warning : warning?.message ?? "";
		if (msg.includes("SQLite is an experimental feature")) return;
		return (orig as Function)(warning, ...args);
	}) as typeof process.emitWarning;
	try {
		sqliteModule = await import("node:sqlite");
	} catch {
		sqliteModule = null;
	} finally {
		process.emitWarning = orig;
	}
	return sqliteModule;
}

type QueryResult =
	| { status: "success"; rows: SqliteRow[] }
	| { status: "failure"; failure: SqliteFailure };

async function runSqliteQuery(dbPath: string, sql: string): Promise<QueryResult> {
	const sqlite = await importSqlite();
	let queryFailed = false;
	if (sqlite) {
		try {
			const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
			try {
				return { status: "success", rows: db.prepare(sql).all() as SqliteRow[] };
			} finally {
				db.close();
			}
		} catch {
			queryFailed = true;
		}
	}

	const cli = await runSqliteCli(dbPath, sql);
	if (cli.status === "success") return cli;
	if (cli.failure === "query") queryFailed = true;
	const python = await runPythonSqlite(dbPath, sql);
	if (python.status === "success") return python;
	if (python.failure === "query") queryFailed = true;
	return { status: "failure", failure: queryFailed ? "query" : "unavailable" };
}

function runSqliteCli(dbPath: string, sql: string): Promise<QueryResult> {
	return new Promise((resolve) => {
		execFile("sqlite3", ["-readonly", "-json", dbPath, sql], { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
			if (err) { resolve({ status: "failure", failure: err.code === "ENOENT" ? "unavailable" : "query" }); return; }
			try {
				const parsed = JSON.parse(stdout || "[]");
				resolve(Array.isArray(parsed) ? { status: "success", rows: parsed as SqliteRow[] } : { status: "failure", failure: "query" });
			} catch {
				resolve({ status: "failure", failure: "query" });
			}
		});
	});
}

function runPythonSqlite(dbPath: string, sql: string): Promise<QueryResult> {
	const script = "import json,sqlite3,sys\ntry:\n c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\n c.row_factory=sqlite3.Row\n print(json.dumps([dict(r) for r in c.execute(sys.argv[2]).fetchall()]))\nexcept Exception:\n sys.exit(1)";
	return new Promise((resolve) => {
		execFile("python3", ["-c", script, dbPath, sql], { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
			if (err) { resolve({ status: "failure", failure: err.code === "ENOENT" ? "unavailable" : "query" }); return; }
			try {
				const parsed = JSON.parse(stdout || "[]");
				resolve(Array.isArray(parsed) ? { status: "success", rows: parsed as SqliteRow[] } : { status: "failure", failure: "query" });
			} catch {
				resolve({ status: "failure", failure: "query" });
			}
		});
	});
}

async function readMetaVersion(dbPath: string): Promise<{ value: number | null; failure?: SqliteFailure }> {
	const result = await runSqliteQuery(dbPath, "SELECT value FROM meta WHERE key = 'version'");
	if (result.status === "failure") {
		return result.failure === "unavailable"
			? { value: null, failure: result.failure }
			: { value: 0 };
	}
	const value = result.rows[0]?.value;
	if (typeof value === "number") return { value: Math.floor(value) };
	if (typeof value === "string") return { value: parseInt(value, 10) || 0 };
	return { value: 0 };
}

async function hasCookieNames(dbPath: string, hosts: string[], names: string[]): Promise<{ present: boolean; failure?: SqliteFailure }> {
	const result = await runSqliteQuery(dbPath, `SELECT DISTINCT name FROM cookies WHERE ${buildCookieWhere(hosts, names)}`);
	if (result.status === "failure") return { present: false, failure: result.failure };
	const present = new Set(result.rows.map((row) => typeof row.name === "string" ? row.name : ""));
	return { present: names.every((name) => present.has(name)) };
}

async function queryCookieRows(dbPath: string, hosts: string[], names: Iterable<string>): Promise<QueryResult> {
	return runSqliteQuery(dbPath, `SELECT name, value, host_key, hex(encrypted_value) AS encrypted_value_hex FROM cookies WHERE ${buildCookieWhere(hosts, names)} ORDER BY expires_utc DESC`);
}

function buildCookieWhere(hosts: string[], cookieNames?: Iterable<string>): string {
	const hostClauses: string[] = [];
	for (const host of hosts) {
		for (const candidate of expandHosts(host)) {
			const escaped = escapeSqlString(candidate);
			hostClauses.push(`host_key = '${escaped}'`, `host_key = '.${escaped}'`, `host_key LIKE '%.${escaped}'`);
		}
	}
	let where = `(${hostClauses.join(" OR ")})`;
	const names = cookieNames ? [...cookieNames].filter(Boolean) : [];
	if (names.length) where += ` AND name IN (${names.map((name) => `'${escapeSqlString(name)}'`).join(", ")})`;
	return where;
}

function escapeSqlString(value: string): string {
	return value.replaceAll("'", "''");
}

function expandHosts(host: string): string[] {
	const parts = host.split(".").filter(Boolean);
	if (parts.length <= 1) return [host];
	const candidates = new Set([host]);
	for (let i = 1; i <= parts.length - 2; i++) candidates.add(parts.slice(i).join("."));
	return [...candidates];
}

function copySidecar(srcDb: string, targetDb: string, suffix: string): void {
	const sidecar = `${srcDb}${suffix}`;
	if (!existsSync(sidecar)) return;
	try {
		copyFileSync(sidecar, `${targetDb}${suffix}`);
	} catch {
	}
}
