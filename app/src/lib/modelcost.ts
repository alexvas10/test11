/**
 * Token -> dollars, for the cost_usd column in the agent log and the P&L.
 *
 * Rates are deliberately NOT hardcoded from memory. Model pricing changes and a
 * wrong rate here silently corrupts the unit-economics number that the whole
 * "sustainability of the business model" argument rests on. Fill these in from
 * the current Vertex AI pricing page via the MODEL_RATES env var.
 *
 * Until a rate is supplied, cost is recorded as 0 and a warning is emitted once
 * per model — a visible zero is recoverable, an invented number is not.
 */

export interface ModelRate {
  /** USD per 1M input tokens. */
  inputPerMillion: number;
  /** USD per 1M output tokens. */
  outputPerMillion: number;
}

const RATES: Record<string, ModelRate> = loadRates();

function loadRates(): Record<string, ModelRate> {
  const raw = process.env.MODEL_RATES;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, ModelRate>;
  } catch {
    process.stderr.write("MODEL_RATES is not valid JSON; costs will record as 0\n");
    return {};
  }
}

const warned = new Set<string>();

export function estimateCostUsd(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
): number {
  if (!model) return 0;

  const rate = RATES[model];
  if (!rate) {
    if (!warned.has(model)) {
      warned.add(model);
      process.stderr.write(
        `No pricing configured for model "${model}"; cost_usd will be 0. ` +
          `Set MODEL_RATES, e.g. {"${model}":{"inputPerMillion":0,"outputPerMillion":0}}\n`,
      );
    }
    return 0;
  }

  const cost =
    (inputTokens / 1_000_000) * rate.inputPerMillion +
    (outputTokens / 1_000_000) * rate.outputPerMillion;

  // Sub-cent precision matters: the per-bid cost metric is an average over
  // hundreds of individual calls.
  return Number(cost.toFixed(8));
}

/**
 * Document AI is billed per page, and a 120-page solicitation is a real line
 * item next to tokens — at typical layout-parser rates it is the same order of
 * magnitude as the whole shred. Recorded separately so gross margin per bid is
 * honest rather than token-only.
 */
export function docAiCostUsd(pages: number): number {
  const perPage = Number(process.env.DOCAI_USD_PER_PAGE ?? "0");
  return Number((pages * perPage).toFixed(6));
}
