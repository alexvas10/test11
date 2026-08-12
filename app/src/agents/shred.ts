/**
 * Shred Agent — decomposes a solicitation into a structured requirement tree.
 *
 * This is the technical core of the product. Everything downstream (bid/no-bid,
 * drafting, the compliance audit, the matrix the customer submits) cites what
 * comes out of here, so two properties matter more than anything else:
 *
 *   1. Recall on mandatory requirements. A missed mandatory item is a
 *      disqualification, and the customer will not discover it until they lose.
 *   2. Verbatim fidelity. The model returns copied text, never a paraphrase,
 *      and we re-find that text in the source afterwards. An unanchored
 *      requirement is a hallucination and is marked as one.
 *
 * Page numbers are derived mechanically from the block the text was found in,
 * not taken from the model's answer. Asking a language model to count pages is
 * asking for a plausible number, and a wrong page citation is worse than none:
 * it is the thing that makes a customer stop trusting the matrix.
 */

import { recordAgentRun, type AgentRunContext } from "../lib/agentlog.ts";
import { generateJson } from "../lib/gemini.ts";
import { normalizedIncludes, normalize } from "../lib/text.ts";
import type { Requirement, RequirementType } from "../lib/types.ts";
import type { ParsedBlock, ParsedDocument } from "../parse/types.ts";

/** Character budget per extraction call. Sections larger than this get split. */
const SECTION_MAX_CHARS = Number(process.env.SHRED_SECTION_CHARS ?? "12000");

/** Sections extracted concurrently. Low by default to stay under the free tier's RPM limit. */
const CONCURRENCY = Number(process.env.SHRED_CONCURRENCY ?? "2");

const SYSTEM_INSTRUCTION = `You extract requirements from public-sector and enterprise solicitations (RFPs, RFQs, ITTs, tenders) for a firm that must respond to every one of them.

Your output is used to build a compliance matrix. A requirement you miss becomes a disqualified bid. A requirement you invent destroys the customer's trust in the whole document.

RULES

1. VERBATIM ONLY. The "verbatim" field must be an exact character-for-character copy of a contiguous span of the source text. Never summarise, never paraphrase, never fix grammar, never merge two sentences, never expand an abbreviation. If you cannot copy it exactly, do not emit it.

2. ONE OBLIGATION PER RECORD. "The Proponent shall provide evidence of WSIB clearance and a certificate of insurance" is one record only if the source states it as one clause. A numbered list of five items is five records.

3. EXTRACT OBLIGATIONS, NOT PROSE. Emit a record when the text imposes something on the bidder: something they must do, provide, hold, sign, submit, comply with, or be scored on. Background about the issuing organisation is not a requirement. Definitions are not requirements. Do not emit boilerplate that binds nobody.

4. CLASSIFY:
   - "mandatory": pass/fail. Signalled by shall, must, is required to, will be deemed non-compliant, mandatory. Non-compliance means rejection.
   - "rated": scored against evaluation criteria, usually with points or weighting stated.
   - "form": a schedule, appendix, form, certificate or attachment to be completed, signed and returned.
   - "informational": binds the bidder but is neither scored nor pass/fail — timelines, contact protocol, contract terms they accept by bidding.
   When a clause is both mandatory and scored, classify it "rated" and let the points speak.

5. FIELDS:
   - "id": the source's own clause number ("3.2.4", "B.7", "Schedule C"). null if the clause is unnumbered. Never invent one.
   - "points": the evaluation points or weight if the source states a number. Otherwise null.
   - "responseLocation": where the source says the response goes ("Appendix B", "Form 4", "Section 3 of the submission"). Otherwise null.
   - "owner": "customer" if answering needs something only the bidding firm holds — a certificate, an insurance policy, financial statements, a signature, named staff, past project references. "agent" if it can be written from knowledge of the firm and the solicitation.
   - "evidenceNeeded": concrete artefacts the bidder must produce. Name the document ("WSIB clearance certificate", "audited financial statements"). Empty array when nothing physical is required.

6. If the section contains no requirements, return an empty array. An empty array is a correct and expected answer for a table of contents, a definitions list, or a background section. Do not manufacture records to fill it.`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    requirements: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING", nullable: true },
          verbatim: { type: "STRING" },
          type: {
            type: "STRING",
            enum: ["mandatory", "rated", "informational", "form"],
          },
          responseLocation: { type: "STRING", nullable: true },
          points: { type: "NUMBER", nullable: true },
          owner: { type: "STRING", enum: ["agent", "customer"] },
          evidenceNeeded: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["verbatim", "type", "owner", "evidenceNeeded"],
      },
    },
  },
  required: ["requirements"],
} as const;

