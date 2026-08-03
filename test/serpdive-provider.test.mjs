import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const serpdiveModuleUrl = new URL("../serpdive.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of ["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "SERPDIVE_API_KEY", "KAGI_API_KEY", "OLLAMA_API_KEY", "SERPBASE_API_KEY", "SERPDIVE_MODEL"]) {
		delete childEnv[key];
	}
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

// Renvoie le corps de la requête envoyée à l'API, plus le résultat mappé.
function probe(extra = "") {
	return `
		let capturedUrl = "";
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				query: capturedBody.query,
				model: capturedBody.model,
				response_time_ms: 1200,
				results: [
					{ url: "https://github.com/nicobailon/pi-web-access", title: "Repo", content: "repo content" },
					{ url: "https://gist.github.com/nicobailon/abc", title: "Gist", content: "gist content" },
					{ url: "https://example.com/nope", title: "Example", content: "example content" },
				],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};
		const { searchWithSerpdive } = await import(${JSON.stringify(serpdiveModuleUrl)});
		${extra}
	`;
}

test("le modèle par défaut est krill, et aucune synthèse n'est demandée", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-serpdive-"));
	const child = runChild(probe(`
		const result = await searchWithSerpdive("vector databases", { numResults: 3 });
		console.log(JSON.stringify({ url: capturedUrl, body: capturedBody, auth: capturedHeaders.Authorization, answer: result.answer }));
	`), { HOME: home, USERPROFILE: home, SERPDIVE_API_KEY: "serpdive-test-key" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.url, "https://api.serpdive.com/v1/search");
	assert.equal(output.auth, "Bearer serpdive-test-key");
	// Le point central de la revue : installer ce provider ne doit RIEN dépenser.
	assert.equal(output.body.model, "krill");
	assert.equal("answer" in output.body, false); // krill ne synthétise pas
	// …mais SearchResponse.answer reste rempli, assemblé depuis les sources,
	// comme le font brave.ts et searxng.ts pour les providers sans synthèse.
	assert.match(output.answer, /repo content/);
	assert.match(output.answer, /Source: Repo/);
});

test("un modèle explicite demande la synthèse à l'API", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-serpdive-"));
	const child = runChild(probe(`
		await searchWithSerpdive("vector databases", {});
		console.log(JSON.stringify({ body: capturedBody }));
	`), { HOME: home, USERPROFILE: home, SERPDIVE_API_KEY: "k", SERPDIVE_MODEL: "moby" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.body.model, "moby");
	assert.equal(output.body.answer, true);
});

test("un modèle inconnu retombe sur krill, jamais sur un modèle payant", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-serpdive-"));
	const child = runChild(probe(`
		await searchWithSerpdive("vector databases", {});
		console.log(JSON.stringify({ body: capturedBody }));
	`), { HOME: home, USERPROFILE: home, SERPDIVE_API_KEY: "k", SERPDIVE_MODEL: "MAKO-turbo" });

	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout.trim()).body.model, "krill");
});

test("max_results est plafonné à 10 — l'API n'accepte pas plus", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-serpdive-"));
	const child = runChild(probe(`
		await searchWithSerpdive("vector databases", { numResults: 20 });
		console.log(JSON.stringify({ body: capturedBody }));
	`), { HOME: home, USERPROFILE: home, SERPDIVE_API_KEY: "k" });

	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout.trim()).body.max_results, 10);
});

test("la récence est un indice de requête, pas un paramètre temporel", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-serpdive-"));
	const child = runChild(probe(`
		await searchWithSerpdive("ai news", { recencyFilter: "week" });
		console.log(JSON.stringify({ body: capturedBody }));
	`), { HOME: home, USERPROFILE: home, SERPDIVE_API_KEY: "k" });

	assert.equal(child.status, 0, child.stderr);
	const body = JSON.parse(child.stdout.trim()).body;
	assert.equal(body.query, "ai news past week"); // l'indice voyage DANS la question
	for (const param of ["time_range", "recency", "start_date", "end_date", "days"]) {
		assert.equal(param in body, false, `${param} n'existe pas dans l'API`);
	}
});

