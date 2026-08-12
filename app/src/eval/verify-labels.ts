/**
 * Checks label files against the PDFs they claim to describe.
 *
 *   node --experimental-strip-types src/eval/verify-labels.ts [corpusDir]
 *
 * Labels are the measuring stick: if a label's verbatim text is misquoted or
 * its page is wrong, a correct extraction scores as a miss and the next prompt
 * change gets made for a bad reason. Worse, that failure is invisible — the
 * number still looks like a number.
 *
 * So every label is re-found in the PDF's own text layer, the same mechanical
 * check the shred's anchoring uses. This catches transcription drift and
 * off-by-one pages. It cannot catch a mandatory clause nobody labelled; only
 * reading the document catches that.
 *
 * Runs locally. No API, no cost.
 */

import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { normalizedIncludes } from "../lib/text.ts";
import { extractPageText } from "../parse/pdftext.ts";
import type { LabelSet } from "./score.ts";

const corpusDir = resolve(process.argv[2] ?? "corpus");
const labelsDir = join(corpusDir, "labels");

let labelFiles: string[];
try {
  labelFiles = (await readdir(labelsDir)).filter((f) => f.endsWith(".json")).sort();
} catch {
  process.stderr.write(`No labels directory at ${labelsDir}\n`);
  process.exit(1);
}

let problems = 0;
let checked = 0;

for (const file of labelFiles) {
  const labels = JSON.parse(await readFile(join(labelsDir, file), "utf8")) as LabelSet;
  const pdfPath = join(corpusDir, labels.document ?? `${basename(file, ".json")}.pdf`);

  let pageText: string[];
  try {
    pageText = await extractPageText(await readFile(pdfPath));
  } catch {
    process.stdout.write(`${file}: cannot read ${pdfPath}\n`);
    problems++;
    continue;
  }

  const issues: string[] = [];
  const seen = new Set<string>();

  labels.requirements.forEach((label, index) => {
    checked++;
    const where = `#${index + 1} p${label.page}`;

    if (label.page < 1 || label.page > pageText.length) {
      issues.push(`${where}: page out of range (document has ${pageText.length})`);
      return;
    }

    const onClaimedPage = normalizedIncludes(pageText[label.page - 1] ?? "", label.verbatim);
    if (!onClaimedPage) {
      // Distinguish "wrong page" from "wrong text" — they need different fixes.
      const actual = pageText.findIndex((text) => normalizedIncludes(text, label.verbatim));
      issues.push(
        actual >= 0
          ? `${where}: text is on page ${actual + 1}, not ${label.page}`
          : `${where}: text not found anywhere in the PDF — "${label.verbatim.slice(0, 60)}…"`,
      );
    }

    const key = label.verbatim.trim().toLowerCase();
    if (seen.has(key)) issues.push(`${where}: duplicate of an earlier label`);
    seen.add(key);
  });

  const mandatory = labels.requirements.filter((r) => r.type === "mandatory").length;
  process.stdout.write(
    `${file}: ${labels.requirements.length} labels (${mandatory} mandatory)` +
      (issues.length === 0 ? "  OK\n" : `  ${issues.length} PROBLEM(S)\n`),
  );
  for (const issue of issues) process.stdout.write(`    ${issue}\n`);
  problems += issues.length;
}

process.stdout.write(
  `\n${checked} labels checked, ${problems} problem(s).\n` +
    (problems === 0
      ? "Verbatim text and pages are sound. Completeness still needs a human read.\n"
      : "Fix these before trusting any score computed against them.\n"),
);

if (problems > 0) process.exit(1);
