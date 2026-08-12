/**
 * Per-page text straight out of the PDF, with no model involved.
 *
 * This is the anchor the whole verbatim guarantee hangs on. Everything else in
 * the pipeline is a model output that could be wrong in a plausible-looking
 * way; this is the document itself. Keep it that way — if this ever starts
 * going through an API, the hallucination check stops being a check.
 *
 * Returns an empty string for any page with no text layer. Scanned
 * solicitations are common in municipal procurement, and a page we cannot read
 * locally has to be reported as unverifiable rather than treated as clean.
 */

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export async function extractPageText(pdf: Uint8Array): Promise<string[]> {
  // pdf.js transfers ownership of the buffer it is handed, and the same bytes
  // are sent to the parser afterwards. Copy so the caller's array survives.
  const doc = await getDocument({
    data: new Uint8Array(pdf),
    // Console noise on the malformed PDFs that procurement portals produce.
    verbosity: 0,
  }).promise;

  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();

    // Items carry their own spacing hints; `hasEOL` is where a visual line
    // ended, which is what makes hyphenated line breaks reconstructable.
    const text = content.items
      .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
      .join("");

    pages.push(text);
    page.cleanup();
  }

  await doc.destroy();
  return pages;
}
