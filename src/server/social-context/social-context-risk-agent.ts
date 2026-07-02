import type { ReviewCase } from "@/domain/types";
import type {
  ExtractedDocument,
  RagEvidenceCandidate
} from "@/server/analysis/review-analysis-pipeline";
import type { AgentFinding } from "@/server/analysis/review-subagents";
import { loadSocialContextKgSeedData } from "./data-loader";
import { extractSocialContextFeatures } from "./feature-extractor";
import { evaluateSocialContextRules } from "./rule-engine";
import type {
  PriorControversyCase,
  SocialContextFeatureSet,
  SocialContextMatch,
  SocialContextRiskResult,
  SocialRiskRule
} from "./types";

export type SocialContextRiskAgentResult = SocialContextRiskResult & {
  features: SocialContextFeatureSet;
  evidenceCandidates: RagEvidenceCandidate[];
  agentFindings: AgentFinding[];
};

function evidenceRelevance(match: SocialContextMatch) {
  return Math.max(0.76, Math.min(0.98, match.confidence));
}

function ruleEvidenceCandidate(
  match: SocialContextMatch,
  rule: SocialRiskRule
): RagEvidenceCandidate {
  return {
    id: match.evidenceCandidateIds.find((id) => id.startsWith("social-context-rule-")) ?? match.id,
    sourceType: "internal_policy",
    documentId: "social-context-kg",
    chunkId: rule.id,
    version: "seed-data-v1",
    title: `Social Context KG Rule: ${rule.nameKo}`,
    section: rule.id,
    quoteSummary: match.rationale,
    relevanceScore: evidenceRelevance(match)
  };
}

function caseEvidenceCandidates(
  match: SocialContextMatch,
  priorCases: PriorControversyCase[]
): RagEvidenceCandidate[] {
  return priorCases.flatMap((priorCase) => {
    const id = match.evidenceCandidateIds.find((candidateId) =>
      candidateId.startsWith(`social-context-case-${priorCase.id}-`)
    );

    if (!id) {
      return [];
    }

    return [
      {
        id,
        sourceType: "case_history" as const,
        documentId: "social-context-prior-controversy-cases",
        chunkId: priorCase.id,
        title: `Prior Social Context Case: ${priorCase.title}`,
        section: priorCase.id,
        quoteSummary: priorCase.lesson,
        relevanceScore: Math.max(0.74, Math.min(0.95, match.confidence - 0.02))
      }
    ];
  });
}

function evidenceCandidatesForMatches(
  matches: SocialContextMatch[],
  rules: SocialRiskRule[],
  priorCases: PriorControversyCase[],
  existingEvidenceCandidates: RagEvidenceCandidate[]
) {
  const existingIds = new Set(existingEvidenceCandidates.map((candidate) => candidate.id));
  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  const candidates: RagEvidenceCandidate[] = [];

  for (const match of matches) {
    const rule = rulesById.get(match.ruleId);

    if (rule) {
      candidates.push(ruleEvidenceCandidate(match, rule));
    }

    candidates.push(...caseEvidenceCandidates(match, priorCases));
  }

  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    if (existingIds.has(candidate.id) || seen.has(candidate.id)) {
      return false;
    }

    seen.add(candidate.id);
    return true;
  });
}

function suggestedCopyFor(match: SocialContextMatch) {
  if (match.suggestedAction === "approve") {
    return "명절·가족 지원 맥락은 유지하되, 종교·참사·정치 상징을 희화화하는 표현이 추가되지 않았는지 최종 확인해 주세요.";
  }

  if (match.riskLevel === "high") {
    return "해당 민감 사건·상징 표현을 금융 혜택 은유에서 제거하고, 상품 조건 중심의 중립 문구로 교체해 주세요.";
  }

  return "문화·국가 상징의 상업적 활용 범위를 줄이고, 존중 맥락 또는 일반 상품 설명으로 문구를 조정해 주세요.";
}

function titleFor(match: SocialContextMatch) {
  if (match.suggestedAction === "approve") {
    return `사회적 맥락 안전 문맥 확인: ${match.ruleName}`;
  }

  return `사회적 맥락 KG 리스크: ${match.ruleName}`;
}

function findingForMatch(match: SocialContextMatch): AgentFinding {
  return {
    id: `finding-${match.id}`,
    agent: "social_context_review",
    issueType: "social_context_kg_risk",
    riskLevel: match.riskLevel,
    title: titleFor(match),
    targetText: match.targetText,
    description: `${match.rationale} 매칭 경로: ${match.matchedPath}`,
    suggestedAction: match.suggestedAction === "approve" ? "approve" : match.suggestedAction,
    suggestedCopy: suggestedCopyFor(match),
    evidenceCandidateIds: match.evidenceCandidateIds,
    confidence: match.confidence,
    rawModelOutput: JSON.stringify({
      countryId: match.countryId,
      ruleId: match.ruleId,
      riskLevel: match.riskLevel,
      suggestedAction: match.suggestedAction,
      matchedTerms: match.matchedTerms,
      matchedDates: match.matchedDates,
      safeContextMatched: match.safeContextMatched
    })
  };
}

export async function runSocialContextRiskAgent(input: {
  review: ReviewCase;
  extractedDocuments: ExtractedDocument[];
  existingEvidenceCandidates?: RagEvidenceCandidate[];
}): Promise<SocialContextRiskAgentResult> {
  const seedData = loadSocialContextKgSeedData();
  const features = extractSocialContextFeatures({
    review: input.review,
    extractedDocuments: input.extractedDocuments,
    seedData
  });
  const result = evaluateSocialContextRules({
    features,
    rules: seedData.socialRiskRules,
    priorControversyCases: seedData.priorControversyCases
  });
  const evidenceCandidates = evidenceCandidatesForMatches(
    result.matches,
    seedData.socialRiskRules,
    seedData.priorControversyCases,
    input.existingEvidenceCandidates ?? []
  );

  return {
    ...result,
    features,
    evidenceCandidates,
    agentFindings: result.matches.map(findingForMatch)
  };
}
