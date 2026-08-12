/**
 * PDF structure via Gemini, on the free tier.
 *
 * Replaces Document AI's Layout Parser, which is $10 per 1,000 pages with no
 * free tier. Gemini reads PDFs natively, so the same job — headings,
 * paragraphs, tables, and the page each sits on — costs nothing during
 * development.
 *
 * The tradeoff, stated plainly: Layout Parser is a purpose-built extraction
 * model and this is a general one, so structure quality is an open question
 * rather than an assumption. That is precisely what the eval harness measures.
 * If mandatory recall on the labelled corpus is materially worse here, the
 * answer is to pay for Layout Parser, and we will know rather than guess.
 *
 * Verbatim text is NOT trusted from this path. `pageText` comes from the PDF's
 * own text layer (see pdftext.ts) and is what the shred anchors against.
 */

import { PDFDocument } from "pdf-lib";
import { recordAgentRun } from "../lib/agentlog.ts";
import { generateJson } from "../lib/gemini.ts";
import { extractPageText } from "./pdftext.ts";
import type { DocumentParser, ParsedBlock, ParsedDocument } from "./types.ts";

/** Pages per Gemini call. Small enough that page attribution stays reliable. */
const WINDOW_PAGES = Number(process.env.PARSE_WINDOW_PAGES ?? "10");

const SYSTEM_INSTRUCTION = `You convert a page range of a procurement solicitation into an ordered list of structural blocks.

You are doing layout analysis, not summarisation. Reproduce the document's text; do not condense it, do not skip clauses, and do not editorialise.

For each block emit:
- "page": the page number printed in the PDF page range you were given. The first page of the range you were given is page 1 of that range, the next is 2, and so on. Use the position of the page in the range, NOT any number printed in the document's own header or footer.
- "kind": one of "heading", "paragraph", "table", "list".
- "level": for headings, the nesting depth 1-6 based on the document's own numbering and typography. null for everything else.
- "text": the block's text.

RULES

1. Preserve numbering. If a clause begins "3.2.4", the text begins "3.2.4".

2. Tables become "kind":"table" with one row per line and cells separated by " | ", header row first. Requirements in solicitations live in tables; a table flattened into prose stops being readable as a set of discrete obligations.

3. Lists become "kind":"list", one item per line.

4. Split at every heading. Do not merge two sections into one block.

5. Skip running page headers, page footers and standalone page numbers. Keep everything else, including boilerplate.

6. Order blocks as they appear in the document, top to bottom, page by page.`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    blocks: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          page: { type: "INTEGER" },
          kind: { type: "STRING", enum: ["heading", "paragraph", "table", "list"] },
          level: { type: "INTEGER", nullable: true },
          text: { type: "STRING" },
        },
        required: ["page", "kind", "text"],
      },
    },
  },
  required: ["blocks"],
} as const;

interface RawBlock {
  page: number;
  kind: ParsedBlock["kind"];
  level?: number | null;
  text: string;
}

export class GeminiPdfParser implements DocumentParser {
  async parse(pdf: Uint8Array, label: string): Promise<ParsedDocument> {
    return recordAgentRun({ agent: "intake" }, async (ctx) => {
      const pageText = await extractPageText(pdf);
      const source = await PDFDocument.load(pdf);
      const pageCount = source.getPageCount();
      const blocks: ParsedBlock[] = [];

      for (let start = 0; start < pageCount; start += WINDOW_PAGES) {
        const end = Math.min(start + WINDOW_PAGES, pageCount);
        process.stderr.write(`[parse] ${label}: pages ${start + 1}-${end} of ${pageCount}\n`);

        const window = await slicePdf(source, start, end);
        const result = await generateJson<{ blocks: RawBlock[] }>({
          systemInstruction: SYSTEM_INSTRUCTION,
          prompt:
            `This PDF holds pages ${start + 1} to ${end} of a ${pageCount}-page solicitation. ` +
            `Return every structural block in order.`,
          responseSchema: RESPONSE_SCHEMA as never,
          pdf: window,
          ctx,
        });

        for (const raw of result.blocks ?? []) {
          const text = (raw.text ?? "").trim();
          if (!text) continue;

          // The model reports a position within the window; clamping keeps a
          // miscount from producing a page number outside the document. Every
          // page number a customer ever sees passes through this line.
          const withinWindow = clamp(Number(raw.page) || 1, 1, end - start);
          blocks.push({
            id: `b${blocks.length}`,
            page: start + withinWindow,
            kind: raw.kind,
            level: raw.kind === "heading" ? (raw.level ?? 1) : null,
            text,
          });
        }
      }

      const scanned = pageText.filter((text) => text.trim().length === 0).length;
      ctx.decision = "PARSED";
      ctx.rationale =
        `${blocks.length} blocks from ${pageCount} pages` +
        (scanned > 0 ? `; ${scanned} pages have no text layer` : "");

      return { pageCount, blocks, pageText };
    });
  }
}

async function slicePdf(
  source: PDFDocument,
  start: number,
  end: number,
): Promise<Uint8Array> {
  const slice = await PDFDocument.create();
  const indices = Array.from({ length: end - start }, (_, i) => start + i);
  const pages = await slice.copyPages(source, indices);
  for (const page of pages) slice.addPage(page);
  return slice.save();
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
