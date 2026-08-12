/**
 * Corpus triage. Runs locally, no API, no cost.
 *
 *   node --experimental-strip-types src/eval/triage.ts <dir>
 *
 * Reports page count and text-layer coverage for every PDF in a directory,
 * before anything is spent on parsing it. Two things this catches:
 *
 *   - Scanned documents. Anchoring runs against the PDF's own text, so a
 *     solicitation with no text layer gives a weaker verification story. Better
 *     to know that when choosing the corpus than when reading the scores.
 *   - Attachments that are not solicitations at all. A tender's PDF set is
 *     usually one requirements document plus drawings, site photos and forms;
 *     only the first is worth labelling.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extractPageText } from "../parse/pdftext.ts";

const dir = resolve(process.argv[2] ?? "corpus");

interface Row {
  file: string;
  pages: number;
  /** Share of pages with any extractable text. */
  textCoverage: number;
  words: number;
  /** Rough signal that this is a requirements document rather than a drawing. */
  obligations: number;
}

const rows: Row[] = [];

for (const file of (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".pdf")).sort()) {
  try {
    const pageText = await extractPageText(await readFile(join(dir, file)));
    const withText = pageText.filter((t) => t.trim().length > 0).length;
    const all = pageText.join(" ");

    rows.push({
      file,
      pages: pageText.length,
      textCoverage: pageText.length === 0 ? 0 : withText / pageText.length,
      words: all.split(/\s+/).filter(Boolean).length,
      // "shall" and "must" are how solicitations state obligations; a drawing
      // set or a photo appendix has effectively none.
      obligations: (all.match(/\b(shall|must|is required to)\b/gi) ?? []).length,
    });
  } catch (err) {
    process.stderr.write(
      `[triage] ${file}: FAILED — ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

rows.sort((a, b) => b.obligations - a.obligations);

process.stdout.write(
  "file" + " ".repeat(50) + "pages  text%   words  'shall'\n",
);
for (const row of rows) {
  process.stdout.write(
    row.file.slice(0, 52).padEnd(54) +
      String(row.pages).padStart(5) +
      `${(row.textCoverage * 100).toFixed(0)}%`.padStart(7) +
      String(row.words).padStart(8) +
      String(row.obligations).padStart(9) +
      "\n",
  );
}

const scanned = rows.filter((r) => r.textCoverage < 0.5);
if (scanned.length > 0) {
  process.stdout.write(
    `\n${scanned.length} file(s) below 50% text coverage — likely scanned, weaker anchoring:\n` +
      scanned.map((r) => `  ${r.file}`).join("\n") +
      "\n",
  );
}
