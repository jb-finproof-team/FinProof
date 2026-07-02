import { randomUUID } from "node:crypto";
import {
  answerReviewQuestion,
  generateIssueBasedOpinionDraft,
  shouldReplaceStaleOpinionDraft
} from "@/domain/chat";
import { filterMatchedEvidence } from "@/domain/evidence";
import { getRequiredMaterialRows } from "@/domain/intake";
import { generateReviewReport } from "@/domain/reports";
import { classifyUploadFileWithConfidence } from "@/domain/upload-policy";
import type { ReviewDocumentExtraction } from "@/domain/revision-diff";
import type {
  ChatMessage,
  ChatSession,
  DraftVersion,
  Evidence,
  KnowledgeDocument,
  PersistedReviewReport,
  QualityGateResult,
  ReviewCase,
  ReviewCertificate,
  ReviewFile,
  ReviewIssue,
  ReviewSummary,
  ReviewVersion,
  RiskLevel
} from "@/domain/types";
import { Prisma } from "@/generated/prisma/client";
import { getPrismaClient } from "@/server/db/prisma";
import { buildAnalysisIssues, highestRiskLevelForIssues } from "@/server/analysis/issue-generation";
import {
  normalizeAiSuggestedAction,
  normalizeAnalysisRiskLevel,
  riskRank
} from "@/server/analysis/risk-policy";
import type {
  AgentFindingCandidate,
  AnalysisArtifacts
} from "@/server/analysis/review-analysis-pipeline";
import {
  toEvidenceChunk,
  toKnowledgeDocument,
  toQualityGateResult,
  toRegulatoryChangeSet,
  toRegulatorySnapshot,
  toRegulatorySource,
  toReviewCase,
  toReviewCertificate,
  toReviewSummary,
  toReviewVersion,
  type PrismaReviewCaseRow
} from "./prisma-mappers";
import type {
  AnalysisJob,
  AuditEvent,
  AuditEventInput,
  ActivateRegulatoryChangeSetInput,
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
  CaseHistoryEvidenceSearchInput,
  FinalReviewStatus,
  IssueReviewCertificateInput,
  ListAuditEventsOptions,
  ListIssuesOptions,
  ListReviewSummariesOptions,
  KnowledgeEvidenceSearchInput,
  RegulatoryChangeSetListOptions,
  ReviewStore,
  ReviewSummaryPage,
  ReviewStoreScope,
  SaveIssueDecisionInput,
  UpdateReviewReviewerInput,
  UpdateReviewStatusOptions
} from "./review-store";

const reviewInclude = {
  files: true,
  certificate: { select: { metadata: true } },
  issues: {
    orderBy: { id: "asc" },
    include: {
      agentFinding: { select: { outputSnapshot: true } },
      evidence: { orderBy: { id: "asc" } }
    }
  }
} as const;

const uploadAnalysisNotice = "실제 업로드 건은 OCR/RAG 분석 전이므로 근거 부족 상태로 표시됩니다.";
const reReviewNotice = "재업로드된 수정본입니다. AI 재분석 없이 직전 버전과 비교해 재검토하세요.";

const longWriteTransactionOptions = {
  maxWait: 10_000,
  timeout: 30_000
} as const;

function plannedDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function dayBeforeDate(value: string): Date {
  const date = plannedDate(value);

  date.setUTCDate(date.getUTCDate() - 1);

  return date;
}

function missingMaterialKeys(review: Pick<ReviewCase, "productType" | "files">): string[] {
  return getRequiredMaterialRows(review)
    .filter((row) => row.status === "missing")
    .map((row) => (row.fileType === "checklist" ? "internal_checklist" : row.fileType));
}

function defaultExpectedDraft(productType: ReviewCase["productType"]): string {
  return `${productType} 상품 실제 업로드 자료는 접수되었습니다. 현재 Demo MVP에서는 OCR/RAG 분석 전이므로 파일 분류와 누락 자료 확인 결과를 기준으로 추가 확인이 필요합니다.`;
}

function reviewRow(row: unknown): PrismaReviewCaseRow {
  return row as PrismaReviewCaseRow;
}

function toAnalysisJob(row: {
  id: string;
  reviewCaseId: string;
  status: AnalysisJob["status"];
  progress: number;
  currentStep: string;
  startedByUserId: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
  artifacts: Prisma.JsonValue | null;
}): AnalysisJob {
  return {
    id: row.id,
    reviewCaseId: row.reviewCaseId,
    status: row.status,
    progress: row.progress,
    currentStep: row.currentStep,
    startedByUserId: row.startedByUserId ?? undefined,
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    completedAt: row.completedAt?.toISOString(),
    errorMessage: row.errorMessage ?? undefined,
    artifacts: (row.artifacts as AnalysisArtifacts | null) ?? undefined
  };
}

function toAuditEvent(row: {
  id: string;
  tenantId: string;
  userId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  beforeValue: Prisma.JsonValue | null;
  afterValue: Prisma.JsonValue | null;
  ipAddress: string | null;
  createdAt: Date;
}): AuditEvent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId ?? "",
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId ?? undefined,
    beforeValue: (row.beforeValue as Record<string, unknown> | null) ?? undefined,
    afterValue: (row.afterValue as Record<string, unknown> | null) ?? undefined,
    ipAddress: row.ipAddress ?? undefined,
    createdAt: row.createdAt.toISOString()
  };
}

function dateOnlyString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function toChatSession(row: {
  id: string;
  reviewCaseId: string;
  issueId: string | null;
  userId: string;
  mode: ChatSession["mode"];
  createdAt: Date;
}): ChatSession {
  return {
    id: row.id,
    reviewCaseId: row.reviewCaseId,
    issueId: row.issueId ?? undefined,
    userId: row.userId,
    mode: row.mode,
    createdAt: row.createdAt.toISOString()
  };
}

function toChatMessage(row: {
  id: string;
  chatSessionId: string;
  role: ChatMessage["role"];
  content: string;
  evidenceIds: Prisma.JsonValue;
  markedForDraft: boolean;
  createdAt: Date;
}): ChatMessage {
  return {
    id: row.id,
    chatSessionId: row.chatSessionId,
    role: row.role,
    content: row.content,
    evidenceIds: jsonStringArray(row.evidenceIds),
    markedForDraft: row.markedForDraft,
    createdAt: row.createdAt.toISOString()
  };
}

function toDraftVersion(row: {
  id: string;
  reviewCaseId: string;
  version: number;
  draft: string;
  source: DraftVersion["source"];
  sourceMessageIds: Prisma.JsonValue;
  evidenceIds: Prisma.JsonValue;
  createdById: string;
  createdAt: Date;
}): DraftVersion {
  return {
    id: row.id,
    reviewCaseId: row.reviewCaseId,
    version: row.version,
    draft: row.draft,
    source: row.source,
    sourceMessageIds: jsonStringArray(row.sourceMessageIds),
    evidenceIds: jsonStringArray(row.evidenceIds),
    createdBy: row.createdById,
    createdAt: row.createdAt.toISOString()
  };
}

function toReviewReport(row: {
  id: string;
  reviewCaseId: string;
  reportType: PersistedReviewReport["reportType"];
  contentMarkdown: string;
  evidenceIds: Prisma.JsonValue;
  version: number;
  storageKey: string | null;
  createdById: string;
  createdAt: Date;
}): PersistedReviewReport {
  return {
    id: row.id,
    reviewCaseId: row.reviewCaseId,
    reportType: row.reportType,
    contentMarkdown: row.contentMarkdown,
    evidenceIds: jsonStringArray(row.evidenceIds),
    version: row.version,
    storageKey: row.storageKey ?? undefined,
    createdBy: row.createdById,
    createdAt: row.createdAt.toISOString()
  };
}

function summaryPage(
  items: ReviewSummary[],
  page: number,
  pageSize: number,
  total: number
): ReviewSummaryPage {
  return {
    items,
    reviewCases: items,
    page,
    pageSize,
    total
  };
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function retryUniqueConstraint<T>(operation: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isUniqueConstraintError(error) || attempt === maxAttempts) {
        throw error;
      }
    }
  }

  throw lastError;
}

class AnalysisJobTransitionConflictError extends Error {}

function chunkIdForReviewDocument(reviewCaseId: string, fileId: string): string {
  return `chunk-${reviewCaseId}-${fileId}`;
}

function chunkIdForKnowledgeDocument(documentId: string): string {
  return `chunk-${documentId}-001`;
}

// Lexical (keyword-overlap) knowledge scores are down-weighted relative to vector
// cosine scores so a keyword-rich generic document cannot outrank a genuinely
// semantic vector match. Korean ad-copy↔regulation cosine tops out ~0.6, while the
// lexical formula floors at 0.55, so without this weight lexical always wins.
const KNOWLEDGE_LEXICAL_WEIGHT = 0.8;

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

function documentSourceType(
  documentType: KnowledgeDocument["documentType"]
): Evidence["sourceType"] {
  return documentType === "law" ? "law" : "internal_policy";
}

function vectorLiteral(vector: number[] | undefined): string | undefined {
  if (!vector || vector.length === 0 || !vector.every((value) => Number.isFinite(value))) {
    return undefined;
  }

  return `[${vector.join(",")}]`;
}

function embeddingVectorFromMetadata(metadata: Record<string, unknown>): number[] | undefined {
  const vector = metadata.embeddingVector;

  return Array.isArray(vector) && vector.every((value) => typeof value === "number")
    ? vector
    : undefined;
}

