/**
 * Text normalisation shared by the shred's anchor check and the eval scorer.
 *
 * Both need "is this the same sentence?" despite PDF extraction artefacts:
 * soft hyphens, ligatures, non-breaking spaces, smart quotes, and line breaks
 * inserted mid-word by the original layout. Comparing raw strings reports
 * hallucinations that are really just a curly apostrophe.
 */

export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    // Curly quotes and dashes -> ASCII. Solicitations are full of both.
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    // Hyphen + line break is a word split by the PDF's line wrapping.
    .replace(/-\s*\n\s*/g, "")
    // Then drop hyphens *inside* words entirely.
    //
    // Without this, de-hyphenating line wraps creates a mismatch it was meant
    // to fix: a solicitation that wraps "non-responsive" as "non-\nresponsive"
    // becomes "nonresponsive", while the same word written inline stays
    // "non-responsive", and the two never compare equal. Since either side of a
    // comparison may be the wrapped one, the only consistent choice is to
    // remove the hyphen in both. Real case — it made a correctly quoted clause
    // look like a hallucination.
    .replace(/(\p{L})-(\p{L})/gu, "$1$2")
    .replace(/[^\p{L}\p{N}\s'"-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function tokenize(text: string): string[] {
  const normalized = normalize(text);
  return normalized ? normalized.split(" ") : [];
}

/**
 * Fraction of `needle`'s tokens present in `haystack`, counting multiplicity.
 *
 * Containment rather than Jaccard because the two sides are deliberately
 * different sizes: one requirement against a whole section, or an extracted
 * clause against a longer labelled one.
 */
export function containment(needle: string, haystack: string): number {
  const needleTokens = tokenize(needle);
  if (needleTokens.length === 0) return 0;

  const available = new Map<string, number>();
  for (const token of tokenize(haystack)) {
    available.set(token, (available.get(token) ?? 0) + 1);
  }

  let found = 0;
  for (const token of needleTokens) {
    const remaining = available.get(token) ?? 0;
    if (remaining > 0) {
      available.set(token, remaining - 1);
      found++;
    }
  }
  return found / needleTokens.length;
}

/** Symmetric token overlap. Used to match extracted requirements to labels. */
export function overlapF1(a: string, b: string): number {
  const precision = containment(a, b);
  const recall = containment(b, a);
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

/** Substring test on normalised text. The shred's anchor check. */
export function normalizedIncludes(haystack: string, needle: string): boolean {
  const n = normalize(needle);
  return n.length > 0 && normalize(haystack).includes(n);
}
