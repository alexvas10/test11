/**
 * Shred a single PDF and print the requirement matrix.
 *
 *   node --experimental-strip-types src/eval/shred-one.ts path/to/solicitation.pdf
 *
 * This is the inner loop while the prompt is being tuned, and it is also the
 * thing the outreach motion sends a prospect: the matrix for a tender they
 * should be bidding on, with page citations they can spot-check in a minute.
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { shred } from "../agents/shred.ts";
import { CachedParser } from "../parse/cache.ts";
import { GeminiPdfParser } from "../parse/geminipdf.ts";

const pdfPath = process.argv[2];
if (!pdfPath) {
  process.stderr.write("usage: shred-one.ts <path-to-pdf>\n");
  process.exit(1);
}

const resolved = resolve(pdfPath);
const pdf = await readFile(resolved);
const parser = new CachedParser(new GeminiPdfParser(), join(dirname(resolved), ".parse-cache"));

const parsed = await parser.parse(pdf, basename(resolved));
const { requirements, stats } = await shred({ document: parsed });

for (const requirement of requirements) {
  const flag = requirement.anchored ? "" : "  ** UNANCHORED **";
  const points = requirement.points === null ? "" : ` (${requirement.points} pts)`;
  process.stdout.write(
    `\n[${requirement.type}] ${requirement.id ?? "-"}  p${requirement.sourcePage}${points}${flag}\n` +
      `  ${requirement.verbatim}\n` +
      (requirement.evidenceNeeded.length
        ? `  evidence: ${requirement.evidenceNeeded.join("; ")}\n`
        : ""),
  );
}

process.stdout.write(
  `\n${requirements.length} requirements (${stats.mandatory} mandatory) ` +
    `from ${stats.pageCount} pages / ${stats.sections} sections. ` +
    `${stats.duplicates} duplicates dropped, ${stats.unanchored} unanchored.\n`,
);

const outPath = resolved.replace(/\.pdf$/i, ".requirements.json");
await writeFile(outPath, JSON.stringify({ stats, requirements }, null, 2));
process.stdout.write(`Written to ${outPath}\n`);
