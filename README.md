<p>
  <img src="banner.png" alt="pi-web-access" width="1100">
</p>

# Pi Web Access

**Web search, content extraction, and video understanding for Pi agent. OpenAI/Codex search, zero-config Exa search, Brave, Parallel, Tavily, self-hosted SearXNG and Firecrawl, optional browser-cookie Gemini Web, or bring your own API keys.**

[![npm version](https://img.shields.io/npm/v/pi-web-access?style=for-the-badge)](https://www.npmjs.com/package/pi-web-access)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows*-blue?style=for-the-badge)]()

https://github.com/user-attachments/assets/cac6a17a-1eeb-4dde-9818-cdf85d8ea98f

## Why Pi Web Access

**Zero Config** — Works out of the box with Exa MCP (no API key needed). If you're signed into Pi with a Codex subscription, OpenAI web search can reuse that auth. Add API keys for OpenAI, Brave, Parallel, Tavily, Exa, Perplexity, or Gemini API for more control; configure self-hosted SearXNG or Firecrawl endpoints for private search and extraction; or opt into browser-cookie access for Gemini Web.

**Video Understanding** — Point it at a YouTube video or local screen recording and ask questions about what's on screen. Full transcripts, visual descriptions, and frame extraction at exact timestamps.

**Smart Fallbacks** — Every capability has a fallback chain. Search tries configured SearXNG first for local/private search, then OpenAI when suitable and available, Exa, Firecrawl, Brave, Parallel, Tavily, Perplexity, Gemini API, and Gemini Web when browser cookies are enabled. With no SearXNG configured, the existing zero-config order is unchanged. YouTube tries Gemini Web when enabled, then API, then Perplexity. Blocked pages retry through Jina Reader, Firecrawl, Parallel, and Gemini extraction. Something always works.

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
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza..."
}
```

In `auto` mode (default), `web_search` tries a configured SearXNG endpoint first for local/private search, then OpenAI when suitable and available, Exa (direct API if keyed, MCP if not), Firecrawl, Brave, Parallel, Tavily, Perplexity, Gemini API, and Gemini Web when browser-cookie access is enabled. With no SearXNG configured, the existing zero-config order is unchanged. Exa handles search; curator summary drafts are generated separately by the configured Pi summary model. Slow summary drafts fall back to a deterministic result summary after a bounded deadline.

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

Search the web via OpenAI, Brave, Parallel, Tavily, self-hosted SearXNG, Exa, Perplexity AI, or Gemini. Returns a synthesized answer with source citations.

```typescript
web_search({ query: "rust async programming" })
web_search({ queries: ["query 1", "query 2"] })
web_search({ query: "latest news", numResults: 10, recencyFilter: "week" })
web_search({ query: "...", domainFilter: ["github.com"] })
web_search({ query: "...", provider: "openai" })
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
| `provider` | Configured provider when omitted or set to `auto`; otherwise `openai`, `brave`, `parallel`, `tavily`, `searxng`, `firecrawl`, `exa`, `perplexity`, or `gemini` (auto-selects when no provider is configured) |
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

When Readability fails or returns only a cookie notice, the extension retries via Jina Reader (handles JS rendering server-side, no API key needed), then Gemini URL Context API, then Gemini Web extraction when browser cookies are enabled. Handles SPAs, JS-heavy pages, and anti-bot protections transparently. Also parses Next.js RSC flight data when present.

## How It Works

```
web_search(query)
  → Exa (direct API with key, MCP without) → Perplexity → Gemini API → Gemini Web (if browser cookies enabled)

fetch_content(url)
  → Video file?  Gemini API (Files API) → Gemini Web (if browser cookies enabled)
  → GitHub URL?  Clone repo, return file contents + local path
  → YouTube URL? Gemini Web (if browser cookies enabled) → Gemini API → Perplexity
  → HTTP fetch → PDF? Extract text, save to ~/Downloads/
               → HTML? Readability → RSC parser → Jina Reader → Gemini fallback
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
  "braveApiKey": "BSA_...",
  "exaApiKey": "exa-...",
  "parallelApiKey": "...",
  "tavilyApiKey": "tvly-...",
  "firecrawlBaseUrl": "http://127.0.0.1:3002",
  "firecrawlApiKey": "fc-...",
  "firecrawlApiVersion": "v2",
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza...",
  "geminiBaseUrl": "https://my-gateway.example.com/gemini",
  "cloudflareApiKey": "...",
  "provider": "openai",
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

All provider API-key fields (`openaiApiKey`, `braveApiKey`, `parallelApiKey`, `tavilyApiKey`, `exaApiKey`, `perplexityApiKey`, `geminiApiKey`, and `cloudflareApiKey`) accept explicit credential sources. Use `$NAME` or `${NAME}` to read one named environment variable, or prefix a trusted local shell command with `!` to resolve one value at provider request time. Escape `$$` as a literal leading `$` and `$!` as a literal leading `!`:

```json
{
  "openaiApiKey": "!/absolute/path/to/secret-manager read openai",
  "braveApiKey": "${SCOPED_BRAVE_API_KEY}",
  "exaApiKey": "$$literal-key",
  "geminiApiKey": "$!literal-command"
}
```

This syntax applies to provider credentials only; other configuration fields are not interpolated.

A command source is not run while the extension loads or registers tools. Each selected provider request runs it again with a five-second timeout, a 16 KiB output limit, a minimized environment, and a one-line non-empty stdout requirement. Command text and stderr are omitted from errors. These commands are trusted local configuration, not a same-user process isolation boundary; use absolute executable paths and protect the config file. `OP_SESSION_*` variables are forwarded to trusted resolver commands so shell-local 1Password sessions can be reused without storing them in config. An explicit source overrides legacy provider environment variables and fails that provider locally rather than falling back with a stale credential. Direct Google Gemini API requests send the resolved key only in the `x-goog-api-key` header, never in the URL.

Set `searxngBaseUrl` or `SEARXNG_BASE_URL` to use a self-hosted SearXNG JSON API. A configured endpoint is preferred first in `auto` mode for local/private search. Its base URL and redirects remain subject to the SSRF guard; add only the narrowest self-hosted range to `ssrf.allowRanges` when it resolves to a private or synthetic range. Thanks to Marcos A. Núñez (@marnunez) for PR #107 and Avinash Kanaujiya (@avinashkanaujiya) for issue #105.

Set `firecrawlBaseUrl` or `FIRECRAWL_BASE_URL` (an IP or hostname — `localhost` is always blocked by the SSRF guard) to use a self-hosted [Firecrawl](https://github.com/firecrawl/firecrawl) instance for both search (`/search`) and content extraction (`/scrape`). `firecrawlApiKey` / `FIRECRAWL_API_KEY` is sent as a Bearer token and may be omitted for instances that run without auth. `firecrawlApiVersion` / `FIRECRAWL_API_VERSION` selects the API surface, `"v2"` (default, current Firecrawl) or `"v1"` for older self-hosted images; any other value is rejected. Firecrawl is tried after Exa in `auto` search — a base URL alone does not imply working search, since self-hosted `/search` needs its own search backend (for example SearXNG) configured in the Firecrawl deployment — and after Jina Reader in the `fetch_content` fallback chain. Scrape targets must pass the local SSRF guard before Firecrawl is called at all, so it cannot be used to reach private addresses. The instance's own base URL and redirects are guarded the same way as SearXNG's, so a self-hosted instance on a private address needs its range added to `ssrf.allowRanges`. Recency filters map to Firecrawl `tbs` values (`day`/`week`/`month`/`year`). Refs #105.

Without an explicit `$` or `!` source, `OPENAI_API_KEY`, `BRAVE_API_KEY`, `PARALLEL_API_KEY`, `TAVILY_API_KEY`, `FIRECRAWL_BASE_URL`, `FIRECRAWL_API_KEY`, `EXA_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, and `CLOUDFLARE_API_KEY` env vars retain their existing precedence over literal config file values. Configured Exa API keys use Exa's own account limits directly; any legacy local `exa-usage.json` file is ignored. `GOOGLE_GEMINI_BASE_URL` overrides the Gemini API host for Gemini generate-content calls such as search, URL context, YouTube, and local video analysis. Set it to a bare host with no trailing slash and no version segment, for example `https://my-gateway.example.com/gemini`; `geminiBaseUrl` is the config-file equivalent. When the configured host contains `gateway.ai.cloudflare.com`, authentication uses `cf-aig-authorization: Bearer <token>` from `CLOUDFLARE_API_KEY` or `cloudflareApiKey`, and `GEMINI_API_KEY` is not required for generate-content calls. Local video file upload still uses Google's Files API directly, so gateway-only video extraction falls back to Gemini Web unless a `GEMINI_API_KEY` is also configured. `provider` sets the default search provider and is used when a tool call omits `provider` or sends `"auto"`: `"openai"`, `"brave"`, `"parallel"`, `"tavily"`, `"searxng"`, `"firecrawl"`, `"exa"`, `"perplexity"`, or `"gemini"`. This is also updated automatically when you change the provider in the curator UI. Set `webSearch.enabled` to `false` to unregister the configured search and source-check tools while leaving fetch/content tools available. `toolNames` can opt into alternate public tool names for environments where another extension or model reserves the defaults, without changing behavior: `webSearch`, `sourceCheck`, `fetchContent`, and `getSearchContent` default to `web_search`, `source_check`, `fetch_content`, and `get_search_content`. `workflow` sets the default search workflow: `"summary-review"` (default, opens curator with auto-generated summary draft), `"auto-summary"` (returns a model-generated summary without opening the curator), or `"none"` (raw results, no curator). Overridden per-call via the `workflow` parameter on the configured search tool, or toggled at runtime with `/curator`. `chromeProfile` pins Gemini Web cookie lookup to a specific Chromium profile. When omitted, detected Chromium profiles are scanned in stable order and the first profile containing the required Gemini cookies is used. `allowBrowserCookies` enables Chromium cookie extraction for Gemini Web; it defaults to `false` to avoid browser data access and surprise macOS Keychain prompts. You can also set `PI_ALLOW_BROWSER_COOKIES=1`. Cookie databases are copied to a temporary read-only working copy; the reader uses `node:sqlite` when available and otherwise tries the `sqlite3` CLI or Python's standard-library SQLite module. `searchModel` overrides the Gemini API model used by the configured search tool without changing URL, YouTube, or video extraction defaults. Gemini API grounded search uses `gemini-2.5-flash` by default; set `searchModel` to choose another model. `summaryModel` sets the default model used for generating summary drafts in the curator UI and `auto-summary` mode (e.g. `"anthropic/claude-haiku-4-5"`, `"openai-codex/gpt-5.3-codex-spark"`, or `"openrouter/nvidia/nemotron-3-super-120b-a12b:free"`). When Pi `enabledModels` is configured, summaries are limited to that allowlist; if no enabled summary model is available, the tool returns a deterministic summary instead of calling an unrelated model. `curatorTimeoutSeconds` controls the initial curator idle timeout (default `20`, max `600`); users can still adjust the timer in the curator UI. `ssrf.allowRanges` lists CIDR ranges (e.g. `"198.18.0.0/15"`, `"fd00::/8"`) exempted from the SSRF guard that otherwise blocks private/reserved IP ranges. This unblocks `fetch_content`/`web_search` on hosts whose network proxy runs in TUN + fake-IP mode (Surge, Clash, Mihomo, Stash, ...), where public domains resolve into a synthetic reserved range. It is **off by default** — the guard stays fully enabled unless you list ranges here. Use the narrowest range that covers your proxy's fake-IP pool. All-address CIDRs such as `0.0.0.0/0` and `::/0` are rejected. `ssrf.trustEnvProxy` is a separate opt-in for sandboxed environments with valid HTTP(S) proxy env vars; it skips local DNS preflight only for proxied hostnames and still blocks localhost, literal private IPs, and `NO_PROXY` matches. It does not configure proxy transport.

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

Rate limits: Perplexity is capped at 10 requests/minute (client-side). Content fetches run 3 concurrent with a 30s timeout per URL.

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
| `tavily.ts` | Tavily Search API provider |
| `searxng.ts` | Self-hosted SearXNG JSON API search provider |
| `firecrawl.ts` | Self-hosted Firecrawl search and content extraction provider |
| `exa.ts` | Exa.ai search provider — direct API and MCP proxy |
| `extract.ts` | URL/file path routing, HTTP extraction, Firecrawl extraction fallback, orchestration |
| `gemini-search.ts` | Search routing across SearXNG, OpenAI, Exa, Firecrawl, Brave, Parallel, Tavily, Perplexity, Gemini API, Gemini Web |
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
