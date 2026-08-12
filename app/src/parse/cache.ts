/**
 * On-disk parse cache.
 *
 * Document AI is billed per page and takes tens of seconds on a 100-page
 * solicitation. The eval loop re-runs extraction dozens of times against the
 * same corpus while the prompt changes, and paying to re-parse an unchanged PDF
 * every time would make the harness too slow and expensive to actually use —
 * which is the failure mode where people stop measuring.
 *
 * Keyed by the PDF's content hash, so editing the corpus invalidates on its own.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentParser, ParsedDocument } from "./types.ts";

export class CachedParser implements DocumentParser {
  constructor(
    private readonly inner: DocumentParser,
    private readonly dir: string,
  ) {}

  async parse(pdf: Uint8Array, label: string): Promise<ParsedDocument> {
    const hash = createHash("sha256").update(pdf).digest("hex").slice(0, 16);
    const path = join(this.dir, `${hash}.json`);

    try {
      const cached = await readFile(path, "utf8");
      process.stderr.write(`[parse] ${label}: cache hit ${hash}\n`);
      return JSON.parse(cached) as ParsedDocument;
    } catch {
      // Miss, or unreadable cache entry. Either way, re-parse.
    }

    const parsed = await this.inner.parse(pdf, label);
    await mkdir(this.dir, { recursive: true });
    await writeFile(path, JSON.stringify(parsed));
    return parsed;
  }
}
