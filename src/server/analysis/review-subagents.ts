import type { RiskLevel, ReviewCase, ReviewIssue } from "@/domain/types";
import { createModelProvider, type ModelProvider } from "@/server/ai/model-provider";
import type { ModelRouteContext, ModelRouteTask } from "@/server/ai/model-router";
import {
  CASE_SEARCH_PROMPT,
  CREATIVE_REVIEW_PROMPT,
  EVIDENCE_VERIFICATION_PROMPT,
  INTERNAL_POLICY_AGENT_PROMPT,
  MAIN_COMPLIANCE_PROMPT,
  PRODUCT_TERMS_PROMPT,
  REGULATION_AGENT_PROMPT
} from "@/server/ai/prompt-registry";
import type { KoreanComplianceMapping, LocalizedRiskFinding } from "./multilingual";
import type { ExtractedDocument, RagEvidenceCandidate } from "./review-analysis-pipeline";
import {
  analysisRiskLevels,
  normalizeAiSuggestedAction,
  normalizeAnalysisRiskLevel,
  riskRank
} from "./risk-policy";

export type ReviewSubAgentId =
  | "main"
  | "creative_review"
  | "product_terms"
  | "regulation"
  | "internal_policy"
  | "evidence_verification"
  | "case_search"
  | "social_context_review"
  | "english_translator_risk"
  | "vietnamese_translator_risk"
  | "myanmar_translator_risk"
  | "khmer_translator_risk"
  | "korean_compliance_mapping";

export type AgentFinding = {
  id: string;
  agent: ReviewSubAgentId;
  issueType: string;
  riskLevel: RiskLevel;
  title: string;
  targetText: string;
  description: string;
  suggestedAction: ReviewIssue["suggestedAction"];
  suggestedCopy: string;
  evidenceCandidateIds: string[];
  confidence: number;
  rawModelOutput?: string;
  localizedRiskFinding?: LocalizedRiskFinding;
  koreanComplianceMapping?: KoreanComplianceMapping;
};

type ReviewSubAgentDefinition = {
  id: ReviewSubAgentId;
  task: ModelRouteTask;
  instructions: string;
};

export type ReviewSubAgentOrchestrator = {
  run(input: {
    review: ReviewCase;
    extractedDocuments: ExtractedDocument[];
    evidenceCandidates: RagEvidenceCandidate[];
    priorFindings?: AgentFinding[];
  }): Promise<AgentFinding[]>;
};

const domainSubAgents: ReviewSubAgentDefinition[] = [
  {
    id: "creative_review",
    task: "creative_review",
    instructions: CREATIVE_REVIEW_PROMPT
  },
  {
    id: "product_terms",
    task: "product_terms",
    instructions: PRODUCT_TERMS_PROMPT
  },
  {
    id: "regulation",
    task: "regulation_agent",
    instructions: REGULATION_AGENT_PROMPT
  },
  {
    id: "internal_policy",
    task: "internal_policy_agent",
    instructions: INTERNAL_POLICY_AGENT_PROMPT
  }
];

const evidenceVerificationAgent: ReviewSubAgentDefinition = {
  id: "evidence_verification",
  task: "evidence_verification",
  instructions: EVIDENCE_VERIFICATION_PROMPT
};

const caseSearchAgent: ReviewSubAgentDefinition = {
  id: "case_search",
  task: "case_search",
  instructions: CASE_SEARCH_PROMPT
};

const mainComplianceAgent: ReviewSubAgentDefinition = {
  id: "main",
  task: "main_compliance",
  instructions: MAIN_COMPLIANCE_PROMPT
};

function clampConfidence(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0.72;
  }

  return Math.max(0, Math.min(1, value));
}

function normalizeRiskLevel(value: unknown): RiskLevel {
  return normalizeAnalysisRiskLevel(value);
}

function normalizeAction(value: unknown): ReviewIssue["suggestedAction"] {
  return normalizeAiSuggestedAction(value);
}

function compactText(text: string, maxLength = 1600) {
  const normalized = text.replace(/\s+/g, " ").trim();

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  const parsed = parseJson(candidate);

  if (parsed !== undefined) {
    return parsed;
  }

  const arrayStart = candidate.indexOf("[");
  const arrayEnd = candidate.lastIndexOf("]");

  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    const arrayParsed = parseJson(candidate.slice(arrayStart, arrayEnd + 1));

    if (arrayParsed !== undefined) {
      return arrayParsed;
    }
  }

  const objectStart = candidate.indexOf("{");
  const objectEnd = candidate.lastIndexOf("}");

  if (objectStart !== -1 && objectEnd > objectStart) {
    const objectParsed = parseJson(candidate.slice(objectStart, objectEnd + 1));

    if (objectParsed !== undefined) {
      return objectParsed;
    }
  }

  return [];
}

function parseJson(candidate: string): unknown | undefined {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function rawFindings(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    "findings" in parsed &&
    Array.isArray(parsed.findings)
  ) {
    return parsed.findings;
  }

  return [];
}

