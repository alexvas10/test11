/**
 * Gemini client.
 *
 * Talks to either backend. With GEMINI_API_KEY set it uses the Gemini
 * Developer API, whose free tier covers development at no cost; with
 * GOOGLE_CLOUD_PROJECT and GEMINI_USE_VERTEX it uses Vertex AI, which bills
 * from the first token.
 *
 * The switch is not just about money. Free-tier prompts may be used to improve
 * Google's products, which is fine for public tender PDFs and NOT fine once a
 * customer's past proposals, financials and staff resumes are in the pipeline —
 * we tell firms their documents are isolated. Vertex (or a paid Developer API
 * tier) is a prerequisite for the first paying customer, not an upgrade.
 *
 * Beyond calling the API this does two things: forces structured output through
 * a response schema, and pushes token usage into the agent-run context
 * automatically, because usage that has to be recorded by hand gets forgotten
 * and then the cost-per-bid number in the P&L is wrong.
 */

import { GoogleGenAI } from "@google/genai";
import type { Part, Schema } from "@google/genai";
import type { AgentRunContext } from "./agentlog.ts";

/** Thrown when the free tier's rate or daily limit is exhausted. */
export class QuotaExhaustedError extends Error {
  constructor(detail: string) {
    super(
      `Gemini quota exhausted — the free tier limit was hit and retries did not clear it.\n` +
        `Wait for the quota window to reset, lower SHRED_CONCURRENCY, or move to a paid tier.\n` +
        `Underlying error: ${detail}`,
    );
    this.name = "QuotaExhaustedError";
  }
}

let client: GoogleGenAI | null = null;

/**
 * Resolved on first use rather than at import: reading the environment at
 * module load makes everything downstream — including tests that never call
 * the API — fail without credentials, and turns a missing variable into a
 * stack trace from an import rather than from a call site.
 */
function gemini(): { ai: GoogleGenAI; model: string } {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      client = new GoogleGenAI({ apiKey });
    } else if (process.env.GEMINI_USE_VERTEX) {
      client = new GoogleGenAI({
        vertexai: true,
        project: requireEnv("GOOGLE_CLOUD_PROJECT"),
        location: process.env.VERTEX_LOCATION ?? "us-central1",
      });
    } else {
      throw new Error(
        "No Gemini credentials. Set GEMINI_API_KEY for the free Developer API tier, " +
          "or GEMINI_USE_VERTEX=1 with GOOGLE_CLOUD_PROJECT for Vertex (which bills).",
      );
    }
  }
  return { ai: client, model: requireEnv("GEMINI_MODEL") };
}

export interface GenerateJsonOptions {
  systemInstruction: string;
  prompt: string;
  responseSchema: Schema;
  /** A PDF to read alongside the prompt. */
  pdf?: Uint8Array;
  /** Extraction wants determinism; drafting will want more. */
  temperature?: number;
  ctx: AgentRunContext;
}

/**
 * One structured-output call. Retries transient failures: a 100-page
 * solicitation is dozens of calls and a single 503 should not lose the shred.
 * Rate limits get a longer backoff than server errors, because on the free
 * tier they clear on a clock rather than immediately.
 */
export async function generateJson<T>(options: GenerateJsonOptions): Promise<T> {
  const { systemInstruction, prompt, responseSchema, pdf, temperature = 0, ctx } = options;
  const { ai, model } = gemini();

  const parts: Part[] = [];
  if (pdf) {
    parts.push({
      inlineData: { mimeType: "application/pdf", data: Buffer.from(pdf).toString("base64") },
    });
  }
  parts.push({ text: prompt });

  let lastError: unknown;
  let rateLimited = false;

  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      await sleep(rateLimited ? 20_000 : 500 * 2 ** attempt);
    }

    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        config: {
          systemInstruction,
          temperature,
          responseMimeType: "application/json",
          responseSchema,
        },
      });

      const usage = response.usageMetadata;
      ctx.addUsage(usage?.promptTokenCount ?? 0, usage?.candidatesTokenCount ?? 0);
      ctx.model = model;

      const text = response.text;
      if (!text) throw new Error("empty response");
      return JSON.parse(text) as T;
    } catch (err) {
      lastError = err;
      rateLimited = isRateLimit(err);
      if (!rateLimited && !isRetryable(err)) throw err;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  if (rateLimited) throw new QuotaExhaustedError(detail);
  throw new Error(`Gemini call failed after retries: ${detail}`);
}

function isRateLimit(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b429\b|RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(message);
}

function isRetryable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b(500|502|503|504)\b|deadline|unavailable|overloaded|ECONNRESET/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
