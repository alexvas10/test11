/**
 * Rebuilds the corpus from corpus/manifest.json.
 *
 *   node --experimental-strip-types src/eval/fetch-corpus.ts [corpusDir]
 *
 * The PDFs are not in git — they are ~29MB of public government documents and
 * git history is permanent. The manifest is, so the corpus is reproducible
 * without the repo carrying it.
 *
 * The catch worth knowing: these are live tender notices, and issuers take
 * documents down after closing. A fetch that 404s is expected over time rather
 * than a bug, which is why failures here are reported per document and do not
 * stop the run. If a document goes missing, the labels for it are still in the
 * repo and still valid — you just need the PDF from somewhere else, and the
 * manifest records the notice URL to start from.
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface ManifestDocument {
  name: string;
  title: string;
  issuer: string;
  solicitationNumber: string;
  closesOn: string;
  noticeUrl: string;
  pdfUrl: string;
}

interface Manifest {
  source: string;
  retrieved: string;
  note: string;
  documents: ManifestDocument[];
}

const corpusDir = resolve(process.argv[2] ?? "corpus");
const manifest = JSON.parse(
  await readFile(join(corpusDir, "manifest.json"), "utf8"),
) as Manifest;

await mkdir(corpusDir, { recursive: true });

let fetched = 0;
let skipped = 0;
const failures: { name: string; reason: string }[] = [];

for (const document of manifest.documents) {
  const target = join(corpusDir, `${document.name}.pdf`);

  if (await exists(target)) {
    skipped++;
    continue;
  }

  try {
    const response = await fetch(document.pdfUrl, {
      headers: {
        // Identify the client. These are public documents on public portals,
        // but a nameless bulk fetcher is a bad neighbour.
        "user-agent": "BidWright-corpus/0.1 (eval corpus fetch; contact via repo)",
      },
    });

    if (!response.ok) {
      failures.push({ name: document.name, reason: `HTTP ${response.status}` });
      continue;
    }

    const body = new Uint8Array(await response.arrayBuffer());
    if (!isPdf(body)) {
      // Portals answer a removed document with an HTML error page and a 200.
      failures.push({ name: document.name, reason: "response was not a PDF" });
      continue;
    }

    await writeFile(target, body);
    process.stdout.write(`fetched  ${document.name}.pdf (${Math.round(body.length / 1024)} KB)\n`);
    fetched++;
  } catch (err) {
    failures.push({
      name: document.name,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  // These are single government file servers, not a CDN.
  await sleep(1500);
}

process.stdout.write(
  `\n${fetched} fetched, ${skipped} already present, ${failures.length} failed.\n`,
);

for (const failure of failures) {
  const document = manifest.documents.find((d) => d.name === failure.name);
  process.stdout.write(
    `  ${failure.name}: ${failure.reason}\n` +
      `    ${document?.solicitationNumber} — ${document?.noticeUrl}\n`,
  );
}

if (failures.length > 0) {
  process.stdout.write(
    "\nTenders are taken down after they close, so this is expected with age.\n" +
      "Labels for a missing document remain valid; source the PDF from the notice URL.\n",
  );
}

function isPdf(bytes: Uint8Array): boolean {
  // %PDF
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