function stringField(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function knownEvidenceIds(candidates: RagEvidenceCandidate[]) {
  return new Set(candidates.map((candidate) => candidate.id));
}

function normalizeEvidenceIds(value: unknown, candidates: RagEvidenceCandidate[]) {
  const allowedIds = knownEvidenceIds(candidates);
  const candidateIds = Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string" && allowedIds.has(id))
    : [];

  if (candidateIds.length > 0) {
    return candidateIds;
  }

  return candidates[0]?.id ? [candidates[0].id] : [];
}

function normalizeFinding(
  agent: ReviewSubAgentId,
  item: unknown,
  index: number,
  evidenceCandidates: RagEvidenceCandidate[],
  rawModelOutput: string
): AgentFinding | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }

  const fields = item as Record<string, unknown>;
  const title = stringField(fields.title, "");

  if (!title) {
    return undefined;
  }

  return {
    id: `finding-${agent}-${String(index + 1).padStart(3, "0")}`,
    agent,
    issueType: stringField(fields.issueType, `ai_${agent}`),
    riskLevel: normalizeRiskLevel(fields.riskLevel),
    title,
    targetText: stringField(fields.targetText, title),
    description: stringField(fields.description, "모델 분석 결과 추가 확인이 필요합니다."),
    suggestedAction: normalizeAction(fields.suggestedAction),
    suggestedCopy: stringField(
      fields.suggestedCopy,
      "조건, 제한 사항, 적용 기준을 인접 영역에 명시해 주세요."
    ),
    evidenceCandidateIds: normalizeEvidenceIds(fields.evidenceCandidateIds, evidenceCandidates),
    confidence: clampConfidence(fields.confidence),
    rawModelOutput
  };
}

function highestFindingRisk(findings: AgentFinding[]): RiskLevel {
  return findings.reduce(
    (highest, finding) =>
      riskRank[finding.riskLevel] > riskRank[highest] ? finding.riskLevel : highest,
    "info" as RiskLevel
  );
}

function evidenceScoresForFinding(
  finding: AgentFinding,
  evidenceCandidates: RagEvidenceCandidate[]
) {
  const evidenceById = new Map(
    evidenceCandidates.map((candidate) => [candidate.id, candidate.relevanceScore])
  );

  return finding.evidenceCandidateIds
    .map((id) => evidenceById.get(id))
    .filter((score): score is number => typeof score === "number");
}

function findingHasWeakEvidence(finding: AgentFinding, evidenceCandidates: RagEvidenceCandidate[]) {
  const scores = evidenceScoresForFinding(finding, evidenceCandidates);

  return scores.length === 0 || scores.some((score) => score < 0.72);
}

function needsEvidenceVerification(
  findings: AgentFinding[],
  evidenceCandidates: RagEvidenceCandidate[]
) {
  return findings.some(
    (finding) =>
      riskRank[finding.riskLevel] >= riskRank.high ||
      finding.confidence < 0.78 ||
      findingHasWeakEvidence(finding, evidenceCandidates)
  );
}

function needsCaseSearch(findings: AgentFinding[], evidenceCandidates: RagEvidenceCandidate[]) {
  return (
    findings.length > 0 &&
    evidenceCandidates.some((candidate) => candidate.sourceType === "case_history")
  );
}

function hasMaterialAgentConflict(findings: AgentFinding[]) {
  if (findings.length < 2) {
    return false;
  }

  const riskValues = findings.map((finding) => riskRank[finding.riskLevel]);
  const riskSpread = Math.max(...riskValues) - Math.min(...riskValues);
  const highRiskAgents = new Set(
    findings
      .filter((finding) => riskRank[finding.riskLevel] >= riskRank.high)
      .map((finding) => finding.agent)
  );

  return riskSpread >= 2 || highRiskAgents.size >= 2;
}

function compactPriorFindings(findings: AgentFinding[]) {
  return findings.map((finding) => ({
    id: finding.id,
    agent: finding.agent,
    issueType: finding.issueType,
    riskLevel: finding.riskLevel,
    title: finding.title,
    targetText: finding.targetText,
    description: finding.description,
    suggestedAction: finding.suggestedAction,
    suggestedCopy: finding.suggestedCopy,
    evidenceCandidateIds: finding.evidenceCandidateIds,
    confidence: finding.confidence,
    localizedRiskFinding: finding.localizedRiskFinding,
    koreanComplianceMapping: finding.koreanComplianceMapping
  }));
}

function bestEvidenceScore(evidenceCandidates: RagEvidenceCandidate[]) {
  return Math.max(0, ...evidenceCandidates.map((candidate) => candidate.relevanceScore));
}

function hasLowOcrConfidence(extractedDocuments: ExtractedDocument[]) {
  return extractedDocuments.some((document) => document.confidence < 0.82);
}

