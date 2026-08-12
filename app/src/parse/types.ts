/**
 * The parser boundary.
 *
 * The shred agent talks to this interface, never to Document AI directly. Two
 * reasons: the eval harness can replay a cached parse without calling a paid
 * API on every run, and swapping the parser (a different processor, a local
 * fallback) does not touch extraction logic.
 */

export type BlockKind = "heading" | "paragraph" | "table" | "list";

export interface ParsedBlock {
  /** Stable within a parse. Used to trace a requirement back to its block. */
  id: string;
  /** 1-based page in the original PDF. */
  page: number;
  kind: BlockKind;
  /** 1-6 for headings, null otherwise. Drives section grouping. */
  level: number | null;
  /**
   * Block text. Tables are rendered as pipe-delimited rows rather than flowed
   * prose — solicitation requirements live in tables, and a table flattened
   * into a sentence stops being readable as a set of discrete obligations.
   */
  text: string;
}

export interface ParsedDocument {
  pageCount: number;
  blocks: ParsedBlock[];
  /**
   * Raw text of each page, index 0 = page 1, taken from the PDF's own text
   * layer without a model in the loop.
   *
   * This is the ground truth the shred's anchor check runs against. Blocks come
   * from a model, so checking extracted requirements against blocks would only
   * prove that two model calls agreed with each other — which looks like
   * verification and is not. An empty string means the page had no text layer
   * (a scan), and the shred counts those separately rather than passing them.
   */
  pageText: string[];
}

export interface DocumentParser {
  parse(pdf: Uint8Array, label: string): Promise<ParsedDocument>;
}
