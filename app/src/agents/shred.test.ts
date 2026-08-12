/**
 * Shred tests with the model call stubbed out.
 *
 * What is under test is everything the product's credibility rests on and the
 * model is not responsible for: that a page citation comes from the block the
 * text was actually found in, that text we cannot re-find is flagged rather
 * than quietly kept, and that a clause appearing in two sections is emitted
 * once.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { shred, type RawRequirement, type SectionExtractor } from "./shred.ts";
import type { ParsedBlock, ParsedDocument } from "../parse/types.ts";

const WSIB = "The Proponent shall provide evidence of WSIB clearance prior to award.";
const INSURANCE = "The Proponent must hold $5,000,000 commercial general liability insurance.";

/**
 * Builds a document whose text layer agrees with its blocks — the normal case.
 * Tests that care about the two disagreeing pass `pageText` explicitly.
 */
function doc(blocks: ParsedBlock[], pageText?: string[]): ParsedDocument {
  const pages = pageText ?? buildPageText(blocks, 40);
  return { pageCount: 40, blocks, pageText: pages };
}

function buildPageText(blocks: ParsedBlock[], pageCount: number): string[] {
  const pages = new Array<string>(pageCount).fill("");
  for (const block of blocks) {
    pages[block.page - 1] = `${pages[block.page - 1] ?? ""}\n${block.text}`;
  }
  return pages;
}

function block(text: string, page: number, kind: ParsedBlock["kind"] = "paragraph"): ParsedBlock {
  return { id: `b${page}`, page, kind, level: kind === "heading" ? 1 : null, text };
}

function raw(partial: Partial<RawRequirement> & { verbatim: string }): RawRequirement {
  return {
    verbatim: partial.verbatim,
    type: partial.type ?? "mandatory",
    owner: partial.owner ?? "customer",
    evidenceNeeded: partial.evidenceNeeded ?? [],
    ...(partial.id === undefined ? {} : { id: partial.id }),
    ...(partial.points === undefined ? {} : { points: partial.points }),
  };
}

/** Returns the same extractions for every section. */
function stub(items: RawRequirement[]): SectionExtractor {
  return async () => items;
}

test("page is derived from where the text was found, not from the model", async () => {
  // The section starts on page 20, but the clause is on page 27. A model asked
  // to report the page would have to count; we look it up instead.
  const document = doc([
    block("3. Submission Requirements", 20, "heading"),
    block("Some preamble about the submission process.", 20),
    block(WSIB, 27),
  ]);

  const { requirements } = await shred({ document, extract: stub([raw({ verbatim: WSIB })]) });

  assert.equal(requirements.length, 1);
  assert.equal(requirements[0]?.sourcePage, 27);
  assert.equal(requirements[0]?.anchored, true);
});

test("text that cannot be re-found is flagged unanchored, not dropped", async () => {
  const document = doc([block(WSIB, 27)]);
  const invented = "The Contractor shall supply a bid bond of ten percent of the total price.";

  const { requirements, stats } = await shred({
    document,
    extract: stub([raw({ verbatim: WSIB }), raw({ verbatim: invented })]),
  });

  assert.equal(requirements.length, 2);
  assert.equal(stats.unanchored, 1);

  const unanchored = requirements.find((r) => !r.anchored);
  assert.equal(unanchored?.verbatim, invented);
  // Falls back to the section's first page rather than claiming a precise one.
  assert.equal(unanchored?.sourcePage, 27);
});

test("anchoring tolerates PDF whitespace and hyphenation", async () => {
  // What the PDF's text layer holds versus what the model copied out of it.
  const document = doc([
    block("The Proponent shall provide evidence of WSIB clear-\nance prior to award.", 12),
  ]);

  const { requirements, stats } = await shred({
    document,
    extract: stub([raw({ verbatim: WSIB })]),
  });

  assert.equal(stats.unanchored, 0);
  assert.equal(requirements[0]?.sourcePage, 12);
});

test("the PDF text layer, not the parsed block, decides whether text is real", async () => {
  // The parser invented a clause that is not in the document. Anchoring against
  // blocks would call this verified; anchoring against the PDF catches it.
  const hallucinated = "The Proponent shall maintain ISO 9001 certification at all times.";
  const document = doc(
    [block(WSIB, 8), block(hallucinated, 8)],
    buildPageText([block(WSIB, 8)], 40),
  );

  const { requirements, stats } = await shred({
    document,
    extract: stub([raw({ verbatim: WSIB }), raw({ verbatim: hallucinated })]),
  });

  assert.equal(stats.unanchored, 1);
  assert.equal(requirements.find((r) => r.verbatim === hallucinated)?.anchored, false);
  assert.equal(requirements.find((r) => r.verbatim === WSIB)?.anchored, true);
});

test("a scanned page falls back to blocks and is reported as unverifiable", async () => {
  // No text layer anywhere: the check is weaker, so say so rather than
  // reporting a clean anchor rate that means nothing.
  const document = doc([block(WSIB, 3)], new Array<string>(40).fill(""));

  const { requirements, stats } = await shred({
    document,
    extract: stub([raw({ verbatim: WSIB })]),
  });

  assert.equal(requirements[0]?.anchored, true);
  assert.equal(requirements[0]?.sourcePage, 3);
  assert.equal(stats.unverifiablePages, 40);
  assert.equal(stats.unanchored, 0);
});

test("the same clause surfacing in two sections is emitted once", async () => {
  const document = doc([
    block("3. Requirements", 5, "heading"),
    block(WSIB, 5),
    block("9. Summary of Mandatories", 60, "heading"),
    block(WSIB, 60),
  ]);

  const { requirements, stats } = await shred({
    document,
    extract: stub([raw({ verbatim: WSIB })]),
  });

  assert.equal(requirements.length, 1);
  assert.equal(stats.extracted, 2);
  assert.equal(stats.duplicates, 1);
});

test("requirements come back ordered by page, with the section trail attached", async () => {
  const document = doc([
    block("3. Requirements", 5, "heading"),
    block(INSURANCE, 30),
    block(WSIB, 12),
  ]);

  const { requirements } = await shred({
    document,
    extract: stub([raw({ verbatim: INSURANCE }), raw({ verbatim: WSIB })]),
  });

  assert.deepEqual(
    requirements.map((r) => r.sourcePage),
    [12, 30],
  );
  assert.deepEqual(requirements[0]?.sectionPath, ["3. Requirements"]);
});

test("stats count mandatories and pages for the agent log", async () => {
  const document = doc([block(WSIB, 3), block(INSURANCE, 4)]);

  const { stats } = await shred({
    document,
    extract: stub([
      raw({ verbatim: WSIB, type: "mandatory" }),
      raw({ verbatim: INSURANCE, type: "rated", points: 10 }),
    ]),
  });

  assert.equal(stats.mandatory, 1);
  assert.equal(stats.extracted, 2);
  assert.equal(stats.pageCount, 40);
});

test("blank verbatim is discarded rather than stored as a requirement", async () => {
  const document = doc([block(WSIB, 3)]);

  const { requirements } = await shred({
    document,
    extract: stub([raw({ verbatim: "   " }), raw({ verbatim: WSIB })]),
  });

  assert.equal(requirements.length, 1);
  assert.equal(requirements[0]?.verbatim, WSIB);
});
