<p>
  <img src="banner.png" alt="pi-web-access" width="1100">
</p>

# Pi Web Access

**Web search, content extraction, and video understanding for Pi agent. OpenAI/Codex search, zero-config Exa search, Brave, Parallel, TinyFish, Tavily, SERPdive, AnySearch, self-hosted SearXNG, optional browser-cookie Gemini Web, or bring your own API keys.**

[![npm version](https://img.shields.io/npm/v/pi-web-access?style=for-the-badge)](https://www.npmjs.com/package/pi-web-access)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows*-blue?style=for-the-badge)]()

https://github.com/user-attachments/assets/cac6a17a-1eeb-4dde-9818-cdf85d8ea98f

## Why Pi Web Access

**Zero Config** — Works out of the box with Exa MCP (no API key needed). If you're signed into Pi with a Codex subscription, OpenAI web search can reuse that auth. Add API keys for OpenAI, Brave, Parallel, TinyFish, Tavily, SERPdive, Exa, Perplexity, or Gemini API for more control; configure a self-hosted SearXNG endpoint for private search; or opt into browser-cookie access for Gemini Web.

**Video Understanding** — Point it at a YouTube video or local screen recording and ask questions about what's on screen. Full transcripts, visual descriptions, and frame extraction at exact timestamps.

**Smart Fallbacks** — Every capability has a fallback chain. Search tries configured SearXNG first for local/private search, then OpenAI when suitable and available, Exa, Brave, Parallel, TinyFish, Tavily, SERPdive, Perplexity, Gemini API, and Gemini Web when browser cookies are enabled. With no SearXNG configured, the existing zero-config order is unchanged. YouTube tries Gemini Web when enabled, then API, then Perplexity. Blocked pages try configured self-hosted Firecrawl first, then Jina Reader, TinyFish, Parallel, and Gemini extraction. Something always works.

**GitHub Cloning** — GitHub URLs are cloned locally instead of scraped. The agent gets real file contents and a local path to explore, not rendered HTML.

## Install

```bash
pi install npm:pi-web-access
```

Works immediately with no API keys — Exa MCP provides zero-config search. If Pi has Codex auth from `/login`, OpenAI search can also work without a separate key. For more providers or direct API access, add keys to `~/.pi/web-search.json`:

```json
{
  "openaiApiKey": "sk-...",
  "braveApiKey": "BSA_...",
  "exaApiKey": "exa-...",
  "tinyfishApiKey": "sk-tinyfish-...",
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza..."
}
```

In `auto` mode (default), `web_search` tries a configured SearXNG endpoint first for local/private search, then OpenAI when suitable and available, Exa (direct API if keyed, MCP if not), Brave, Parallel, TinyFish, Tavily, SERPdive, Perplexity, Gemini API, and Gemini Web when browser-cookie access is enabled. With no SearXNG configured, the existing zero-config order is unchanged. Exa handles search; curator summary drafts are generated separately by the configured Pi summary model. Slow summary drafts fall back to a deterministic result summary after a bounded deadline.

If your OpenAI key belongs to a third-party Responses-compatible gateway, set `openaiResponsesUrl` to that gateway's full Responses endpoint. The default remains `https://api.openai.com/v1/responses`.

For sandboxed networks that provide outbound proxy transport through environment variables, set `ssrf.trustEnvProxy` to `true` to skip local DNS preflight for proxied hostnames:

```json
{
  "ssrf": {
    "trustEnvProxy": true
  }
}
```

This is an opt-in DNS-preflight adjustment, not proxy transport configuration. `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` are recognized; `NO_PROXY` hosts still undergo DNS validation, and localhost or literal private IP targets remain blocked.

Optional dependencies for video frame extraction:

```bash
brew install ffmpeg   # frame extraction, video thumbnails, local video duration
brew install yt-dlp   # YouTube stream URLs for frame extraction
```

Without these, video content analysis (transcripts, visual descriptions via Gemini) still works. The binaries are only needed for extracting individual frames as images.

Requires Pi v0.37.3+.

## Quick Start

```typescript
// Search the web
web_search({ query: "TypeScript best practices 2025" })

// Fetch a page
fetch_content({ url: "https://docs.example.com/guide" })

// Clone a GitHub repo
fetch_content({ url: "https://github.com/owner/repo" })

// Understand a YouTube video
fetch_content({ url: "https://youtube.com/watch?v=abc", prompt: "What libraries are shown?" })

// Analyze a screen recording
fetch_content({ url: "/path/to/recording.mp4", prompt: "What error appears on screen?" })
```

## Tools

### web_search

Search the web via OpenAI, Brave, Parallel, TinyFish, Tavily, SERPdive, AnySearch, self-hosted SearXNG, Exa, Perplexity AI, or Gemini. Returns a synthesized answer with source citations.

```typescript
web_search({ query: "rust async programming" })
web_search({ queries: ["query 1", "query 2"] })
web_search({ query: "latest news", numResults: 10, recencyFilter: "week" })
web_search({ query: "...", domainFilter: ["github.com"] })
web_search({ query: "...", provider: "openai" })
web_search({ query: "...", provider: "all" })
web_search({ query: "...", includeContent: true })
web_search({ queries: ["query 1", "query 2"], workflow: "none" })
web_search({ queries: ["query 1", "query 2"], workflow: "summary-review" })
web_search({ queries: ["query 1", "query 2"], workflow: "auto-summary" })
```

| Parameter | Description |
|-----------|-------------|
| `query` / `queries` | Single query or batch of queries |
| `numResults` | Results per query (default: 5, max: 20) |
| `recencyFilter` | `day`, `week`, `month`, or `year` |
| `domainFilter` | Limit to domains (prefix with `-` to exclude) |
| `provider` | Configured provider when omitted or set to `auto`; `all` searches every eligible provider except AnySearch simultaneously; otherwise `openai`, `brave`, `parallel`, `tinyfish`, `tavily`, `serpdive`, `anysearch`, `searxng`, `exa`, `perplexity`, or `gemini` (auto-selects when no provider or routing is configured; AnySearch is explicit-only) |
| `includeContent` | Fetch full page content from sources in background |
| `workflow` | `none` (skip curator), `summary-review` (open curator and auto-generate a summary draft, default), or `auto-summary` (generate a summary without opening the curator) |

### fetch_content

Fetch URL(s) and extract readable content as markdown. Automatically detects and handles GitHub repos, YouTube videos, PDFs, local video files, and regular web pages.

```typescript
fetch_content({ url: "https://example.com/article" })
fetch_content({ urls: ["url1", "url2", "url3"] })
fetch_content({ url: "https://github.com/owner/repo" })
fetch_content({ url: "https://youtube.com/watch?v=abc", prompt: "What libraries are shown?" })
fetch_content({ url: "/path/to/recording.mp4", prompt: "What error appears on screen?" })
fetch_content({ url: "https://youtube.com/watch?v=abc", timestamp: "23:41-25:00", frames: 4 })
```

| Parameter | Description |
|-----------|-------------|
| `url` / `urls` | Single URL/path or multiple URLs |
| `prompt` | Question to ask about a YouTube video or local video file |
| `timestamp` | Extract frame(s) — single (`"23:41"`), range (`"23:41-25:00"`), or seconds (`"85"`) |
| `frames` | Number of frames to extract (max 12) |
| `forceClone` | Clone GitHub repos that exceed the 350MB size threshold |

### get_search_content

Retrieve stored content from previous searches or fetches. Fetched URL content is stored in full, but `get_search_content` returns bounded slices by default so large pages do not overflow the next model request. Use `offset` and `limit` to page through long content intentionally.

```typescript
get_search_content({ responseId: "abc123", urlIndex: 0 })
get_search_content({ responseId: "abc123", url: "https://...", offset: 30000 })
get_search_content({ responseId: "abc123", query: "original query" })
```

### source_check

Check a claim and return a machine-readable artifact with exact passage citations. Search results are deduplicated and capped at 20 sources; `fetchContent` fetches at most 5 pages, while stored and retrieved content remains subject to the existing 30,000-character `offset`/`limit` bounds.

```typescript
source_check({ claim: "The API supports streaming responses" })
source_check({
  claim: "The API supports streaming responses",
  queries: ["API streaming responses documentation", "API streaming limitations"],
  fetchContent: true,
  domainFilter: ["docs.example.com", "-old.example.com"]
})
```

The artifact includes `supported`, `contradicted`, `unclear`, or `missing-evidence` claim status, source quality hints, SHA-256 content hashes, and passage IDs with exact source offsets. Search and fetch errors remain in the artifact instead of being silently discarded. Artifacts are stored with the session and retrieved through `get_search_content` using the returned `responseId`; paged artifact responses are JSON slices, so request the next `offset` when needed.

## Capabilities

### GitHub repos

GitHub URLs are cloned locally instead of scraped. The agent gets real file contents and a local path to explore with `read` and `bash`. Root URLs return the repo tree + README, `/tree/` paths return directory listings, `/blob/` paths return file contents.

Repos over 350MB get a lightweight API-based view instead of a full clone (override with `forceClone: true`). Commit SHA URLs are handled via the API. Clones are cached for the session and wiped on session change. Private repos require the `gh` CLI. Set `githubClone.enabled` to `false` to skip this GitHub-specific clone/API handling; `fetch_content` remains available, so the URL can continue through the normal HTTP extraction path.

### YouTube videos

YouTube URLs are processed via Gemini for full video understanding — visual descriptions, transcripts with timestamps, and chapter markers. Pass a `prompt` to ask specific questions about the video. Results include the video thumbnail so the agent gets visual context alongside the transcript.

Fallback: Gemini Web when browser cookies are enabled → Gemini API → Perplexity (text summary only). Handles all URL formats: `/watch?v=`, `youtu.be/`, `/shorts/`, `/live/`, `/embed/`, `/v/`.

### Local video files

Pass a file path (`/`, `./`, `../`, or `file://` prefix) to analyze video content via Gemini. Supports MP4, MOV, WebM, AVI, and other common formats up to 50MB for Gemini analysis. Pass a `prompt` to ask about specific content. If ffmpeg is installed, a thumbnail frame is included alongside the analysis. Timestamp/frame extraction uses ffmpeg directly and can still operate on larger local files.

Fallback: Gemini API (Files API upload) → Gemini Web when browser cookies are enabled.

### Video frame extraction

Use `timestamp` and/or `frames` on any YouTube URL or local video file to extract visual frames as images.

```typescript
fetch_content({ url: "...", timestamp: "23:41" })                       // single frame
fetch_content({ url: "...", timestamp: "23:41-25:00" })                 // range, 6 frames
fetch_content({ url: "...", timestamp: "23:41-25:00", frames: 3 })      // range, custom count
fetch_content({ url: "...", timestamp: "23:41", frames: 5 })            // 5 frames at 5s intervals
fetch_content({ url: "...", frames: 6 })                                // sample whole video
```

Requires `ffmpeg` (and `yt-dlp` for YouTube). Timestamps accept `H:MM:SS`, `MM:SS`, or bare seconds.

### PDFs

PDF URLs are extracted as text and saved to `~/Downloads/` as markdown. The agent can then `read` specific sections without loading the full document into context. Text-based extraction only — no OCR.

### Blocked pages

When Readability fails or returns only a cookie notice, the extension retries configured Firecrawl extraction first, then Jina Reader (handles JS rendering server-side, no API key needed), TinyFish, Parallel, Gemini URL Context API, and Gemini Web extraction when browser cookies are enabled. Firecrawl requests are cache-only by default and require an explicit fresh-scrape opt-in before the Firecrawl server can fetch target URLs. Handles SPAs, JS-heavy pages, and anti-bot protections transparently. Also parses Next.js RSC flight data when present.

## How It Works

```
web_search(query)
  → SearXNG (if configured) → OpenAI (when suitable) → Exa → Brave → Parallel → TinyFish → Tavily → SERPdive → Perplexity → Gemini

fetch_content(url)
  → Video file?  Gemini API (Files API) → Gemini Web (if browser cookies enabled)
  → GitHub URL?  Clone repo, return file contents + local path
  → YouTube URL? Gemini Web (if browser cookies enabled) → Gemini API → Perplexity
  → HTTP fetch → PDF? Extract text, save to ~/Downloads/
               → HTML? Readability → RSC parser → Firecrawl (if configured, cache-only by default) → Jina Reader → TinyFish → Parallel → Gemini fallback
               → Text/JSON/Markdown? Return directly
```

## Commands

### /websearch

Open the search curator directly. Runs searches and lets you review, add, select results, and approve a summary before it is sent back to the agent — no LLM round-trip needed.

```
/websearch                                               # empty page, type your own searches
/websearch react hooks, next.js caching                  # pre-fill with comma-separated queries
```

Results get injected into the conversation when you approve the summary or click "Send selected results without summary". On timeout, the curator auto-submits and falls back to a deterministic summary if no approved draft is present.

### /curator

Toggle or configure the curator workflow at runtime.

```
/curator                    # toggle on/off
/curator on                 # enable curator (summary-review)
/curator off                # disable curator (raw results only)
/curator summary-review     # explicit workflow
```

Persists to `~/.pi/web-search.json` and takes effect on the next `web_search` call. When disabled, `web_search` returns raw results without opening the curator window.

### /search

Browse stored search results interactively. Lists all results from the current session with their response IDs for easy retrieval.

### /google-account

Show the active Google account currently authenticated for Gemini Web. Useful when multiple Chromium profiles exist or `chromeProfile` is set in config.

## Activity Monitor

Toggle with **Ctrl+Shift+W** to see live request/response activity:

```
─── Web Search Activity ────────────────────────────────────
  API  "typescript best practices"     200    2.1s ✓
  GET  docs.example.com/article        200    0.8s ✓
  GET  blog.example.com/post           404    0.3s ✗
────────────────────────────────────────────────────────────
```

## Configuration

Config defaults to `~/.pi/web-search.json`, or `web-search.json` under `PI_CODING_AGENT_DIR` / `XDG_CONFIG_HOME/pi` when set. Every field is optional.

```json
{
  "openaiApiKey": "sk-...",
  "openaiResponsesUrl": "https://gateway.example.com/v1/responses",
  "braveApiKey": "BSA_...",
  "exaApiKey": "exa-...",
  "parallelApiKey": "...",
  "tinyfishApiKey": "sk-tinyfish-...",
  "tavilyApiKey": "tvly-...",
  "serpdiveApiKey": "sd_live_...",
  "serpdiveModel": "krill",
  "searxngBaseUrl": "https://search.example.com",
  "firecrawlBaseUrl": "https://crawl.example.com",
  "firecrawlApiKey": "fc-...",
  "firecrawlApiVersion": "v2",
  "firecrawlFreshScrape": false,
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza...",
  "geminiBaseUrl": "https://my-gateway.example.com/gemini",
  "cloudflareApiKey": "...",
  "provider": "openai",
  "searchRouting": {
    "providers": ["openai", "brave", "exa"],
    "fallbackOn": ["transient", "quota", "network"]
  },
  "webSearch": {
    "enabled": true
  },
  "chromeProfile": "Profile 2",
  "allowBrowserCookies": false,
  "searchModel": "gemini-2.5-flash",
  "summaryModel": "anthropic/claude-haiku-4-5",
  "workflow": "summary-review",
  "curatorTimeoutSeconds": 20,
  "githubClone": {
    "enabled": true,
    "maxRepoSizeMB": 350,
    "cloneTimeoutSeconds": 30,
    "clonePath": "/tmp/pi-github-repos"
  },
  "youtube": {
    "enabled": true,
    "preferredModel": "gemini-3-flash-preview"
  },
  "video": {
    "enabled": true,
    "preferredModel": "gemini-3-flash-preview",
    "maxSizeMB": 50
  },
  "fetchContent": {
    "domainPolicy": {
      "allow": ["example.com"],
      "deny": ["blocked.example.com"]
    }
  },
  "shortcuts": {
    "curate": "ctrl+shift+s",
    "activity": "ctrl+shift+w"
  },
  "ssrf": {
    "allowRanges": ["198.18.0.0/15"],
    "trustEnvProxy": false
  }
}
```

All provider API-key fields (`openaiApiKey`, `braveApiKey`, `parallelApiKey`, `tinyfishApiKey`, `tavilyApiKey`, `serpdiveApiKey`, `anysearchApiKey`, `firecrawlApiKey`, `exaApiKey`, `perplexityApiKey`, `geminiApiKey`, and `cloudflareApiKey`) accept explicit credential sources. Use `$NAME` or `${NAME}` to read one named environment variable, or prefix a trusted local shell command with `!` to resolve one value at provider request time. Escape `$$` as a literal leading `$` and `$!` as a literal leading `!`:

```json
{
  "openaiApiKey": "!/absolute/path/to/secret-manager read openai",
  "braveApiKey": "${SCOPED_BRAVE_API_KEY}",
  "exaApiKey": "$$literal-key",
  "geminiApiKey": "$!literal-command"
}
```

This syntax applies to provider credentials only; other configuration fields are not interpolated. `firecrawlApiKey` uses the same credential-source rules, while `firecrawlBaseUrl`, `firecrawlApiVersion`, and `firecrawlFreshScrape` are literal config values.

A command source is not run while the extension loads or registers tools. Each selected provider request runs it again with a five-second timeout, a 16 KiB output limit, a minimized environment, and a one-line non-empty stdout requirement. Command text and stderr are omitted from errors. These commands are trusted local configuration, not a same-user process isolation boundary; use absolute executable paths and protect the config file. `OP_SESSION_*` variables are forwarded to trusted resolver commands so shell-local 1Password sessions can be reused without storing them in config. An explicit source overrides legacy provider environment variables and fails that provider locally rather than falling back with a stale credential. Direct Google Gemini API requests send the resolved key only in the `x-goog-api-key` header, never in the URL.

`fetchContent.domainPolicy` is an optional hostname allow/deny policy for `fetch_content` target URLs. It is off when omitted. Each bare hostname matches itself and its subdomains; `deny` wins when a hostname matches both lists. The policy is checked before HTTP(S) target handling and before each redirect followed by this extension's own fetch path. Local file paths and non-HTTP sources are not subject to this policy. It is an additional restriction: the existing SSRF guard still blocks private and internal destinations. Remote extraction services can still perform their own DNS, redirects, and egress after this extension preflights the submitted target URL, so keep their deployments separately isolated.

Set `searxngBaseUrl` or `SEARXNG_BASE_URL` to use a self-hosted SearXNG JSON API. A configured endpoint is preferred first in `auto` mode for local/private search. Its base URL and redirects remain subject to the SSRF guard; add only the narrowest self-hosted range to `ssrf.allowRanges` when it resolves to a private or synthetic range. Thanks to Marcos A. Núñez (@marnunez) for PR #107 and Avinash Kanaujiya (@avinashkanaujiya) for issue #105.

Set `firecrawlBaseUrl` or `FIRECRAWL_BASE_URL` to use Firecrawl as an extraction-only fallback for `fetch_content`. It calls `/v2/scrape` by default; set `firecrawlApiVersion` or `FIRECRAWL_API_VERSION` to `v1` for older self-hosted images. Firecrawl requests are cache-only by default (`lockdown: true`), so the Firecrawl server does not make fresh outbound target requests unless you explicitly set `firecrawlFreshScrape: true` or `FIRECRAWL_FRESH_SCRAPE=1`. Enable fresh scraping only for a Firecrawl deployment whose own egress, redirects, DNS rebinding behavior, and internal-network access are isolated or allowlisted; this extension can preflight the submitted URL but cannot control network requests made by the Firecrawl server. The configured Firecrawl API base URL and redirects are still validated by the same SSRF guard as other remote requests, and Firecrawl credentials are stripped from cross-origin API redirects.

Without an explicit `$` or `!` source, `OPENAI_API_KEY`, `BRAVE_API_KEY`, `PARALLEL_API_KEY`, `TINYFISH_API_KEY`, `TAVILY_API_KEY`, `SERPDIVE_API_KEY`, `ANYSEARCH_API_KEY`, `FIRECRAWL_API_KEY`, `EXA_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, and `CLOUDFLARE_API_KEY` env vars retain their existing precedence over literal config file values. `openaiResponsesUrl` can point OpenAI `web_search` and `source_check` at a third-party gateway that supports the OpenAI Responses API and web search tool; it is an explicit endpoint override, not derived from Pi model provider settings, and defaults to `https://api.openai.com/v1/responses`. Configured Exa API keys use Exa's own account limits directly; any legacy local `exa-usage.json` file is ignored. `GOOGLE_GEMINI_BASE_URL` overrides the Gemini API host for Gemini generate-content calls such as search, URL context, YouTube, and local video analysis. Set it to a bare host with no trailing slash and no version segment, for example `https://my-gateway.example.com/gemini`; `geminiBaseUrl` is the config-file equivalent. When the configured host contains `gateway.ai.cloudflare.com`, authentication uses `cf-aig-authorization: Bearer <token>` from `CLOUDFLARE_API_KEY` or `cloudflareApiKey`, and `GEMINI_API_KEY` is not required for generate-content calls. Local video file upload still uses Google's Files API directly, so gateway-only video extraction falls back to Gemini Web unless a `GEMINI_API_KEY` is also configured. `provider` or `searchProvider` sets the default search provider and is used when a tool call omits `provider` or sends `"auto"`: `"all"`, `"openai"`, `"brave"`, `"parallel"`, `"tinyfish"`, `"tavily"`, `"serpdive"`, `"anysearch"`, `"searxng"`, `"exa"`, `"perplexity"`, or `"gemini"`. AnySearch is never selected by `auto`; choose it explicitly or place it in `searchRouting`. If either single-provider field is configured, it takes precedence over `searchRouting`. Otherwise, `searchRouting` can opt into an ordered `providers` list and an explicit `fallbackOn` list containing `"transient"`, `"quota"`, and/or `"network"`; only those typed failures continue to the next available candidate. `"all"` is not valid inside `searchRouting.providers`, because that list defines sequential fallback rather than multi-provider aggregation. Named providers remain strict, and exhausted routes return per-provider diagnostics. Random, weighted, sticky, and cooldown routing are not enabled. This is also updated automatically when you change the provider in the curator UI. Set `webSearch.enabled` to `false` to unregister the configured search and source-check tools while leaving fetch/content tools available. `toolNames` can opt into alternate public tool names for environments where another extension or model reserves the defaults, without changing behavior: `webSearch`, `sourceCheck`, `fetchContent`, and `getSearchContent` default to `web_search`, `source_check`, `fetch_content`, and `get_search_content`. `workflow` sets the default search workflow: `"summary-review"` (default, opens curator with auto-generated summary draft), `"auto-summary"` (returns a model-generated summary without opening the curator), or `"none"` (raw results, no curator). Overridden per-call via the `workflow` parameter on the configured search tool, or toggled at runtime with `/curator`. `chromeProfile` pins Gemini Web cookie lookup to a specific Chromium profile. When omitted, detected Chromium profiles are scanned in stable order and the first profile containing the required Gemini cookies is used. `allowBrowserCookies` enables Chromium cookie extraction for Gemini Web; it defaults to `false` to avoid browser data access and surprise macOS Keychain prompts. You can also set `PI_ALLOW_BROWSER_COOKIES=1`. Cookie databases are copied to a temporary read-only working copy; the reader uses `node:sqlite` when available and otherwise tries the `sqlite3` CLI or Python's standard-library SQLite module. `searchModel` overrides the Gemini API model used by the configured search tool without changing URL, YouTube, or video extraction defaults. Gemini API grounded search uses `gemini-2.5-flash` by default; set `searchModel` to choose another model. `summaryModel` sets the default model used for generating summary drafts in the curator UI and `auto-summary` mode (e.g. `"anthropic/claude-haiku-4-5"`, `"openai-codex/gpt-5.3-codex-spark"`, or `"openrouter/nvidia/nemotron-3-super-120b-a12b:free"`). When Pi `enabledModels` is configured, summaries are limited to that allowlist; if no enabled summary model is available, the tool returns a deterministic summary instead of calling an unrelated model. `curatorTimeoutSeconds` controls the initial curator idle timeout (default `20`, max `600`); users can still adjust the timer in the curator UI. `ssrf.allowRanges` lists CIDR ranges (e.g. `"198.18.0.0/15"`, `"fd00::/8"`) exempted from the SSRF guard that otherwise blocks private/reserved IP ranges. This unblocks `fetch_content`/`web_search` on hosts whose network proxy runs in TUN + fake-IP mode (Surge, Clash, Mihomo, Stash, ...), where public domains resolve into a synthetic reserved range. It is **off by default** — the guard stays fully enabled unless you list ranges here. Use the narrowest range that covers your proxy's fake-IP pool. All-address CIDRs such as `0.0.0.0/0` and `::/0` are rejected. `ssrf.trustEnvProxy` is a separate opt-in for sandboxed environments with valid HTTP(S) proxy env vars; it skips local DNS preflight only for proxied hostnames and still blocks localhost, literal private IPs, and `NO_PROXY` matches. It does not configure proxy transport.

### All providers

Set `provider: "all"` on `web_search` or `source_check`, or configure `"provider": "all"` as the default, to run the same query against every eligible search provider simultaneously. AnySearch is always excluded from this mode because it is explicit-only. Exa remains eligible through its zero-config MCP path, OpenAI can use Pi auth, and other API-backed search providers participate when their API key, local endpoint, or gateway makes them available. Browser-cookie access alone does not opt Gemini into `all`; select Gemini explicitly or configure its API/gateway. Firecrawl is an extraction backend, not a search provider, so it is not part of `all`.

Successful provider answers are preserved separately while source URLs and inline content are deduplicated, and one provider failure does not discard the other results. If every participating provider fails, the tool returns per-provider diagnostics. In the Curator, **All** can also be selected like the other provider buttons. Each participating provider gets its own result card, including a provider badge and independent selection checkbox; failed providers get their own disabled error card. The final summary is generated from the selected provider cards and is what Pi receives. Outside the Curator, the same provider answers remain available as labeled sections in one tool response.

### TinyFish

`tinyfishApiKey` enables the TinyFish Search and Fetch APIs; alternatively, set `TINYFISH_API_KEY`. Get an API key from the [TinyFish API Keys](https://agent.tinyfish.ai/api-keys) page. Like the other provider keys, `tinyfishApiKey` can contain a literal key, an environment-variable reference, or a trusted command credential source:

```json
{
  "tinyfishApiKey": "$TINYFISH_API_KEY",
  "provider": "tinyfish"
}
```

Setting `provider` is optional. In `auto` mode, an available TinyFish provider is tried after Parallel and before Tavily. You can also select it per request with `provider: "tinyfish"` or place `"tinyfish"` in `searchRouting.providers`.

TinyFish Search supports the shared `numResults`, `recencyFilter`, and include/exclude `domainFilter` options. Requests above 10 results use TinyFish pagination. When `includeContent` is true, result URLs are sent to TinyFish Fetch in batches of up to 10 and returned as inline Markdown content. TinyFish Fetch is also used as a hosted `fetch_content` fallback after Jina Reader and before Parallel.

The stable Search (`https://api.search.tinyfish.ai`) and Fetch (`https://api.fetch.tinyfish.ai`) endpoints are built in, so no base URL setting is required. TinyFish currently documents both APIs as credit-free, with Free-plan limits of 30 search requests per minute and 150 fetched URLs per minute; an API key is still required. See the [TinyFish Search reference](https://docs.tinyfish.ai/search-api/reference) and [TinyFish Fetch reference](https://docs.tinyfish.ai/fetch-api/reference).

### AnySearch

AnySearch is an explicit-only provider: it is never included in zero-config `auto` fallback or in `provider: "all"`, but it can be selected with `provider: "anysearch"`, configured as the named provider, or placed in `searchRouting`. It supports anonymous requests and optional `anysearchApiKey` / `ANYSEARCH_API_KEY` credentials. Requests intentionally send only `{ query, max_results }`; `recencyFilter`, `domainFilter`, and `includeContent` do not add API request parameters. When `includeContent` is true, returned `content` fields are exposed as inline content.

### SERPdive

`serpdiveApiKey` enables the SERPdive provider; get a key at [serpdive.com](https://serpdive.com/dashboard/keys). `serpdiveModel` (or `SERPDIVE_MODEL`) picks the retrieval depth:

| Model | Cost | What comes back |
| --- | --- | --- |
| `krill` (default) | free, fair use | Extracted page content. No API-side answer synthesis — the answer is assembled from the sources, as for Brave and SearXNG. |
| `mako` | 1 credit | The fact-carrying sentences of each page, plus a synthesized answer. |
| `moby` | 1.5 credits | The full readable content of every page, plus a cited answer. |

The model is the only thing that decides retrieval depth: `includeContent` controls whether that content is also returned inline, it never changes the model. For full page text, set `serpdiveModel` to `moby` yourself. The default is the free tier on purpose: installing this provider never starts spending on your behalf. An unrecognised value falls back to `krill` rather than failing, so a typo cannot cost money. Current pricing: [serpdive.com/pricing](https://serpdive.com/pricing).

Two behaviours worth knowing, both consequences of the API surface:

- **Recency is a hint, not a filter.** SERPdive exposes no time-range parameter. `recencyFilter` is appended to the question ("past week"), which biases ranking toward recent pages; results outside the window can still come back.
- **Domain filters are applied locally.** SERPdive has no include/exclude domain parameter, so `domainFilter` is applied to the results that come back. It can narrow a page of results, not ask the engine for more from a given domain.

`numResults` maps to `max_results`, which the API treats as a cap between 1 and 10 — never a minimum. Values above 10 are clamped; the engine returns what it judges relevant, which is often fewer.

### Shortcuts

Both shortcuts are configurable via `~/.pi/web-search.json`:

```json
{
  "shortcuts": {
    "curate": "ctrl+shift+s",
    "activity": "ctrl+shift+w"
  }
}
```

Values use the same format as pi keybindings (e.g. `ctrl+s`, `ctrl+shift+s`, `alt+r`). Changes take effect on next pi restart.

Set `"enabled": false` under any feature to disable it. For GitHub specifically, `githubClone.enabled: false` only skips clone/API specialization; it does not unregister `fetch_content` or block generic URL extraction. Config changes require a Pi restart.

Rate limits: Perplexity is capped at 10 requests/minute (client-side). TinyFish applies the plan limits documented by its API. Content fetches run 3 concurrent with a 30s timeout per URL.

## Limitations

- If the curator cannot open a browser automatically, such as in Docker, WSL, SSH, or headless environments, the running curator URL is shown in the tool output. Copy it into a browser that can reach the Pi host, or use a tunnel/port-forward when needed.
- Chromium cookie extraction for Gemini Web is opt-in via `allowBrowserCookies: true` or `PI_ALLOW_BROWSER_COOKIES=1`; no browser data or password store is touched while it is disabled. On macOS, enabling it may trigger a Keychain dialog. Required cookie names are checked before password-store access, and browser encryption passwords are cached only in-process. If `node:sqlite` is unavailable, the reader falls back to the `sqlite3` CLI or Python stdlib; `/google-account` reports a sanitized SQLite/profile/password diagnostic when extraction fails.
- YouTube private/age-restricted videos may fail on all extraction paths.
- Gemini can process videos up to ~1 hour; longer videos may be truncated.
- PDFs are text-extracted only (no OCR for scanned documents).
- GitHub branch names with slashes may misresolve file paths; the clone still works and the agent can navigate manually.
- Non-code GitHub URLs (issues, PRs, wiki) fall through to normal web extraction.

<details>
<summary>Files</summary>

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry, tool definitions, commands, widget |
| `curator-page.ts` | HTML/CSS/JS generation for the curator UI with markdown rendering |
| `curator-server.ts` | Ephemeral HTTP server with SSE streaming and state machine |
| `summary-review.ts` | Summary prompt construction, model-based draft generation, and deterministic fallback summary |
| `openai-search.ts` | OpenAI Responses API web search provider with Codex/API-key auth |
| `brave.ts` | Brave Search API provider |
| `parallel.ts` | Parallel search provider and extraction fallback |
| `tinyfish.ts` | TinyFish Search and Fetch API provider |
| `tavily.ts` | Tavily Search API provider |
| `serpdive.ts` | SERPdive Search API provider |
| `anysearch.ts` | Explicit-only AnySearch search provider |
| `searxng.ts` | Self-hosted SearXNG JSON API search provider |
| `exa.ts` | Exa.ai search provider — direct API and MCP proxy |
| `extract.ts` | URL/file path routing, HTTP extraction, fallback orchestration |
| `gemini-search.ts` | Single-provider, ordered-fallback, and simultaneous all-provider search aggregation |
| `gemini-url-context.ts` | Gemini URL Context + Web extraction fallbacks |
| `gemini-web.ts` | Gemini Web client (cookie auth, StreamGenerate) |
| `gemini-web-config.ts` | Gemini Web profile and browser-cookie opt-in config |
| `gemini-api.ts` | Gemini REST API client (generateContent) |
| `chrome-cookies.ts` | macOS/Linux Chromium-based cookie extraction (Keychain/secret-tool + SQLite) |
| `youtube-extract.ts` | YouTube detection, three-tier extraction, frame extraction |
| `video-extract.ts` | Local video detection, Files API upload, Gemini analysis |
| `github-extract.ts` | GitHub URL parsing, clone cache, content generation |
| `github-api.ts` | GitHub API fallback for large repos and commit SHAs |
| `perplexity.ts` | Perplexity API client with rate limiting |
| `pdf-extract.ts` | PDF text extraction, saves to markdown |
| `rsc-extract.ts` | RSC flight data parser for Next.js pages |
| `utils.ts` | Shared formatting and error helpers |
| `storage.ts` | Session-aware result storage |
| `activity.ts` | Activity tracking for the observability widget |

</details>
