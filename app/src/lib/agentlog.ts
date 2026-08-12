/**
 * Structured agent-run logging.
 *
 * This exists before most of the agents do, on purpose. The submission asks for
 * agent execution logs and API usage records, and the plan is explicit that
 * teams lose by retrofitting this in the last 48 hours. Every agent invocation
 * writes one record here.
 *
 * Records go to stdout as single-line JSON. Cloud Run ships stdout to Cloud
 * Logging, and a log sink routes `agent_run` entries into BigQuery — so there
 * is no write-path latency and no extra failure mode on the critical path.
 */

import { estimateCostUsd } from "./modelcost.ts";

export type AgentName =
  | "intake"
  | "shred"
  | "bid_no_bid"
  | "draft"
  | "compliance"
  | "assembly"
  | "outreach";

/**
 * How much of a human was involved. This ratio is the core "AI-native
 * operations" number, so it is recorded per run rather than inferred later.
 */
export type Autonomy =
  | "autonomous"
  | "human_reviewed"
  | "human_overridden"
  | "escalated_to_human";

export interface AgentRunRecord {
  run_id: string;
  customer_id: string | null;
  bid_id: string | null;
  agent: AgentName;
  started_at: string;
  duration_ms: number;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  /** The decision the agent actually made, e.g. GO, BLOCK_DELIVERY, SHREDDED. */
  decision: string;
  /** Why. Free text, but always populated — this is what makes the log readable to a judge. */
  decision_rationale: string;
  autonomy: Autonomy;
  cost_usd: number;
  error: string | null;
}

export interface AgentRunInput {
  customerId?: string | null;
  bidId?: string | null;
  agent: AgentName;
  model?: string | null;
}

export interface AgentRunContext {
  readonly runId: string;
  decision: string;
  rationale: string;
  autonomy: Autonomy;
  inputTokens: number;
  outputTokens: number;
  model: string | null;
  /** Adds token usage from one model call. Called by the Gemini wrapper. */
  addUsage(inputTokens: number, outputTokens: number): void;
}

/**
 * Wraps one agent invocation. The callback sets its decision and rationale on
 * the context; everything else (timing, cost, run id, token totals) is recorded
 * automatically so that no call site can forget.
 */
export async function recordAgentRun<T>(
  input: AgentRunInput,
  fn: (ctx: AgentRunContext) => Promise<T>,
): Promise<T> {
  const runId = crypto.randomUUID();
  const startedAt = new Date();
  const startedHrMs = performance.now();

  const ctx: AgentRunContext = {
    runId,
    decision: "UNSET",
    rationale: "",
    autonomy: "autonomous",
    inputTokens: 0,
    outputTokens: 0,
    model: input.model ?? null,
    addUsage(inputTokens: number, outputTokens: number) {
      ctx.inputTokens += inputTokens;
      ctx.outputTokens += outputTokens;
    },
  };

  let error: string | null = null;
  try {
    return await fn(ctx);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    if (ctx.decision === "UNSET") {
      ctx.decision = "FAILED";
      ctx.rationale = error;
    }
    throw err;
  } finally {
    emit({
      run_id: runId,
      customer_id: input.customerId ?? null,
      bid_id: input.bidId ?? null,
      agent: input.agent,
      started_at: startedAt.toISOString(),
      duration_ms: Math.round(performance.now() - startedHrMs),
      model: ctx.model,
      input_tokens: ctx.inputTokens,
      output_tokens: ctx.outputTokens,
      decision: ctx.decision,
      decision_rationale: ctx.rationale,
      autonomy: ctx.autonomy,
      cost_usd: estimateCostUsd(ctx.model, ctx.inputTokens, ctx.outputTokens),
      error,
    });
  }
}

function emit(record: AgentRunRecord): void {
  // `logType` is the field the Cloud Logging sink filters on to route into
  // BigQuery. `severity` is picked up by Cloud Logging natively.
  //
  // stderr, not stdout: the eval CLI writes machine-readable results to stdout
  // and agent logs must not interleave into that stream.
  process.stderr.write(
    JSON.stringify({
      logType: "agent_run",
      severity: record.error ? "ERROR" : "INFO",
      message: `${record.agent}: ${record.decision}`,
      ...record,
    }) + "\n",
  );
}