test("le filtrage par domaine est appliqué côté client, sur ce qui revient", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-serpdive-"));
	const child = runChild(probe(`
		const result = await searchWithSerpdive("sdk docs", {
			domainFilter: ["github.com", "-gist.github.com"],
			numResults: 5,
			includeContent: true,
		});
		console.log(JSON.stringify({
			body: capturedBody,
			urls: result.results.map((r) => r.url),
			inline: (result.inlineContent ?? []).map((c) => c.url),
		}));
	`), { HOME: home, USERPROFILE: home, SERPDIVE_API_KEY: "k" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	// Aucun paramètre de domaine ne part : l'API n'en a pas.
	for (const param of ["include_domains", "exclude_domains", "domains"]) {
		assert.equal(param in output.body, false);
	}
	assert.deepEqual(output.urls, ["https://github.com/nicobailon/pi-web-access"]);
	assert.deepEqual(output.inline, ["https://github.com/nicobailon/pi-web-access"]);
});

test("une erreur HTTP remonte le statut sans jamais laisser fuir la clé", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-serpdive-"));
	const child = runChild(`
		globalThis.fetch = async () => new Response(
			JSON.stringify({ error: "invalid_api_key", message: "This API key is invalid or was revoked. key=serpdive-secret-key" }),
			{ status: 401 },
		);
		const { searchWithSerpdive } = await import(${JSON.stringify(serpdiveModuleUrl)});
		try {
			await searchWithSerpdive("q", {});
			console.log(JSON.stringify({ threw: false }));
		} catch (err) {
			console.log(JSON.stringify({ threw: true, message: err.message }));
		}
	`, { HOME: home, USERPROFILE: home, SERPDIVE_API_KEY: "serpdive-secret-key" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.threw, true);
	assert.match(output.message, /SERPdive API error 401/);
	assert.match(output.message, /invalid_api_key/);
	assert.equal(output.message.includes("serpdive-secret-key"), false); // redacted
});

// Répond directement à la revue : « uses the shared request-time
// credential-source path ». La clé n'est pas lue au chargement du module mais
// résolue au moment de la requête, par la même mécanique que les autres
// providers — ici un `!command`, dont on prouve qu'il ne tourne QU'À l'appel.
test("la clé passe par le chemin de credentials partagé, résolue à la requête", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-serpdive-cred-"));
	const agentDir = join(home, "agent");
	await mkdir(agentDir, { recursive: true });
	const marker = join(home, "serpdive-resolver-ran");
	await writeFile(
		join(agentDir, "web-search.json"),
		JSON.stringify({ serpdiveApiKey: `!touch ${marker} && printf serpdive-command-key` }) + "\n",
		"utf8",
	);

	const child = runChild(`
		import { existsSync } from "node:fs";
		const { isSerpdiveAvailable, searchWithSerpdive } = await import(${JSON.stringify(serpdiveModuleUrl)});
		const availableBefore = isSerpdiveAvailable();
		const ranBefore = existsSync(${JSON.stringify(marker)});
		let auth = null;
		globalThis.fetch = async (url, init) => {
			auth = Object.fromEntries(new Headers(init.headers)).authorization;
			return new Response(JSON.stringify({ results: [] }), { status: 200 });
		};
		await searchWithSerpdive("q", { numResults: 1 });
		console.log(JSON.stringify({ availableBefore, ranBefore, ranAfter: existsSync(${JSON.stringify(marker)}), auth }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.availableBefore, true);   // disponible sans exécuter la commande
	assert.equal(output.ranBefore, false);        // rien n'a tourné au chargement
	assert.equal(output.ranAfter, true);          // résolue au moment de la requête
	assert.equal(output.auth, "Bearer serpdive-command-key");
});
