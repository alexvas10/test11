/**
 * Domain model. Every collection is tenanted by `customerId` — per-customer
 * data isolation is a thing we say in the sales pitch, so it has to be
 * structurally true, not a filter someone remembers to apply.
 */

/**
 * How a requirement binds the bidder.
 *
 * `mandatory` is the one that matters most: missing a single mandatory item is
 * a disqualification on a technicality, which is the exact failure the product
 * exists to prevent. Recall on this class is the number the eval harness
 * optimises for.
 */
export type RequirementType =
  /** Pass/fail. Missing it disqualifies the bid. */
  | "mandatory"
  /** Scored against a rubric. Points are usually stated. */
  | "rated"
  /** Context the bidder must know but does not respond to. */
  | "informational"
  /** A form, schedule, or certificate to be filled in and returned. */
  | "form";

/**
 * One requirement lifted out of a solicitation.
 *
 * The central design rule: `verbatim` is copied from the source, never
 * paraphrased, and `sourcePage` says where to find it. Everything downstream —
 * the compliance matrix, the drafted sections, the audit — cites this record,
 * so a paraphrase here silently becomes an unfalsifiable claim three agents
 * later. `anchored` records whether we mechanically re-found the text in the
 * source, which is our hallucination check.
 */
export interface Requirement {
  /** The solicitation's own clause number ("3.2.4") where it has one. */
  id: string | null;
  /** 1-based page in the original PDF. */
  sourcePage: number;
  /** Copied from the source. Never rewritten. */
  verbatim: string;
  type: RequirementType;
  /** Where the response goes, if the solicitation says ("Appendix B"). */
  responseLocation: string | null;
  /** Evaluation points, for rated items. */
  points: number | null;
  /** Whether we can answer this or the customer must supply something. */
  owner: "agent" | "customer";
  /** Documents or artefacts the bidder has to produce ("WSIB clearance certificate"). */
  evidenceNeeded: string[];
  /** Heading trail the requirement was found under. Debugging and grouping. */
  sectionPath: string[];
  /** True when `verbatim` was re-found in the source text after extraction. */
  anchored: boolean;
}

/** A small firm we write bids for. */
export interface Customer {
  id: string;
  name: string;
  contactName: string;
  contactEmail: string;
  /** NAICS/UNSPSC codes they sell under. Feeds bid/no-bid scoring. */
  industryCodes: string[];
  /** Certifications, bonding capacity, coverage area, headcount. */
  profile: Record<string, string>;
  createdAt: Date;
}

export interface Solicitation {
  id: string;
  customerId: string | null;
  /** Issuing body, e.g. "Halton Region". */
  issuer: string;
  /** The issuer's own reference, e.g. "RFP 2026-114". */
  solicitationNumber: string;
  title: string;
  closesAt: Date | null;
  closesAtTimezone: string | null;
  submissionMethod: string | null;
  /** GCS URI of the source PDF. */
  sourceUri: string;
  pageCount: number;
}

export type BidStatus =
  | "intake"
  | "shredded"
  | "no_bid"
  | "drafting"
  | "compliance_review"
  | "human_review"
  | "delivered"
  | "abandoned";

export interface Bid {
  id: string;
  customerId: string;
  solicitationId: string;
  status: BidStatus;
  requirements: Requirement[];
  /** Set by the bid/no-bid agent. */
  recommendation: "GO" | "NO_GO" | null;
  recommendationRationale: string | null;
  createdAt: Date;
}
