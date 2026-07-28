import assert from "node:assert/strict";
import { after, test } from "node:test";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.GEMINI_API_KEY;
process.env.GEMINI_API_KEY = "synthetic-gemini-key";

const { extractPDFViaGemini } = await import("../gemini-pdf-extract.ts");

after(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalApiKey;
});

test("Gemini PDF conversion sends inline PDF data and normalizes valid Markdown", async () => {
  let capturedUrl = "";
  let capturedInit;
  globalThis.fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return jsonResponse({
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ text: "```markdown\n<!-- Page 1 -->\n# Sample Document\n\nFirst page.\n\n<!-- Page 2 -->\n\nSecond page.\n```" }] },
      }],
    });
  };

  const input = Uint8Array.from([1, 2, 3, 4]).buffer;
  const markdown = await extractPDFViaGemini(input, {
    pages: 5,
    maxPages: 2,
    title: "Sample Document",
  });

  assert.match(capturedUrl, /gemini-3-flash-preview:generateContent$/);
  assert.equal(new Headers(capturedInit.headers).get("x-goog-api-key"), "synthetic-gemini-key");
  const body = JSON.parse(capturedInit.body);
  assert.equal(body.contents[0].role, "user");
  assert.equal(body.contents[0].parts[0].inlineData.mimeType, "application/pdf");
  assert.equal(body.contents[0].parts[0].inlineData.data, Buffer.from(input).toString("base64"));
  assert.match(body.contents[0].parts[1].text, /pages 1 through 2/);
  assert.match(markdown, /^<!-- Page 1 -->/);
  assert.doesNotMatch(markdown, /^<!-- Page 1 -->\s*\n# Sample Document/m);
  assert.match(markdown, /<!-- Page 2 -->/);
});

test("Gemini PDF conversion supports Cloudflare AI Gateway without a direct Gemini key", async () => {
  const savedApiKey = process.env.GEMINI_API_KEY;
  const savedBaseUrl = process.env.GOOGLE_GEMINI_BASE_URL;
  const savedCloudflareKey = process.env.CLOUDFLARE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  process.env.GOOGLE_GEMINI_BASE_URL = "https://gateway.ai.cloudflare.com/v1/example/gemini";
  process.env.CLOUDFLARE_API_KEY = "synthetic-cloudflare-key";

  try {
    globalThis.fetch = async (url, init) => {
      assert.match(String(url), /^https:\/\/gateway\.ai\.cloudflare\.com\//);
      assert.equal(new Headers(init.headers).get("cf-aig-authorization"), "Bearer synthetic-cloudflare-key");
      assert.equal(new Headers(init.headers).get("x-goog-api-key"), null);
      return jsonResponse({
        candidates: [{
          finishReason: "STOP",
          content: { parts: [{ text: "<!-- Page 1 -->\nGateway result" }] },
        }],
      });
    };

    const markdown = await extractPDFViaGemini(new ArrayBuffer(1), {
      pages: 1,
      maxPages: 1,
      title: "Document",
    });
    assert.match(markdown, /Gateway result/);
  } finally {
    if (savedApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedApiKey;
    if (savedBaseUrl === undefined) delete process.env.GOOGLE_GEMINI_BASE_URL;
    else process.env.GOOGLE_GEMINI_BASE_URL = savedBaseUrl;
    if (savedCloudflareKey === undefined) delete process.env.CLOUDFLARE_API_KEY;
    else process.env.CLOUDFLARE_API_KEY = savedCloudflareKey;
  }
});

test("Gemini PDF conversion rejects truncated output", async () => {
  globalThis.fetch = async () => jsonResponse({
    candidates: [{
      finishReason: "MAX_TOKENS",
      content: { parts: [{ text: "<!-- Page 1 -->\nPartial" }] },
    }],
  });

  await assert.rejects(
    extractPDFViaGemini(new ArrayBuffer(1), { pages: 1, maxPages: 1, title: "Document" }),
    /MAX_TOKENS/,
  );
});

test("Gemini PDF conversion rejects missing or out-of-sequence page markers", async () => {
  globalThis.fetch = async () => jsonResponse({
    candidates: [{
      finishReason: "STOP",
      content: { parts: [{ text: "<!-- Page 1 -->\nFirst\n\n<!-- Page 3 -->\nThird" }] },
    }],
  });

  await assert.rejects(
    extractPDFViaGemini(new ArrayBuffer(1), { pages: 2, maxPages: 2, title: "Document" }),
    /out of sequence/,
  );
});

test("Gemini PDF conversion surfaces safety blocks and empty responses", async () => {
  globalThis.fetch = async () => jsonResponse({ promptFeedback: { blockReason: "SAFETY" } });
  await assert.rejects(
    extractPDFViaGemini(new ArrayBuffer(1), { pages: 1, maxPages: 1, title: "Document" }),
    /blocked PDF extraction: SAFETY/,
  );

  globalThis.fetch = async () => jsonResponse({ candidates: [{ finishReason: "STOP", content: { parts: [] } }] });
  await assert.rejects(
    extractPDFViaGemini(new ArrayBuffer(1), { pages: 1, maxPages: 1, title: "Document" }),
    /empty PDF extraction/,
  );
});

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