/** What the model returns, before we anchor it and derive its page. */
export interface RawRequirement {
  id?: string | null;
  verbatim: string;
  type: RequirementType;
  responseLocation?: string | null;
  points?: number | null;
  owner: "agent" | "customer";
  evidenceNeeded: string[];
}

export interface ShredResult {
  requirements: Requirement[];
  stats: ShredStats;
}

export interface ShredStats {
  sections: number;
  pageCount: number;
  extracted: number;
  /** Dropped as duplicates of a requirement already found in another section. */
  duplicates: number;
  /** Emitted but not re-found in the source text. The hallucination count. */
  unanchored: number;
  /**
   * Pages with no text layer, where the anchor check had to fall back to the
   * parsed blocks. Reported so the anchor rate is never read as stronger
   * evidence than it is on a scanned solicitation.
   */
  unverifiablePages: number;
  mandatory: number;
}

export type SectionExtractor = (
  section: Section,
  ctx: AgentRunContext,
) => Promise<RawRequirement[]>;

export interface ShredInput {
  document: ParsedDocument;
  customerId?: string | null;
  bidId?: string | null;
  /**
   * Override the model call. Exists so the surrounding logic — anchoring, page
   * derivation, deduplication — can be tested against known extractions
   * instead of against whatever the model said that day.
   */
  extract?: SectionExtractor;
}

export async function shred(input: ShredInput): Promise<ShredResult> {
  return recordAgentRun(
    {
      agent: "shred",
      customerId: input.customerId ?? null,
      bidId: input.bidId ?? null,
    },
    async (ctx) => runShred(input, ctx),
  );
}

async function runShred(input: ShredInput, ctx: AgentRunContext): Promise<ShredResult> {
  const { document } = input;
  const extract = input.extract ?? extractSection;

  const sections = groupIntoSections(document.blocks);
  const results = await mapWithConcurrency(sections, CONCURRENCY, (section) =>
    extract(section, ctx),
  );

  const requirements: Requirement[] = [];
  const seen = new Set<string>();
  let extracted = 0;
  let duplicates = 0;

  for (const [index, raw] of results.entries()) {
    const section = sections[index];
    if (!section) continue;

    for (const item of raw) {
      extracted++;

      // Overlapping context means the same clause can surface twice. Keyed on
      // normalised text so whitespace differences do not defeat it.
      const key = normalize(item.verbatim);
      if (!key || seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);

      requirements.push(toRequirement(item, section, document.pageText));
    }
  }

  requirements.sort((a, b) => a.sourcePage - b.sourcePage);

  const stats: ShredStats = {
    sections: sections.length,
    pageCount: document.pageCount,
    extracted,
    duplicates,
    unanchored: requirements.filter((r) => !r.anchored).length,
    unverifiablePages: document.pageText.filter((text) => text.trim().length === 0).length,
    mandatory: requirements.filter((r) => r.type === "mandatory").length,
  };

  ctx.decision = "SHREDDED";
  ctx.rationale =
    `${requirements.length} requirements (${stats.mandatory} mandatory) from ` +
    `${stats.pageCount} pages across ${stats.sections} sections; ` +
    `${stats.unanchored} unanchored` +
    (stats.unverifiablePages > 0
      ? `; ${stats.unverifiablePages} pages unverifiable (no text layer)`
      : "");

  return { requirements, stats };
}