function hasStrongCaseHistory(evidenceCandidates: RagEvidenceCandidate[]) {
  return evidenceCandidates.some(
    (candidate) => candidate.sourceType === "case_history" && candidate.relevanceScore >= 0.84
  );
}

function baseRouteContext(input: {
  review: ReviewCase;
  extractedDocuments: ExtractedDocument[];
  evidenceCandidates: RagEvidenceCandidate[];
}) {
  const bestScore = bestEvidenceScore(input.evidenceCandidates);

  return {
    riskLevel: input.review.highestRiskLevel,
    evidenceCount: input.evidenceCandidates.length,
    evidenceRelevanceScore: bestScore || undefined,
    lowOcrConfidence: hasLowOcrConfidence(input.extractedDocuments)
  };
}

function agentInput({
  review,
  extractedDocuments,
  evidenceCandidates,
  priorFindings = []
}: {
  review: ReviewCase;
  extractedDocuments: ExtractedDocument[];
  evidenceCandidates: RagEvidenceCandidate[];
  priorFindings?: AgentFinding[];
}) {
  return JSON.stringify({
    review: {
      id: review.id,
      title: review.title,
      affiliate: review.affiliate,
      productType: review.productType,
      channelType: review.channelType,
      plannedPublishDate: review.plannedPublishDate,
      missingMaterials: review.missingMaterials
    },
    documents: extractedDocuments.map((document) => ({
      fileId: document.fileId,
      fileName: document.fileName,
      provider: document.provider,
      confidence: document.confidence,
      text: compactText(document.text)
    })),
    evidenceCandidates: evidenceCandidates.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      quoteSummary: candidate.quoteSummary,
      relevanceScore: candidate.relevanceScore,
      sourceType: candidate.sourceType,
      documentId: candidate.documentId,
      sourceFileId: candidate.sourceFileId
    })),
    ...(priorFindings.length > 0 ? { priorFindings: compactPriorFindings(priorFindings) } : {}),
    outputSchema: {
      findings:
        "array of { title, issueType, riskLevel, targetText, description, suggestedAction, suggestedCopy, evidenceCandidateIds, confidence }",
      allowedRiskLevels: analysisRiskLevels,
      allowedSuggestedActions: ["approve", "change_request", "hold"]
    }
  });
}

async function runAgent({
  provider,
  agent,
  input,
  priorFindings = [],
  routeContext = {}
}: {
  provider: ModelProvider;
  agent: ReviewSubAgentDefinition;
  input: {
    review: ReviewCase;
    extractedDocuments: ExtractedDocument[];
    evidenceCandidates: RagEvidenceCandidate[];
  };
  priorFindings?: AgentFinding[];
  routeContext?: ModelRouteContext;
}) {
  const result = await provider.generateText({
    task: agent.task,
    routeContext: {
      ...baseRouteContext(input),
      ...routeContext
    },
    instructions: agent.instructions,
    input: agentInput({ ...input, priorFindings }),
    fallback: "[]"
  });

  return rawFindings(extractJson(result.text))
    .map((finding, index) =>
      normalizeFinding(agent.id, finding, index, input.evidenceCandidates, result.text)
    )
    .filter((finding): finding is AgentFinding => Boolean(finding));
}

export function createReviewSubAgentOrchestrator(
  provider: ModelProvider = createModelProvider()
): ReviewSubAgentOrchestrator {
  return {
    async run(input) {
      const priorFindings = input.priorFindings ?? [];
      const domainFindings = await Promise.all(
        domainSubAgents.map((agent) =>
          runAgent({
            provider,
            agent,
            input
          })
        )
      );
      const findings = [...priorFindings, ...domainFindings.flat()];

      if (findings.length === 0) {
        return findings;
      }

      if (needsEvidenceVerification(findings, input.evidenceCandidates)) {
        findings.push(
          ...(await runAgent({
            provider,
            agent: evidenceVerificationAgent,
            input,
            priorFindings: findings,
            routeContext: {
              riskLevel: highestFindingRisk(findings),
              evidenceContradiction: findings.some((finding) =>
                findingHasWeakEvidence(finding, input.evidenceCandidates)
              )
            }
          }))
        );
      }

      if (needsCaseSearch(findings, input.evidenceCandidates)) {
        findings.push(
          ...(await runAgent({
            provider,
            agent: caseSearchAgent,
            input,
            priorFindings: findings,
            routeContext: {
              riskLevel: highestFindingRisk(findings),
              caseStronglyInfluencesJudgment:
                hasStrongCaseHistory(input.evidenceCandidates) ||
                findings.some((finding) => riskRank[finding.riskLevel] >= riskRank.high)
            }
          }))
        );
      }

      const mainFindings = await runAgent({
        provider,
        agent: mainComplianceAgent,
        input,
        priorFindings: findings,
        routeContext: {
          riskLevel: highestFindingRisk(findings),
          agentConflict: hasMaterialAgentConflict(findings)
        }
      });

      return mainFindings.length > 0 ? mainFindings : findings;
    }
  };
}
