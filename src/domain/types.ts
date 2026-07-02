export type RoleId = "requester" | "reviewer" | "compliance_admin";

export type RiskLevel = "info" | "caution" | "high";

export type ReviewStatus =
  | "draft"
  | "submitted"
  | "parsing"
  | "analysis_waiting"
  | "analysis_queued"
  | "analysis_in_progress"
  | "analysis_complete"
  | "analysis_failed"
  | "re_review_pending"
  | "under_review"
  | "change_requested"
  | "rejected"
  | "approved"
  | "on_hold"
  | "archived";

export type FinalReviewStatus = Extract<
  ReviewStatus,
  "approved" | "change_requested" | "rejected" | "on_hold"
>;

export type ReviewAction = "start_analysis" | "open_workbench" | "view_audit";

export type ProductType =
  | "deposit"
  | "loan"
  | "card"
  | "capital"
  | "insurance"
  | "investment"
  | "image_test";

export type ReviewFile = {
  id: string;
  name: string;
  fileType:
    | "promotional_creative"
    | "copy_draft"
    | "product_description"
    | "terms"
    | "rate_table"
    | "checklist"
    | "url_list"
    | "package_archive"
    | "misc";
  classificationConfidence: number;
  parseStatus: "pending" | "parsed" | "failed";
  storageProvider?: "sample" | "local" | "s3";
  storageKey?: string;
  contentType?: string;
  sizeBytes?: number;
};

export type Evidence = {
  id: string;
  sourceType: "law" | "internal_policy" | "product_doc" | "case_history";
  documentId?: string;
  chunkId?: string;
  version?: string;
  effectiveFrom?: string;
  title: string;
  page?: number;
  section?: string;
  quoteSummary: string;
  relevanceScore: number;
};

export type MultilingualIssueContext = {
  segmentId: string;
  language: "en" | "vi" | "my" | "km";
  originalText: string;
  literalTranslation: string;
  complianceMeaning: string;
  riskCategory: "expression_risk" | "compliance_risk" | "both";
  riskSignals: string[];
  koreanComplianceCategory: string;
  koreanComplianceReason: string;
  evidenceQuery: string;
  suggestedCopyOriginalLanguage: string;
  suggestedCopyKoreanMeaning: string;
};

export type ReviewIssue = {
  id: string;
  issueType: string;
  riskLevel: RiskLevel;
  reviewerRiskLevel?: RiskLevel;
  title: string;
  targetText: string;
  targetBbox: [number, number, number, number];
  targetFileId?: string;
  targetPage?: number;
  confidence?: number;
  agentFindingId?: string;
  sourceAgents: string[];
  suggestedAction: "approve" | "change_request" | "reject" | "hold";
  finalAction?: "approve" | "change_request" | "reject" | "hold";
  reviewerComment?: string;
  status: "open" | "reviewed" | "resolved" | "dismissed";
  description: string;
  suggestedCopy: string;
  multilingualContext?: MultilingualIssueContext;
  evidence: Evidence[];
};

export type ReviewCase = {
  id: string;
  title: string;
  affiliate: string;
  productType: ProductType;
  channelType: string[];
  plannedPublishDate: string;
  status: ReviewStatus;
  highestRiskLevel: RiskLevel;
  requester: string;
  requestDepartment?: string;
  reviewer: string;
  promotionalCopy: string;
  disclosure: string;
  productDescription: string;
  missingMaterials: string[];
  files: ReviewFile[];
  issues: ReviewIssue[];
  expectedDraft: string;
  currentDraft?: string;
  currentDraftVersion?: number;
  currentVersion: number;
  analysisNotice?: string;
};

