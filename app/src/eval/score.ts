/**
 * Scoring the shred against hand-labelled solicitations.
 *
 * The ground truth is inside the input document: a clause either says "the
 * Proponent shall provide WSIB clearance" on page 27 or it does not. That is
 * what makes this idea testable without a customer, a phone call, or an
 * opinion — so the harness exists before the sales motion does.
 *
 * The headline number is MANDATORY RECALL. Precision matters much less: an
 * extra informational row costs a customer ten seconds of reading, a missed
 * mandatory row costs them the contract. Do not trade recall for a prettier
 * precision figure.
 */

import { overlapF1 } from "../lib/text.ts";
import type { Requirement, RequirementType } from "../lib/types.ts";

/** Token-overlap F1 above which an extraction counts as the labelled clause. */
const MATCH_THRESHOLD = Number(process.env.EVAL_MATCH_THRESHOLD ?? "0.6");

export interface LabelledRequirement {
  /** Copied from the PDF by a human. The same verbatim rule applies. */
  verbatim: string;
  type: RequirementType;
  /** 1-based page in the source PDF. */
  page: number;
}

export interface LabelSet {
  /** PDF filename this labels, relative to the corpus directory. */
  document: string;
  note?: string;
  requirements: LabelledRequirement[];
}

export interface Match {
  label: LabelledRequirement;
  extracted: Requirement;
  similarity: number;
  typeCorrect: boolean;
  pageCorrect: boolean;
}

export interface ScoreReport {
  document: string;
  labelled: number;
  extracted: number;
  matched: number;
  /** Fraction of labelled requirements that were found. */
  recall: number;
  /** Fraction of extracted requirements that correspond to a label. */
  precision: number;
  /** Recall restricted to labels typed "mandatory". The number that matters. */
  mandatoryRecall: number;
  mandatoryLabelled: number;
  mandatoryMatched: number;
  /** Of matched pairs, fraction where the agent's type agrees with the label. */
  typeAccuracy: number;
  /** Of matched pairs, fraction where the cited page is right. */
  pageAccuracy: number;
  /** Extractions whose verbatim was not re-found in the source. */
  unanchored: number;
  misses: LabelledRequirement[];
  extras: Requirement[];
}

/**
 * Greedy one-to-one matching, best pairs first.
 *
 * Greedy rather than optimal assignment: with a 0.6 threshold the candidate
 * pairs barely overlap in practice, and a Hungarian solve would move the score
 * by a fraction of a point while making a disagreement much harder to explain
 * to the person who wrote the labels.
 */
export function score(
  documentName: string,
  extracted: Requirement[],
  labels: LabelSet,
): ScoreReport {
  const candidates: { labelIndex: number; extractedIndex: number; similarity: number }[] = [];

  labels.requirements.forEach((label, labelIndex) => {
    extracted.forEach((item, extractedIndex) => {
      const similarity = overlapF1(label.verbatim, item.verbatim);
      if (similarity >= MATCH_THRESHOLD) {
        candidates.push({ labelIndex, extractedIndex, similarity });
      }
    });
  });

  candidates.sort((a, b) => b.similarity - a.similarity);

  const usedLabels = new Set<number>();
  const usedExtracted = new Set<number>();
  const matches: Match[] = [];

  for (const candidate of candidates) {
    if (usedLabels.has(candidate.labelIndex)) continue;
    if (usedExtracted.has(candidate.extractedIndex)) continue;

    const label = labels.requirements[candidate.labelIndex];
    const item = extracted[candidate.extractedIndex];
    if (!label || !item) continue;

    usedLabels.add(candidate.labelIndex);
    usedExtracted.add(candidate.extractedIndex);
    matches.push({
      label,
      extracted: item,
      similarity: candidate.similarity,
      typeCorrect: item.type === label.type,
      pageCorrect: item.sourcePage === label.page,
    });
  }

  const mandatoryLabels = labels.requirements.filter((r) => r.type === "mandatory");
  const mandatoryMatched = matches.filter((m) => m.label.type === "mandatory").length;

  return {
    document: documentName,
    labelled: labels.requirements.length,
    extracted: extracted.length,
    matched: matches.length,
    recall: ratio(matches.length, labels.requirements.length),
    precision: ratio(matches.length, extracted.length),
    mandatoryRecall: ratio(mandatoryMatched, mandatoryLabels.length),
    mandatoryLabelled: mandatoryLabels.length,
    mandatoryMatched,
    typeAccuracy: ratio(matches.filter((m) => m.typeCorrect).length, matches.length),
    pageAccuracy: ratio(matches.filter((m) => m.pageCorrect).length, matches.length),
    unanchored: extracted.filter((r) => !r.anchored).length,
    misses: labels.requirements.filter((_, index) => !usedLabels.has(index)),
    extras: extracted.filter((_, index) => !usedExtracted.has(index)),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

/**
 * Anchor rate over a document with no labels.
 *
 * This is the reason the corpus does not have to be fully labelled to be
 * useful: re-finding every verbatim in the source is a hallucination check that
 * needs no ground truth at all, so an unlabelled solicitation still tells us
 * whether the agent is inventing text.
 */
export function anchorRate(extracted: Requirement[]): number {
  return ratio(extracted.filter((r) => r.anchored).length, extracted.length);
}
