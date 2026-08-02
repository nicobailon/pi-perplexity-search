import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

interface SummaryModelScopeContext {
	cwd: string;
	isProjectTrusted(): boolean;
}

export interface ModelLike {
	provider: string;
	id: string;
}

export interface ModelRegistryLike<T extends ModelLike = ModelLike> {
	find(provider: string, id: string): T | undefined;
	getAvailable(): readonly T[];
}

/** Resolve a model through its native provider or a provider that routes that model ID. */
export function findModelWithProviderRouting<T extends ModelLike>(
	registry: ModelRegistryLike<T>,
	provider: string,
	id: string,
): T | undefined {
	const available = registry.getAvailable();
	const direct = available.find(model => model.provider === provider && model.id === id);
	if (direct) return direct;

	const routedId = `${provider}/${id}`;
	const routed = available.find(model => model.id === routedId);
	return routed ?? registry.find(provider, id);
}

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function readSettings(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const raw = readFileSync(path, "utf8");
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${path}: ${message}`);
	}
}

export function loadEnabledModelPatterns(ctx: SummaryModelScopeContext): string[] | null {
	const globalSettings = readSettings(join(getAgentDir(), "settings.json"));
	const projectSettings = ctx.isProjectTrusted()
		? readSettings(join(ctx.cwd, ".pi", "settings.json"))
		: {};
	const value = Object.hasOwn(projectSettings, "enabledModels")
		? projectSettings.enabledModels
		: globalSettings.enabledModels;
	if (value === undefined) return null;
	if (!Array.isArray(value)) throw new Error("enabledModels must be an array");
	return value
		.filter((item): item is string => typeof item === "string")
		.map(item => item.trim())
		.filter(Boolean);
}

export function summaryModelValue(model: ModelLike): string {
	return `${model.provider}/${model.id}`;
}

function stripThinkingSuffix(pattern: string): string {
	const index = pattern.lastIndexOf(":");
	if (index < 0) return pattern;
	const suffix = pattern.slice(index + 1);
	return THINKING_LEVELS.has(suffix) ? pattern.slice(0, index) : pattern;
}

function globToRegExp(pattern: string): RegExp {
	let source = "^";
	for (const char of pattern) {
		if (char === "*") {
			source += ".*";
		} else if (char === "?") {
			source += ".";
		} else {
			source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
		}
	}
	return new RegExp(`${source}$`, "i");
}

export function modelMatchesEnabledPatterns(model: ModelLike, patterns: string[] | null): boolean {
	if (patterns === null) return true;
	const value = summaryModelValue(model).toLowerCase();
	const id = model.id.toLowerCase();
	for (const rawPattern of patterns) {
		const pattern = stripThinkingSuffix(rawPattern.trim()).toLowerCase();
		if (!pattern) continue;
		if (pattern.includes("*") || pattern.includes("?")) {
			const regex = globToRegExp(pattern);
			if (regex.test(value) || regex.test(id)) return true;
			continue;
		}
		if (pattern === value || pattern === id) return true;
	}
	return false;
}
