# BidWright

Small firms skip government and enterprise contracts they could win, because
writing the response costs 30 hours they don't have. Agents do the reading in
minutes.

A public tender arrives as a 40–120 page PDF. To respond, a 10-person firm has
to find every mandatory requirement — including the ones buried in appendices —
build a compliance matrix, write 15–60 pages of narrative, and submit in the
exact format demanded or be disqualified on a technicality. The rational move is
not to bid. So they don't, and the contracts go to incumbents with full-time
proposal staff.

Every skipped bid is a small firm that didn't grow and people who didn't get
hired.

## What's built

The **shred agent** — the piece everything else depends on. It decomposes a
solicitation into a structured requirement tree: every obligation, classified
`mandatory` / `rated` / `form` / `informational`, quoted verbatim, with the page
it came from and the evidence the bidder has to produce.

```
solicitation.pdf
      │
      ├── pdftext.ts    text layer, extracted locally, no model  ─┐
      │                                                          │ ground truth
      └── geminipdf.ts  structure: headings, tables, lists        │
                │                                                │
           shred.ts     requirement extraction, section by section│
                │                                                │
                └── anchoring: re-find every quote ───────────────┘
```

Two design rules do most of the work:

**Page numbers are derived, not generated.** The model returns copied text; the
page comes from searching the document for that text. Asking a language model to
count pages gets you a plausible number, and a wrong citation is what makes a
customer stop trusting the whole matrix.

**Every quote is re-found in the source.** After extraction, each `verbatim` is
searched for in the PDF's own text layer — extracted locally, with no model
involved. Text that can't be re-found is flagged `anchored: false` rather than
silently kept. Because the check runs against the document rather than against
another model call, it needs no labels: an unlabelled solicitation still tells
you whether the agent is inventing text.

Pages with no text layer (scanned PDFs are common in municipal procurement) fall
back to a weaker check and are counted separately, so the anchor rate is never
read as stronger evidence than it is.

## Why this is testable without a customer

The ground truth is inside the input. A clause either says *"the Proponent shall
provide evidence of WSIB clearance"* on page 27 or it does not — no opinion, no
waiting on an award decision 30–120 days out.

So the eval harness came before the sales motion:

| Command | What it does |
|---|---|
| `npm run corpus:fetch` | rebuild the corpus from `manifest.json` |
| `npm run corpus:triage` | page count and text-layer coverage, before spending anything |
| `npm run labels:verify` | re-find every label in its PDF; catches drift and off-by-one pages |
| `npm run shred -- <pdf>` | one document, printed requirement matrix |
| `npm run eval` | whole corpus, scored, with `misses.txt` |

The headline metric is **mandatory recall**. Precision matters much less: an
extra informational row costs a customer ten seconds of reading, a missed
mandatory row costs them the contract.

The corpus is 11 live Canadian federal tenders — janitorial, grounds
maintenance, snow removal, electrical, HVAC, cleaning, staffing; 38–85 pages.
Two are hand-labelled, 70 clauses, every quote and page machine-verified.

## Status

Honest state of things:

- Shred agent, eval harness and corpus: built, 18 tests passing.
- Two labelled documents; scoring has not yet been run against a live model.
- No customers, no revenue yet.

The label verifier caught a real bug within minutes of meeting its first
government PDF: a clause wrapping as `non-\nresponsive` normalised differently
from the same word written inline, which would have scored correctly quoted
clauses as hallucinations. That failure was invisible to hand-written fixtures.
Contact with real documents is the only thing that finds that class of bug,
which is the argument for the corpus existing this early.

## Running it

```sh
cd app
npm install
cp .env.example .env      # set GEMINI_API_KEY and GEMINI_MODEL
npm run corpus:fetch
npm test
```

Requires Node 22+. TypeScript runs directly via `--experimental-strip-types`;
`tsc` is a checker, never a build step.

Every agent invocation writes one structured record — decision, rationale,
autonomy level, tokens, cost — as single-line JSON, for Cloud Logging to route
into BigQuery. That exists before most of the agents do, on purpose.

## Layout

```
app/src/
  agents/shred.ts      the agent + section grouping
  parse/geminipdf.ts   PDF structure
  parse/pdftext.ts     local text layer — the anchor, keep it model-free
  parse/cache.ts       content-hashed parse cache
  lib/gemini.ts        structured output, token accounting
  lib/agentlog.ts      agent-run records
  lib/text.ts          normalisation shared by anchoring and scoring
  eval/                triage, scoring, label verification, corpus fetch
```

Corpus PDFs are not tracked — public documents, ~29MB, and git history is
permanent. `app/corpus/manifest.json` records what each one is and where it came
from; `npm run corpus:fetch` restores them.
