/**
 * PDF Content Extractor
 *
 * Uses Gemini for structured PDF-to-Markdown conversion when configured,
 * with unpdf as the deterministic local fallback.
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { CredentialResolutionError } from "./credential-source.ts";
import { isGeminiApiAvailable } from "./gemini-api.ts";
import { extractPDFViaGemini } from "./gemini-pdf-extract.ts";
import { getWebSearchConfigPath } from "./utils.ts";

export interface PDFExtractResult {
  title: string;
  pages: number;
  chars: number;
  outputPath: string;
}

export interface PDFExtractOptions {
  maxPages?: number;
  outputDir?: string;
  filename?: string;
  signal?: AbortSignal;
  geminiTimeoutMs?: number;
}

export interface PDFConfig {
  maxSizeMB: number;
}

export const DEFAULT_PDF_MAX_SIZE_MB = 20;
export const MAX_PDF_MAX_SIZE_MB = 50;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_OUTPUT_DIR = join(homedir(), "Downloads");
const CONFIG_PATH = getWebSearchConfigPath();

let cachedPDFConfig: PDFConfig | null = null;

export function loadPDFConfig(): PDFConfig {
  if (cachedPDFConfig) return { ...cachedPDFConfig };
  if (!existsSync(CONFIG_PATH)) {
    cachedPDFConfig = { maxSizeMB: DEFAULT_PDF_MAX_SIZE_MB };
    return { ...cachedPDFConfig };
  }

  const rawText = readFileSync(CONFIG_PATH, "utf-8");
  let raw: unknown;
  try {
    raw = JSON.parse(rawText) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
  }

  const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const pdf = root.pdf && typeof root.pdf === "object"
    ? root.pdf as Record<string, unknown>
    : {};
  const configured = pdf.maxSizeMB;
  const normalized = typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? Math.min(configured, MAX_PDF_MAX_SIZE_MB)
    : DEFAULT_PDF_MAX_SIZE_MB;

  cachedPDFConfig = { maxSizeMB: normalized };
  return { ...cachedPDFConfig };
}

async function getUnpdf() {
  if (typeof (Promise as PromiseConstructor & { try?: unknown }).try !== "function") {
    const { default: promiseTry } = await import("promise.try");
    promiseTry.shim();
  }

  const [unpdf, pdfjs] = await Promise.all([
    import("unpdf"),
    import("unpdf/pdfjs"),
  ]);
  const { VerbosityLevel } = pdfjs as typeof pdfjs & { VerbosityLevel: { ERRORS: number } };

  return { getDocumentProxy: unpdf.getDocumentProxy, VerbosityLevel };
}

/**
 * Extract text from a PDF buffer and save it to a Markdown file.
 */
export async function extractPDFToMarkdown(
  buffer: ArrayBuffer,
  url: string,
  options: PDFExtractOptions = {}
): Promise<PDFExtractResult> {
  const {
    maxPages = DEFAULT_MAX_PAGES,
    outputDir = DEFAULT_OUTPUT_DIR,
    filename,
    signal,
    geminiTimeoutMs,
  } = options;

  const safeMaxPages = Number.isFinite(maxPages)
    ? Math.max(1, Math.floor(maxPages))
    : DEFAULT_MAX_PAGES;

  const { getDocumentProxy, VerbosityLevel } = await getUnpdf();
  // PDF.js may transfer and detach the supplied ArrayBuffer. Give it a copy so
  // the original remains available for Gemini inline document input.
  const pdf = await getDocumentProxy(new Uint8Array(buffer.slice(0)), {
    verbosity: VerbosityLevel.ERRORS,
  });
  const metadata = await pdf.getMetadata();
  const metadataInfo = metadata.info && typeof metadata.info === "object"
    ? metadata.info as Record<string, unknown>
    : null;

  const metaTitle = typeof metadataInfo?.Title === "string" ? metadataInfo.Title : undefined;
  const metaAuthor = typeof metadataInfo?.Author === "string" ? metadataInfo.Author : undefined;
  const urlTitle = extractTitleFromURL(url);
  const title = metaTitle?.trim() || urlTitle;
  const pagesToExtract = Math.min(pdf.numPages, safeMaxPages);
  const truncated = pdf.numPages > safeMaxPages;

  let markdownBody: string | null = null;
  try {
    if (isGeminiApiAvailable()) {
      markdownBody = await extractPDFViaGemini(buffer, {
        pages: pdf.numPages,
        maxPages: safeMaxPages,
        title,
        ...(signal ? { signal } : {}),
        ...(geminiTimeoutMs !== undefined ? { timeoutMs: geminiTimeoutMs } : {}),
      });
    }
  } catch (err) {
    if (shouldRethrowGeminiError(err, signal)) throw err;
  }

  if (markdownBody === null) {
    const pages: { pageNum: number; text: string }[] = [];
    for (let i = 1; i <= pagesToExtract; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item: unknown) => {
          const textItem = item as { str?: string };
          return textItem.str || "";
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (pageText) pages.push({ pageNum: i, text: pageText });
    }

    const bodyLines: string[] = [];
    for (let i = 0; i < pages.length; i++) {
      if (i > 0) {
        bodyLines.push("");
        bodyLines.push(`<!-- Page ${pages[i].pageNum} -->`);
        bodyLines.push("");
      }
      bodyLines.push(pages[i].text);
    }
    markdownBody = bodyLines.join("\n");
  }

  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`> Source: ${url}`);
  lines.push(`> Pages: ${pdf.numPages}${truncated ? ` (extracted first ${pagesToExtract})` : ""}`);
  if (metaAuthor) lines.push(`> Author: ${metaAuthor}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  if (markdownBody) lines.push(markdownBody);

  if (truncated) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(`*[Truncated: Only first ${pagesToExtract} of ${pdf.numPages} pages extracted]*`);
  }

  const content = lines.join("\n");
  const outputFilename = filename || sanitizeFilename(title) + ".md";
  const outputPath = join(outputDir, outputFilename);

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, content, "utf-8");

  return {
    title,
    pages: pdf.numPages,
    chars: content.length,
    outputPath,
  };
}

function shouldRethrowGeminiError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (err instanceof CredentialResolutionError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.startsWith("Failed to parse ");
}

/** Extract a reasonable title from a URL. */
function extractTitleFromURL(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    let filename = basename(pathname, ".pdf");

    if (urlObj.hostname.includes("arxiv.org")) {
      const match = pathname.match(/\/(?:pdf|abs)\/(\d+\.\d+)/);
      if (match) filename = `arxiv-${match[1]}`;
    }

    filename = filename
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return filename || "document";
  } catch {
    return "document";
  }
}

/** Sanitize a string for use as a filename. */
function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 100)
    .replace(/^-|-$/g, "")
    || "document";
}

/** Check whether a URL or content type indicates a PDF. */
export function isPDF(url: string, contentType?: string): boolean {
  if (contentType?.includes("application/pdf")) return true;
  try {
    const urlObj = new URL(url);
    return urlObj.pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}