export type ReviewVersion = {
  id: string;
  reviewCaseId: string;
  versionNumber: number;
  status: FinalReviewStatus;
  reviewerComment?: string;
  opinionDraft?: string;
  issuesSnapshot: ReviewIssue[];
  filesSnapshot: Array<Pick<ReviewFile, "id" | "name" | "fileType">>;
  /**
   * 이 회차에서 분석된 각 문서의 OCR 추출 텍스트 스냅샷. 재업로드 시 원본 파일/추출
   * 텍스트가 삭제되므로, 다음 회차의 변경분석(diff) 비교 기준으로 보존한다.
   * 이 기능 배포 이전에 확정된 회차는 비어 있을 수 있다.
   */
  documentsSnapshot?: Array<{
    fileId: string;
    fileName: string;
    fileType: ReviewFile["fileType"];
    text: string;
  }>;
  decidedByUserId: string;
  decidedByName?: string;
  decidedAt: string;
  createdAt: string;
};

export type ReviewCertificateMetadata = {
  title: string;
  productType: ProductType;
  affiliateName: string;
  reviewerName: string;
  approvedAt: string;
};

export type ReviewCertificateStatus = "draft" | "issued";

export type ReviewCertificate = {
  id: string;
  reviewCaseId: string;
  // 심의 중 워크벤치에서 임시 저장한 내용은 "draft", 승인 후 정식 발급되면 "issued"로 표시한다.
  status: ReviewCertificateStatus;
  certificateNumber: string;
  body: string;
  validFrom?: string;
  validUntil?: string;
  remarks?: string;
  metadata: ReviewCertificateMetadata;
  issuedByUserId: string;
  issuedByName?: string;
  issuedAt: string;
  updatedAt: string;
  createdAt: string;
};

export type ReviewSummary = Pick<
  ReviewCase,
  | "id"
  | "title"
  | "affiliate"
  | "productType"
  | "plannedPublishDate"
  | "status"
  | "highestRiskLevel"
  | "requester"
  | "requestDepartment"
  | "reviewer"
  | "currentVersion"
> & {
  availableActions?: ReviewAction[];
  // 심의 이력 탭에서 승인 건의 심의필 발급 필요 여부를 표시하기 위한 상태.
  certificateStatus?: ReviewCertificateStatus;
};

export type PaginatedResult<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
};

export type KnowledgeDocumentType = "law" | "internal_policy" | "checklist" | "guide";
export type KnowledgeApprovalStatus = "draft" | "approved" | "inactive";
export type KnowledgeLifecycleStatus = "active" | "superseded" | "inactive";
export type EvidenceChunkStatus = "active" | "superseded" | "inactive";

export type RegulatorySourceType =
  | "regulator"
  | "law_portal"
  | "association"
  | "internal_policy_repo"
  | "case_knowledge";

export type RegulatorySourceStatus = "active" | "paused" | "failing";

export type RegulatoryChangeType =
  | "created"
  | "amended"
  | "deleted"
  | "wording_changed"
  | "effective_date_changed"
  | "scope_changed"
  | "interpretation_changed";

export type RegulatoryRiskImpactLevel = "info" | "caution" | "high" | "critical";

export type QualityGateType =
  | "citation_coverage"
  | "schema_validation"
  | "contradiction_check"
  | "retrieval_regression"
  | "effective_date"
  | "rollback_ready";

export type QualityGateStatus = "passed" | "failed" | "flagged";

export type KnowledgeDocument = {
  id: string;
  tenantId: string;
  affiliateId?: string;
  canonicalKey?: string;
  sourceSnapshotId?: string;
  changeSetId?: string;
  supersedesDocumentId?: string;
  documentType: KnowledgeDocumentType;
  productType?: ProductType;
  title: string;
  version: string;
  effectiveFrom: string;
  effectiveTo?: string;
  lifecycleStatus?: KnowledgeLifecycleStatus;
  approvalStatus: KnowledgeApprovalStatus;
  autoIngested?: boolean;
  sourcePublishedAt?: string;
  interpretationSummary?: string;
  storageKey: string;
  createdBy: string;
  approvedBy?: string;
  createdAt: string;
  approvedAt?: string;
};

