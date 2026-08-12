/**
 * Eval CLI — run the shred over the corpus and score it.
 *
 *   node --experimental-strip-types src/eval/run.ts [corpusDir]
 *
 * Every PDF in the corpus is shredded. Ones with a matching label file in
 * `labels/` are scored against it; ones without still report an anchor rate,
 * which is the hallucination check that needs no ground truth.
 *
 * Extraction output is written to `out/` so a prompt change can be diffed
 * against the previous run rather than argued about.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { shred } from "../agents/shred.ts";
import { CachedParser } from "../parse/cache.ts";
import { GeminiPdfParser } from "../parse/geminipdf.ts";
import { anchorRate, score, type LabelSet, type ScoreReport } from "./score.ts";

const corpusDir = resolve(process.argv[2] ?? "corpus");

async function main(): Promise<void> {
  const pdfs = (await readdir(corpusDir))
    .filter((name) => name.toLowerCase().endsWith(".pdf"))
    .sort();

  if (pdfs.length === 0) {
    process.stderr.write(`No PDFs in ${corpusDir}. See corpus/README.md.\n`);
    process.exit(1);
  }

  const parser = new CachedParser(new GeminiPdfParser(), join(corpusDir, ".parse-cache"));
  const outDir = join(corpusDir, "out");
  await mkdir(outDir, { recursive: true });

  const reports: ScoreReport[] = [];
  const unlabelled: { document: string; extracted: number; anchorRate: number }[] = [];

  for (const pdf of pdfs) {
    const pdfBytes = await readFile(join(corpusDir, pdf));
    const parsed = await parser.parse(pdfBytes, pdf);
    const { requirements, stats } = await shred({ document: parsed });

    await writeFile(
      join(outDir, `${basename(pdf, ".pdf")}.json`),
      JSON.stringify({ stats, requirements }, null, 2),
    );

    const labels = await loadLabels(pdf);
    if (labels) {
      reports.push(score(pdf, requirements, labels));
    } else {
      unlabelled.push({
        document: pdf,
        extracted: requirements.length,
        anchorRate: anchorRate(requirements),
      });
    }
  }

  printLabelled(reports);
  printUnlabelled(unlabelled);
  await writeMisses(outDir, reports);
}

async function loadLabels(pdf: string): Promise<LabelSet | null> {
  const path = join(corpusDir, "labels", `${basename(pdf, ".pdf")}.json`);
  try {
    return JSON.parse(await readFile(path, "utf8")) as LabelSet;
  } catch {
    return null;
  }
}

function printLabelled(reports: ScoreReport[]): void {
  if (reports.length === 0) return;

  process.stdout.write("\nSCORED (labelled documents)\n");
  process.stdout.write(
    "document                        mand.recall  recall  prec.  type   page   anchored\n",
  );

  for (const report of reports) {
    process.stdout.write(
      [
        report.document.slice(0, 30).padEnd(32),
        `${pct(report.mandatoryRecall)} (${report.mandatoryMatched}/${report.mandatoryLabelled})`.padEnd(13),
        pct(report.recall).padEnd(8),
        pct(report.precision).padEnd(7),
        pct(report.typeAccuracy).padEnd(7),
        pct(report.pageAccuracy).padEnd(7),
        `${report.extracted - report.unanchored}/${report.extracted}`,
      ].join("") + "\n",
    );
  }

  // Micro-averaged: one missed mandatory clause counts the same wherever it
  // was, rather than being diluted by which document it happened to be in.
  const totals = reports.reduce(
    (acc, r) => ({
      mandatoryLabelled: acc.mandatoryLabelled + r.mandatoryLabelled,
      mandatoryMatched: acc.mandatoryMatched + r.mandatoryMatched,
      labelled: acc.labelled + r.labelled,
      matched: acc.matched + r.matched,
    }),
    { mandatoryLabelled: 0, mandatoryMatched: 0, labelled: 0, matched: 0 },
  );

  process.stdout.write(
    `\nOVERALL  mandatory recall ${pct(totals.mandatoryMatched / (totals.mandatoryLabelled || 1))}` +
      ` (${totals.mandatoryMatched}/${totals.mandatoryLabelled})` +
      `   recall ${pct(totals.matched / (totals.labelled || 1))}` +
      ` (${totals.matched}/${totals.labelled})\n`,
  );
}

function printUnlabelled(
  rows: { document: string; extracted: number; anchorRate: number }[],
): void {
  if (rows.length === 0) return;

  process.stdout.write("\nUNLABELLED (anchor check only)\n");
  for (const row of rows) {
    process.stdout.write(
      `${row.document.slice(0, 30).padEnd(32)}${String(row.extracted).padEnd(8)}anchored ${pct(row.anchorRate)}\n`,
    );
  }
}

/**
 * Misses are the working file. Reading the clauses the agent did not find, in
 * one place, is what actually drives the next prompt change.
 */
async function writeMisses(outDir: string, reports: ScoreReport[]): Promise<void> {
  if (reports.length === 0) return;

  const lines: string[] = [];
  for (const report of reports) {
    if (report.misses.length === 0) continue;
    lines.push(`# ${report.document}`);
    for (const miss of report.misses) {
      lines.push(`[${miss.type}] p${miss.page}: ${miss.verbatim}`);
    }
    lines.push("");
  }

  const path = join(outDir, "misses.txt");
  await writeFile(path, lines.join("\n"));
  if (lines.length > 0) process.stdout.write(`\nMisses written to ${path}\n`);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

await main();
