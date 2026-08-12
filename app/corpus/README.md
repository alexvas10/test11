# Eval corpus

Real solicitations, plus hand-written ground truth for some of them. This is
what makes the shred agent testable without a customer: the correct answer is
inside the input document, so a clause either says what we extracted on the
page we cited, or it does not.

## Layout

```
corpus/
  manifest.json                # tracked: what each PDF is and where it came from
  halton-2026-114.pdf          # NOT tracked: run `npm run corpus:fetch`
  labels/
    halton-2026-114.json       # tracked: ground truth, same basename
  .parse-cache/                # parser output, keyed by content hash
  out/                         # extraction results + misses.txt
```

**The PDFs are not in git.** They are ~29MB of public government documents and
git history is permanent, so the manifest is tracked instead:

```sh
npm run corpus:fetch
```

Tender documents get taken down after a solicitation closes, so expect this to
degrade with age. A failed fetch is reported with the notice URL to chase. The
labels for a missing document stay valid — only the PDF needs re-sourcing.

Adding a document means adding an entry to `manifest.json` too, or the next
person to clone will not get it.

A PDF with no label file is still useful — it gets an anchor-rate check, which
catches invented text without needing anyone to label anything. Anchoring runs
against the PDF's own text layer, extracted locally with no model involved, so
it is a real check and not two model calls agreeing with each other. Scanned
PDFs have no text layer; those pages are counted as `unverifiablePages` rather
than silently passing, so prefer digital PDFs when you have the choice.

## Where to get documents

Free and public:

- **SAM.gov** — US federal, has an opportunities API
- **CanadaBuys** — Canadian federal
- **MERX / Biddingo / bids&tenders** — Canadian provincial and municipal
- **Contracts Finder**, **Find a Tender** — UK
- **TED** — EU

Bias the corpus toward what we actually sell into: facilities services, trades
at commercial scale, IT services and staffing, under $5M, 40–120 pages. A
corpus of tidy federal RFPs will overstate our accuracy on the messy municipal
PDFs that are the real business.

## Writing labels

```json
{
  "document": "halton-2026-114.pdf",
  "note": "Janitorial, 3-year. Mandatories concentrated in s.3 and Appendix B.",
  "requirements": [
    {
      "verbatim": "The Proponent shall provide evidence of WSIB clearance prior to award.",
      "type": "mandatory",
      "page": 27
    }
  ]
}
```

Rules for labelling, which are the same rules the agent is held to:

1. **Copy the text.** Do not tidy it. The scorer normalises whitespace,
   hyphenation and quote characters, so extraction artefacts are fine, but
   rewording is not — a reworded label makes a correct extraction look wrong.
2. **Page is the PDF page**, 1-based, not the number printed in the footer.
   Those disagree in most solicitations because of cover pages.
3. **Label everything mandatory.** Partial labelling of the other types is
   fine and expected: `mandatoryRecall` is the headline metric and is computed
   only over what you labelled.
4. **One obligation per entry**, matching rule 2 of the agent's instructions.

Two fully labelled documents is enough to start iterating. Label a third only
once the first two stop finding new failure modes.

## Running

```sh
npm run shred -- corpus/halton-2026-114.pdf   # one document, printed matrix
npm run eval                                  # whole corpus, scored
```

Parse results are cached by content hash, so re-running after a prompt change
re-extracts but does not re-parse — which keeps the loop inside the free tier's
daily request budget as well as fast.