function highestRiskLevelFrom(riskLevels: RiskLevel[], fallback: RiskLevel): RiskLevel {
  return riskLevels.reduce(
    (highest, riskLevel) => (riskRank[riskLevel] > riskRank[highest] ? riskLevel : highest),
    fallback
  );
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

type AllowedEvidenceChunk = {
  id: string;
  knowledgeDocumentId: string | null;
  documentVersion?: string | null;
  documentEffectiveFrom?: Date | null;
};

type VectorKnowledgeEvidenceRow = {
  chunkId: string;
  documentId: string;
  documentType: KnowledgeDocument["documentType"];
  title: string;
  version: string;
  effectiveFrom: Date | string;
  chunkSummary: string | null;
  chunkText: string;
  page: number | null;
  section: string | null;
  relevanceScore: number | string;
};

function dateOnlyFromRaw(value: Date | string): string {
  return value instanceof Date ? dateOnlyString(value) : value.slice(0, 10);
}

function vectorRowToEvidence(row: VectorKnowledgeEvidenceRow): Evidence {
  return {
    id: `knowledge-evidence-${row.chunkId}`,
    sourceType: documentSourceType(row.documentType),
    documentId: row.documentId,
    chunkId: row.chunkId,
    version: row.version,
    effectiveFrom: dateOnlyFromRaw(row.effectiveFrom),
    title: row.title,
    page: row.page ?? undefined,
    section: row.section ?? undefined,
    quoteSummary: row.chunkSummary ?? row.chunkText,
    relevanceScore: Number(row.relevanceScore)
  };
}

function evidenceCreateInput(
  reviewCaseId: string,
  issueId: string,
  finding: AgentFindingCandidate,
  allowedChunks: Map<string, AllowedEvidenceChunk>
) {
  return finding.evidence.map((evidence, index) => {
    const chunkId = (() => {
      const sourceFileChunkId = evidence.sourceFileId
        ? chunkIdForReviewDocument(reviewCaseId, evidence.sourceFileId)
        : undefined;

      if (sourceFileChunkId && allowedChunks.has(sourceFileChunkId)) {
        return sourceFileChunkId;
      }

      return evidence.chunkId && allowedChunks.has(evidence.chunkId) ? evidence.chunkId : undefined;
    })();
    const allowedChunk = chunkId ? allowedChunks.get(chunkId) : undefined;
    const hasAllowedKnowledgeDocument =
      allowedChunk?.knowledgeDocumentId &&
      (!evidence.documentId || allowedChunk.knowledgeDocumentId === evidence.documentId);
    const documentId = hasAllowedKnowledgeDocument ? allowedChunk.knowledgeDocumentId : undefined;

    return {
      id: `evidence-${issueId}-${String(index + 1).padStart(3, "0")}`,
      sourceType: evidence.sourceType,
      documentId,
      chunkId,
      version: hasAllowedKnowledgeDocument ? allowedChunk.documentVersion : undefined,
      effectiveFrom: hasAllowedKnowledgeDocument ? allowedChunk.documentEffectiveFrom : undefined,
      title: evidence.title,
      page: evidence.page,
      section: evidence.section,
      quoteSummary: evidence.quoteSummary,
      relevanceScore: evidence.relevanceScore
    };
  });
}

function issueCreateData(reviewCaseId: string, issue: ReviewIssue) {
  return {
    id: issue.id,
    reviewCaseId,
    issueType: issue.issueType,
    riskLevel: issue.riskLevel,
    reviewerRiskLevel: issue.reviewerRiskLevel,
    title: issue.title,
    targetText: issue.targetText,
    targetBbox: issue.targetBbox as Prisma.InputJsonValue,
    targetFileId: issue.targetFileId,
    targetPage: issue.targetPage,
    confidence: issue.confidence,
    agentFindingId: issue.agentFindingId,
    sourceAgents: issue.sourceAgents as Prisma.InputJsonValue,
    suggestedAction: issue.suggestedAction,
    finalAction: issue.finalAction,
    reviewerComment: issue.reviewerComment,
    status: issue.status,
    description: issue.description,
    suggestedCopy: issue.suggestedCopy,
    evidence: {
      create: issue.evidence.map((evidence) => ({
        id: evidence.id,
        sourceType: evidence.sourceType,
        documentId: evidence.documentId,
        chunkId: evidence.chunkId,
        version: evidence.version,
        effectiveFrom: evidence.effectiveFrom ? plannedDate(evidence.effectiveFrom) : undefined,
        title: evidence.title,
        page: evidence.page,
        section: evidence.section,
        quoteSummary: evidence.quoteSummary,
        relevanceScore: evidence.relevanceScore
      }))
    }
  };
}

function reviewCaseScopeWhere(scope: ReviewStoreScope): Prisma.ReviewCaseWhereInput {
  return {
    tenantId: scope.tenantId,
    ...(scope.actorRole === "requester" ? { requesterId: scope.actorUserId } : {})
  };
}

function demoUserEmailForActor(scope: ReviewStoreScope): string {
  const safeUserId = scope.actorUserId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return `${safeUserId || "requester"}@finproof.local`;
}

async function recordReviewVersionSnapshot(
  tx: Prisma.TransactionClient,
  scope: ReviewStoreScope,
  review: ReviewCase,
  status: FinalReviewStatus,
  reviewerComment: string | undefined,
  decidedAt: Date
): Promise<void> {
  const versionNumber = review.currentVersion;

  // 재업로드 시 원본 파일/추출 텍스트가 삭제되므로, 다음 회차 변경분석(diff) 비교 기준으로
  // 현재 문서들의 OCR 추출 텍스트를 스냅샷에 함께 보존한다.
  const fileIds = review.files.map((file) => file.id);
  const chunks = fileIds.length
    ? await tx.evidenceChunk.findMany({
        where: { reviewFileId: { in: fileIds } },
        select: { reviewFileId: true, chunkText: true }
      })
    : [];
  const chunkByFileId = new Map(
    chunks
      .filter((chunk) => chunk.reviewFileId !== null)
      .map((chunk) => [chunk.reviewFileId as string, chunk.chunkText])
  );
  const documentsSnapshot = review.files
    .map((file) => {
      const text = chunkByFileId.get(file.id);
      if (typeof text !== "string") {
        return undefined;
      }
      return { fileId: file.id, fileName: file.name, fileType: file.fileType, text };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  const data = {
    status,
    reviewerComment: reviewerComment ?? null,
    opinionDraft: review.currentDraft ?? null,
    issuesSnapshot: review.issues as unknown as Prisma.InputJsonValue,
    filesSnapshot: review.files.map((file) => ({
      id: file.id,
      name: file.name,
      fileType: file.fileType
    })) as unknown as Prisma.InputJsonValue,
    documentsSnapshot: documentsSnapshot as unknown as Prisma.InputJsonValue,
    decidedByUserId: scope.actorUserId,
    decidedByName: scope.actorUserName ?? null,
    decidedAt
  };

  await tx.reviewVersion.upsert({
    where: {
      reviewCaseId_versionNumber: {
        reviewCaseId: review.id,
        versionNumber
      }
    },
    create: {
      id: `review-version-${review.id}-v${versionNumber}`,
      reviewCaseId: review.id,
      versionNumber,
      ...data
    },
    update: data
  });
}

export function createPrismaReviewStore(): ReviewStore {
  const prisma = getPrismaClient();

  async function ensureDemoRequesterUser(scope: ReviewStoreScope) {
    if (scope.actorRole !== "requester" || process.env.FINPROOF_AUTH_MODE === "jwt") {
      return;
    }

    await prisma.user.upsert({
      where: { id: scope.actorUserId },
      update: {
        name: scope.actorUserName?.trim() || "업로드 요청자",
        role: "requester",
        status: "active"
      },
      create: {
        id: scope.actorUserId,
        tenantId: scope.tenantId,
        email: demoUserEmailForActor(scope),
        name: scope.actorUserName?.trim() || "업로드 요청자",
        role: "requester"
      }
    });
  }

  async function getReviewCase(scope: ReviewStoreScope, id: string) {
    const row = await prisma.reviewCase.findFirst({
      where: { id, ...reviewCaseScopeWhere(scope) },
      include: reviewInclude
    });

    return row ? toReviewCase(reviewRow(row)) : undefined;
  }

  return {
    async listReviewSummaries(scope, options: ListReviewSummariesOptions = {}) {
      const page = Math.max(1, options.page ?? 1);
      const pageSize = Math.max(1, options.pageSize ?? 50);
      const where: Prisma.ReviewCaseWhereInput = {
        ...reviewCaseScopeWhere(scope),
        status: options.status,
        productType: options.productType,
        affiliateId: options.affiliateId,
        highestRiskLevel: options.riskLevel
      };
      const [rows, total] = await prisma.$transaction([
        prisma.reviewCase.findMany({
          where,
          include: reviewInclude,
          orderBy: { updatedAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize
        }),
        prisma.reviewCase.count({ where })
      ]);

      return summaryPage(
        rows.map((row) => toReviewSummary(reviewRow(row))),
        page,
        pageSize,
        total
      );
    },

    async listCaseLibrary(scope, options: ListReviewSummariesOptions = {}) {
      const page = Math.max(1, options.page ?? 1);
      const pageSize = Math.max(1, options.pageSize ?? 50);
      const finalStatuses = ["approved", "change_requested", "rejected", "on_hold"] as const;

      if (
        options.status &&
        !finalStatuses.includes(options.status as (typeof finalStatuses)[number])
      ) {
        return summaryPage([], page, pageSize, 0);
      }

      const where: Prisma.ReviewCaseWhereInput = {
        tenantId: scope.tenantId,
        status: options.status ?? { in: [...finalStatuses] },
        productType: options.productType,
        affiliateId: options.affiliateId,
        highestRiskLevel: options.riskLevel
      };

      const [rows, total] = await prisma.$transaction([
        prisma.reviewCase.findMany({
          where,
          include: reviewInclude,
          orderBy: { updatedAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize
        }),
        prisma.reviewCase.count({ where })
      ]);

      return summaryPage(
        rows.map((row) => toReviewSummary(reviewRow(row))),
        page,
        pageSize,
        total
      );
    },

    async isReviewCaseIdAvailable(_scope, id) {
      const existing = await prisma.reviewCase.count({ where: { id } });

      return existing === 0;
    },

    async createKnowledgeDocument(scope, input: CreateKnowledgeDocumentInput) {
      const affiliate = input.affiliateId
        ? await prisma.affiliate.findFirst({
            where: { id: input.affiliateId, tenantId: scope.tenantId },
            select: { id: true }
          })
        : undefined;
      const document = await prisma.knowledgeDocument.create({
        data: {
          id: input.id ?? `knowledge-${randomUUID()}`,
          tenantId: scope.tenantId,
          affiliateId: affiliate?.id,
          documentType: input.documentType,
          productType: input.productType,
          title: input.title,
          version: input.version,
          effectiveFrom: plannedDate(input.effectiveFrom),
          approvalStatus: "draft",
          storageKey: input.storageKey,
          createdById: scope.actorUserId
        }
      });

      return toKnowledgeDocument(document);
    },

    async listKnowledgeDocuments(scope) {
      const documents = await prisma.knowledgeDocument.findMany({
        where: { tenantId: scope.tenantId },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }]
      });

      return documents.map(toKnowledgeDocument);
    },

    async approveKnowledgeDocument(scope, documentId) {
      return prisma.$transaction(async (tx) => {
        const approvedAt = new Date();
        const updated = await tx.knowledgeDocument.updateMany({
          where: { id: documentId, tenantId: scope.tenantId },
          data: {
            approvalStatus: "approved",
            approvedById: scope.actorUserId,
            approvedAt
          }
        });

        if (updated.count !== 1) {
          return undefined;
        }

        const document = await tx.knowledgeDocument.findUniqueOrThrow({
          where: { id: documentId }
        });

        const existingChunkCount = await tx.evidenceChunk.count({
          where: { tenantId: document.tenantId, knowledgeDocumentId: document.id }
        });

        if (existingChunkCount === 0) {
          await tx.evidenceChunk.create({
            data: {
              id: chunkIdForKnowledgeDocument(document.id),
              tenantId: document.tenantId,
              knowledgeDocumentId: document.id,
              chunkText: `${document.title} ${document.version}`,
              chunkSummary: document.title,
              embeddingModel: "text-embedding-3-small",
              embeddingId: `embedding-${document.id}-001`,
              metadata: { source: "knowledge_document" }
            }
          });
        }

        return toKnowledgeDocument(document);
      });
    },

    async unapproveKnowledgeDocument(scope, documentId) {
      return prisma.$transaction(async (tx) => {
        const updated = await tx.knowledgeDocument.updateMany({
          where: { id: documentId, tenantId: scope.tenantId },
          data: {
            approvalStatus: "draft",
            approvedById: null,
            approvedAt: null
          }
        });

        if (updated.count !== 1) {
          return undefined;
        }

        const document = await tx.knowledgeDocument.findUniqueOrThrow({
          where: { id: documentId }
        });

        return toKnowledgeDocument(document);
      });
    },

    async deleteKnowledgeDocument(scope, documentId) {
      const document = await prisma.knowledgeDocument.findFirst({
        where: { id: documentId, tenantId: scope.tenantId }
      });

      if (!document) {
        return undefined;
      }

      await prisma.knowledgeDocument.delete({
        where: { id: documentId }
      });

      return toKnowledgeDocument(document);
    },

    async replaceKnowledgeDocumentChunks(
      scope,
      documentId,
      chunks: CreateKnowledgeDocumentChunkInput[]
    ) {
      const document = await prisma.knowledgeDocument.findFirst({
        where: { id: documentId, tenantId: scope.tenantId },
        select: { id: true }
      });

      if (!document) {
        return undefined;
      }

      return prisma.$transaction(async (tx) => {
        await tx.evidenceChunk.deleteMany({
          where: { tenantId: scope.tenantId, knowledgeDocumentId: documentId }
        });

        if (chunks.length > 0) {
          await tx.evidenceChunk.createMany({
            data: chunks.map((chunk) => ({
              id: chunk.id,
              tenantId: scope.tenantId,
              knowledgeDocumentId: documentId,
              chunkText: chunk.chunkText,
              chunkSummary: chunk.chunkSummary,
              embeddingModel: chunk.embeddingModel,
              embeddingId: chunk.embeddingId,
              page: chunk.page,
              section: chunk.section,
              canonicalSectionKey: chunk.canonicalSectionKey,
              sectionNumber: chunk.sectionNumber,
              changeSetId: chunk.changeSetId,
              supersedesChunkId: chunk.supersedesChunkId,
              chunkStatus: chunk.chunkStatus ?? "active",
              impactTags: (chunk.impactTags ?? []) as Prisma.InputJsonValue,
              effectiveFrom: chunk.effectiveFrom ? plannedDate(chunk.effectiveFrom) : undefined,
              effectiveTo: chunk.effectiveTo ? plannedDate(chunk.effectiveTo) : undefined,
              sourceReliability: chunk.sourceReliability,
              metadata: chunk.metadata as Prisma.InputJsonValue
            }))
          });
        }

        for (const chunk of chunks) {
          const literal = vectorLiteral(embeddingVectorFromMetadata(chunk.metadata));

          if (literal) {
            await tx.$executeRawUnsafe(
              'UPDATE "evidence_chunks" SET "embedding_vector" = $1::vector WHERE "id" = $2 AND "tenant_id" = $3',
              literal,
              chunk.id,
              scope.tenantId
            );
          }
        }

        const rows = await tx.evidenceChunk.findMany({
          where: { tenantId: scope.tenantId, knowledgeDocumentId: documentId },
          orderBy: { id: "asc" }
        });

        return rows.map(toEvidenceChunk);
      }, longWriteTransactionOptions);
    },

    async listKnowledgeDocumentChunks(scope, documentId) {
      const document = await prisma.knowledgeDocument.findFirst({
        where: { id: documentId, tenantId: scope.tenantId },
        select: { id: true }
      });

      if (!document) {
        return undefined;
      }

      const rows = await prisma.evidenceChunk.findMany({
        where: { tenantId: scope.tenantId, knowledgeDocumentId: documentId },
        orderBy: [{ sectionNumber: "asc" }, { page: "asc" }, { id: "asc" }]
      });

      return rows.map(toEvidenceChunk);
    },

    async searchKnowledgeEvidence(scope, input: KnowledgeEvidenceSearchInput) {
      const topK = input.topK ?? 4;
      const minScore = input.minScore ?? 0.5;
      const queryVector = vectorLiteral(input.queryEmbedding);
      let vectorEvidence: Evidence[] = [];
      const effectiveOn = input.effectiveOn ? plannedDate(input.effectiveOn) : undefined;

      if (queryVector) {
        const params: Array<string | number | Date> = [scope.tenantId, queryVector];
        const whereParts = [
          'ec."tenant_id" = $1',
          'kd."tenant_id" = $1',
          "kd.\"approval_status\" = 'approved'",
          effectiveOn
            ? '(kd."lifecycle_status" = \'active\' OR (kd."lifecycle_status" = \'superseded\' AND kd."effective_to" IS NOT NULL))'
            : "kd.\"lifecycle_status\" = 'active'",
          effectiveOn
            ? '(ec."chunk_status" = \'active\' OR (ec."chunk_status" = \'superseded\' AND ec."effective_to" IS NOT NULL))'
            : "ec.\"chunk_status\" = 'active'",
          'ec."embedding_vector" IS NOT NULL'
        ];

        if (input.productType) {
          params.push(input.productType);
          whereParts.push(
            `(kd."product_type" = $${params.length}::"ProductType" OR kd."product_type" IS NULL)`
          );
        }

        if (input.affiliateId) {
          params.push(input.affiliateId);
          whereParts.push(`(kd."affiliate_id" = $${params.length} OR kd."affiliate_id" IS NULL)`);
        }

        if (effectiveOn) {
          params.push(effectiveOn);
          const effectiveOnParam = `$${params.length}::date`;
          whereParts.push(`kd."effective_from" <= ${effectiveOnParam}`);
          whereParts.push(
            `(kd."effective_to" IS NULL OR kd."effective_to" >= ${effectiveOnParam})`
          );
          whereParts.push(
            `(ec."effective_from" IS NULL OR ec."effective_from" <= ${effectiveOnParam})`
          );
          whereParts.push(
            `(ec."effective_to" IS NULL OR ec."effective_to" >= ${effectiveOnParam})`
          );
        }

        params.push(Math.max(topK * 4, topK));

        try {
          const rows = await prisma.$queryRawUnsafe<VectorKnowledgeEvidenceRow[]>(
            `
              SELECT
                ec."id" AS "chunkId",
                kd."id" AS "documentId",
                kd."document_type" AS "documentType",
                kd."title" AS "title",
                kd."version" AS "version",
                kd."effective_from" AS "effectiveFrom",
                ec."chunk_summary" AS "chunkSummary",
                ec."chunk_text" AS "chunkText",
                ec."page" AS "page",
                ec."section" AS "section",
                GREATEST(0, 1 - (ec."embedding_vector" <=> $2::vector)) AS "relevanceScore"
              FROM "evidence_chunks" ec
              INNER JOIN "knowledge_documents" kd ON kd."id" = ec."knowledge_document_id"
              WHERE ${whereParts.join(" AND ")}
              ORDER BY ec."embedding_vector" <=> $2::vector
              LIMIT $${params.length}
            `,
            ...params
          );
          vectorEvidence = rows
            .map(vectorRowToEvidence)
            .filter((item) => item.relevanceScore >= minScore)
            .slice(0, topK);
        } catch {
          // Fall back to lexical retrieval when pgvector is not available in a local database.
        }
      }

      const documentFilters: Prisma.KnowledgeDocumentWhereInput[] = [
        {
          tenantId: scope.tenantId,
          approvalStatus: "approved"
        },
        effectiveOn
          ? {
              OR: [
                { lifecycleStatus: "active" },
                { lifecycleStatus: "superseded", effectiveTo: { not: null } }
              ]
            }
          : {
              lifecycleStatus: "active"
            }
      ];

      const chunkFilters: Prisma.EvidenceChunkWhereInput[] = [
        {
          tenantId: scope.tenantId,
          knowledgeDocument: {
            is: { AND: documentFilters }
          }
        },
        effectiveOn
          ? {
              OR: [
                { chunkStatus: "active" },
                { chunkStatus: "superseded", effectiveTo: { not: null } }
              ]
            }
          : {
              chunkStatus: "active"
            }
      ];

      if (input.productType) {
        documentFilters.push({
          OR: [{ productType: input.productType }, { productType: null }]
        });
      }

      if (input.affiliateId) {
        documentFilters.push({
          OR: [{ affiliateId: input.affiliateId }, { affiliateId: null }]
        });
      }

      if (effectiveOn) {
        documentFilters.push({
          effectiveFrom: { lte: effectiveOn },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveOn } }]
        });
        chunkFilters.push({
          OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: effectiveOn } }]
        });
        chunkFilters.push({
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveOn } }]
        });
      }

      const rows = await prisma.evidenceChunk.findMany({
        where: {
          AND: chunkFilters
        },
        include: {
          knowledgeDocument: true
        },
        orderBy: { id: "asc" },
        take: Math.max(topK * 4, topK)
      });

      const lexicalEvidence = rows.flatMap((chunk) => {
        const document = chunk.knowledgeDocument;

        if (!document) {
          return [];
        }

        const score =
          lexicalKnowledgeScore(
            input.query,
            [chunk.chunkSummary, chunk.chunkText, document.version].filter(Boolean).join(" "),
            document.title
          ) * KNOWLEDGE_LEXICAL_WEIGHT;

        if (score < minScore) {
          return [];
        }

        return [
          {
            id: `knowledge-evidence-${chunk.id}`,
            sourceType: documentSourceType(document.documentType),
            documentId: document.id,
            chunkId: chunk.id,
            version: document.version,
            effectiveFrom: dateOnlyString(document.effectiveFrom),
            title: document.title,
            page: chunk.page ?? undefined,
            section: chunk.section ?? undefined,
            quoteSummary: chunk.chunkSummary ?? chunk.chunkText,
            relevanceScore: score
          }
        ];
      });
      // Dedupe by DOCUMENT (keep each document's best-scoring chunk), not by chunk,
      // so a single large regulation (e.g. 은행업감독규정 with 60+ chunks) cannot crowd
      // out single-chunk-but-more-relevant documents (e.g. a 1-chunk 광고 심의 체크리스트).
      // This gives the candidate pool document-level diversity for per-issue matching.
      const evidenceByDocument = new Map<string, Evidence>();

      for (const evidence of [...vectorEvidence, ...lexicalEvidence]) {
        const key = evidence.documentId ?? evidence.id;
        const existing = evidenceByDocument.get(key);

        if (!existing || evidence.relevanceScore > existing.relevanceScore) {
          evidenceByDocument.set(key, evidence);
        }
      }

      return Array.from(evidenceByDocument.values())
        .sort((left, right) => right.relevanceScore - left.relevanceScore)
        .slice(0, topK);
    },

    async createRegulatorySource(scope, input: CreateRegulatorySourceInput) {
      const source = await prisma.regulatorySource.create({
        data: {
          id: input.id ?? `reg-source-${randomUUID()}`,
          tenantId: scope.tenantId,
          sourceType: input.sourceType,
          name: input.name,
          url: input.url,
          repositoryPath: input.repositoryPath,
          pollingSchedule: input.pollingSchedule,
          trustLevel: input.trustLevel,
          status: input.status ?? "active"
        }
      });

      return toRegulatorySource(source);
    },

    async listRegulatorySources(scope) {
      const sources = await prisma.regulatorySource.findMany({
        where: { tenantId: scope.tenantId },
        orderBy: [{ status: "asc" }, { updatedAt: "desc" }, { id: "asc" }]
      });

      return sources.map(toRegulatorySource);
    },

    async getRegulatorySource(scope, sourceId) {
      const source = await prisma.regulatorySource.findFirst({
        where: { id: sourceId, tenantId: scope.tenantId }
      });

      return source ? toRegulatorySource(source) : undefined;
    },

    async createRegulatorySnapshot(scope, input: CreateRegulatorySnapshotInput) {
      return prisma.$transaction(async (tx) => {
        const source = await tx.regulatorySource.findFirst({
          where: { id: input.sourceId, tenantId: scope.tenantId },
          select: { id: true, status: true }
        });

        if (!source) {
          throw new Error("Regulatory source not found");
        }

        const snapshot = await tx.regulatorySnapshot.create({
          data: {
            id: input.id ?? `reg-snapshot-${randomUUID()}`,
            sourceId: input.sourceId,
            tenantId: scope.tenantId,
            sourceUrl: input.sourceUrl,
            title: input.title,
            publishedAt: input.publishedAt ? plannedDate(input.publishedAt) : undefined,
            effectiveFrom: input.effectiveFrom ? plannedDate(input.effectiveFrom) : undefined,
            contentHash: input.contentHash,
            rawStorageKey: input.rawStorageKey,
            normalizedStorageKey: input.normalizedStorageKey,
            detectedDocumentType: input.detectedDocumentType,
            fetchStatus: input.fetchStatus,
            normalizationConfidence: input.normalizationConfidence
          }
        });

        await tx.regulatorySource.update({
          where: { id: source.id },
          data: {
            lastCheckedAt: snapshot.createdAt,
            status: input.fetchStatus === "failed" ? "failing" : source.status
          }
        });

        return toRegulatorySnapshot(snapshot);
      }, longWriteTransactionOptions);
    },

    async getLatestRegulatorySnapshot(scope, sourceId) {
      const source = await prisma.regulatorySource.findFirst({
        where: { id: sourceId, tenantId: scope.tenantId },
        select: { id: true }
      });

      if (!source) {
        return undefined;
      }

      const snapshot = await prisma.regulatorySnapshot.findFirst({
        where: { sourceId, tenantId: scope.tenantId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }]
      });

      return snapshot ? toRegulatorySnapshot(snapshot) : undefined;
    },

    async listLatestRegulatorySnapshots(scope, sourceIds) {
      if (sourceIds.length === 0) {
        return new Map();
      }

      const snapshots = await prisma.regulatorySnapshot.findMany({
        where: {
          tenantId: scope.tenantId,
          sourceId: { in: sourceIds },
          source: { tenantId: scope.tenantId }
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }]
      });
      const latestSnapshots = new Map<string, RegulatorySnapshot>();

      for (const snapshot of snapshots) {
        if (!latestSnapshots.has(snapshot.sourceId)) {
          latestSnapshots.set(snapshot.sourceId, toRegulatorySnapshot(snapshot));
        }
      }

      return latestSnapshots;
    },

    async createRegulatoryChangeSet(scope, input: CreateRegulatoryChangeSetInput) {
      const source = await prisma.regulatorySource.findFirst({
        where: { id: input.sourceId, tenantId: scope.tenantId },
        select: { id: true }
      });
      const newSnapshot = await prisma.regulatorySnapshot.findFirst({
        where: { id: input.newSnapshotId, tenantId: scope.tenantId, sourceId: input.sourceId },
        select: { id: true }
      });
      const previousSnapshot = input.previousSnapshotId
        ? await prisma.regulatorySnapshot.findFirst({
            where: {
              id: input.previousSnapshotId,
              tenantId: scope.tenantId,
              sourceId: input.sourceId
            },
            select: { id: true }
          })
        : undefined;

      if (!source || !newSnapshot || (input.previousSnapshotId && !previousSnapshot)) {
        throw new Error("Regulatory source or snapshot not found");
      }

      const changeSet = await prisma.regulatoryChangeSet.create({
        data: {
          id: input.id ?? `reg-change-${randomUUID()}`,
          tenantId: scope.tenantId,
          sourceId: input.sourceId,
          previousSnapshotId: input.previousSnapshotId,
          newSnapshotId: input.newSnapshotId,
          changeType: input.changeType,
          changeSummary: input.changeSummary,
          changedSections: input.changedSections as Prisma.InputJsonValue,
          effectiveFrom: input.effectiveFrom ? plannedDate(input.effectiveFrom) : undefined,
          riskImpactLevel: input.riskImpactLevel,
          interpretationSummary: input.interpretationSummary,
          mappedProductTypes: input.mappedProductTypes as Prisma.InputJsonValue,
          mappedChannels: input.mappedChannels as Prisma.InputJsonValue,
          mappedReviewCategories: input.mappedReviewCategories as Prisma.InputJsonValue,
          qualityGateStatus: input.qualityGateStatus,
          confidence: input.confidence
        }
      });

      return toRegulatoryChangeSet(changeSet);
    },

    async listRegulatoryChangeSets(scope, options: RegulatoryChangeSetListOptions = {}) {
      const where: Prisma.RegulatoryChangeSetWhereInput = {
        tenantId: scope.tenantId,
        sourceId: options.sourceId,
        qualityGateStatus: options.qualityGateStatus
      };
      const changeSets = await prisma.regulatoryChangeSet.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }]
      });

      return changeSets.map(toRegulatoryChangeSet);
    },

    async getRegulatoryChangeSet(scope, changeSetId) {
      const changeSet = await prisma.regulatoryChangeSet.findFirst({
        where: { id: changeSetId, tenantId: scope.tenantId }
      });

      return changeSet ? toRegulatoryChangeSet(changeSet) : undefined;
    },

    async replaceQualityGateResults(scope, changeSetId, results: QualityGateResult[]) {
      return prisma.$transaction(async (tx) => {
        const changeSet = await tx.regulatoryChangeSet.findFirst({
          where: { id: changeSetId, tenantId: scope.tenantId },
          select: { id: true }
        });

        if (!changeSet) {
          return undefined;
        }

        await tx.qualityGateResult.deleteMany({ where: { changeSetId } });

        if (results.length > 0) {
          await tx.qualityGateResult.createMany({
            data: results.map((result) => ({
              id: result.id,
              changeSetId,
              gateType: result.gateType,
              status: result.status,
              summary: result.summary,
              evidence: result.evidence as Prisma.InputJsonValue,
              createdAt: new Date(result.createdAt)
            }))
          });
        }

        const rows = await tx.qualityGateResult.findMany({
          where: { changeSetId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }]
        });

        return rows.map(toQualityGateResult);
      }, longWriteTransactionOptions);
    },

    async listQualityGateResults(scope, changeSetId) {
      const changeSet = await prisma.regulatoryChangeSet.findFirst({
        where: { id: changeSetId, tenantId: scope.tenantId },
        select: { id: true }
      });

      if (!changeSet) {
        return undefined;
      }

      const results = await prisma.qualityGateResult.findMany({
        where: { changeSetId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }]
      });

      return results.map(toQualityGateResult);
    },

    async activateRegulatoryChangeSet(scope, input: ActivateRegulatoryChangeSetInput) {
      return prisma.$transaction(async (tx) => {
        const changeSet = await tx.regulatoryChangeSet.findFirst({
          where: { id: input.changeSetId, tenantId: scope.tenantId }
        });

        if (!changeSet) {
          return undefined;
        }

        const documentChangeSetId = input.document.changeSetId ?? changeSet.id;
        const sourceSnapshotId = input.document.sourceSnapshotId ?? changeSet.newSnapshotId;

        if (documentChangeSetId !== changeSet.id) {
          throw new Error("Activation document change set must match the activated change set");
        }

        if (sourceSnapshotId !== changeSet.newSnapshotId) {
          throw new Error("Activation document snapshot must match the change set snapshot");
        }

        const sourceSnapshot = await tx.regulatorySnapshot.findFirst({
          where: {
            id: sourceSnapshotId,
            tenantId: scope.tenantId,
            sourceId: changeSet.sourceId
          },
          select: { id: true }
        });

        if (!sourceSnapshot) {
          throw new Error("Activation source snapshot not found");
        }

        if (input.document.supersedesDocumentId) {
          const supersededDocument = await tx.knowledgeDocument.findFirst({
            where: { id: input.document.supersedesDocumentId, tenantId: scope.tenantId },
            select: { id: true }
          });

          if (!supersededDocument) {
            throw new Error("Superseded knowledge document not found");
          }
        }

        const invalidChunkChangeSet = input.chunks.find(
          (chunk) => chunk.changeSetId && chunk.changeSetId !== changeSet.id
        );

        if (invalidChunkChangeSet) {
          throw new Error("Activation chunk change set must match the activated change set");
        }

        const supersedesChunkIds = unique(
          input.chunks
            .map((chunk) => chunk.supersedesChunkId)
            .filter((chunkId): chunkId is string => Boolean(chunkId))
        );

        if (supersedesChunkIds.length > 0) {
          const supersededChunkCount = await tx.evidenceChunk.count({
            where: { id: { in: supersedesChunkIds }, tenantId: scope.tenantId }
          });

          if (supersededChunkCount !== supersedesChunkIds.length) {
            throw new Error("Superseded evidence chunk not found");
          }
        }

        if (input.document.canonicalKey) {
          const supersededEffectiveTo = dayBeforeDate(input.document.effectiveFrom);
          const previousDocuments = await tx.knowledgeDocument.findMany({
            where: {
              tenantId: scope.tenantId,
              canonicalKey: input.document.canonicalKey,
              lifecycleStatus: "active"
            },
            select: { id: true }
          });
          const previousDocumentIds = previousDocuments.map((document) => document.id);

          if (previousDocumentIds.length > 0) {
            await tx.knowledgeDocument.updateMany({
              where: { tenantId: scope.tenantId, id: { in: previousDocumentIds } },
              data: { lifecycleStatus: "superseded" }
            });
            await tx.knowledgeDocument.updateMany({
              where: {
                tenantId: scope.tenantId,
                id: { in: previousDocumentIds },
                OR: [{ effectiveTo: null }, { effectiveTo: { gt: supersededEffectiveTo } }]
              },
              data: { effectiveTo: supersededEffectiveTo }
            });
            await tx.evidenceChunk.updateMany({
              where: {
                tenantId: scope.tenantId,
                knowledgeDocumentId: { in: previousDocumentIds }
              },
              data: { chunkStatus: "superseded" }
            });
            await tx.evidenceChunk.updateMany({
              where: {
                tenantId: scope.tenantId,
                knowledgeDocumentId: { in: previousDocumentIds },
                OR: [{ effectiveTo: null }, { effectiveTo: { gt: supersededEffectiveTo } }]
              },
              data: { effectiveTo: supersededEffectiveTo }
            });
          }
        }

        const affiliate = input.document.affiliateId
          ? await tx.affiliate.findFirst({
              where: { id: input.document.affiliateId, tenantId: scope.tenantId },
              select: { id: true }
            })
          : undefined;
        const now = new Date();
        const document = await tx.knowledgeDocument.create({
          data: {
            id: input.document.id ?? `knowledge-${randomUUID()}`,
            tenantId: scope.tenantId,
            affiliateId: affiliate?.id,
            documentType: input.document.documentType,
            productType: input.document.productType,
            title: input.document.title,
            version: input.document.version,
            effectiveFrom: plannedDate(input.document.effectiveFrom),
            approvalStatus: "approved",
            storageKey: input.document.storageKey,
            createdById: scope.actorUserId,
            approvedById: scope.actorUserId,
            approvedAt: now,
            canonicalKey: input.document.canonicalKey,
            sourceSnapshotId,
            changeSetId: documentChangeSetId,
            supersedesDocumentId: input.document.supersedesDocumentId,
            lifecycleStatus: "active",
            autoIngested: input.document.autoIngested ?? true,
            sourcePublishedAt: input.document.sourcePublishedAt
              ? plannedDate(input.document.sourcePublishedAt)
              : undefined,
            interpretationSummary: input.document.interpretationSummary
          }
        });

        if (input.chunks.length > 0) {
          await tx.evidenceChunk.createMany({
            data: input.chunks.map((chunk) => ({
              id: chunk.id,
              tenantId: scope.tenantId,
              knowledgeDocumentId: document.id,
              chunkText: chunk.chunkText,
              chunkSummary: chunk.chunkSummary,
              embeddingModel: chunk.embeddingModel,
              embeddingId: chunk.embeddingId,
              page: chunk.page,
              section: chunk.section,
              canonicalSectionKey: chunk.canonicalSectionKey,
              sectionNumber: chunk.sectionNumber,
              changeSetId: chunk.changeSetId ?? changeSet.id,
              supersedesChunkId: chunk.supersedesChunkId,
              chunkStatus: chunk.chunkStatus ?? "active",
              impactTags: (chunk.impactTags ?? []) as Prisma.InputJsonValue,
              effectiveFrom: chunk.effectiveFrom ? plannedDate(chunk.effectiveFrom) : undefined,
              effectiveTo: chunk.effectiveTo ? plannedDate(chunk.effectiveTo) : undefined,
              sourceReliability: chunk.sourceReliability,
              metadata: chunk.metadata as Prisma.InputJsonValue
            }))
          });
        }

        for (const chunk of input.chunks) {
          const literal = vectorLiteral(embeddingVectorFromMetadata(chunk.metadata));

          if (literal) {
            await tx.$executeRawUnsafe(
              'UPDATE "evidence_chunks" SET "embedding_vector" = $1::vector WHERE "id" = $2 AND "tenant_id" = $3',
              literal,
              chunk.id,
              scope.tenantId
            );
          }
        }

        const updatedChangeSet = await tx.regulatoryChangeSet.update({
          where: { id: changeSet.id },
          data: {
            createdKnowledgeDocumentId: document.id,
            qualityGateStatus: input.qualityGateStatus ?? "passed"
          }
        });
        const chunks = await tx.evidenceChunk.findMany({
          where: { tenantId: scope.tenantId, knowledgeDocumentId: document.id },
          orderBy: { id: "asc" }
        });

        return {
          changeSet: toRegulatoryChangeSet(updatedChangeSet),
          document: toKnowledgeDocument(document),
          chunks: chunks.map(toEvidenceChunk)
        };
      }, longWriteTransactionOptions);
    },

    async searchCaseHistoryEvidence(scope, input: CaseHistoryEvidenceSearchInput) {
      const topK = input.topK ?? 4;
      const minScore = input.minScore ?? 0.5;
      const finalStatuses = ["approved", "change_requested", "rejected", "on_hold"] as const;

      const rows = await prisma.reviewIssue.findMany({
        where: {
          reviewCase: {
            tenantId: scope.tenantId,
            status: { in: [...finalStatuses] },
            ...(input.excludeReviewCaseId ? { id: { not: input.excludeReviewCaseId } } : {}),
            ...(input.productType ? { productType: input.productType } : {})
          }
        },
        include: {
          reviewCase: {
            select: {
              id: true,
              title: true,
              affiliateName: true,
              productType: true,
              status: true,
              finalDecisionAt: true
            }
          },
          evidence: true
        },
        orderBy: { updatedAt: "desc" },
        take: Math.max(topK * 8, topK)
      });

      return rows
        .flatMap((issue): Evidence[] => {
          const searchableText = [
            issue.reviewCase.title,
            issue.reviewCase.affiliateName,
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
            return [];
          }

          return [
            {
              id: `case-history-evidence-${issue.id}`,
              sourceType: "case_history",
              documentId: issue.reviewCase.id,
              title: issue.reviewCase.id,
              quoteSummary: `${issue.title}: ${issue.suggestedCopy}`,
              relevanceScore: score
            }
          ];
        })
        .sort((left, right) => right.relevanceScore - left.relevanceScore)
        .slice(0, topK);
    },

    async createChatSession(scope, input) {
      const review = await prisma.reviewCase.findFirst({
        where: { id: input.reviewCaseId, tenantId: scope.tenantId },
        select: { id: true }
      });

      if (!review) {
        return undefined;
      }

      if (input.issueId) {
        const issue = await prisma.reviewIssue.findFirst({
          where: {
            id: input.issueId,
            reviewCaseId: input.reviewCaseId,
            reviewCase: { tenantId: scope.tenantId }
          },
          select: { id: true }
        });

        if (!issue) {
          return undefined;
        }
      }

      const session = await prisma.chatSession.create({
        data: {
          id: `chat-session-${randomUUID()}`,
          reviewCaseId: input.reviewCaseId,
          issueId: input.issueId,
          userId: scope.actorUserId,
          mode: input.mode
        }
      });

      return toChatSession(session);
    },

    async createChatMessage(scope, input: CreateChatMessageInput) {
      const session = await prisma.chatSession.findFirst({
        where: {
          id: input.sessionId,
          reviewCase: { tenantId: scope.tenantId }
        },
        select: {
          id: true,
          reviewCaseId: true,
          issueId: true
        }
      });

      if (!session) {
        return undefined;
      }

      const review = await getReviewCase(scope, session.reviewCaseId);

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
              evidence: [] as ReviewCase["issues"][number]["evidence"]
            };
      const now = new Date();
      const [userMessage, assistantMessage] = await prisma.$transaction([
        prisma.chatMessage.create({
          data: {
            id: `chat-message-${randomUUID()}`,
            chatSessionId: session.id,
            role: "user",
            content: input.content,
            evidenceIds: [],
            markedForDraft: false,
            createdAt: now
          }
        }),
        prisma.chatMessage.create({
          data: {
            id: `chat-message-${randomUUID()}`,
            chatSessionId: session.id,
            role: "assistant",
            content: response.content,
            evidenceIds: response.evidence.map((evidence) => evidence.id),
            markedForDraft: false,
            createdAt: now
          }
        })
      ]);

      return {
        userMessage: toChatMessage(userMessage),
        assistantMessage: toChatMessage(assistantMessage)
      };
    },

    async markChatMessageForDraft(scope, messageId, markedForDraft) {
      const updated = await prisma.chatMessage.updateMany({
        where: {
          id: messageId,
          chatSession: { reviewCase: { tenantId: scope.tenantId } }
        },
        data: { markedForDraft }
      });

      if (updated.count !== 1) {
        return undefined;
      }

      const message = await prisma.chatMessage.findFirst({
        where: {
          id: messageId,
          chatSession: { reviewCase: { tenantId: scope.tenantId } }
        }
      });

      return message ? toChatMessage(message) : undefined;
    },

    async createDraftVersion(scope, reviewCaseId, input: CreateDraftVersionInput) {
      return prisma.$transaction(async (tx) => {
        const reviewRowValue = await tx.reviewCase.findFirst({
          where: { id: reviewCaseId, tenantId: scope.tenantId },
          include: reviewInclude
        });

        if (!reviewRowValue) {
          return undefined;
        }

        const review = toReviewCase(reviewRow(reviewRowValue));
        const markedMessages = await tx.chatMessage.findMany({
          where: {
            role: "assistant",
            markedForDraft: true,
            chatSession: {
              reviewCaseId,
              reviewCase: { tenantId: scope.tenantId }
            }
          },
          orderBy: { createdAt: "asc" }
        });
        const validSourceMessages =
          input.sourceMessageIds !== undefined
            ? await tx.chatMessage.findMany({
                where: {
                  id: { in: input.sourceMessageIds },
                  role: "assistant",
                  chatSession: {
                    reviewCaseId,
                    reviewCase: { tenantId: scope.tenantId }
                  }
                },
                select: { id: true }
              })
            : [];
        const validSourceMessageIds = new Set(validSourceMessages.map((message) => message.id));
        const sourceMessageIds =
          input.sourceMessageIds !== undefined
            ? input.sourceMessageIds.filter((id) => validSourceMessageIds.has(id))
            : markedMessages.map((message) => message.id);
        const validRequestedEvidence =
          input.evidenceIds !== undefined
            ? await tx.evidence.findMany({
                where: {
                  id: { in: input.evidenceIds },
                  issue: {
                    reviewCaseId,
                    reviewCase: { tenantId: scope.tenantId }
                  }
                },
                select: { id: true }
              })
            : [];
        const validRequestedEvidenceIdSet = new Set(
          validRequestedEvidence.map((evidence) => evidence.id)
        );
        const validRequestedEvidenceIds =
          input.evidenceIds !== undefined
            ? input.evidenceIds.filter((id) => validRequestedEvidenceIdSet.has(id))
            : [];
        const evidenceIds = unique([
          ...validRequestedEvidenceIds,
          ...markedMessages.flatMap((message) => jsonStringArray(message.evidenceIds))
        ]);
        const draft = input.draft?.trim()
          ? input.draft
          : markedMessages.length > 0
            ? `${review.expectedDraft}\n\n채팅 반영: ${markedMessages
                .map((message) => message.content)
                .join("\n")}`
            : review.expectedDraft;
        const updatedReview = await tx.reviewCase.update({
          where: { id: reviewCaseId },
          data: {
            currentDraft: draft,
            currentDraftVersion: { increment: 1 }
          },
          select: { currentDraftVersion: true }
        });
        const nextVersion = updatedReview.currentDraftVersion;
        const draftVersion = await tx.draftVersion.create({
          data: {
            id: `draft-${reviewCaseId}-v${nextVersion}`,
            reviewCaseId,
            version: nextVersion,
            draft,
            source: input.source,
            sourceMessageIds: sourceMessageIds as Prisma.InputJsonValue,
            evidenceIds: evidenceIds as Prisma.InputJsonValue,
            createdById: scope.actorUserId
          }
        });

        return toDraftVersion(draftVersion);
      });
    },

    async createReviewReport(scope, reviewCaseId, input: CreateReviewReportInput) {
      return retryUniqueConstraint(() =>
        prisma.$transaction(async (tx) => {
          const reviewRowValue = await tx.reviewCase.findFirst({
            where: { id: reviewCaseId, tenantId: scope.tenantId },
            include: reviewInclude
          });

          if (!reviewRowValue) {
            return undefined;
          }

          const review = toReviewCase(reviewRow(reviewRowValue));
          const versionAggregate = await tx.reviewReport.aggregate({
            where: { reviewCaseId },
            _max: { version: true }
          });
          const nextVersion = (versionAggregate._max.version ?? 0) + 1;
          const generated = generateReviewReport({
            review,
            reportType: input.reportType,
            tone: input.tone,
            includeChatContext: input.includeChatContext,
            issueIds: input.issueIds,
            draft: input.draft
          });
          const report = await tx.reviewReport.create({
            data: {
              id: `report-${reviewCaseId}-v${nextVersion}`,
              reviewCaseId,
              reportType: input.reportType,
              contentMarkdown: generated.contentMarkdown,
              evidenceIds: generated.evidenceIds as Prisma.InputJsonValue,
              version: nextVersion,
              storageKey: `reports/${reviewCaseId}/v${nextVersion}.md`,
              createdById: scope.actorUserId
            }
          });

          return toReviewReport(report);
        })
      );
    },

    getReviewCase,

    async createReviewCaseFromSamplePackage(
      scope,
      input: CreateReviewCaseFromSamplePackageInput
    ): Promise<CreateReviewCaseResult | undefined> {
      const sample = await prisma.reviewCase.findFirst({
        where: { id: input.samplePackageId, tenantId: scope.tenantId },
        include: reviewInclude
      });

      if (!sample) {
        return undefined;
      }

      const [, updated] = await prisma.$transaction([
        prisma.analysisJob.deleteMany({
          where: { tenantId: scope.tenantId, reviewCaseId: sample.id }
        }),
        prisma.reviewCase.update({
          where: { id: sample.id },
          data: {
            status: "analysis_waiting",
            analysisStartedAt: null,
            analysisCompletedAt: null,
            finalDecisionAt: null
          },
          include: reviewInclude
        })
      ]);
      const reviewCase = toReviewCase(reviewRow(updated));

      return {
        reviewCase,
        files: reviewCase.files,
        missingMaterials: reviewCase.missingMaterials,
        analysisStartHref: `/api/v1/review-cases/${reviewCase.id}/analysis/start`
      };
    },

    async createReviewCaseFromUploadedFiles(scope, input: CreateReviewCaseFromUploadedFilesInput) {
      await ensureDemoRequesterUser(scope);

      const id = input.reviewCaseId ?? `rc-${randomUUID()}`;
      const affiliate = await prisma.affiliate.findFirst({
        where: { tenantId: scope.tenantId, name: input.affiliate },
        select: { id: true }
      });
      const files = input.files.map((file) => {
        const contentType = file.type || "application/octet-stream";
        const cls = classifyUploadFileWithConfidence({ ...file, type: contentType });

        return {
          id: file.id ?? `file-${randomUUID()}`,
          originalFilename: file.name,
          fileType: cls.fileType,
          classificationConfidence: cls.confidence,
          parseStatus: "pending" as const,
          storageProvider: file.storageProvider ?? "local",
          storageKey: file.storageKey ?? `local/${id}/${file.name}`,
          contentType,
          sizeBytes: BigInt(file.size)
        };
      });
      const missingMaterials = missingMaterialKeys({
        productType: input.productType,
        files: files.map((file) => ({
          id: file.id,
          name: file.originalFilename,
          fileType: file.fileType,
          classificationConfidence: file.classificationConfidence,
          parseStatus: file.parseStatus,
          storageProvider: file.storageProvider as ReviewFile["storageProvider"],
          storageKey: file.storageKey,
          contentType: file.contentType,
          sizeBytes: Number(file.sizeBytes)
        }))
      });

      const created = await prisma.reviewCase.create({
        data: {
          id,
          tenantId: scope.tenantId,
          affiliateId: affiliate?.id,
          affiliateName: input.affiliate,
          title: input.title,
          productType: input.productType,
          channelType: input.channelType,
          plannedPublishDate: plannedDate(input.plannedPublishDate),
          status: "analysis_waiting",
          highestRiskLevel: "info",
          requesterId: scope.actorUserId,
          reviewerId: null,
          requesterName: scope.actorUserName?.trim() || "업로드 요청자",
          requestDepartment: input.requestDepartment?.trim() || "",
          reviewerName: "",
          promotionalCopy: "실제 업로드 자료 분석 대기",
          disclosure: uploadAnalysisNotice,
          productDescription: "실제 업로드 파일의 본문 추출은 아직 적용되지 않았습니다.",
          missingMaterials,
          expectedDraft: defaultExpectedDraft(input.productType),
          analysisNotice: uploadAnalysisNotice,
          files: { create: files }
        },
        include: reviewInclude
      });
      const reviewCase = toReviewCase(reviewRow(created));

      return {
        reviewCase,
        files: reviewCase.files,
        missingMaterials: reviewCase.missingMaterials,
        analysisStartHref: `/api/v1/review-cases/${reviewCase.id}/analysis/start`
      };
    },

    async startAnalysis(scope, reviewCaseId, options = {}) {
      const review = await prisma.reviewCase.findFirst({
        where: { id: reviewCaseId, tenantId: scope.tenantId },
        include: reviewInclude
      });

      if (!review) {
        return undefined;
      }

      const now = new Date();
      const reviewCase = toReviewCase(reviewRow(review));
      const generatedIssues =
        options.artifacts && reviewCase.issues.length === 0
          ? buildAnalysisIssues(reviewCase, options.artifacts)
          : [];
      const issuesForRisk = generatedIssues.length > 0 ? generatedIssues : reviewCase.issues;

      const result = await prisma.$transaction(async (tx) => {
        const job = await tx.analysisJob.create({
          data: {
            id: `job-${randomUUID()}`,
            tenantId: scope.tenantId,
            reviewCaseId,
            status: "completed",
            progress: 100,
            currentStep: "deterministic_mock_analysis",
            startedByUserId: scope.actorUserId,
            artifacts: options.artifacts as Prisma.InputJsonValue | undefined,
            startedAt: now,
            completedAt: now
          }
        });

        for (const issue of generatedIssues) {
          await tx.reviewIssue.create({
            data: issueCreateData(reviewCaseId, issue)
          });
        }

        const updated = await tx.reviewCase.update({
          where: { id: reviewCaseId },
          data: {
            status: "analysis_complete",
            highestRiskLevel: highestRiskLevelForIssues(reviewCase.highestRiskLevel, issuesForRisk),
            analysisStartedAt: now,
            analysisCompletedAt: now
          },
          include: reviewInclude
        });

        return { job, updated };
      });

      return {
        reviewCaseId,
        status: "analysis_complete",
        issueCount: result.updated.issues.length,
        analysisHref: `/reviews/${reviewCaseId}`,
        analysisNotice: result.updated.analysisNotice ?? undefined,
        jobId: result.job.id,
        extractedDocumentCount: options.artifacts?.extractedDocuments.length,
        evidenceCandidateCount: options.artifacts?.evidenceCandidates.length
      };
    },

    async enqueueAnalysis(scope, reviewCaseId) {
      try {
        return await prisma.$transaction(async (tx) => {
          const review = await tx.reviewCase.findFirst({
            where: { id: reviewCaseId, tenantId: scope.tenantId },
            include: reviewInclude
          });

          if (!review) {
            return undefined;
          }

          const activeJob = await tx.analysisJob.findFirst({
            where: {
              tenantId: scope.tenantId,
              reviewCaseId,
              status: { in: ["queued", "running"] }
            },
            select: { id: true }
          });

          if (activeJob) {
            return undefined;
          }

          const job = await tx.analysisJob.create({
            data: {
              id: `job-${randomUUID()}`,
              tenantId: scope.tenantId,
              reviewCaseId,
              status: "queued",
              progress: 0,
              currentStep: "queued",
              startedByUserId: scope.actorUserId
            }
          });
          const updated = await tx.reviewCase.update({
            where: { id: reviewCaseId },
            data: {
              status: "analysis_queued",
              analysisStartedAt: null,
              analysisCompletedAt: null
            },
            include: reviewInclude
          });

          return {
            reviewCaseId,
            status: "analysis_queued",
            issueCount: updated.issues.length,
            analysisHref: `/reviews/${reviewCaseId}`,
            analysisNotice: updated.analysisNotice ?? undefined,
            jobId: job.id
          };
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return undefined;
        }

        throw error;
      }
    },

    async claimNextAnalysisJob(tenantId, workerId) {
      void workerId;

      const queued = await prisma.analysisJob.findFirst({
        where: { tenantId, status: "queued" },
        orderBy: { queuedAt: "asc" }
      });

      if (!queued) {
        return undefined;
      }

      const now = new Date();
      const claimedCount = await prisma.analysisJob.updateMany({
        where: { id: queued.id, status: "queued" },
        data: {
          status: "running",
          progress: 20,
          currentStep: "worker_running",
          startedAt: now
        }
      });

      if (claimedCount.count === 0) {
        return undefined;
      }

      let job, review;
      try {
        [job, review] = await prisma.$transaction([
          prisma.analysisJob.findUniqueOrThrow({
            where: { id: queued.id }
          }),
          prisma.reviewCase.update({
            where: { id: queued.reviewCaseId },
            data: {
              status: "analysis_in_progress",
              analysisStartedAt: now
            },
            include: reviewInclude
          })
        ]);
      } catch (txError) {
        throw txError;
      }

      return {
        ...toAnalysisJob(job),
        reviewCase: toReviewCase(reviewRow(review))
      };
    },

    async completeAnalysisJob(scope, jobId, _artifacts) {
      void _artifacts;

      return prisma.$transaction(async (tx) => {
        const job = await tx.analysisJob.findFirst({
          where: {
            id: jobId,
            tenantId: scope.tenantId,
            status: { in: ["queued", "running"] },
            currentStep: "outputs_persisted"
          }
        });

        const persistedArtifacts = (job?.artifacts as AnalysisArtifacts | null) ?? undefined;

        if (!job || !persistedArtifacts) {
          return undefined;
        }

        const now = new Date();
        const completed = await tx.analysisJob.updateMany({
          where: {
            id: jobId,
            tenantId: scope.tenantId,
            status: { in: ["queued", "running"] },
            currentStep: "outputs_persisted"
          },
          data: {
            status: "completed",
            progress: 100,
            currentStep: "worker_completed",
            completedAt: now,
            artifacts: persistedArtifacts as unknown as Prisma.InputJsonValue
          }
        });

        if (completed.count !== 1) {
          return undefined;
        }

        const updated = await tx.reviewCase.update({
          where: { id: job.reviewCaseId },
          data: {
            status: "analysis_complete",
            analysisCompletedAt: now,
            analysisNotice: null
          },
          include: reviewInclude
        });

        return {
          reviewCaseId: job.reviewCaseId,
          status: "analysis_complete",
          issueCount: updated.issues.length,
          analysisHref: `/reviews/${job.reviewCaseId}`,
          analysisNotice: updated.analysisNotice ?? undefined,
          jobId,
          extractedDocumentCount: persistedArtifacts.extractedDocuments.length,
          evidenceCandidateCount: persistedArtifacts.evidenceCandidates.length
        };
      });
    },

    async persistAnalysisOutputs(scope, input) {
      try {
        return await prisma.$transaction(async (tx) => {
          const persistStartedAt = new Date();
          const claimedPersist = await tx.analysisJob.updateMany({
            where: {
              id: input.jobId,
              tenantId: scope.tenantId,
              reviewCaseId: input.reviewCaseId,
              status: { in: ["queued", "running"] },
              currentStep: { notIn: ["outputs_persisting", "outputs_persisted"] }
            },
            data: {
              progress: 80,
              currentStep: "outputs_persisting"
            }
          });

          if (claimedPersist.count !== 1) {
            return undefined;
          }

          const job = await tx.analysisJob.findFirst({
            where: {
              id: input.jobId,
              tenantId: scope.tenantId,
              reviewCaseId: input.reviewCaseId,
              status: { in: ["queued", "running"] },
              currentStep: "outputs_persisting"
            }
          });

          if (!job) {
            throw new AnalysisJobTransitionConflictError();
          }

          if (!job.startedAt) {
            await tx.analysisJob.update({
              where: { id: input.jobId },
              data: { startedAt: persistStartedAt }
            });
          }

          const review = await tx.reviewCase.findFirst({
            where: { id: input.reviewCaseId, tenantId: scope.tenantId },
            include: reviewInclude
          });

          if (!review) {
            throw new AnalysisJobTransitionConflictError();
          }

          const reviewCase = toReviewCase(reviewRow(review));
          const findings = findingsFromArtifacts(reviewCase, input.artifacts);
          const persistedArtifacts: AnalysisArtifacts =
            input.artifacts.findings && input.artifacts.findings.length > 0
              ? input.artifacts
              : { ...input.artifacts, findings };

          if (!review.analysisStartedAt) {
            await tx.reviewCase.update({
              where: { id: input.reviewCaseId },
              data: {
                status: "analysis_in_progress",
                analysisStartedAt: persistStartedAt
              }
            });
          }

          const reviewFileIds = new Set(review.files.map((file) => file.id));
          const reviewFileChunks = new Map<
            string,
            { id: string; knowledgeDocumentId: string | null }
          >();

          for (const document of input.artifacts.extractedDocuments) {
            if (!reviewFileIds.has(document.fileId)) {
              continue;
            }

            const chunkId = chunkIdForReviewDocument(input.reviewCaseId, document.fileId);
            const chunkData = {
              reviewFileId: document.fileId,
              chunkText: document.text,
              chunkSummary: document.fileName,
              embeddingModel: "deterministic",
              embeddingId: `embedding-${chunkId}`,
              metadata: {
                source: "review_file",
                provider: document.provider,
                storageKey: document.storageKey,
                confidence: document.confidence
              } as Prisma.InputJsonValue
            };

            await tx.evidenceChunk.upsert({
              where: { id: chunkId },
              create: {
                id: chunkId,
                tenantId: scope.tenantId,
                ...chunkData
              },
              update: chunkData
            });
            reviewFileChunks.set(chunkId, { id: chunkId, knowledgeDocumentId: null });
          }

          const candidateChunkIds = unique(
            findings.flatMap((finding) =>
              finding.evidence
                .map((evidence) => evidence.chunkId)
                .filter((chunkId): chunkId is string => Boolean(chunkId))
            )
          );
          const allowedExistingChunks =
            candidateChunkIds.length > 0
              ? await tx.evidenceChunk.findMany({
                  where: {
                    id: { in: candidateChunkIds },
                    tenantId: scope.tenantId,
                    OR: [
                      { knowledgeDocument: { is: { approvalStatus: "approved" } } },
                      { reviewFile: { is: { reviewCaseId: input.reviewCaseId } } }
                    ]
                  },
                  select: {
                    id: true,
                    knowledgeDocumentId: true,
                    knowledgeDocument: {
                      select: {
                        version: true,
                        effectiveFrom: true
                      }
                    }
                  }
                })
              : [];
          const allowedChunks = new Map([
            ...reviewFileChunks,
            ...allowedExistingChunks.map(
              (chunk) =>
                [
                  chunk.id,
                  {
                    id: chunk.id,
                    knowledgeDocumentId: chunk.knowledgeDocumentId,
                    documentVersion: chunk.knowledgeDocument?.version,
                    documentEffectiveFrom: chunk.knowledgeDocument?.effectiveFrom
                  }
                ] as const
            )
          ]);

          for (const agentType of unique(findings.map((finding) => finding.agentType))) {
            const runId = `agent-run-${input.reviewCaseId}-${input.jobId}-${agentType}`;
            const runData = {
              analysisJobId: input.jobId,
              status: "completed" as const,
              model: "deterministic",
              modelTier: "mock",
              inputSnapshot: {
                reviewCaseId: input.reviewCaseId,
                extractedDocumentCount: input.artifacts.extractedDocuments.length,
                evidenceCandidateCount: input.artifacts.evidenceCandidates.length
              } as Prisma.InputJsonValue,
              outputSnapshot: {
                findingCount: findings.filter((finding) => finding.agentType === agentType).length
              } as Prisma.InputJsonValue,
              completedAt: new Date()
            };

            await tx.agentRun.upsert({
              where: { id: runId },
              create: {
                id: runId,
                reviewCaseId: input.reviewCaseId,
                agentType,
                ...runData,
                startedAt: new Date(input.artifacts.generatedAt)
              },
              update: runData
            });
          }

          for (const [index, finding] of findings.entries()) {
            const findingId = `finding-${input.reviewCaseId}-${input.jobId}-${String(
              index + 1
            ).padStart(3, "0")}`;
            const findingData = {
              agentRunId: `agent-run-${input.reviewCaseId}-${input.jobId}-${finding.agentType}`,
              issueType: finding.issueType,
              riskLevel: finding.riskLevel,
              title: finding.title,
              targetText: finding.targetText,
              targetBbox: finding.targetBbox,
              outputSnapshot: finding as unknown as Prisma.InputJsonValue
            };

            await tx.agentFinding.upsert({
              where: { id: findingId },
              create: {
                id: findingId,
                reviewCaseId: input.reviewCaseId,
                ...findingData
              },
              update: findingData
            });
          }

          await tx.evidence.deleteMany({ where: { issue: { reviewCaseId: input.reviewCaseId } } });
          await tx.reviewIssue.deleteMany({ where: { reviewCaseId: input.reviewCaseId } });

          for (const [index, finding] of findings.entries()) {
            const issueId = `issue-${input.reviewCaseId}-${String(index + 1).padStart(3, "0")}`;
            const findingId = `finding-${input.reviewCaseId}-${input.jobId}-${String(
              index + 1
            ).padStart(3, "0")}`;
            const issueData = {
              issueType: finding.issueType,
              riskLevel: finding.riskLevel,
              title: finding.title,
              targetText: finding.targetText,
              targetBbox: finding.targetBbox,
              targetFileId:
                finding.evidence[0]?.sourceFileId &&
                reviewFileIds.has(finding.evidence[0].sourceFileId)
                  ? finding.evidence[0].sourceFileId
                  : undefined,
              confidence: finding.confidence,
              agentFindingId: findingId,
              sourceAgents: [finding.agentType],
              suggestedAction: finding.suggestedAction,
              status: "open" as const,
              description: finding.description,
              suggestedCopy: finding.suggestedCopy
            };

            await tx.reviewIssue.create({
              data: {
                id: issueId,
                reviewCaseId: input.reviewCaseId,
                ...issueData
              }
            });
            const evidenceRows = evidenceCreateInput(
              input.reviewCaseId,
              issueId,
              finding,
              allowedChunks
            );

            for (const evidence of evidenceRows) {
              await tx.evidence.create({
                data: {
                  issueId,
                  ...evidence
                }
              });
            }
          }

          const [issueCount, evidenceCount, issueRiskRows] = await Promise.all([
            tx.reviewIssue.count({ where: { reviewCaseId: input.reviewCaseId } }),
            tx.evidence.count({ where: { issue: { reviewCaseId: input.reviewCaseId } } }),
            tx.reviewIssue.findMany({
              where: { reviewCaseId: input.reviewCaseId },
              select: { riskLevel: true }
            })
          ]);
          const highestRiskLevel =
            issueRiskRows.length > 0
              ? highestRiskLevelFrom(
                  issueRiskRows.map((issue) => issue.riskLevel),
                  "info"
                )
              : review.highestRiskLevel;
          const refreshedReview = await tx.reviewCase.findFirst({
            where: { id: input.reviewCaseId, tenantId: scope.tenantId },
            include: reviewInclude
          });

          if (!refreshedReview) {
            throw new AnalysisJobTransitionConflictError();
          }

          const reviewForDraft: ReviewCase = {
            ...toReviewCase(reviewRow(refreshedReview)),
            highestRiskLevel
          };
          const reviewUpdateData: Prisma.ReviewCaseUpdateInput = {
            highestRiskLevel
          };

          if (shouldReplaceStaleOpinionDraft(reviewCase.currentDraft)) {
            reviewUpdateData.currentDraft = generateIssueBasedOpinionDraft(reviewForDraft);
            reviewUpdateData.currentDraftVersion = { increment: 1 };
          }

          await tx.reviewCase.update({
            where: { id: input.reviewCaseId },
            data: reviewUpdateData
          });
          const persistedJob = await tx.analysisJob.updateMany({
            where: {
              id: input.jobId,
              tenantId: scope.tenantId,
              reviewCaseId: input.reviewCaseId,
              status: { in: ["queued", "running"] },
              currentStep: "outputs_persisting"
            },
            data: {
              progress: Math.max(job.progress, 90),
              currentStep: "outputs_persisted",
              artifacts: persistedArtifacts as Prisma.InputJsonValue
            }
          });

          if (persistedJob.count !== 1) {
            throw new AnalysisJobTransitionConflictError();
          }

          return { issueCount, evidenceCount };
        }, longWriteTransactionOptions);
      } catch (error) {
        if (error instanceof AnalysisJobTransitionConflictError) {
          return undefined;
        }

        throw error;
      }
    },

    async failAnalysisJob(scope, jobId, errorMessage) {
      return prisma.$transaction(async (tx) => {
        const job = await tx.analysisJob.findFirst({
          where: {
            id: jobId,
            tenantId: scope.tenantId,
            status: { in: ["queued", "running"] },
            currentStep: { not: "outputs_persisting" }
          },
          select: { reviewCaseId: true }
        });

        if (!job) {
          return undefined;
        }

        const failedCount = await tx.analysisJob.updateMany({
          where: {
            id: jobId,
            tenantId: scope.tenantId,
            status: { in: ["queued", "running"] },
            currentStep: { not: "outputs_persisting" }
          },
          data: {
            status: "failed",
            progress: 100,
            currentStep: "worker_failed",
            completedAt: new Date(),
            errorMessage
          }
        });

        if (failedCount.count !== 1) {
          return undefined;
        }

        const failed = await tx.analysisJob.findUniqueOrThrow({
          where: { id: jobId }
        });
        await tx.reviewCase.update({
          where: { id: job.reviewCaseId },
          data: {
            status: "analysis_failed"
          }
        });

        return toAnalysisJob(failed);
      });
    },

    async failStaleAnalysisJobs(tenantId: string, olderThanMs: number): Promise<number> {
      const cutoff = new Date(Date.now() - olderThanMs);
      const errorMsg = `stale: job exceeded ${Math.round(olderThanMs / 1000)}s timeout`;

      const rows = await prisma.$queryRaw<{ count: bigint }[]>`
        WITH stale AS (
          UPDATE analysis_jobs
          SET
            status       = 'failed',
            progress     = 100,
            current_step = 'worker_failed',
            completed_at = now(),
            error_message = ${errorMsg}
          WHERE tenant_id  = ${tenantId}
            AND status     = 'running'
            AND started_at < ${cutoff}
          RETURNING review_case_id
        ),
        reset AS (
          UPDATE review_cases
          SET status = 'analysis_failed', updated_at = now()
          WHERE id IN (SELECT review_case_id FROM stale)
        )
        SELECT COUNT(*) AS count FROM stale
      `;

      return Number(rows[0]?.count ?? 0);
    },

    async getLatestAnalysisJob(scope, reviewCaseId) {
      const row = await prisma.analysisJob.findFirst({
        where: { tenantId: scope.tenantId, reviewCaseId },
        orderBy: { queuedAt: "desc" }
      });

      return row ? toAnalysisJob(row) : undefined;
    },

    async listIssues(scope, reviewCaseId, options: ListIssuesOptions = {}) {
      const review = await getReviewCase(scope, reviewCaseId);

      if (!review) {
        return undefined;
      }

      return options.riskLevel
        ? review.issues.filter((issue) => issue.riskLevel === options.riskLevel)
        : review.issues;
    },

    async getIssue(scope, reviewCaseId, issueId) {
      const review = await getReviewCase(scope, reviewCaseId);

      return review?.issues.find((issue) => issue.id === issueId);
    },

    async getIssueEvidence(scope, issueId) {
      const issue = await prisma.reviewIssue.findFirst({
        where: { id: issueId, reviewCase: { tenantId: scope.tenantId } },
        include: { evidence: { orderBy: { id: "asc" } } }
      });

      return issue
        ? filterMatchedEvidence(
            issue.evidence.map((evidence) => ({
              id: evidence.id,
              sourceType: evidence.sourceType,
              documentId: evidence.documentId ?? undefined,
              chunkId: evidence.chunkId ?? undefined,
              version: evidence.version ?? undefined,
              effectiveFrom: evidence.effectiveFrom
                ? evidence.effectiveFrom.toISOString().slice(0, 10)
                : undefined,
              title: evidence.title,
              page: evidence.page ?? undefined,
              section: evidence.section ?? undefined,
              quoteSummary: evidence.quoteSummary,
              relevanceScore: evidence.relevanceScore
            }))
          )
        : undefined;
    },

    async saveIssueDecision(scope, input: SaveIssueDecisionInput) {
      const issue = await prisma.reviewIssue.findFirst({
        where: {
          id: input.issueId,
          reviewCaseId: input.reviewCaseId,
          reviewCase: { tenantId: scope.tenantId }
        }
      });

      if (!issue) {
        return undefined;
      }

      await prisma.reviewIssue.update({
        where: { id: input.issueId },
        data: {
          reviewerRiskLevel: input.reviewerRiskLevel,
          finalAction: input.finalAction,
          reviewerComment: input.reviewerComment,
          status: "reviewed"
        }
      });

      const review = await getReviewCase(scope, input.reviewCaseId);

      return review?.issues.find((candidate) => candidate.id === input.issueId);
    },

    async createManualIssue(
      scope,
      reviewCaseId,
      input: CreateManualIssueInput
    ): Promise<ReviewIssue | undefined> {
      return prisma.$transaction(async (tx) => {
        const reviewRowValue = await tx.reviewCase.findFirst({
          where: { id: reviewCaseId, tenantId: scope.tenantId },
          include: reviewInclude
        });

        if (!reviewRowValue) {
          return undefined;
        }

        const reviewCase = toReviewCase(reviewRow(reviewRowValue));
        const issue: ReviewIssue = {
          id: `issue-${reviewCaseId}-manual-${randomUUID()}`,
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

        await tx.reviewIssue.create({
          data: {
            id: issue.id,
            reviewCaseId,
            issueType: issue.issueType,
            riskLevel: issue.riskLevel,
            title: issue.title,
            targetText: issue.targetText,
            targetBbox: issue.targetBbox as Prisma.InputJsonValue,
            sourceAgents: issue.sourceAgents as Prisma.InputJsonValue,
            suggestedAction: issue.suggestedAction,
            status: issue.status,
            description: issue.description,
            suggestedCopy: issue.suggestedCopy
          }
        });

        await tx.reviewCase.update({
          where: { id: reviewCaseId },
          data: {
            highestRiskLevel: highestRiskLevelForIssues(reviewCase.highestRiskLevel, [
              ...reviewCase.issues,
              issue
            ])
          }
        });

        return issue;
      });
    },

    async saveOpinionDraft(scope, reviewCaseId, draft) {
      const review = await prisma.reviewCase.findFirst({
        where: { id: reviewCaseId, tenantId: scope.tenantId }
      });

      if (!review) {
        return undefined;
      }

      const updated = await prisma.reviewCase.update({
        where: { id: reviewCaseId },
        data: {
          currentDraft: draft,
          currentDraftVersion: { increment: 1 }
        },
        include: reviewInclude
      });

      return toReviewCase(reviewRow(updated));
    },

    async updateReviewReviewer(scope, input: UpdateReviewReviewerInput) {
      const review = await prisma.reviewCase.findFirst({
        where: { id: input.reviewCaseId, tenantId: scope.tenantId }
      });

      if (!review) {
        return undefined;
      }

      const updated = await prisma.reviewCase.update({
        where: { id: input.reviewCaseId },
        data: {
          reviewerName: input.reviewer
        },
        include: reviewInclude
      });

      return toReviewCase(reviewRow(updated));
    },

    async updateReviewStatus(
      scope,
      reviewCaseId,
      status: FinalReviewStatus,
      options: UpdateReviewStatusOptions = {}
    ) {
      return prisma.$transaction(async (tx) => {
        const review = await tx.reviewCase.findFirst({
          where: { id: reviewCaseId, tenantId: scope.tenantId },
          select: { id: true }
        });

        if (!review) {
          return undefined;
        }

        const decidedAt = new Date();
        const updated = await tx.reviewCase.update({
          where: { id: reviewCaseId },
          data: {
            status,
            finalDecisionAt: decidedAt
          },
          include: reviewInclude
        });
        const reviewCase = toReviewCase(reviewRow(updated));

        await recordReviewVersionSnapshot(
          tx,
          scope,
          reviewCase,
          status,
          options.reviewerComment,
          decidedAt
        );

        return reviewCase;
      });
    },

    async createReviewCaseRevision(
      scope,
      reviewCaseId,
      input: CreateReviewCaseRevisionInput
    ): Promise<ReviewCase | undefined> {
      return prisma.$transaction(async (tx) => {
        const reviewRowValue = await tx.reviewCase.findFirst({
          where: { id: reviewCaseId, ...reviewCaseScopeWhere(scope) },
          include: reviewInclude
        });

        if (!reviewRowValue) {
          return undefined;
        }

        const reviewCase = toReviewCase(reviewRow(reviewRowValue));

        if (reviewCase.status !== "change_requested" && reviewCase.status !== "rejected") {
          return undefined;
        }

        const nextVersion = reviewCase.currentVersion + 1;
        const files = input.files.map((file, index) => {
          const contentType = file.type || "application/octet-stream";
          const cls = classifyUploadFileWithConfidence({ ...file, type: contentType });

          return {
            id:
              file.id ??
              `${reviewCaseId}-v${nextVersion}-file-upload-${String(index + 1).padStart(3, "0")}`,
            originalFilename: file.name,
            fileType: cls.fileType,
            classificationConfidence: cls.confidence,
            parseStatus: "pending" as const,
            storageProvider: file.storageProvider ?? "local",
            storageKey: file.storageKey ?? `local/${reviewCaseId}/${file.name}`,
            contentType,
            sizeBytes: BigInt(file.size)
          };
        });
        const missingMaterials = missingMaterialKeys({
          productType: reviewCase.productType,
          files: files.map((file) => ({
            id: file.id,
            name: file.originalFilename,
            fileType: file.fileType,
            classificationConfidence: file.classificationConfidence,
            parseStatus: file.parseStatus,
            storageProvider: file.storageProvider as ReviewFile["storageProvider"],
            storageKey: file.storageKey,
            contentType: file.contentType,
            sizeBytes: Number(file.sizeBytes)
          }))
        });

        await tx.evidence.deleteMany({ where: { issue: { reviewCaseId } } });
        await tx.reviewIssue.deleteMany({ where: { reviewCaseId } });
        await tx.reviewFile.deleteMany({ where: { reviewCaseId } });

        const updated = await tx.reviewCase.update({
          where: { id: reviewCaseId },
          data: {
            status: "re_review_pending",
            highestRiskLevel: "info",
            currentDraft: null,
            currentDraftVersion: 0,
            currentVersion: { increment: 1 },
            analysisStartedAt: null,
            analysisCompletedAt: null,
            finalDecisionAt: null,
            analysisNotice: reReviewNotice,
            missingMaterials,
            files: { create: files }
          },
          include: reviewInclude
        });

        return toReviewCase(reviewRow(updated));
      }, longWriteTransactionOptions);
    },

    async listReviewVersions(scope, reviewCaseId): Promise<ReviewVersion[]> {
      const review = await prisma.reviewCase.findFirst({
        where: { id: reviewCaseId, ...reviewCaseScopeWhere(scope) },
        select: { id: true }
      });

      if (!review) {
        return [];
      }

      const rows = await prisma.reviewVersion.findMany({
        where: { reviewCaseId },
        orderBy: { versionNumber: "asc" }
      });

      return rows.map(toReviewVersion);
    },

    async getReviewDocumentExtractions(scope, reviewCaseId) {
      const review = await prisma.reviewCase.findFirst({
        where: { id: reviewCaseId, ...reviewCaseScopeWhere(scope) },
        select: { files: { select: { id: true, originalFilename: true, fileType: true } } }
      });

      if (!review) {
        return [];
      }

      const fileIds = review.files.map((file) => file.id);
      if (fileIds.length === 0) {
        return [];
      }

      const chunks = await prisma.evidenceChunk.findMany({
        where: { reviewFileId: { in: fileIds } },
        select: { reviewFileId: true, chunkText: true }
      });
      const textByFileId = new Map(
        chunks
          .filter((chunk) => chunk.reviewFileId !== null)
          .map((chunk) => [chunk.reviewFileId as string, chunk.chunkText])
      );

      return review.files
        .map((file) => {
          const text = textByFileId.get(file.id);
          if (typeof text !== "string") {
            return undefined;
          }
          return {
            fileId: file.id,
            fileName: file.originalFilename,
            fileType: file.fileType as ReviewDocumentExtraction["fileType"],
            text
          };
        })
        .filter((entry): entry is ReviewDocumentExtraction => entry !== undefined);
    },

    async replaceReviewDocumentExtractions(scope, reviewCaseId, documents) {
      const review = await prisma.reviewCase.findFirst({
        where: { id: reviewCaseId, ...reviewCaseScopeWhere(scope) },
        select: { files: { select: { id: true } } }
      });

      if (!review) {
        return;
      }

      const reviewFileIds = new Set(review.files.map((file) => file.id));

      await prisma.$transaction(async (tx) => {
        for (const document of documents) {
          if (!reviewFileIds.has(document.fileId)) {
            continue;
          }

          const chunkId = chunkIdForReviewDocument(reviewCaseId, document.fileId);
          const chunkData = {
            reviewFileId: document.fileId,
            chunkText: document.text,
            chunkSummary: document.fileName,
            embeddingModel: "deterministic",
            embeddingId: `embedding-${chunkId}`,
            metadata: {
              source: "review_file",
              provider: document.provider,
              storageKey: document.storageKey,
              confidence: document.confidence
            } as Prisma.InputJsonValue
          };

          await tx.evidenceChunk.upsert({
            where: { id: chunkId },
            create: { id: chunkId, tenantId: scope.tenantId, ...chunkData },
            update: chunkData
          });
        }
      });
    },

    async issueReviewCertificate(
      scope,
      reviewCaseId,
      input: IssueReviewCertificateInput
    ): Promise<ReviewCertificate | undefined> {
      return prisma.$transaction(async (tx) => {
        const review = await tx.reviewCase.findFirst({
          where: { id: reviewCaseId, tenantId: scope.tenantId },
          select: {
            id: true,
            title: true,
            productType: true,
            affiliateName: true,
            reviewerName: true,
            finalDecisionAt: true
          }
        });

        if (!review) {
          return undefined;
        }

        const existing = await tx.reviewCertificate.findUnique({
          where: { reviewCaseId }
        });
        const now = new Date();
        const existingApprovedAt = existing
          ? toReviewCertificate(existing).metadata.approvedAt
          : "";
        const approvedAt = existingApprovedAt || (review.finalDecisionAt ?? now).toISOString();
        const certificateNumber = input.certificateNumber;
        const metadata = {
          title: review.title,
          productType: review.productType,
          affiliateName: review.affiliateName,
          reviewerName: review.reviewerName,
          approvedAt,
          status: input.status ?? "issued"
        } as unknown as Prisma.InputJsonValue;
        const certificate = await tx.reviewCertificate.upsert({
          where: { reviewCaseId },
          create: {
            id: `review-certificate-${reviewCaseId}`,
            reviewCaseId,
            certificateNumber,
            body: input.body,
            validFrom: input.validFrom ?? null,
            validUntil: input.validUntil ?? null,
            remarks: input.remarks ?? null,
            metadata,
            issuedByUserId: scope.actorUserId,
            issuedByName: scope.actorUserName ?? null
          },
          update: {
            certificateNumber,
            body: input.body,
            validFrom: input.validFrom ?? null,
            validUntil: input.validUntil ?? null,
            remarks: input.remarks ?? null,
            metadata,
            issuedByUserId: scope.actorUserId,
            issuedByName: scope.actorUserName ?? null
          }
        });

        return toReviewCertificate(certificate);
      });
    },

    async getReviewCertificate(scope, reviewCaseId): Promise<ReviewCertificate | undefined> {
      const certificate = await prisma.reviewCertificate.findFirst({
        where: {
          reviewCaseId,
          reviewCase: { ...reviewCaseScopeWhere(scope) }
        }
      });

      return certificate ? toReviewCertificate(certificate) : undefined;
    },

    async deleteReviewCase(scope, reviewCaseId) {
      const review = await prisma.reviewCase.findFirst({
        where: { id: reviewCaseId, tenantId: scope.tenantId },
        include: reviewInclude
      });

      if (!review) {
        return undefined;
      }

      await prisma.reviewCase.delete({
        where: { id: reviewCaseId }
      });

      return toReviewCase(reviewRow(review));
    },

    async recordAuditEvent(scope, input: AuditEventInput): Promise<AuditEvent> {
      const actorUser = await prisma.user.findFirst({
        where: {
          id: scope.actorUserId,
          tenantId: scope.tenantId
        },
        select: { id: true }
      });
      const event = await prisma.auditLog.create({
        data: {
          id: `audit-${randomUUID()}`,
          tenantId: scope.tenantId,
          userId: actorUser?.id ?? null,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          beforeValue: input.beforeValue as Prisma.InputJsonValue | undefined,
          afterValue: input.afterValue as Prisma.InputJsonValue | undefined,
          ipAddress: scope.ipAddress
        }
      });

      return toAuditEvent(event);
    },

    async listAuditEvents(scope, options: ListAuditEventsOptions = {}) {
      const events = await prisma.auditLog.findMany({
        where: {
          tenantId: scope.tenantId,
          targetType: options.targetType,
          targetId: options.targetId
        },
        orderBy: { createdAt: "desc" }
      });

      return events.map(toAuditEvent);
    }
  };
}