export type EvidenceChunk = {
  id: string;
  tenantId: string;
  knowledgeDocumentId?: string;
  reviewFileId?: string;
  canonicalSectionKey?: string;
  sectionNumber?: string;
  changeSetId?: string;
  supersedesChunkId?: string;
  chunkText: string;
  chunkSummary?: string;
  chunkStatus?: EvidenceChunkStatus;
  impactTags?: string[];
  effectiveFrom?: string;
  effectiveTo?: string;
  sourceReliability?: number;
  embeddingModel: string;
  embeddingId: string;
  page?: number;
  section?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type RegulatorySource = {
  id: string;
  tenantId: string;
  sourceType: RegulatorySourceType;
  name: string;
  url?: string;
  repositoryPath?: string;
  pollingSchedule: string;
  trustLevel: "official" | "industry" | "internal" | "reference";
  lastCheckedAt?: string;
  status: RegulatorySourceStatus;
  createdAt: string;
  updatedAt: string;
};

export type RegulatorySnapshot = {
  id: string;
  sourceId: string;
  tenantId: string;
  sourceUrl?: string;
  title: string;
  publishedAt?: string;
  effectiveFrom?: string;
  contentHash: string;
  rawStorageKey: string;
  normalizedStorageKey: string;
  detectedDocumentType: KnowledgeDocumentType;
  fetchStatus: "fetched" | "unchanged" | "failed";
  normalizationConfidence: number;
  createdAt: string;
};

export type RegulatoryChangedSection = {
  sectionId: string;
  sectionNumber?: string;
  title: string;
  previousText?: string;
  newText?: string;
  diffSummary: string;
  citation: {
    snapshotId: string;
    sectionId: string;
  };
};

export type RegulatoryChangeSet = {
  id: string;
  tenantId: string;
  sourceId: string;
  previousSnapshotId?: string;
  newSnapshotId: string;
  changeType: RegulatoryChangeType;
  changeSummary: string;
  changedSections: RegulatoryChangedSection[];
  effectiveFrom?: string;
  riskImpactLevel: RegulatoryRiskImpactLevel;
  interpretationSummary: string;
  mappedProductTypes: ProductType[];
  mappedChannels: string[];
  mappedReviewCategories: string[];
  qualityGateStatus: QualityGateStatus;
  confidence: number;
  createdKnowledgeDocumentId?: string;
  createdAt: string;
};

export type QualityGateResult = {
  id: string;
  changeSetId: string;
  gateType: QualityGateType;
  status: QualityGateStatus;
  summary: string;
  evidence: Record<string, unknown>;
  createdAt: string;
};

export type AgentRunStatus = "queued" | "running" | "completed" | "failed";
export type AgentType =
  | "main"
  | "creative"
  | "product_terms"
  | "regulation"
  | "internal_policy"
  | "case_search"
  | "social_context"
  | "english_translator_risk"
  | "vietnamese_translator_risk"
  | "myanmar_translator_risk"
  | "khmer_translator_risk"
  | "korean_compliance_mapping";

export type AgentRun = {
  id: string;
  reviewCaseId: string;
  analysisJobId?: string;
  agentType: AgentType;
  status: AgentRunStatus;
  model: string;
  modelTier: string;
  escalationReason?: string;
  inputSnapshot: Record<string, unknown>;
  outputSnapshot?: Record<string, unknown>;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
};

export type ChatMode = "issue" | "case" | "similar_case" | "draft";
export type ChatRole = "user" | "assistant" | "system";

export type ChatSession = {
  id: string;
  reviewCaseId: string;
  issueId?: string;
  userId: string;
  mode: ChatMode;
  createdAt: string;
};

export type ChatMessage = {
  id: string;
  chatSessionId: string;
  role: ChatRole;
  content: string;
  evidenceIds: string[];
  markedForDraft: boolean;
  createdAt: string;
};

export type DraftVersion = {
  id: string;
  reviewCaseId: string;
  version: number;
  draft: string;
  source: "generated" | "manual" | "fallback";
  sourceMessageIds: string[];
  evidenceIds: string[];
  createdBy: string;
  createdAt: string;
};

export type PersistedReviewReport = {
  id: string;
  reviewCaseId: string;
  reportType: "approve" | "change_request" | "reject" | "hold";
  contentMarkdown: string;
  evidenceIds: string[];
  version: number;
  storageKey?: string;
  createdBy: string;
  createdAt: string;
};
