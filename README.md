# Pi Web Search

An extension for [Pi coding agent](https://github.com/badlogic/pi-mono/) that adds web search and content fetching. Uses Perplexity AI for search, extracts readable content from URLs.

```typescript
web_search({ query: "TypeScript best practices 2025" })
fetch_content({ url: "https://docs.example.com/guide" })
```

## Why

AI agents need web access. Most solutions require complex setup or external services.

This extension:

- **Single API Key** - Just Perplexity. No orchestration services, no subscriptions.
- **Async Content Fetching** - Background fetch with agent notification when ready.
- **Session-Aware Storage** - Results persist across turns, isolated per session.
- **Clean Extraction** - Readability + RSC parser for markdown output, not raw HTML dumps.

## Install

```bash
# Clone to extensions directory
git clone https://github.com/nicobailon/pi-web-search ~/.pi/agent/extensions/web-search
cd ~/.pi/agent/extensions/web-search
npm install
```

Add your Perplexity API key:

```bash
# Option 1: Environment variable
export PERPLEXITY_API_KEY="pplx-..."

# Option 2: Config file
echo '{"perplexityApiKey": "pplx-..."}' > ~/.pi/web-search.json
```

Get a key at https://perplexity.ai/settings/api

**Requires:** Pi v0.37.3+

## Tools

### web_search

Search the web via Perplexity AI. Returns synthesized answer with source citations.

```typescript
// Single query
web_search({ query: "rust async programming" })

// Multiple queries (parallel)
web_search({ queries: ["query 1", "query 2"] })

// With options
web_search({
  query: "latest news",
  numResults: 10,              // Default: 5, max: 20
  recencyFilter: "week",       // day, week, month, year
  domainFilter: ["github.com"] // Prefix with - to exclude
})

// Fetch full page content (async)
web_search({ query: "...", includeContent: true })
```

When `includeContent: true`, sources are fetched in the background. Agent receives notification when ready.

### fetch_content

Fetch URL(s) and extract readable content as markdown.

```typescript
// Single URL - returns content directly
fetch_content({ url: "https://example.com/article" })

// Multiple URLs - stores content for retrieval
fetch_content({ urls: ["url1", "url2", "url3"] })
```

### get_search_content

Retrieve stored content from previous searches or fetches.

```typescript
// By response ID (from web_search or fetch_content)
get_search_content({ responseId: "abc123", urlIndex: 0 })

// By URL
get_search_content({ responseId: "abc123", url: "https://..." })

// By query (for search results)
get_search_content({ responseId: "abc123", query: "original query" })
```

## Features

### Activity Monitor (Ctrl+Shift+O)

Toggle live request/response activity:

```
─── Web Search Activity ────────────────────────────────────
  API  "typescript best practices"     200    2.1s ✓
  GET  docs.example.com/article        200    0.8s ✓
  GET  blog.example.com/post           404    0.3s ✗
  GET  news.example.com/latest         ...    1.2s ⋯
────────────────────────────────────────────────────────────
Rate: 3/10 (resets in 42s)
```

### RSC Content Extraction

Next.js App Router pages embed content as RSC (React Server Components) flight data in script tags. When Readability fails, the extension parses these JSON payloads directly, reconstructing markdown with headings, tables, code blocks, and links.

### TUI Rendering

Tool calls render with real-time progress:

```
┌─ search "TypeScript best practices 2025" ─────────────────────────┐
│ [████████░░] searching                                            │
└───────────────────────────────────────────────────────────────────┘
```

## Commands

### /search

Browse stored search results interactively.

## How It Works

```
Agent Request → Perplexity API → Synthesized Answer + Citations
                                         ↓
                              [if includeContent: true]
                                         ↓
                              Background Fetch (3 concurrent)
                                         ↓
                              Readability → Markdown
                                    ↓ (fallback)
                              RSC Parser → Markdown
                                         ↓
                              Agent Notification (triggerTurn)
```

## Rate Limits

- **Perplexity API**: 10 requests/minute (enforced client-side)
- **Content Fetch**: 3 concurrent requests, 30s timeout per URL
- **Cache TTL**: 1 hour

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry, tool definitions, commands, widget |
| `perplexity.ts` | Perplexity API client, rate limiting |
| `extract.ts` | URL fetching, content extraction |
| `rsc-extract.ts` | RSC flight data parser for Next.js pages |
| `storage.ts` | Session-aware result storage |
| `activity.ts` | Activity tracking for observability widget |

## Limitations

- Content extraction works best on article-style pages
- Heavy JS sites may not extract well (no browser rendering), though Next.js App Router pages with RSC flight data are supported
- Binary files (images, PDFs, etc.) are rejected
- Max response size: 5MB, max content length: 10,000 chars per URL (truncated)
- Requires Pi restart after config file changes
