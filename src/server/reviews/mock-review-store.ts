import { getRequiredMaterialRows } from "@/domain/intake";
import {
  answerReviewQuestion,
  generateIssueBasedOpinionDraft,
  shouldReplaceStaleOpinionDraft
} from "@/domain/chat";
import { filterMatchedEvidence } from "@/domain/evidence";
import { generateReviewReport } from "@/domain/reports";
import { reviewCases } from "@/domain/reviews";
import { classifyUploadFileWithConfidence } from "@/domain/upload-policy";
import { buildAnalysisIssues, highestRiskLevelForIssues } from "@/server/analysis/issue-generation";
import {
  normalizeAiSuggestedAction,
  normalizeAnalysisRiskLevel
} from "@/server/analysis/risk-policy";
import type {
  AgentRun,
  ChatMessage,
  ChatSession,
  DraftVersion,
  EvidenceChunk,
  KnowledgeDocument,
  PersistedReviewReport,
  ProductType,
  QualityGateResult,
  RegulatoryChangeSet,
  RegulatorySnapshot,
  RegulatorySource,
  ReviewCase,
  ReviewCertificate,
  ReviewFile,
  ReviewIssue,
  ReviewSummary,
  ReviewVersion,
  RiskLevel
} from "@/domain/types";
import type {
  AgentFindingCandidate,
  AnalysisArtifacts
} from "@/server/analysis/review-analysis-pipeline";
import type {
  AnalysisJob,
  AnalysisResult,
  ActivateRegulatoryChangeSetInput,
  AuditEvent,
  CreateChatMessageInput,
  CreateDraftVersionInput,
  CreateKnowledgeDocumentChunkInput,
  CreateKnowledgeDocumentInput,
  CreateManualIssueInput,
  CreateRegulatoryChangeSetInput,
  CreateRegulatorySnapshotInput,
  CreateRegulatorySourceInput,
  CreateReviewReportInput,
  CreateReviewCaseFromUploadedFilesInput,
  CreateReviewCaseFromSamplePackageInput,
  CreateReviewCaseResult,
  CreateReviewCaseRevisionInput,
  FinalReviewStatus,
  IssueReviewCertificateInput,
  ListReviewSummariesOptions,
  RegulatoryChangeSetListOptions,
  ListAuditEventsOptions,
  ListIssuesOptions,
  CaseHistoryEvidenceSearchInput,
  KnowledgeEvidenceSearchInput,
  ReviewStore,
  ReviewSummaryPage,
  ReviewStoreScope,
  ClaimAnalysisJobResult,
  SaveIssueDecisionInput,
  UpdateReviewReviewerInput,
  UpdateReviewStatusOptions
} from "./review-store";

const uploadAnalysisNotice = "실제 업로드 건은 OCR/RAG 분석 전이므로 근거 부족 상태로 표시됩니다.";
const reReviewNotice = "재업로드된 수정본입니다. AI 재분석 없이 직전 버전과 비교해 재검토하세요.";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function filterIssueMatchedEvidence(issue: ReviewIssue): ReviewIssue {
  return {
    ...issue,
    evidence: filterMatchedEvidence(issue.evidence)
  };
}

function filterReviewMatchedEvidence(review: ReviewCase): ReviewCase {
  return {
    ...review,
    issues: review.issues.map(filterIssueMatchedEvidence)
  };
}

function inferContentType(fileName: string): string {
  if (fileName.endsWith(".png")) {
    return "image/png";
  }

  if (fileName.endsWith(".pdf")) {
    return "application/pdf";
  }

  if (fileName.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }

  return "application/octet-stream";
}

function missingMaterialKeys(review: Pick<ReviewCase, "productType" | "files">): string[] {
  return getRequiredMaterialRows(review)
    .filter((row) => row.status === "missing")
    .map((row) => (row.fileType === "checklist" ? "internal_checklist" : row.fileType));
}

function defaultExpectedDraft(productType: ProductType): string {
  return `${productType} 상품 실제 업로드 자료는 접수되었습니다. 현재 Demo MVP에서는 OCR/RAG 분석 전이므로 파일 분류와 누락 자료 확인 결과를 기준으로 추가 확인이 필요합니다.`;
}

function withStorageMetadata(review: ReviewCase): ReviewCase {
  return {
    ...review,
    currentVersion: review.currentVersion ?? 1,
    files: review.files.map<ReviewFile>((file) => ({
      ...file,
      storageProvider: "sample",
      storageKey: `sample/${review.id}/${file.name}`,
      contentType: inferContentType(file.name),
      sizeBytes: file.name.length * 1024
    }))
  };
}

function toSummary(
  review: ReviewCase,
  certificateStatus?: ReviewSummary["certificateStatus"]
): ReviewSummary {
  return {
    id: review.id,
    title: review.title,
    affiliate: review.affiliate,
    productType: review.productType,
    plannedPublishDate: review.plannedPublishDate,
    status: review.status,
    highestRiskLevel: review.highestRiskLevel,
    requester: review.requester,
    requestDepartment: review.requestDepartment,
    reviewer: review.reviewer,
    currentVersion: review.currentVersion ?? 1,
    ...(certificateStatus ? { certificateStatus } : {})
  };
}

const affiliateIdsByName = new Map([
  ["광주은행", "aff-gwangju-bank"],
  ["전북은행", "aff-jeonbuk-bank"],
  ["PPCBank", "aff-ppc-bank"],
  ["JB Securities Vietnam", "aff-jb-securities-vietnam"],
  ["JB Capital Myanmar", "aff-jb-capital-myanmar"],
  ["JB PPAM", "aff-jb-ppam"]
]);

function affiliateIdForReview(review: ReviewCase): string | undefined {
  return affiliateIdsByName.get(review.affiliate);
}

function agentTypeFromSourceAgents(sourceAgents: string[]): AgentFindingCandidate["agentType"] {
  const [sourceAgent] = sourceAgents;

  if (
    sourceAgent === "english_translator_risk" ||
    sourceAgent === "vietnamese_translator_risk" ||
    sourceAgent === "myanmar_translator_risk" ||
    sourceAgent === "khmer_translator_risk" ||
    sourceAgent === "korean_compliance_mapping"
  ) {
    return sourceAgent;
  }

  if (sourceAgent === "creative_review") {
    return "creative";
  }

  if (sourceAgent === "social_context_review") {
    return "social_context";
  }

  if (
    sourceAgent === "main" ||
    sourceAgent === "creative" ||
    sourceAgent === "product_terms" ||
    sourceAgent === "regulation" ||
    sourceAgent === "internal_policy" ||
    sourceAgent === "case_search" ||
    sourceAgent === "social_context"
  ) {
    return sourceAgent;
  }

  return "main";
}

function multilingualSnapshotsFromIssue(issue: ReviewIssue) {
  const context = issue.multilingualContext;

  if (!context) {
    return {};
  }

  return {
    localizedRiskFinding: {
      segmentId: context.segmentId,
      language: context.language,
      originalText: context.originalText,
      literalTranslation: context.literalTranslation,
      complianceMeaning: context.complianceMeaning,
      riskCategory: context.riskCategory,
      riskSignals: context.riskSignals,
      riskLevelHint: issue.riskLevel,
      suggestedCopyOriginalLanguage: context.suggestedCopyOriginalLanguage,
      suggestedCopyKoreanMeaning: context.suggestedCopyKoreanMeaning,
      confidence: issue.confidence ?? 0.72
    },
    koreanComplianceMapping: {
      localizedFindingId: context.segmentId,
      issueType: issue.issueType,
      koreanComplianceCategory: context.koreanComplianceCategory,
      koreanComplianceReason: context.koreanComplianceReason,
      evidenceQuery: context.evidenceQuery,
      suggestedAction: issue.suggestedAction
    }
  };
}

function findingFromIssue(issue: ReviewIssue): AgentFindingCandidate {
  return {
    agentType: agentTypeFromSourceAgents(issue.sourceAgents),
    issueType: issue.issueType,
    riskLevel: issue.riskLevel,
    title: issue.title,
    targetText: issue.targetText,
    targetBbox: issue.targetBbox,
    description: issue.description,
    suggestedAction: issue.suggestedAction,
    suggestedCopy: issue.suggestedCopy,
    confidence: issue.confidence ?? 0.86,
    evidence: issue.evidence,
    ...multilingualSnapshotsFromIssue(issue)
  };
}

function normalizeFindingCandidate(finding: AgentFindingCandidate): AgentFindingCandidate {
  const normalized: AgentFindingCandidate = {
    ...finding,
    riskLevel: normalizeAnalysisRiskLevel(finding.riskLevel),
    suggestedAction: normalizeAiSuggestedAction(finding.suggestedAction)
  };

  if (finding.localizedRiskFinding) {
    normalized.localizedRiskFinding = {
      ...finding.localizedRiskFinding,
      riskLevelHint: normalizeAnalysisRiskLevel(finding.localizedRiskFinding.riskLevelHint)
    };
  }

  if (finding.koreanComplianceMapping) {
    normalized.koreanComplianceMapping = {
      ...finding.koreanComplianceMapping,
      suggestedAction: normalizeAiSuggestedAction(finding.koreanComplianceMapping.suggestedAction)
    };
  }

  return normalized;
}

function findingsFromArtifacts(
  review: ReviewCase,
  artifacts: AnalysisArtifacts
): AgentFindingCandidate[] {
  const findings =
    artifacts.findings && artifacts.findings.length > 0
      ? artifacts.findings
      : buildAnalysisIssues(review, artifacts).map(findingFromIssue);

  return findings.map(normalizeFindingCandidate);
}

