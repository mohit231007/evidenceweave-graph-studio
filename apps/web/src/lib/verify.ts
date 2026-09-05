import { tokenizeRetrieval } from "./retrieval";
import type { RankedEvidence } from "./hybrid";

export interface ClaimValidation {
  claim: string;
  citationIds: string[];
  support: number;
  supported: boolean;
}

export interface VerifiedAnswer {
  answer: string;
  claims: ClaimValidation[];
  coverage: number;
  mode: "extractive" | "webllm";
  modelId?: string;
}

const sentenceSplit = (value: string) => value.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map((item) => item.trim()).filter(Boolean);

function bestSentence(question: string, text: string): string {
  const terms = new Set(tokenizeRetrieval(question));
  const sentences = sentenceSplit(text.replace(/\s+/g, " "));
  return sentences.sort((left, right) => {
    const leftScore = tokenizeRetrieval(left).filter((term) => terms.has(term)).length;
    const rightScore = tokenizeRetrieval(right).filter((term) => terms.has(term)).length;
    return rightScore - leftScore || left.length - right.length;
  })[0] ?? text.slice(0, 300);
}

export function synthesizeExtractive(question: string, evidence: RankedEvidence[], maxSources = 5): string {
  if (!evidence.length) return "Evidence gap: the local workspace does not contain enough support for this question.";
  return evidence.slice(0, maxSources).map((hit, index) => `${bestSentence(question, hit.block.text)} [S${index + 1}]`).join(" ");
}

function supportScore(claim: string, sourceText: string): number {
  const claimTerms = tokenizeRetrieval(claim).filter((term) => !/^s\d+$/i.test(term));
  if (!claimTerms.length) return 0;
  const sourceTerms = new Set(tokenizeRetrieval(sourceText));
  return claimTerms.filter((term) => sourceTerms.has(term)).length / claimTerms.length;
}

export function validateAnswer(answer: string, evidence: RankedEvidence[]): ClaimValidation[] {
  return sentenceSplit(answer).map((claim) => {
    const citationIds = [...claim.matchAll(/\[S(\d+)\]/g)].map((match) => `S${match[1]}`);
    const sourceIndexes = citationIds.map((id) => Number(id.slice(1)) - 1).filter((index) => index >= 0 && index < evidence.length);
    const support = sourceIndexes.reduce((best, index) => Math.max(best, supportScore(claim.replace(/\[S\d+\]/g, ""), evidence[index].block.text)), 0);
    return { claim, citationIds, support, supported: citationIds.length > 0 && support >= 0.34 };
  });
}

export function verifyExtractive(question: string, evidence: RankedEvidence[]): VerifiedAnswer {
  const answer = synthesizeExtractive(question, evidence);
  const claims = validateAnswer(answer, evidence);
  const coverage = claims.length ? claims.filter((claim) => claim.supported).length / claims.length : 0;
  return { answer, claims, coverage, mode: "extractive" };
}

export async function generateWithWebLLM(
  question: string,
  evidence: RankedEvidence[],
  modelId: string,
  onProgress?: (progress: string) => void
): Promise<VerifiedAnswer> {
  if (typeof navigator === "undefined" || !("gpu" in navigator)) throw new Error("WebLLM requires a browser with WebGPU. Evidence-only mode remains available.");
  const webllm = await import("@mlc-ai/web-llm");
  const engine = await webllm.CreateMLCEngine(modelId, {
    appConfig: { ...webllm.prebuiltAppConfig, cacheBackend: "indexeddb" },
    initProgressCallback: (report) => onProgress?.(report.text)
  });
  const context = evidence.slice(0, 8).map((hit, index) => `[S${index + 1}] ${hit.block.title}\n${hit.block.text}`).join("\n\n");
  const completion = await engine.chat.completions.create({
    messages: [
      { role: "system", content: "Answer only from the supplied EvidenceWeave sources. Cite every factual sentence using [S#]. If support is missing, state the evidence gap. Do not invent citations." },
      { role: "user", content: `Question: ${question}\n\nSources:\n${context}` }
    ],
    temperature: 0.1,
    max_tokens: 500
  });
  const answer = completion.choices[0]?.message?.content?.trim() || "Evidence gap: local generation returned no answer.";
  const claims = validateAnswer(answer, evidence);
  const coverage = claims.length ? claims.filter((claim) => claim.supported).length / claims.length : 0;
  return { answer, claims, coverage, mode: "webllm", modelId };
}