function toRequirement(
  raw: RawRequirement,
  section: Section,
  pageText: string[],
): Requirement {
  const verbatim = raw.verbatim.trim();

  // Page first from the document's own text layer, which is authoritative;
  // then from the block the model produced; then the section's first page,
  // which is at worst off by the length of one section.
  const textLayerPage = findInPageText(verbatim, section, pageText);
  const blockPage = findInBlocks(verbatim, section)?.page ?? null;

  return {
    id: raw.id?.trim() || null,
    sourcePage: textLayerPage ?? blockPage ?? section.startPage,
    verbatim,
    type: raw.type,
    responseLocation: raw.responseLocation?.trim() || null,
    points: typeof raw.points === "number" ? raw.points : null,
    owner: raw.owner,
    evidenceNeeded: raw.evidenceNeeded ?? [],
    sectionPath: section.path,
    // Anchored means re-found in the PDF's own text. Where a page has no text
    // layer we fall back to the parsed block, which is a weaker check — those
    // pages are counted in `unverifiablePages` so the number is never read as
    // stronger than it is.
    anchored: textLayerPage !== null || (hasNoTextLayer(section, pageText) && blockPage !== null),
  };
}

/**
 * Searches the PDF's own text for the requirement, within the section's pages.
 *
 * Scoped to the section rather than the whole document because a clause is
 * often restated in a summary table elsewhere, and citing the restatement
 * instead of the binding clause sends the customer to the wrong page.
 */
function findInPageText(
  verbatim: string,
  section: Section,
  pageText: string[],
): number | null {
  for (let page = section.startPage; page <= section.endPage; page++) {
    const text = pageText[page - 1];
    if (text && normalizedIncludes(text, verbatim)) return page;
  }
  return null;
}

function findInBlocks(verbatim: string, section: Section): ParsedBlock | null {
  for (const block of section.blocks) {
    if (normalizedIncludes(block.text, verbatim)) return block;
  }
  return null;
}

/** True when none of the section's pages yielded any extractable text. */
function hasNoTextLayer(section: Section, pageText: string[]): boolean {
  for (let page = section.startPage; page <= section.endPage; page++) {
    if ((pageText[page - 1] ?? "").trim().length > 0) return false;
  }
  return true;
}

async function extractSection(
  section: Section,
  ctx: AgentRunContext,
): Promise<RawRequirement[]> {
  const heading = section.path.length ? section.path.join(" > ") : "(no heading)";
  const prompt = [
    `SOLICITATION SECTION: ${heading}`,
    `Pages ${section.startPage}-${section.endPage}.`,
    "",
    "SOURCE TEXT:",
    section.text,
  ].join("\n");

  const result = await generateJson<{ requirements: RawRequirement[] }>({
    systemInstruction: SYSTEM_INSTRUCTION,
    prompt,
    responseSchema: RESPONSE_SCHEMA as never,
    ctx,
  });

  return result.requirements ?? [];
}

export interface Section {
  path: string[];
  blocks: ParsedBlock[];
  text: string;
  startPage: number;
  endPage: number;
}

/**
 * Groups blocks into extraction units.
 *
 * A section break happens at a heading, because a heading is where the
 * document itself says the subject changed. Sections longer than the character
 * budget are split, and a split carries the heading trail forward — a clause
 * that lands in part 2 of "5. Mandatory Submission Requirements" still has to
 * be read as a mandatory submission requirement.
 */
export function groupIntoSections(
  blocks: ParsedBlock[],
  maxChars = SECTION_MAX_CHARS,
): Section[] {
  const sections: Section[] = [];
  let path: string[] = [];
  let current: ParsedBlock[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const pages = current.map((b) => b.page);
    sections.push({
      path: [...path],
      blocks: current,
      text: current.map(render).join("\n\n"),
      startPage: Math.min(...pages),
      endPage: Math.max(...pages),
    });
    current = [];
  };

  for (const block of blocks) {
    if (block.kind === "heading") {
      flush();
      const level = block.level ?? 1;
      // Trim the trail to this heading's depth, then push it. A level-2
      // heading replaces the previous level-2 and everything under it.
      path = path.slice(0, Math.max(0, level - 1));
      path.push(block.text);
      current.push(block);
      continue;
    }

    const projected = current.reduce((n, b) => n + b.text.length, 0) + block.text.length;
    if (projected > maxChars && current.length > 0) flush();
    current.push(block);
  }

  flush();
  return sections.filter((section) => section.text.trim().length > 0);
}

/** Tables are labelled so the model reads pipe-delimited rows as a table. */
function render(block: ParsedBlock): string {
  return block.kind === "table" ? `[TABLE]\n${block.text}` : block.text;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await fn(item);
    }
  });

  await Promise.all(workers);
  return results;
}