function paginatedSummaries(
  reviews: ReviewCase[],
  options: ListReviewSummariesOptions = {},
  certificateStatusFor?: (reviewCaseId: string) => ReviewSummary["certificateStatus"]
): ReviewSummaryPage {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.max(1, options.pageSize ?? 50);
  const filtered = reviews.filter((review) => {
    if (options.status && review.status !== options.status) {
      return false;
    }

    if (options.productType && review.productType !== options.productType) {
      return false;
    }

    if (options.riskLevel && review.highestRiskLevel !== options.riskLevel) {
      return false;
    }

    if (options.affiliateId && affiliateIdForReview(review) !== options.affiliateId) {
      return false;
    }

    return true;
  });
  const items = filtered
    .slice((page - 1) * pageSize, page * pageSize)
    .map((review) => toSummary(review, certificateStatusFor?.(review.id)));

  return {
    items,
    reviewCases: items,
    page,
    pageSize,
    total: filtered.length
  };
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

type MockReviewStore = ReviewStore & {
  listEvidenceChunksForTest(
    scope: ReviewStoreScope,
    knowledgeDocumentId?: string
  ): Promise<EvidenceChunk[]>;
  listAgentRunsForTest(scope: ReviewStoreScope, reviewCaseId?: string): Promise<AgentRun[]>;
  listAgentFindingsForTest(
    scope: ReviewStoreScope,
    reviewCaseId?: string
  ): Promise<
    Array<
      AgentFindingCandidate & {
        id: string;
        agentRunId: string;
        reviewCaseId: string;
      }
    >
  >;
};

export function createMockReviewStore(seedCases: ReviewCase[] = reviewCases) {
  const samples = new Map(
    seedCases.map((review) => [review.id, withStorageMetadata(clone(review))])
  );
  const cases = new Map(Array.from(samples, ([id, review]) => [id, clone(review)]));
  const caseTenants = new Map(Array.from(samples.keys()).map((id) => [id, "tenant-demo"]));
  const caseRequesters = new Map(
    Array.from(samples.keys()).map((id) => [id, "user-requester-demo"])
  );
  const affiliateTenants = new Map([
    ["aff-gwangju-bank", "tenant-demo"],
    ["aff-jeonbuk-bank", "tenant-demo"],
    ["aff-ppc-bank", "tenant-demo"],
    ["aff-jb-securities-vietnam", "tenant-demo"],
    ["aff-jb-capital-myanmar", "tenant-demo"],
    ["aff-jb-ppam", "tenant-demo"]
  ]);
  let uploadSequence = 1;
  let knowledgeSequence = 1;
  let chatSessionSequence = 1;
  let chatMessageSequence = 1;
  let regulatorySourceSequence = 1;
  let regulatorySnapshotSequence = 1;
  let regulatoryChangeSetSequence = 1;
  const analysisJobs = new Map<string, AnalysisJob[]>();
  const auditEvents: AuditEvent[] = [];
  const knowledgeDocuments = new Map<string, KnowledgeDocument>();
  const evidenceChunks = new Map<string, EvidenceChunk>();
  const regulatorySources = new Map<string, RegulatorySource>();
  const regulatorySnapshots = new Map<string, RegulatorySnapshot>();
  const regulatoryChangeSets = new Map<string, RegulatoryChangeSet>();
  const qualityGateResults = new Map<string, QualityGateResult[]>();
  const chatSessions = new Map<string, ChatSession>();
  const chatSessionTenants = new Map<string, string>();
  const chatMessages = new Map<string, ChatMessage[]>();
  const draftVersions = new Map<string, DraftVersion[]>();
  const reviewReports = new Map<string, PersistedReviewReport[]>();
  const reviewVersions = new Map<string, ReviewVersion[]>();
  const reviewCertificates = new Map<string, ReviewCertificate>();
  const manualIssueSequences = new Map<string, number>();
  const agentRuns = new Map<string, AgentRun>();
  const agentFindings = new Map<
    string,
    AgentFindingCandidate & {
      id: string;
      agentRunId: string;
      reviewCaseId: string;
    }
  >();

  function nextJobId(reviewCaseId: string): string {
    const sequence = (analysisJobs.get(reviewCaseId)?.length ?? 0) + 1;

    return `job-${reviewCaseId}-${String(sequence).padStart(3, "0")}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function collectReviewDocumentExtractions(
    review: ReviewCase
  ): ReviewVersion["documentsSnapshot"] {
    return review.files
      .map((file) => {
        const chunk = evidenceChunks.get(deterministicReviewFileChunkId(review.id, file.id));
        if (!chunk || typeof chunk.chunkText !== "string") {
          return undefined;
        }
        return {
          fileId: file.id,
          fileName: file.name,
          fileType: file.fileType,
          text: chunk.chunkText
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  }

  function recordReviewVersionSnapshot(
    scope: ReviewStoreScope,
    review: ReviewCase,
    status: FinalReviewStatus,
    reviewerComment: string | undefined
  ): void {
    const versions = reviewVersions.get(review.id) ?? [];
    const versionNumber = review.currentVersion;
    const now = nowIso();
    const existingIndex = versions.findIndex((version) => version.versionNumber === versionNumber);
    const snapshot: ReviewVersion = {
      id: `review-version-${review.id}-v${versionNumber}`,
      reviewCaseId: review.id,
      versionNumber,
      status,
      reviewerComment,
      opinionDraft: review.currentDraft,
      issuesSnapshot: clone(review.issues),
      filesSnapshot: review.files.map((file) => ({
        id: file.id,
        name: file.name,
        fileType: file.fileType
      })),
      documentsSnapshot: collectReviewDocumentExtractions(review),
      decidedByUserId: scope.actorUserId,
      decidedByName: scope.actorUserName,
      decidedAt: now,
      createdAt: existingIndex === -1 ? now : versions[existingIndex].createdAt
    };

    if (existingIndex === -1) {
      reviewVersions.set(review.id, [...versions, snapshot]);
    } else {
      const updated = [...versions];
      updated[existingIndex] = snapshot;
      reviewVersions.set(review.id, updated);
    }
  }

  function deterministicKnowledgeChunkId(documentId: string): string {
    return `chunk-${documentId}-001`;
  }

  function deterministicReviewFileChunkId(reviewCaseId: string, fileId: string): string {
    return `chunk-${reviewCaseId}-${fileId}`;
  }

  function ensureApprovedKnowledgeChunk(document: KnowledgeDocument): void {
    const chunkId = deterministicKnowledgeChunkId(document.id);

    if (evidenceChunks.has(chunkId)) {
      return;
    }

    evidenceChunks.set(chunkId, {
      id: chunkId,
      tenantId: document.tenantId,
      knowledgeDocumentId: document.id,
      chunkText: `${document.title} ${document.version}`,
      chunkSummary: document.title,
      embeddingModel: "text-embedding-3-small",
      embeddingId: `embedding-${document.id}-001`,
      metadata: { source: "knowledge_document" },
      createdAt: nowIso()
    });
  }

  function lexicalKnowledgeScore(query: string, text: string, title = ""): number {
    const terms = query
      .split(/[\s.,:;!?()[\]{}"'`~|\\/]+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);

    if (terms.length === 0) {
      return 0.72;
    }

    const target = `${title} ${text}`.toLowerCase();
    const matches = terms.filter((term) => target.includes(term.toLowerCase())).length;
    const titleTarget = title.toLowerCase();
    const titleMatches = titleTarget
      ? terms.filter((term) => titleTarget.includes(term.toLowerCase())).length
      : 0;
    const normalizedQuery = query.replace(/\s+/g, " ").trim().toLowerCase();
    const normalizedTitle = title.replace(/\s+/g, " ").trim().toLowerCase();
    const titleBoost =
      normalizedTitle && normalizedQuery.includes(normalizedTitle)
        ? 0.35
        : titleMatches > 0
          ? Math.min(0.2, titleMatches / terms.length)
          : 0;

    return Math.max(0.55, Math.min(0.99, 0.55 + matches / terms.length / 2 + titleBoost));
  }

  function documentSourceType(document: KnowledgeDocument): "law" | "internal_policy" {
    return document.documentType === "law" ? "law" : "internal_policy";
  }

  function matchesKnowledgeSearch(
    document: KnowledgeDocument,
    input: KnowledgeEvidenceSearchInput
  ) {
    return (
      document.approvalStatus === "approved" &&
      searchableLifecycleStatus(document, input) &&
      activeWindowForSearch(
        { effectiveFrom: document.effectiveFrom, effectiveTo: document.effectiveTo },
        input
      ) &&
      (!input.productType || !document.productType || document.productType === input.productType) &&
      (!input.affiliateId || !document.affiliateId || document.affiliateId === input.affiliateId)
    );
  }

  function dayBeforeDateOnly(value: string): string {
    const date = new Date(`${value}T00:00:00.000Z`);

    date.setUTCDate(date.getUTCDate() - 1);

    return date.toISOString().slice(0, 10);
  }

  function earlierEffectiveTo(existing: string | undefined, cutoff: string): string {
    return existing && existing < cutoff ? existing : cutoff;
  }

  function searchableLifecycleStatus(
    document: KnowledgeDocument,
    input: KnowledgeEvidenceSearchInput
  ): boolean {
    if (!document.lifecycleStatus || document.lifecycleStatus === "active") {
      return true;
    }

    return (
      document.lifecycleStatus === "superseded" &&
      Boolean(input.effectiveOn && document.effectiveTo)
    );
  }

  function searchableChunkStatus(
    chunk: EvidenceChunk,
    input: KnowledgeEvidenceSearchInput
  ): boolean {
    if (!chunk.chunkStatus || chunk.chunkStatus === "active") {
      return true;
    }

    return chunk.chunkStatus === "superseded" && Boolean(input.effectiveOn && chunk.effectiveTo);
  }

  function canAccessRegulatorySource(scope: ReviewStoreScope, sourceId: string): boolean {
    return regulatorySources.get(sourceId)?.tenantId === scope.tenantId;
  }

  function validRegulatorySnapshot(
    scope: ReviewStoreScope,
    sourceId: string,
    snapshotId: string | undefined
  ): boolean {
    if (!snapshotId) {
      return true;
    }

    const snapshot = regulatorySnapshots.get(snapshotId);

    return (
      snapshot?.tenantId === scope.tenantId &&
      snapshot.sourceId === sourceId &&
      canAccessRegulatorySource(scope, sourceId)
    );
  }

  function sortedQualityGateResults(results: QualityGateResult[]): QualityGateResult[] {
    return [...results].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    );
  }

  function activeWindowForSearch(
    window: Pick<EvidenceChunk, "effectiveFrom" | "effectiveTo">,
    input: KnowledgeEvidenceSearchInput
  ): boolean {
    if (!input.effectiveOn) {
      return true;
    }

    if (window.effectiveFrom && input.effectiveOn < window.effectiveFrom) {
      return false;
    }

    return !(window.effectiveTo && input.effectiveOn > window.effectiveTo);
  }

  function activeChunkForSearch(
    chunk: EvidenceChunk,
    input: KnowledgeEvidenceSearchInput
  ): boolean {
    return searchableChunkStatus(chunk, input) && activeWindowForSearch(chunk, input);
  }

  function canAccessCase(scope: ReviewStoreScope, reviewCaseId: string): boolean {
    if (caseTenants.get(reviewCaseId) !== scope.tenantId) {
      return false;
    }

    if (scope.actorRole === "requester") {
      return caseRequesters.get(reviewCaseId) === scope.actorUserId;
    }

    return true;
  }

  function validAffiliateId(scope: ReviewStoreScope, affiliateId: string | undefined) {
    return affiliateId && affiliateTenants.get(affiliateId) === scope.tenantId
      ? affiliateId
      : undefined;
  }

  function validAssistantMessageIdsForReview(
    scope: ReviewStoreScope,
    reviewCaseId: string,
    messageIds: string[]
  ) {
    const allowed = new Set(
      Array.from(chatSessions.values())
        .filter(
          (session) =>
            session.reviewCaseId === reviewCaseId &&
            chatSessionTenants.get(session.id) === scope.tenantId
        )
        .flatMap((session) => chatMessages.get(session.id) ?? [])
        .filter((message) => message.role === "assistant")
        .map((message) => message.id)
    );

    return messageIds.filter((messageId) => allowed.has(messageId));
  }

  function validEvidenceIdsForReview(review: ReviewCase, evidenceIds: string[]) {
    const allowed = new Set(
      review.issues.flatMap((issue) => issue.evidence.map((evidence) => evidence.id))
    );

    return evidenceIds.filter((evidenceId) => allowed.has(evidenceId));
  }

  type AllowedEvidenceChunk = EvidenceChunk & {
    documentVersion?: string;
    documentEffectiveFrom?: string;
  };

  function generatedIssueFromFinding(
    reviewCaseId: string,
    jobId: string,
    finding: AgentFindingCandidate,
    index: number,
    reviewFileIds: Set<string>,
    allowedChunks: Map<string, AllowedEvidenceChunk>
  ): ReviewIssue {
    const issueId = `issue-${reviewCaseId}-${String(index + 1).padStart(3, "0")}`;
    const sourceFileId = finding.evidence[0]?.sourceFileId;
    const targetFileId = sourceFileId && reviewFileIds.has(sourceFileId) ? sourceFileId : undefined;
    const multilingualContext =
      finding.localizedRiskFinding && finding.koreanComplianceMapping
        ? {
            segmentId: finding.localizedRiskFinding.segmentId,
            language: finding.localizedRiskFinding.language,
            originalText: finding.localizedRiskFinding.originalText,
            literalTranslation: finding.localizedRiskFinding.literalTranslation,
            complianceMeaning: finding.localizedRiskFinding.complianceMeaning,
            riskCategory: finding.localizedRiskFinding.riskCategory,
            riskSignals: finding.localizedRiskFinding.riskSignals,
            koreanComplianceCategory: finding.koreanComplianceMapping.koreanComplianceCategory,
            koreanComplianceReason: finding.koreanComplianceMapping.koreanComplianceReason,
            evidenceQuery: finding.koreanComplianceMapping.evidenceQuery,
            suggestedCopyOriginalLanguage:
              finding.localizedRiskFinding.suggestedCopyOriginalLanguage,
            suggestedCopyKoreanMeaning: finding.localizedRiskFinding.suggestedCopyKoreanMeaning
          }
        : undefined;
    const evidence = finding.evidence.map((candidate, evidenceIndex) => {
      const candidateSourceFileId =
        candidate.sourceFileId && reviewFileIds.has(candidate.sourceFileId)
          ? candidate.sourceFileId
          : undefined;
      const candidateReviewFileChunkId = candidateSourceFileId
        ? deterministicReviewFileChunkId(reviewCaseId, candidateSourceFileId)
        : undefined;
      const allowedChunkId =
        candidateReviewFileChunkId && allowedChunks.has(candidateReviewFileChunkId)
          ? candidateReviewFileChunkId
          : candidate.chunkId && allowedChunks.has(candidate.chunkId)
            ? candidate.chunkId
            : undefined;
      const allowedChunk = allowedChunkId ? allowedChunks.get(allowedChunkId) : undefined;
      const hasAllowedKnowledgeDocument =
        allowedChunk?.knowledgeDocumentId &&
        (!candidate.documentId || allowedChunk.knowledgeDocumentId === candidate.documentId);
      const documentId = hasAllowedKnowledgeDocument ? allowedChunk.knowledgeDocumentId : undefined;

      return {
        id: `evidence-${issueId}-${String(evidenceIndex + 1).padStart(3, "0")}`,
        sourceType: candidate.sourceType,
        documentId,
        chunkId: allowedChunkId,
        version: hasAllowedKnowledgeDocument ? allowedChunk.documentVersion : undefined,
        effectiveFrom: hasAllowedKnowledgeDocument ? allowedChunk.documentEffectiveFrom : undefined,
        title: candidate.title,
        page: candidate.page,
        section: candidate.section,
        quoteSummary: candidate.quoteSummary,
        relevanceScore: candidate.relevanceScore
      };
    });

    return {
      id: issueId,
      issueType: finding.issueType,
      riskLevel: finding.riskLevel,
      title: finding.title,
      targetText: finding.targetText,
      targetBbox: finding.targetBbox,
      targetFileId,
      confidence: finding.confidence,
      agentFindingId: `finding-${reviewCaseId}-${jobId}-${String(index + 1).padStart(3, "0")}`,
      sourceAgents: [finding.agentType],
      suggestedAction: finding.suggestedAction,
      status: "open",
      description: finding.description,
      suggestedCopy: finding.suggestedCopy,
      multilingualContext,
      evidence: clone(evidence)
    };
  }

  const store: MockReviewStore = {
    async listReviewSummaries(scope: ReviewStoreScope, options?: ListReviewSummariesOptions) {
      return paginatedSummaries(
        Array.from(cases.values()).filter((review) => canAccessCase(scope, review.id)),
        options,
        (id) => reviewCertificates.get(id)?.status
      );
    },

    async getReviewCase(scope: ReviewStoreScope, id) {
      const review = cases.get(id);

      return review && canAccessCase(scope, id)
        ? filterReviewMatchedEvidence(clone(review))
        : undefined;
    },

    async isReviewCaseIdAvailable(_scope: ReviewStoreScope, id) {
      return !cases.has(id);
    },

    async createReviewCaseFromSamplePackage(
      scope: ReviewStoreScope,
      { samplePackageId }: CreateReviewCaseFromSamplePackageInput
    ): Promise<CreateReviewCaseResult | undefined> {
      const sample = samples.get(samplePackageId);

      if (!sample || !canAccessCase(scope, samplePackageId)) {
        return undefined;
      }

      const reviewCase: ReviewCase = {
        ...clone(sample),
        status: "analysis_waiting"
      };

      cases.set(reviewCase.id, clone(reviewCase));
      caseTenants.set(reviewCase.id, scope.tenantId);
      caseRequesters.set(reviewCase.id, scope.actorUserId);

      return {
        reviewCase: clone(reviewCase),
        files: clone(reviewCase.files),
        missingMaterials: [...reviewCase.missingMaterials],
        analysisStartHref: `/api/v1/review-cases/${reviewCase.id}/analysis/start`
      };
    },

    async createReviewCaseFromUploadedFiles(
      scope: ReviewStoreScope,
      input: CreateReviewCaseFromUploadedFilesInput
    ): Promise<CreateReviewCaseResult> {
      let id = input.reviewCaseId;

      if (id) {
        if (cases.has(id)) {
          throw new Error("Review case id already exists");
        }
      } else {
        do {
          id = `rc-upload-${String(uploadSequence).padStart(3, "0")}`;
          uploadSequence += 1;
        } while (cases.has(id));
      }

      const files = input.files.map<ReviewFile>((file, index) => {
        const contentType = file.type || inferContentType(file.name);
        const cls = classifyUploadFileWithConfidence({ ...file, type: contentType });

        return {
          id: file.id ?? `file-upload-${String(index + 1).padStart(3, "0")}`,
          name: file.name,
          fileType: cls.fileType,
          classificationConfidence: cls.confidence,
          parseStatus: "pending",
          storageProvider: file.storageProvider ?? "local",
          storageKey: file.storageKey ?? `local/${id}/${file.name}`,
          contentType,
          sizeBytes: file.size
        };
      });

      const reviewCase: ReviewCase = {
        id,
        title: input.title,
        affiliate: input.affiliate,
        productType: input.productType,
        channelType: input.channelType,
        plannedPublishDate: input.plannedPublishDate,
        status: "analysis_waiting",
        highestRiskLevel: "info",
        requester: scope.actorUserName?.trim() || "업로드 요청자",
        requestDepartment: input.requestDepartment?.trim() || undefined,
        reviewer: "",
        promotionalCopy: "실제 업로드 자료 분석 대기",
        disclosure: uploadAnalysisNotice,
        productDescription: "실제 업로드 파일의 본문 추출은 아직 적용되지 않았습니다.",
        missingMaterials: [],
        files,
        issues: [],
        expectedDraft: defaultExpectedDraft(input.productType),
        currentVersion: 1,
        analysisNotice: uploadAnalysisNotice
      };

      reviewCase.missingMaterials = missingMaterialKeys(reviewCase);
      cases.set(id, clone(reviewCase));
      caseTenants.set(id, scope.tenantId);
      caseRequesters.set(id, scope.actorUserId);

      return {
        reviewCase: clone(reviewCase),
        files: clone(files),
        missingMaterials: [...reviewCase.missingMaterials],
        analysisStartHref: `/api/v1/review-cases/${id}/analysis/start`
      };
    },

    async startAnalysis(
      scope: ReviewStoreScope,
      reviewCaseId,
      options = {}
    ): Promise<AnalysisResult | undefined> {
      const review = cases.get(reviewCaseId);

      if (!review || !canAccessCase(scope, reviewCaseId)) {
        return undefined;
      }

      const now = nowIso();
      const job: AnalysisJob = {
        id: nextJobId(reviewCaseId),
        reviewCaseId,
        status: "completed",
        progress: 100,
        currentStep: "deterministic_mock_analysis",
        startedByUserId: scope.actorUserId,
        queuedAt: now,
        startedAt: now,
        completedAt: now,
        artifacts: options.artifacts
      };
      const issues =
        options.artifacts && review.issues.length === 0
          ? buildAnalysisIssues(review, options.artifacts)
          : review.issues;
      const updatedReview: ReviewCase = {
        ...review,
        status: "analysis_complete",
        highestRiskLevel: highestRiskLevelForIssues(review.highestRiskLevel, issues),
        issues
      };

      analysisJobs.set(reviewCaseId, [...(analysisJobs.get(reviewCaseId) ?? []), job]);
      cases.set(reviewCaseId, updatedReview);

      return {
        reviewCaseId,
        status: "analysis_complete",
        issueCount: updatedReview.issues.length,
        analysisHref: `/reviews/${reviewCaseId}`,
        analysisNotice: updatedReview.analysisNotice,
        jobId: job.id,
        extractedDocumentCount: options.artifacts?.extractedDocuments.length,
        evidenceCandidateCount: options.artifacts?.evidenceCandidates.length
      };
    },

    async enqueueAnalysis(scope: ReviewStoreScope, reviewCaseId) {
      const review = cases.get(reviewCaseId);

      if (!review || !canAccessCase(scope, reviewCaseId)) {
        return undefined;
      }

      const activeJob = (analysisJobs.get(reviewCaseId) ?? []).find(
        (job) => job.status === "queued" || job.status === "running"
      );

      if (activeJob) {
        return undefined;
      }

      const job: AnalysisJob = {
        id: nextJobId(reviewCaseId),
        reviewCaseId,
        status: "queued",
        progress: 0,
        currentStep: "queued",
        startedByUserId: scope.actorUserId,
        queuedAt: nowIso()
      };
      const updatedReview: ReviewCase = {
        ...review,
        status: "analysis_queued"
      };

      analysisJobs.set(reviewCaseId, [...(analysisJobs.get(reviewCaseId) ?? []), job]);
      cases.set(reviewCaseId, updatedReview);

      return {
        reviewCaseId,
        status: "analysis_queued" as const,
        issueCount: updatedReview.issues.length,
        analysisHref: `/reviews/${reviewCaseId}`,
        analysisNotice: updatedReview.analysisNotice,
        jobId: job.id
      };
    },

    async claimNextAnalysisJob(
      tenantId: string,
      _workerId: string
    ): Promise<ClaimAnalysisJobResult | undefined> {
      void _workerId;

      for (const [reviewCaseId, jobs] of analysisJobs) {
        const jobIndex = jobs.findIndex((job) => job.status === "queued");

        if (jobIndex === -1) {
          continue;
        }

        const review = cases.get(reviewCaseId);

        if (!review || caseTenants.get(reviewCaseId) !== tenantId) {
          continue;
        }

        const claimed: AnalysisJob = {
          ...jobs[jobIndex],
          status: "running",
          progress: 20,
          currentStep: "worker_running",
          startedAt: nowIso()
        };

        const updatedJobs = [...jobs];
        updatedJobs[jobIndex] = claimed;
        analysisJobs.set(reviewCaseId, updatedJobs);
        cases.set(reviewCaseId, {
          ...review,
          status: "analysis_in_progress"
        });

        return {
          ...clone(claimed),
          reviewCase: clone(review)
        };
      }

      void tenantId;

      return undefined;
    },

    async completeAnalysisJob(scope: ReviewStoreScope, jobId, _artifacts) {
      void _artifacts;

      for (const [reviewCaseId, jobs] of analysisJobs) {
        const jobIndex = jobs.findIndex((job) => job.id === jobId);

        if (jobIndex === -1) {
          continue;
        }

        const review = cases.get(reviewCaseId);

        if (!review || !canAccessCase(scope, reviewCaseId)) {
          return undefined;
        }

        const job = jobs[jobIndex];
        const persistedArtifacts = job.artifacts;

        if (
          (job.status !== "queued" && job.status !== "running") ||
          job.currentStep !== "outputs_persisted" ||
          !persistedArtifacts
        ) {
          return undefined;
        }

        const completed: AnalysisJob = {
          ...job,
          status: "completed",
          progress: 100,
          currentStep: "worker_completed",
          completedAt: nowIso(),
          artifacts: persistedArtifacts
        };
        const updatedReview: ReviewCase = {
          ...review,
          status: "analysis_complete"
        };

        const updatedJobs = [...jobs];
        updatedJobs[jobIndex] = completed;
        analysisJobs.set(reviewCaseId, updatedJobs);
        cases.set(reviewCaseId, updatedReview);

        return {
          reviewCaseId,
          status: "analysis_complete" as const,
          issueCount: updatedReview.issues.length,
          analysisHref: `/reviews/${reviewCaseId}`,
          analysisNotice: updatedReview.analysisNotice,
          jobId,
          extractedDocumentCount: persistedArtifacts.extractedDocuments.length,
          evidenceCandidateCount: persistedArtifacts.evidenceCandidates.length
        };
      }

      return undefined;
    },

    async persistAnalysisOutputs(scope, { reviewCaseId, jobId, artifacts }) {
      const review = cases.get(reviewCaseId);

      if (!review || !canAccessCase(scope, reviewCaseId)) {
        return undefined;
      }

      const jobs = analysisJobs.get(reviewCaseId) ?? [];
      const jobIndex = jobs.findIndex((candidate) => candidate.id === jobId);
      const job = jobIndex === -1 ? undefined : jobs[jobIndex];

      if (
        !job ||
        (job.status !== "queued" && job.status !== "running") ||
        job.currentStep === "outputs_persisting" ||
        job.currentStep === "outputs_persisted"
      ) {
        return undefined;
      }

      const persistingJob: AnalysisJob = {
        ...job,
        progress: Math.max(job.progress, 80),
        currentStep: "outputs_persisting"
      };
      const persistingJobs = [...jobs];
      persistingJobs[jobIndex] = persistingJob;
      analysisJobs.set(reviewCaseId, persistingJobs);

      const findings = findingsFromArtifacts(review, artifacts);
      const agentTypes = unique(findings.map((finding) => finding.agentType));
      const now = nowIso();
      const reviewFileIds = new Set(review.files.map((file) => file.id));

      for (const document of artifacts.extractedDocuments) {
        if (!reviewFileIds.has(document.fileId)) {
          continue;
        }

        const chunkId = deterministicReviewFileChunkId(reviewCaseId, document.fileId);
        evidenceChunks.set(chunkId, {
          id: chunkId,
          tenantId: scope.tenantId,
          reviewFileId: document.fileId,
          chunkText: document.text,
          chunkSummary: document.fileName,
          embeddingModel: "deterministic",
          embeddingId: `embedding-${chunkId}`,
          metadata: {
            source: "review_file",
            provider: document.provider,
            confidence: document.confidence,
            ...(document.storageKey ? { storageKey: document.storageKey } : {})
          },
          createdAt: now
        });
      }

      for (const agentType of agentTypes) {
        const runId = `agent-run-${reviewCaseId}-${jobId}-${agentType}`;
        agentRuns.set(runId, {
          id: runId,
          reviewCaseId,
          analysisJobId: jobId,
          agentType,
          status: "completed",
          model: "deterministic",
          modelTier: "mock",
          inputSnapshot: {
            reviewCaseId,
            extractedDocumentCount: artifacts.extractedDocuments.length,
            evidenceCandidateCount: artifacts.evidenceCandidates.length
          },
          outputSnapshot: {
            findingCount: findings.filter((finding) => finding.agentType === agentType).length
          },
          startedAt: artifacts.generatedAt,
          completedAt: now
        });
      }

      findings.forEach((finding, index) => {
        const findingId = `finding-${reviewCaseId}-${jobId}-${String(index + 1).padStart(3, "0")}`;
        agentFindings.set(findingId, {
          ...clone(finding),
          id: findingId,
          agentRunId: `agent-run-${reviewCaseId}-${jobId}-${finding.agentType}`,
          reviewCaseId
        });
      });

      const generatedIssues =
        review.issues.length === 0
          ? (() => {
              const allowedChunks = new Map(
                Array.from(evidenceChunks.values())
                  .filter(
                    (chunk) =>
                      chunk.tenantId === scope.tenantId &&
                      ((chunk.knowledgeDocumentId !== undefined &&
                        knowledgeDocuments.get(chunk.knowledgeDocumentId)?.approvalStatus ===
                          "approved") ||
                        (chunk.reviewFileId !== undefined &&
                          reviewFileIds.has(chunk.reviewFileId) &&
                          chunk.id ===
                            deterministicReviewFileChunkId(reviewCaseId, chunk.reviewFileId)))
                  )
                  .map((chunk) => {
                    const document = chunk.knowledgeDocumentId
                      ? knowledgeDocuments.get(chunk.knowledgeDocumentId)
                      : undefined;

                    return [
                      chunk.id,
                      {
                        ...chunk,
                        documentVersion: document?.version,
                        documentEffectiveFrom: document?.effectiveFrom
                      }
                    ] as const;
                  })
              );

              return findings.map((finding, index) =>
                generatedIssueFromFinding(
                  reviewCaseId,
                  jobId,
                  finding,
                  index,
                  reviewFileIds,
                  allowedChunks
                )
              );
            })()
          : review.issues;
      const highestRiskLevel =
        generatedIssues.find((issue) => issue.riskLevel === "high")?.riskLevel ??
        generatedIssues.find((issue) => issue.riskLevel === "caution")?.riskLevel ??
        review.highestRiskLevel;
      const analysisReview: ReviewCase = {
        ...review,
        issues: generatedIssues,
        highestRiskLevel
      };
      const shouldRefreshDraft = shouldReplaceStaleOpinionDraft(review.currentDraft);
      const updatedReview: ReviewCase = {
        ...analysisReview,
        ...(shouldRefreshDraft
          ? {
              currentDraft: generateIssueBasedOpinionDraft(analysisReview),
              currentDraftVersion: (review.currentDraftVersion ?? 0) + 1
            }
          : {})
      };

      cases.set(reviewCaseId, updatedReview);
      const updatedJobs = [...persistingJobs];
      updatedJobs[jobIndex] = {
        ...persistingJob,
        progress: Math.max(persistingJob.progress, 90),
        currentStep: "outputs_persisted",
        artifacts
      };
      analysisJobs.set(reviewCaseId, updatedJobs);

      return {
        issueCount: updatedReview.issues.length,
        evidenceCount: updatedReview.issues.reduce(
          (count, issue) => count + issue.evidence.length,
          0
        )
      };
    },

    async failAnalysisJob(scope: ReviewStoreScope, jobId, errorMessage) {
      for (const [reviewCaseId, jobs] of analysisJobs) {
        const jobIndex = jobs.findIndex((job) => job.id === jobId);

        if (jobIndex === -1) {
          continue;
        }

        if (!canAccessCase(scope, reviewCaseId)) {
          return undefined;
        }

        const job = jobs[jobIndex];

        if (
          (job.status !== "queued" && job.status !== "running") ||
          job.currentStep === "outputs_persisting"
        ) {
          return undefined;
        }

        const failed: AnalysisJob = {
          ...job,
          status: "failed",
          progress: 100,
          currentStep: "worker_failed",
          completedAt: nowIso(),
          errorMessage
        };

        const updatedJobs = [...jobs];
        updatedJobs[jobIndex] = failed;
        analysisJobs.set(reviewCaseId, updatedJobs);

        const review = cases.get(reviewCaseId);
        if (review) {
          cases.set(reviewCaseId, {
            ...review,
            status: "analysis_failed"
          });
        }

        return clone(failed);
      }

      return undefined;
    },

    async failStaleAnalysisJobs(tenantId: string, olderThanMs: number): Promise<number> {
      const cutoff = new Date(Date.now() - olderThanMs);
      let count = 0;

      for (const [reviewCaseId, jobs] of analysisJobs) {
        if (caseTenants.get(reviewCaseId) !== tenantId) continue;

        const updatedJobs = jobs.map((job) => {
          if (job.status === "running" && job.startedAt && new Date(job.startedAt) <= cutoff) {
            count++;
            return {
              ...job,
              status: "failed" as const,
              progress: 100,
              currentStep: "worker_failed",
              completedAt: nowIso(),
              errorMessage: `stale: job exceeded ${Math.round(olderThanMs / 1000)}s timeout`
            };
          }
          return job;
        });

        analysisJobs.set(reviewCaseId, updatedJobs);

        const newlyFailed = updatedJobs.filter(
          (j, i) => jobs[i]?.status === "running" && j.status === "failed"
        );
        if (newlyFailed.length > 0) {
          const review = cases.get(reviewCaseId);
          if (review) {
            cases.set(reviewCaseId, { ...review, status: "analysis_failed" });
          }
        }
      }

      return count;
    },

    async getLatestAnalysisJob(scope: ReviewStoreScope, reviewCaseId) {
      if (!canAccessCase(scope, reviewCaseId)) {
        return undefined;
      }

      const jobs = analysisJobs.get(reviewCaseId) ?? [];
      const latestJob = jobs.at(-1);

      return latestJob ? clone(latestJob) : undefined;
    },

    async listIssues(scope: ReviewStoreScope, reviewCaseId, options: ListIssuesOptions = {}) {
      const review = cases.get(reviewCaseId);

      if (!review || !canAccessCase(scope, reviewCaseId)) {
        return undefined;
      }

      const issues = options.riskLevel
        ? review.issues.filter((issue) => issue.riskLevel === options.riskLevel)
        : review.issues;

      return clone(issues).map(filterIssueMatchedEvidence);
    },

    async getIssue(scope: ReviewStoreScope, reviewCaseId, issueId) {
      const review = cases.get(reviewCaseId);

      if (!review || !canAccessCase(scope, reviewCaseId)) {
        return undefined;
      }

      const issue = review?.issues.find((candidate) => candidate.id === issueId);

      return issue ? filterIssueMatchedEvidence(clone(issue)) : undefined;
    },

    async getIssueEvidence(scope: ReviewStoreScope, issueId) {
      for (const [reviewCaseId, review] of cases) {
        if (!canAccessCase(scope, reviewCaseId)) {
          continue;
        }

        const issue = review.issues.find((candidate) => candidate.id === issueId);

        if (issue) {
          return filterMatchedEvidence(clone(issue.evidence));
        }
      }

      return undefined;
    },

    async saveIssueDecision(
      scope: ReviewStoreScope,
      {
        reviewCaseId,
        issueId,
        reviewerRiskLevel,
        finalAction,
        reviewerComment
      }: SaveIssueDecisionInput
    ): Promise<ReviewIssue | undefined> {
      const review = cases.get(reviewCaseId);

      if (!review || !canAccessCase(scope, reviewCaseId)) {
        return undefined;
      }

      let updatedIssue: ReviewIssue | undefined;
      const updatedIssues = review.issues.map((issue) => {
        if (issue.id !== issueId) {
          return issue;
        }

        updatedIssue = {
          ...issue,
          reviewerRiskLevel,
          finalAction,
          reviewerComment,
          status: "reviewed"
        };

        return updatedIssue;
      });

      if (!updatedIssue) {
        return undefined;
      }

      cases.set(reviewCaseId, {
        ...review,
        issues: updatedIssues
      });

      return clone(updatedIssue);
    },

    async createManualIssue(
      scope: ReviewStoreScope,
      reviewCaseId,
      input: CreateManualIssueInput
    ): Promise<ReviewIssue | undefined> {
      const review = cases.get(reviewCaseId);

      if (!review || !canAccessCase(scope, reviewCaseId)) {
        return undefined;
      }

      const sequence = (manualIssueSequences.get(reviewCaseId) ?? 0) + 1;
      manualIssueSequences.set(reviewCaseId, sequence);

      const issue: ReviewIssue = {
        id: `issue-${reviewCaseId}-manual-${String(sequence).padStart(3, "0")}`,
        issueType: input.issueType?.trim() || "manual_review",
        riskLevel: input.riskLevel,
        title: input.title,
        targetText: input.targetText ?? "",
        targetBbox: [0, 0, 0, 0],
        sourceAgents: ["manual"],
        suggestedAction: input.suggestedAction,
        status: "open",
        description: input.description ?? "",
        suggestedCopy: input.suggestedCopy ?? "",
        evidence: []
      };
      const issues = [...review.issues, issue];

      cases.set(reviewCaseId, {
        ...review,
        issues,
        highestRiskLevel: highestRiskLevelForIssues(review.highestRiskLevel, issues)
      });

      return clone(issue);
    },

    async saveOpinionDraft(scope: ReviewStoreScope, reviewCaseId, draft) {
      const review = cases.get(reviewCaseId);

      if (!review || !canAccessCase(scope, reviewCaseId)) {
        return undefined;
      }

      const updatedReview = {
        ...review,
        currentDraft: draft,
        currentDraftVersion: (review.currentDraftVersion ?? 0) + 1
      };

      cases.set(reviewCaseId, updatedReview);

      return clone(updatedReview);
    },

    async updateReviewReviewer(
      scope: ReviewStoreScope,
      { reviewCaseId, reviewer }: UpdateReviewReviewerInput
    ) {
      const review = cases.get(reviewCaseId);

      if (!review || !canAccessCase(scope, reviewCaseId)) {
        return undefined;
      }

      const updatedReview = {
        ...review,
        reviewer
      };

      cases.set(reviewCaseId, updatedReview);

      return clone(updatedReview);
    },

    async updateReviewStatus(
      scope: ReviewStoreScope,
      reviewCaseId,
      status,
      options: UpdateReviewStatusOptions = {}
    ) {
      const review = cases.get(reviewCaseId);

      if (!review || !canAccessCase(scope, reviewCaseId)) {
        return undefined;
      }

      const updatedReview = {
        ...review,
        status
      };

      cases.set(reviewCaseId, updatedReview);
      recordReviewVersionSnapshot(scope, updatedReview, status, options.reviewerComment);

      return clone(updatedReview);
    },

    async createReviewCaseRevision(
      scope: ReviewStoreScope,
      reviewCaseId,
      input: CreateReviewCaseRevisionInput
    ): Promise<ReviewCase | undefined> {
      const review = cases.get(reviewCaseId);

      if (!review || !canAccessCase(scope, reviewCaseId)) {
        return undefined;
      }

      if (review.status !== "change_requested" && review.status !== "rejected") {
        return undefined;
      }

      const nextVersion = review.currentVersion + 1;
      const files = input.files.map<ReviewFile>((file, index) => {
        const contentType = file.type || inferContentType(file.name);
        const cls = classifyUploadFileWithConfidence({ ...file, type: contentType });

        return {
          id:
            file.id ??
            `${reviewCaseId}-v${nextVersion}-file-upload-${String(index + 1).padStart(3, "0")}`,
          name: file.name,
          fileType: cls.fileType,
          classificationConfidence: cls.confidence,
          parseStatus: "pending",
          storageProvider: file.storageProvider ?? "local",
          storageKey: file.storageKey ?? `local/${reviewCaseId}/${file.name}`,
          contentType,
          sizeBytes: file.size
        };
      });
      const revisedReview: ReviewCase = {
        ...review,
        files,
        issues: [],
        currentDraft: undefined,
        currentDraftVersion: undefined,
        highestRiskLevel: "info",
        currentVersion: nextVersion,
        status: "re_review_pending",
        analysisNotice: reReviewNotice,
        missingMaterials: []
      };

      revisedReview.missingMaterials = missingMaterialKeys(revisedReview);
      cases.set(reviewCaseId, revisedReview);

      return clone(revisedReview);
    },

    async listReviewVersions(scope: ReviewStoreScope, reviewCaseId): Promise<ReviewVersion[]> {
      if (!canAccessCase(scope, reviewCaseId)) {
        return [];
      }

      return clone(
        [...(reviewVersions.get(reviewCaseId) ?? [])].sort(
          (left, right) => left.versionNumber - right.versionNumber
        )
      );
    },

    async getReviewDocumentExtractions(scope, reviewCaseId) {
      const review = cases.get(reviewCaseId);
      if (!review || !canAccessCase(scope, reviewCaseId)) {
        return [];
      }
      return clone(collectReviewDocumentExtractions(review) ?? []);
    },

    async replaceReviewDocumentExtractions(scope, reviewCaseId, documents) {
      const review = cases.get(reviewCaseId);
      if (!review || !canAccessCase(scope, reviewCaseId)) {
        return;
      }

      const now = nowIso();
      const reviewFileIds = new Set(review.files.map((file) => file.id));

      for (const document of documents) {
        if (!reviewFileIds.has(document.fileId)) {
          continue;
        }

        const chunkId = deterministicReviewFileChunkId(reviewCaseId, document.fileId);
        evidenceChunks.set(chunkId, {
          id: chunkId,
          tenantId: scope.tenantId,
          reviewFileId: document.fileId,
          chunkText: document.text,
          chunkSummary: document.fileName,
          embeddingModel: "deterministic",
          embeddingId: `embedding-${chunkId}`,
          metadata: {
            source: "review_file",
            provider: document.provider,
            confidence: document.confidence,
            ...(document.storageKey ? { storageKey: document.storageKey } : {})
          },
          createdAt: now
        });
      }
    },

    async issueReviewCertificate(
      scope: ReviewStoreScope,
      reviewCaseId,
      input: IssueReviewCertificateInput
    ): Promise<ReviewCertificate | undefined> {
      const review = cases.get(reviewCaseId);

      if (!review || !canAccessCase(scope, reviewCaseId)) {
        return undefined;
      }

      const now = nowIso();
      const existing = reviewCertificates.get(reviewCaseId);
      const approvedAt = existing?.metadata.approvedAt ?? now;
      const certificate: ReviewCertificate = {
        id: existing?.id ?? `review-certificate-${reviewCaseId}`,
        reviewCaseId,
        status: input.status ?? "issued",
        certificateNumber: input.certificateNumber,
        body: input.body,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
        remarks: input.remarks,
        metadata: {
          title: review.title,
          productType: review.productType,
          affiliateName: review.affiliate,
          reviewerName: review.reviewer,
          approvedAt
        },
        issuedByUserId: scope.actorUserId,
        issuedByName: scope.actorUserName,
        issuedAt: existing?.issuedAt ?? now,
        updatedAt: now,
        createdAt: existing?.createdAt ?? now
      };

      reviewCertificates.set(reviewCaseId, certificate);

      return clone(certificate);
    },

    async getReviewCertificate(
      scope: ReviewStoreScope,
      reviewCaseId
    ): Promise<ReviewCertificate | undefined> {
      if (!canAccessCase(scope, reviewCaseId)) {
        return undefined;
      }

      const certificate = reviewCertificates.get(reviewCaseId);

      return certificate ? clone(certificate) : undefined;
    },

    async deleteReviewCase(scope: ReviewStoreScope, reviewCaseId) {
      const review = cases.get(reviewCaseId);

      if (!review || !canAccessCase(scope, reviewCaseId)) {
        return undefined;
      }

      cases.delete(reviewCaseId);

      return clone(review);
    },

    async recordAuditEvent(scope, input) {
      const event: AuditEvent = {
        id: `audit-${String(auditEvents.length + 1).padStart(3, "0")}`,
        tenantId: scope.tenantId,
        userId: scope.actorUserId,
        ipAddress: scope.ipAddress,
        createdAt: nowIso(),
        ...input
      };

      auditEvents.unshift(event);

      return clone(event);
    },

    async listAuditEvents(scope: ReviewStoreScope, options: ListAuditEventsOptions = {}) {
      return clone(
        auditEvents.filter((event) => {
          if (event.tenantId !== scope.tenantId) {
            return false;
          }

          if (options.targetType && event.targetType !== options.targetType) {
            return false;
          }

          if (options.targetId && event.targetId !== options.targetId) {
            return false;
          }

          return true;
        })
      );
    },

    async createKnowledgeDocument(scope: ReviewStoreScope, input: CreateKnowledgeDocumentInput) {
      const document: KnowledgeDocument = {
        id: input.id ?? `knowledge-${String(knowledgeSequence).padStart(3, "0")}`,
        tenantId: scope.tenantId,
        affiliateId: validAffiliateId(scope, input.affiliateId),
        documentType: input.documentType,
        productType: input.productType,
        title: input.title,
        version: input.version,
        effectiveFrom: input.effectiveFrom,
        approvalStatus: "draft",
        storageKey: input.storageKey,
        createdBy: scope.actorUserId,
        createdAt: nowIso()
      };

      knowledgeSequence += input.id ? 0 : 1;
      knowledgeDocuments.set(document.id, document);

      return clone(document);
    },

    async listKnowledgeDocuments(scope: ReviewStoreScope) {
      return clone(
        Array.from(knowledgeDocuments.values()).filter(
          (document) => document.tenantId === scope.tenantId
        )
      );
    },

    async approveKnowledgeDocument(scope: ReviewStoreScope, documentId) {
      const document = knowledgeDocuments.get(documentId);

      if (!document || document.tenantId !== scope.tenantId) {
        return undefined;
      }

      const approved: KnowledgeDocument = {
        ...document,
        approvalStatus: "approved",
        approvedBy: scope.actorUserId,
        approvedAt: nowIso()
      };

      knowledgeDocuments.set(documentId, approved);
      ensureApprovedKnowledgeChunk(approved);

      return clone(approved);
    },

    async unapproveKnowledgeDocument(scope: ReviewStoreScope, documentId) {
      const document = knowledgeDocuments.get(documentId);

      if (!document || document.tenantId !== scope.tenantId) {
        return undefined;
      }

      const draft: KnowledgeDocument = {
        ...document,
        approvalStatus: "draft",
        approvedBy: undefined,
        approvedAt: undefined
      };

      knowledgeDocuments.set(documentId, draft);

      return clone(draft);
    },

    async deleteKnowledgeDocument(scope: ReviewStoreScope, documentId) {
      const document = knowledgeDocuments.get(documentId);

      if (!document || document.tenantId !== scope.tenantId) {
        return undefined;
      }

      knowledgeDocuments.delete(documentId);

      for (const [chunkId, chunk] of evidenceChunks) {
        if (chunk.knowledgeDocumentId === documentId) {
          evidenceChunks.delete(chunkId);
        }
      }

      return clone(document);
    },

    async replaceKnowledgeDocumentChunks(
      scope: ReviewStoreScope,
      documentId,
      chunks: CreateKnowledgeDocumentChunkInput[]
    ) {
      const document = knowledgeDocuments.get(documentId);

      if (!document || document.tenantId !== scope.tenantId) {
        return undefined;
      }

      for (const [chunkId, chunk] of evidenceChunks) {
        if (chunk.knowledgeDocumentId === documentId) {
          evidenceChunks.delete(chunkId);
        }
      }

      const now = nowIso();
      const persisted = chunks.map<EvidenceChunk>((chunk) => ({
        ...chunk,
        tenantId: scope.tenantId,
        knowledgeDocumentId: documentId,
        impactTags: chunk.impactTags ? [...chunk.impactTags] : undefined,
        metadata: clone(chunk.metadata),
        createdAt: now
      }));

      for (const chunk of persisted) {
        evidenceChunks.set(chunk.id, chunk);
      }

      return clone(persisted);
    },

    async listKnowledgeDocumentChunks(scope: ReviewStoreScope, documentId) {
      const document = knowledgeDocuments.get(documentId);

      if (!document || document.tenantId !== scope.tenantId) {
        return undefined;
      }

      return clone(
        Array.from(evidenceChunks.values())
          .filter(
            (chunk) => chunk.tenantId === scope.tenantId && chunk.knowledgeDocumentId === documentId
          )
          .sort((left, right) => left.id.localeCompare(right.id))
      );
    },

    async searchKnowledgeEvidence(scope: ReviewStoreScope, input: KnowledgeEvidenceSearchInput) {
      const minScore = input.minScore ?? 0.5;
      const topK = input.topK ?? 4;

      const knowledgeMatches = Array.from(evidenceChunks.values()).flatMap((chunk) => {
        const documentId = chunk.knowledgeDocumentId;
        const document = documentId ? knowledgeDocuments.get(documentId) : undefined;

        if (
          !document ||
          document.tenantId !== scope.tenantId ||
          !matchesKnowledgeSearch(document, input) ||
          !activeChunkForSearch(chunk, input)
        ) {
          return [];
        }

        // Down-weight lexical vs vector cosine (see prisma store KNOWLEDGE_LEXICAL_WEIGHT)
        // so keyword-rich generic docs cannot outrank genuine semantic matches.
        const score =
          lexicalKnowledgeScore(
            input.query,
            [chunk.chunkSummary, chunk.chunkText, document.version].filter(Boolean).join(" "),
            document.title
          ) * 0.8;

        if (score < minScore) {
          return [];
        }

        return [
          {
            id: `knowledge-evidence-${chunk.id}`,
            sourceType: documentSourceType(document),
            documentId: document.id,
            chunkId: chunk.id,
            version: document.version,
            effectiveFrom: document.effectiveFrom,
            title: document.title,
            page: chunk.page,
            section: chunk.section,
            quoteSummary: chunk.chunkSummary || chunk.chunkText,
            relevanceScore: score
          }
        ];
      });

      // Dedupe by document (best chunk per document) so a large multi-chunk
      // regulation can't crowd out single-chunk relevant documents (see prisma store).
      const knowledgeByDocument = new Map<string, (typeof knowledgeMatches)[number]>();
      for (const evidence of knowledgeMatches) {
        const key = evidence.documentId ?? evidence.id;
        const existing = knowledgeByDocument.get(key);

        if (!existing || evidence.relevanceScore > existing.relevanceScore) {
          knowledgeByDocument.set(key, evidence);
        }
      }

      return Array.from(knowledgeByDocument.values())
        .sort((left, right) => right.relevanceScore - left.relevanceScore)
        .slice(0, topK);
    },

    async createRegulatorySource(scope: ReviewStoreScope, input: CreateRegulatorySourceInput) {
      const now = nowIso();
      const id = input.id ?? `reg-source-${String(regulatorySourceSequence).padStart(3, "0")}`;

      if (regulatorySources.has(id)) {
        throw new Error("Regulatory source id already exists");
      }

      regulatorySourceSequence += input.id ? 0 : 1;
      const source: RegulatorySource = {
        id,
        tenantId: scope.tenantId,
        sourceType: input.sourceType,
        name: input.name,
        url: input.url,
        repositoryPath: input.repositoryPath,
        pollingSchedule: input.pollingSchedule,
        trustLevel: input.trustLevel,
        status: input.status ?? "active",
        createdAt: now,
        updatedAt: now
      };

      regulatorySources.set(id, source);

      return clone(source);
    },

    async listRegulatorySources(scope: ReviewStoreScope) {
      return clone(
        Array.from(regulatorySources.values()).filter(
          (source) => source.tenantId === scope.tenantId
        )
      );
    },

    async getRegulatorySource(scope: ReviewStoreScope, sourceId) {
      const source = regulatorySources.get(sourceId);

      return source && source.tenantId === scope.tenantId ? clone(source) : undefined;
    },

    async createRegulatorySnapshot(scope: ReviewStoreScope, input: CreateRegulatorySnapshotInput) {
      if (!canAccessRegulatorySource(scope, input.sourceId)) {
        throw new Error("Regulatory source not found");
      }

      const id = input.id ?? `reg-snapshot-${String(regulatorySnapshotSequence).padStart(3, "0")}`;

      if (regulatorySnapshots.has(id)) {
        throw new Error("Regulatory snapshot id already exists");
      }

      regulatorySnapshotSequence += input.id ? 0 : 1;
      const snapshot: RegulatorySnapshot = {
        ...input,
        id,
        tenantId: scope.tenantId,
        createdAt: nowIso()
      };

      regulatorySnapshots.set(id, clone(snapshot));
      const source = regulatorySources.get(input.sourceId);

      if (source) {
        regulatorySources.set(source.id, {
          ...source,
          lastCheckedAt: snapshot.createdAt,
          status: input.fetchStatus === "failed" ? "failing" : source.status,
          updatedAt: snapshot.createdAt
        });
      }

      return clone(snapshot);
    },

    async getLatestRegulatorySnapshot(scope: ReviewStoreScope, sourceId) {
      if (!canAccessRegulatorySource(scope, sourceId)) {
        return undefined;
      }

      const latestSnapshot = Array.from(regulatorySnapshots.values())
        .filter(
          (snapshot) => snapshot.tenantId === scope.tenantId && snapshot.sourceId === sourceId
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];

      return latestSnapshot ? clone(latestSnapshot) : undefined;
    },

    async listLatestRegulatorySnapshots(scope: ReviewStoreScope, sourceIds) {
      const requestedSourceIds = new Set(
        sourceIds.filter((sourceId) => canAccessRegulatorySource(scope, sourceId))
      );
      const snapshots = Array.from(regulatorySnapshots.values())
        .filter(
          (snapshot) =>
            snapshot.tenantId === scope.tenantId && requestedSourceIds.has(snapshot.sourceId)
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const latestSnapshots = new Map<string, RegulatorySnapshot>();

      for (const snapshot of snapshots) {
        if (!latestSnapshots.has(snapshot.sourceId)) {
          latestSnapshots.set(snapshot.sourceId, clone(snapshot));
        }
      }

      return latestSnapshots;
    },

    async createRegulatoryChangeSet(
      scope: ReviewStoreScope,
      input: CreateRegulatoryChangeSetInput
    ) {
      if (!canAccessRegulatorySource(scope, input.sourceId)) {
        throw new Error("Regulatory source not found");
      }

      if (
        !validRegulatorySnapshot(scope, input.sourceId, input.newSnapshotId) ||
        !validRegulatorySnapshot(scope, input.sourceId, input.previousSnapshotId)
      ) {
        throw new Error("Regulatory source or snapshot not found");
      }

      const id = input.id ?? `reg-change-${String(regulatoryChangeSetSequence).padStart(3, "0")}`;

      if (regulatoryChangeSets.has(id)) {
        throw new Error("Regulatory change set id already exists");
      }

      regulatoryChangeSetSequence += input.id ? 0 : 1;
      const changeSet: RegulatoryChangeSet = {
        ...clone(input),
        id,
        tenantId: scope.tenantId,
        createdAt: nowIso()
      };

      regulatoryChangeSets.set(id, changeSet);

      return clone(changeSet);
    },

    async listRegulatoryChangeSets(
      scope: ReviewStoreScope,
      options: RegulatoryChangeSetListOptions = {}
    ) {
      return clone(
        Array.from(regulatoryChangeSets.values())
          .filter((changeSet) => changeSet.tenantId === scope.tenantId)
          .filter((changeSet) => !options.sourceId || changeSet.sourceId === options.sourceId)
          .filter(
            (changeSet) =>
              !options.qualityGateStatus ||
              changeSet.qualityGateStatus === options.qualityGateStatus
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      );
    },

    async getRegulatoryChangeSet(scope: ReviewStoreScope, changeSetId) {
      const changeSet = regulatoryChangeSets.get(changeSetId);

      return changeSet && changeSet.tenantId === scope.tenantId ? clone(changeSet) : undefined;
    },

    async replaceQualityGateResults(
      scope: ReviewStoreScope,
      changeSetId,
      results: QualityGateResult[]
    ) {
      const changeSet = regulatoryChangeSets.get(changeSetId);

      if (!changeSet || changeSet.tenantId !== scope.tenantId) {
        return undefined;
      }

      const sortedResults = sortedQualityGateResults(clone(results));

      qualityGateResults.set(changeSetId, sortedResults);

      return clone(sortedResults);
    },

    async listQualityGateResults(scope: ReviewStoreScope, changeSetId) {
      const changeSet = regulatoryChangeSets.get(changeSetId);

      if (!changeSet || changeSet.tenantId !== scope.tenantId) {
        return undefined;
      }

      return clone(sortedQualityGateResults(qualityGateResults.get(changeSetId) ?? []));
    },

    async activateRegulatoryChangeSet(
      scope: ReviewStoreScope,
      input: ActivateRegulatoryChangeSetInput
    ) {
      const changeSet = regulatoryChangeSets.get(input.changeSetId);

      if (!changeSet || changeSet.tenantId !== scope.tenantId) {
        return undefined;
      }

      const documentChangeSetId = input.document.changeSetId ?? changeSet.id;
      const sourceSnapshotId = input.document.sourceSnapshotId ?? changeSet.newSnapshotId;
      const sourceSnapshot = regulatorySnapshots.get(sourceSnapshotId);

      if (documentChangeSetId !== changeSet.id) {
        throw new Error("Activation document change set must match the activated change set");
      }

      if (
        sourceSnapshotId !== changeSet.newSnapshotId ||
        !sourceSnapshot ||
        sourceSnapshot.tenantId !== scope.tenantId ||
        sourceSnapshot.sourceId !== changeSet.sourceId
      ) {
        throw new Error("Activation source snapshot not found");
      }

      if (input.document.supersedesDocumentId) {
        const supersededDocument = knowledgeDocuments.get(input.document.supersedesDocumentId);

        if (!supersededDocument || supersededDocument.tenantId !== scope.tenantId) {
          throw new Error("Superseded knowledge document not found");
        }
      }

      const invalidChunkChangeSet = input.chunks.find(
        (chunk) => chunk.changeSetId && chunk.changeSetId !== changeSet.id
      );

      if (invalidChunkChangeSet) {
        throw new Error("Activation chunk change set must match the activated change set");
      }

      for (const chunk of input.chunks) {
        if (!chunk.supersedesChunkId) {
          continue;
        }

        const supersededChunk = evidenceChunks.get(chunk.supersedesChunkId);

        if (!supersededChunk || supersededChunk.tenantId !== scope.tenantId) {
          throw new Error("Superseded evidence chunk not found");
        }
      }

      if (input.document.canonicalKey) {
        const supersededEffectiveTo = dayBeforeDateOnly(input.document.effectiveFrom);

        for (const [documentId, document] of knowledgeDocuments) {
          if (
            document.tenantId === scope.tenantId &&
            document.canonicalKey === input.document.canonicalKey &&
            (!document.lifecycleStatus || document.lifecycleStatus === "active")
          ) {
            knowledgeDocuments.set(documentId, {
              ...document,
              lifecycleStatus: "superseded",
              effectiveTo: earlierEffectiveTo(document.effectiveTo, supersededEffectiveTo)
            });

            for (const [chunkId, chunk] of evidenceChunks) {
              if (chunk.knowledgeDocumentId === documentId && chunk.tenantId === scope.tenantId) {
                evidenceChunks.set(chunkId, {
                  ...chunk,
                  chunkStatus: "superseded",
                  effectiveTo: earlierEffectiveTo(chunk.effectiveTo, supersededEffectiveTo)
                });
              }
            }
          }
        }
      }

      const now = nowIso();
      const document: KnowledgeDocument = {
        id: input.document.id ?? `knowledge-${String(knowledgeSequence).padStart(3, "0")}`,
        tenantId: scope.tenantId,
        affiliateId: validAffiliateId(scope, input.document.affiliateId),
        documentType: input.document.documentType,
        productType: input.document.productType,
        title: input.document.title,
        version: input.document.version,
        effectiveFrom: input.document.effectiveFrom,
        approvalStatus: "approved",
        storageKey: input.document.storageKey,
        createdBy: scope.actorUserId,
        approvedBy: scope.actorUserId,
        createdAt: now,
        approvedAt: now,
        canonicalKey: input.document.canonicalKey,
        sourceSnapshotId,
        changeSetId: documentChangeSetId,
        supersedesDocumentId: input.document.supersedesDocumentId,
        lifecycleStatus: "active",
        autoIngested: input.document.autoIngested ?? true,
        sourcePublishedAt: input.document.sourcePublishedAt,
        interpretationSummary: input.document.interpretationSummary
      };

      knowledgeSequence += input.document.id ? 0 : 1;
      knowledgeDocuments.set(document.id, document);

      const persistedChunks = input.chunks.map<EvidenceChunk>((chunk) => ({
        ...chunk,
        tenantId: scope.tenantId,
        knowledgeDocumentId: document.id,
        changeSetId: chunk.changeSetId ?? changeSet.id,
        chunkStatus: chunk.chunkStatus ?? "active",
        impactTags: chunk.impactTags ? [...chunk.impactTags] : undefined,
        metadata: clone(chunk.metadata),
        createdAt: nowIso()
      }));

      for (const chunk of persistedChunks) {
        evidenceChunks.set(chunk.id, chunk);
      }

      const updatedChangeSet: RegulatoryChangeSet = {
        ...clone(changeSet),
        qualityGateStatus: input.qualityGateStatus ?? "passed",
        createdKnowledgeDocumentId: document.id
      };

      regulatoryChangeSets.set(changeSet.id, updatedChangeSet);

      return {
        changeSet: clone(updatedChangeSet),
        document: clone(document),
        chunks: clone(persistedChunks)
      };
    },

    async searchCaseHistoryEvidence(
      scope: ReviewStoreScope,
      input: CaseHistoryEvidenceSearchInput
    ) {
      const minScore = input.minScore ?? 0.5;
      const topK = input.topK ?? 4;
      const finalStatuses: ReviewCase["status"][] = [
        "approved",
        "change_requested",
        "rejected",
        "on_hold"
      ];

      return Array.from(cases.values())
        .filter(
          (review) =>
            canAccessCase(scope, review.id) &&
            review.id !== input.excludeReviewCaseId &&
            finalStatuses.includes(review.status) &&
            (!input.productType || review.productType === input.productType)
        )
        .flatMap((review) =>
          review.issues.map((issue) => {
            const searchableText = [
              review.title,
              review.affiliate,
              issue.title,
              issue.issueType,
              issue.targetText,
              issue.description,
              issue.suggestedCopy,
              issue.reviewerComment,
              ...issue.evidence.map((evidence) => evidence.quoteSummary)
            ]
              .filter(Boolean)
              .join(" ");
            const score = lexicalKnowledgeScore(input.query, searchableText, issue.title);

            if (score < minScore) {
              return undefined;
            }

            return {
              id: `case-history-evidence-${issue.id}`,
              sourceType: "case_history" as const,
              documentId: review.id,
              title: review.id,
              quoteSummary: `${issue.title}: ${issue.suggestedCopy}`,
              relevanceScore: score
            };
          })
        )
        .filter(
          (
            evidence
          ): evidence is {
            id: string;
            sourceType: "case_history";
            documentId: string;
            title: string;
            quoteSummary: string;
            relevanceScore: number;
          } => Boolean(evidence)
        )
        .sort((left, right) => right.relevanceScore - left.relevanceScore)
        .slice(0, topK);
    },

    async createChatSession(scope: ReviewStoreScope, input) {
      const review = cases.get(input.reviewCaseId);

      if (!review || !canAccessCase(scope, input.reviewCaseId)) {
        return undefined;
      }

      if (input.issueId && !review.issues.some((issue) => issue.id === input.issueId)) {
        return undefined;
      }

      const session: ChatSession = {
        id: `chat-session-${String(chatSessionSequence).padStart(3, "0")}`,
        reviewCaseId: input.reviewCaseId,
        issueId: input.issueId,
        userId: scope.actorUserId,
        mode: input.mode,
        createdAt: nowIso()
      };

      chatSessionSequence += 1;
      chatSessions.set(session.id, session);
      chatSessionTenants.set(session.id, scope.tenantId);
      chatMessages.set(session.id, []);

      return clone(session);
    },

    async createChatMessage(scope: ReviewStoreScope, input: CreateChatMessageInput) {
      const session = chatSessions.get(input.sessionId);

      if (!session) {
        return undefined;
      }

      if (chatSessionTenants.get(session.id) !== scope.tenantId) {
        return undefined;
      }

      const review = cases.get(session.reviewCaseId);

      if (!review) {
        return undefined;
      }

      const issue = session.issueId
        ? review.issues.find((candidate) => candidate.id === session.issueId)
        : undefined;
      const response =
        issue !== undefined
          ? answerReviewQuestion({ review, issue, question: input.content })
          : {
              content:
                "추가 확인 필요: 특정 이슈와 연결되지 않은 질의는 현재 승인된 근거만으로 단정할 수 없습니다.",
              evidence: [] as ReviewIssue["evidence"]
            };
      const userMessage: ChatMessage = {
        id: `chat-message-${String(chatMessageSequence).padStart(3, "0")}`,
        chatSessionId: session.id,
        role: "user",
        content: input.content,
        evidenceIds: [],
        markedForDraft: false,
        createdAt: nowIso()
      };

      chatMessageSequence += 1;

      const assistantMessage: ChatMessage = {
        id: `chat-message-${String(chatMessageSequence).padStart(3, "0")}`,
        chatSessionId: session.id,
        role: "assistant",
        content: response.content,
        evidenceIds: response.evidence.map((evidence) => evidence.id),
        markedForDraft: false,
        createdAt: nowIso()
      };

      chatMessageSequence += 1;
      chatMessages.set(session.id, [
        ...(chatMessages.get(session.id) ?? []),
        userMessage,
        assistantMessage
      ]);

      return {
        userMessage: clone(userMessage),
        assistantMessage: clone(assistantMessage)
      };
    },

    async markChatMessageForDraft(scope: ReviewStoreScope, messageId, markedForDraft) {
      for (const [sessionId, messages] of chatMessages) {
        const messageIndex = messages.findIndex((message) => message.id === messageId);

        if (messageIndex === -1) {
          continue;
        }

        if (chatSessionTenants.get(sessionId) !== scope.tenantId) {
          return undefined;
        }

        const updated: ChatMessage = {
          ...messages[messageIndex],
          markedForDraft
        };
        const updatedMessages = [...messages];
        updatedMessages[messageIndex] = updated;
        chatMessages.set(sessionId, updatedMessages);

        return clone(updated);
      }

      return undefined;
    },

    async createDraftVersion(
      scope: ReviewStoreScope,
      reviewCaseId,
      input: CreateDraftVersionInput
    ) {
      const review = cases.get(reviewCaseId);

      if (!review || !canAccessCase(scope, reviewCaseId)) {
        return undefined;
      }

      const markedMessages = Array.from(chatSessions.values())
        .filter(
          (session) =>
            session.reviewCaseId === reviewCaseId &&
            chatSessionTenants.get(session.id) === scope.tenantId
        )
        .flatMap((session) => chatMessages.get(session.id) ?? [])
        .filter((message) => message.role === "assistant" && message.markedForDraft);
      const sourceMessageIds =
        input.sourceMessageIds !== undefined
          ? validAssistantMessageIdsForReview(scope, reviewCaseId, input.sourceMessageIds)
          : markedMessages.map((message) => message.id);
      const evidenceIds = unique([
        ...validEvidenceIdsForReview(review, input.evidenceIds ?? []),
        ...markedMessages.flatMap((message) => message.evidenceIds)
      ]);
      const draft = input.draft?.trim()
        ? input.draft
        : markedMessages.length > 0
          ? `${review.expectedDraft}\n\n채팅 반영: ${markedMessages
              .map((message) => message.content)
              .join("\n")}`
          : review.expectedDraft;
      const versions = draftVersions.get(reviewCaseId) ?? [];
      const nextVersion = Math.max(review.currentDraftVersion ?? 0, versions.length) + 1;
      const draftVersion: DraftVersion = {
        id: `draft-${reviewCaseId}-v${nextVersion}`,
        reviewCaseId,
        version: nextVersion,
        draft,
        source: input.source,
        sourceMessageIds,
        evidenceIds,
        createdBy: scope.actorUserId,
        createdAt: nowIso()
      };
      const updatedReview: ReviewCase = {
        ...review,
        currentDraft: draft,
        currentDraftVersion: draftVersion.version
      };

      draftVersions.set(reviewCaseId, [...versions, draftVersion]);
      cases.set(reviewCaseId, updatedReview);

      return clone(draftVersion);
    },

    async createReviewReport(
      scope: ReviewStoreScope,
      reviewCaseId,
      input: CreateReviewReportInput
    ) {
      const review = cases.get(reviewCaseId);

      if (!review || !canAccessCase(scope, reviewCaseId)) {
        return undefined;
      }

      const versions = reviewReports.get(reviewCaseId) ?? [];
      const nextVersion = versions.length + 1;
      const generated = generateReviewReport({
        review,
        reportType: input.reportType,
        tone: input.tone,
        includeChatContext: input.includeChatContext,
        issueIds: input.issueIds,
        draft: input.draft
      });
      const report: PersistedReviewReport = {
        id: `report-${reviewCaseId}-v${nextVersion}`,
        reviewCaseId,
        reportType: input.reportType,
        contentMarkdown: generated.contentMarkdown,
        evidenceIds: generated.evidenceIds,
        version: nextVersion,
        storageKey: `reports/${reviewCaseId}/v${nextVersion}.md`,
        createdBy: scope.actorUserId,
        createdAt: nowIso()
      };

      reviewReports.set(reviewCaseId, [...versions, report]);

      return clone(report);
    },

    async listEvidenceChunksForTest(scope: ReviewStoreScope, knowledgeDocumentId) {
      return clone(
        Array.from(evidenceChunks.values()).filter((chunk) => {
          if (chunk.tenantId !== scope.tenantId) {
            return false;
          }

          if (knowledgeDocumentId && chunk.knowledgeDocumentId !== knowledgeDocumentId) {
            return false;
          }

          return true;
        })
      );
    },

    async listAgentRunsForTest(scope: ReviewStoreScope, reviewCaseId) {
      if (reviewCaseId && !canAccessCase(scope, reviewCaseId)) {
        return [];
      }

      return clone(
        Array.from(agentRuns.values()).filter((run) => {
          if (reviewCaseId && run.reviewCaseId !== reviewCaseId) {
            return false;
          }

          return canAccessCase(scope, run.reviewCaseId);
        })
      );
    },

    async listAgentFindingsForTest(scope: ReviewStoreScope, reviewCaseId) {
      if (reviewCaseId && !canAccessCase(scope, reviewCaseId)) {
        return [];
      }

      return clone(
        Array.from(agentFindings.values()).filter((finding) => {
          if (reviewCaseId && finding.reviewCaseId !== reviewCaseId) {
            return false;
          }

          return canAccessCase(scope, finding.reviewCaseId);
        })
      );
    },

    async listCaseLibrary(scope: ReviewStoreScope, options?: ListReviewSummariesOptions) {
      const finalStatuses = new Set(["approved", "change_requested", "rejected", "on_hold"]);
      const finalReviews = Array.from(cases.values()).filter(
        (review) => finalStatuses.has(review.status) && canAccessCase(scope, review.id)
      );
      const riskLevel = options?.riskLevel as RiskLevel | undefined;

      return paginatedSummaries(
        finalReviews,
        {
          ...options,
          riskLevel
        },
        (id) => reviewCertificates.get(id)?.status
      );
    }
  };

  return store;
}
