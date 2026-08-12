/**
 * Tests for the parts of the pipeline that do not need an API key: section
 * grouping, text normalisation, and the scorer.
 *
 * The scorer decides whether a prompt change was an improvement, so a bug in
 * here is worse than a bug in the agent — it would make every future decision
 * about the agent wrong.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { groupIntoSections } from "../agents/shred.ts";
import { normalize, overlapF1 } from "../lib/text.ts";
import type { Requirement } from "../lib/types.ts";
import type { ParsedBlock } from "../parse/types.ts";
import { anchorRate, score, type LabelSet } from "./score.ts";

function block(partial: Partial<ParsedBlock> & { text: string }): ParsedBlock {
  return {
    id: partial.id ?? "b",
    page: partial.page ?? 1,
    kind: partial.kind ?? "paragraph",
    level: partial.level ?? null,
    text: partial.text,
  };
}

function requirement(partial: Partial<Requirement> & { verbatim: string }): Requirement {
  return {
    id: partial.id ?? null,
    sourcePage: partial.sourcePage ?? 1,
    verbatim: partial.verbatim,
    type: partial.type ?? "mandatory",
    responseLocation: partial.responseLocation ?? null,
    points: partial.points ?? null,
    owner: partial.owner ?? "agent",
    evidenceNeeded: partial.evidenceNeeded ?? [],
    sectionPath: partial.sectionPath ?? [],
    anchored: partial.anchored ?? true,
  };
}

test("normalize survives PDF extraction artefacts", () => {
  // Curly apostrophe, a word split across a line break, and a non-breaking
  // space — all three appear in essentially every real solicitation.
  assert.equal(
    normalize("the Proponent’s pre-\nqualification evidence"),
    "the proponent's prequalification evidence",
  );
});

test("a hyphenated word matches whether or not the PDF wrapped it", () => {
  // Found in the RCMP tender: the source wraps "non-responsive" across a line,
  // the label quoted it inline, and the two did not compare equal — which made
  // a correctly quoted clause look invented. All three forms must agree.
  const wrapped = normalize("will be considered non-\nresponsive and disqualified");
  const inline = normalize("will be considered non-responsive and disqualified");
  const joined = normalize("will be considered nonresponsive and disqualified");

  assert.equal(wrapped, inline);
  assert.equal(inline, joined);
});

test("overlapF1 is high for the same clause and low for a different one", () => {
  const a = "The Proponent shall provide evidence of WSIB clearance.";
  const b = "The Proponent shall provide evidence of WSIB clearance";
  assert.ok(overlapF1(a, b) > 0.9);

  const other = "Proposals must be submitted electronically before the closing time.";
  assert.ok(overlapF1(a, other) < 0.4);
});

test("headings start a new section and trim the heading trail by level", () => {
  const sections = groupIntoSections([
    block({ text: "3. Submission Requirements", kind: "heading", level: 1, page: 4 }),
    block({ text: "Proposals shall be submitted electronically.", page: 4 }),
    block({ text: "3.1 Insurance", kind: "heading", level: 2, page: 5 }),
    block({ text: "The Proponent shall carry $5,000,000 in liability coverage.", page: 5 }),
    block({ text: "4. Evaluation", kind: "heading", level: 1, page: 6 }),
    block({ text: "Technical approach is worth 40 points.", page: 6 }),
  ]);

  assert.equal(sections.length, 3);
  assert.deepEqual(sections[0]?.path, ["3. Submission Requirements"]);
  assert.deepEqual(sections[1]?.path, ["3. Submission Requirements", "3.1 Insurance"]);
  // The level-1 heading replaces the level-1 entry *and* drops 3.1 beneath it.
  assert.deepEqual(sections[2]?.path, ["4. Evaluation"]);
});

test("oversized sections split and keep the heading trail", () => {
  const long = "x".repeat(400);
  const sections = groupIntoSections(
    [
      block({ text: "5. Scope", kind: "heading", level: 1, page: 2 }),
      block({ text: long, page: 2 }),
      block({ text: long, page: 3 }),
      block({ text: long, page: 4 }),
    ],
    500,
  );

  assert.ok(sections.length > 1);
  for (const section of sections) {
    assert.deepEqual(section.path, ["5. Scope"]);
  }
  // Page range is derived from the blocks that actually landed in each part.
  assert.equal(sections[0]?.startPage, 2);
});

test("section page range spans its blocks", () => {
  const sections = groupIntoSections([
    block({ text: "2. Terms", kind: "heading", level: 1, page: 7 }),
    block({ text: "Clause one.", page: 7 }),
    block({ text: "Clause two.", page: 9 }),
  ]);

  assert.equal(sections[0]?.startPage, 7);
  assert.equal(sections[0]?.endPage, 9);
});

test("score matches on wording, and reports mandatory recall separately", () => {
  const labels: LabelSet = {
    document: "sample.pdf",
    requirements: [
      {
        verbatim: "The Proponent shall provide evidence of WSIB clearance.",
        type: "mandatory",
        page: 27,
      },
      {
        verbatim: "Technical approach will be evaluated out of 40 points.",
        type: "rated",
        page: 31,
      },
      {
        verbatim: "The Proponent must hold $5,000,000 commercial general liability insurance.",
        type: "mandatory",
        page: 28,
      },
    ],
  };

  const extracted = [
    // Same clause, trailing period dropped and page right.
    requirement({
      verbatim: "The Proponent shall provide evidence of WSIB clearance",
      type: "mandatory",
      sourcePage: 27,
    }),
    // Same clause, but typed wrong and cited on the wrong page.
    requirement({
      verbatim: "Technical approach will be evaluated out of 40 points.",
      type: "mandatory",
      sourcePage: 30,
    }),
    // Not in the labels at all.
    requirement({
      verbatim: "Questions must be directed to the Contract Administrator.",
      type: "informational",
      sourcePage: 5,
    }),
  ];

  const report = score("sample.pdf", extracted, labels);

  assert.equal(report.matched, 2);
  assert.equal(report.labelled, 3);
  // One of two mandatory labels found — the insurance clause was missed.
  assert.equal(report.mandatoryLabelled, 2);
  assert.equal(report.mandatoryMatched, 1);
  assert.equal(report.mandatoryRecall, 0.5);
  assert.equal(report.typeAccuracy, 0.5);
  assert.equal(report.pageAccuracy, 0.5);
  assert.equal(report.misses.length, 1);
  assert.match(report.misses[0]?.verbatim ?? "", /liability insurance/);
  assert.equal(report.extras.length, 1);
});

test("each label matches at most one extraction", () => {
  const labels: LabelSet = {
    document: "dupes.pdf",
    requirements: [
      {
        verbatim: "The Proponent shall provide evidence of WSIB clearance.",
        type: "mandatory",
        page: 27,
      },
    ],
  };

  const extracted = [
    requirement({ verbatim: "The Proponent shall provide evidence of WSIB clearance." }),
    requirement({ verbatim: "The Proponent shall provide evidence of WSIB clearance" }),
  ];

  const report = score("dupes.pdf", extracted, labels);
  assert.equal(report.matched, 1);
  assert.equal(report.recall, 1);
  assert.equal(report.precision, 0.5);
});

test("anchorRate reports the share of re-found extractions", () => {
  assert.equal(
    anchorRate([
      requirement({ verbatim: "a", anchored: true }),
      requirement({ verbatim: "b", anchored: false }),
      requirement({ verbatim: "c", anchored: true }),
      requirement({ verbatim: "d", anchored: true }),
    ]),
    0.75,
  );
  // An empty extraction is vacuously clean rather than a division by zero.
  assert.equal(anchorRate([]), 1);
});
