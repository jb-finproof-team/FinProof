"use client";

import { Fragment, useEffect, useRef, useState, type JSX } from "react";
import {
  ClipboardCheck,
  History,
  Loader2,
  PlayCircle,
  Stamp,
  Trash2,
  UserCheck
} from "lucide-react";
import { RiskBadge, StatusBadge } from "@/components/Badges";
import { statusLabels } from "@/domain/reviews";
import type {
  ProductType,
  ReviewAction,
  ReviewCase,
  ReviewSummary,
  ReviewVersion,
  RoleId
} from "@/domain/types";

const productLabels: Record<ProductType, string> = {
  deposit: "예금/적금",
  loan: "대출",
  card: "카드",
  capital: "캐피탈",
  insurance: "보험",
  investment: "투자상품",
  image_test: "이미지 테스트"
};

function isAnalysisWaiting(status: ReviewCase["status"]): boolean {
  return status === "submitted" || status === "analysis_waiting" || status === "analysis_queued";
}

function canOpenWorkbench(status: ReviewCase["status"]): boolean {
  return (
    status === "analysis_complete" ||
    status === "under_review" ||
    status === "change_requested" ||
    status === "rejected" ||
    status === "approved" ||
    status === "on_hold"
  );
}

function isFinalizedHistoryStatus(status: ReviewCase["status"]): boolean {
  return status === "approved" || status === "rejected";
}

function fallbackActionsFor(role: RoleId, status: ReviewCase["status"]): ReviewAction[] {
  if (
    (status === "analysis_waiting" || status === "analysis_failed") &&
    (role === "reviewer" || role === "compliance_admin")
  ) {
    return status === "analysis_failed"
      ? ["start_analysis", "open_workbench", "view_audit"]
      : ["start_analysis"];
  }
  if (
    status === "re_review_pending" &&
    (role === "reviewer" || role === "compliance_admin")
  ) {
    return ["start_analysis"];
  }
  if (canOpenWorkbench(status)) {
    return status === "analysis_complete" ? ["open_workbench", "view_audit"] : ["view_audit"];
  }
  return [];
}

function actionsFor(review: ReviewSummary, role: RoleId): ReviewAction[] {
  return review.availableActions ?? fallbackActionsFor(role, review.status);
}

function requestDepartment(review: ReviewSummary): string {
  if (review.requestDepartment?.trim()) return review.requestDepartment.trim();
  if (review.requester.includes("업로드")) return "디지털마케팅팀";
  if (review.productType === "card") return "제휴마케팅팀";
  if (review.productType === "loan") return "리테일금융팀";
  return "마케팅팀";
}

export type QueueTableProps = {
  rows: ReviewSummary[];
  activeRole: RoleId;
  activeAnalysisId: string | null;
  analysisStates?: QueueAnalysisStates;
  isLoading?: boolean;
  loadingMessage?: string;
  emptyMessage?: string;
  canDeleteReviewHistory?: boolean;
  deletingReviewHistoryIds?: string[];
  showVersionHistory?: boolean;
  apiHeaders?: (extra?: Record<string, string>) => Record<string, string>;
  loggedInUser?: { name: string } | null;
  onSaveReviewer?: (review: ReviewSummary, reviewer: string) => void;
  onDeleteReviewHistory?: (review: ReviewSummary) => void;
  onStartAnalysis: (review: ReviewSummary) => void;
  onOpenProgress?: (review: ReviewSummary) => void;
  onOpenReview: (reviewId: string) => void;
};

type VersionsResponse = {
  currentVersion: number;
  versions: ReviewVersion[];
};

type VersionHistoryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; currentVersion: number; versions: ReviewVersion[] };

function formatDecidedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function QueueVersionTimeline({
  versions,
  currentVersion
}: {
  versions: ReviewVersion[];
  currentVersion: number;
}): JSX.Element {
  const ordered = [...versions].sort((a, b) => a.versionNumber - b.versionNumber);

  return (
    <ol className="queue-version-history__list">
      {ordered.map((version) => {
        const isCurrent = version.versionNumber === currentVersion;
        const opinion = version.opinionDraft?.trim() || version.reviewerComment?.trim() || "";

        return (
          <li key={version.id ?? version.versionNumber} className="queue-version-item">
            <span className="queue-version-item__marker" aria-hidden="true" />
            <div className="queue-version-item__body">
              <div className="queue-version-item__head">
                <span className="queue-version-item__number">v{version.versionNumber}</span>
                <span
                  className="queue-version-item__status"
                  data-status={version.status}
                >
                  {statusLabels[version.status]}
                </span>
                {isCurrent ? (
                  <span className="queue-version-item__current">현재</span>
                ) : null}
              </div>
              <dl className="queue-version-item__meta">
                <div>
                  <dt>결정일</dt>
                  <dd>{formatDecidedAt(version.decidedAt)}</dd>
                </div>
                <div>
                  <dt>심의자</dt>
                  <dd>{version.decidedByName || "-"}</dd>
                </div>
              </dl>
              {opinion ? (
                <pre className="queue-version-item__opinion">{opinion}</pre>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export type QueueAnalysisState = {
  status: "queued" | "running" | "completed" | "failed";
  errorMessage?: string;
};

export type QueueAnalysisStates = Record<string, QueueAnalysisState | undefined>;

type PendingOpen = {
  review: ReviewSummary;
  reviewerName: string;
};

function ReviewerConfirmToast({
  pending,
  onConfirm,
  onCancel
}: {
  pending: PendingOpen;
  onConfirm: (reviewerName: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [name, setName] = useState(pending.reviewerName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="reviewer-confirm-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="reviewer-confirm-toast"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reviewer-confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="reviewer-confirm-toast__icon" aria-hidden="true">
          <UserCheck size={22} />
        </span>
        <div className="reviewer-confirm-toast__body">
          <p id="reviewer-confirm-title" className="reviewer-confirm-toast__title">
            담당자 확인
          </p>
          <p className="reviewer-confirm-toast__sub">{pending.review.title}</p>
          <input
            ref={inputRef}
            className="reviewer-confirm-toast__input"
            value={name}
            placeholder="담당자 이름"
            aria-label="담당자 이름"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) onConfirm(name.trim());
              if (e.key === "Escape") onCancel();
            }}
          />
        </div>
        <div className="reviewer-confirm-toast__actions">
          <button
            className="button button--small button--primary"
            type="button"
            disabled={!name.trim()}
            onClick={() => onConfirm(name.trim())}
          >
            검토 시작
          </button>
          <button className="button button--small" type="button" onClick={onCancel}>
            취소
          </button>
        </div>
      </div>
    </div>
  );
}

export function QueueTable({
  rows,
  activeRole,
  activeAnalysisId,
  analysisStates = {},
  isLoading = false,
  loadingMessage = "심의 대기 목록을 불러오는 중입니다.",
  emptyMessage,
  canDeleteReviewHistory = false,
  deletingReviewHistoryIds = [],
  showVersionHistory = false,
  apiHeaders,
  loggedInUser,
  onSaveReviewer,
  onDeleteReviewHistory,
  onStartAnalysis,
  onOpenProgress,
  onOpenReview
}: QueueTableProps): JSX.Element {
  const [pendingOpen, setPendingOpen] = useState<PendingOpen | null>(null);
  const [expandedVersionIds, setExpandedVersionIds] = useState<Set<string>>(new Set());
  const [versionHistory, setVersionHistory] = useState<Record<string, VersionHistoryState>>({});

  async function loadVersionHistory(caseId: string): Promise<void> {
    setVersionHistory((current) => ({ ...current, [caseId]: { status: "loading" } }));
    try {
      const response = await fetch(`/api/v1/review-cases/${caseId}/versions`, {
        headers: apiHeaders?.() ?? {}
      });
      if (!response.ok) throw new Error("심의 버전 이력을 불러오지 못했습니다.");
      const body = (await response.json()) as VersionsResponse;
      setVersionHistory((current) => ({
        ...current,
        [caseId]: {
          status: "loaded",
          currentVersion: body.currentVersion,
          versions: body.versions ?? []
        }
      }));
    } catch (error) {
      setVersionHistory((current) => ({
        ...current,
        [caseId]: {
          status: "error",
          message:
            error instanceof Error ? error.message : "심의 버전 이력을 불러오지 못했습니다."
        }
      }));
    }
  }

  function toggleVersionHistory(caseId: string): void {
    setExpandedVersionIds((current) => {
      const next = new Set(current);
      if (next.has(caseId)) {
        next.delete(caseId);
      } else {
        next.add(caseId);
        // Lazy-fetch once and cache; re-expanding reuses the cached result.
        if (!versionHistory[caseId]) {
          void loadVersionHistory(caseId);
        }
      }
      return next;
    });
  }

  function handleOpenReviewClick(review: ReviewSummary): void {
    if (loggedInUser) {
      const reviewerName = loggedInUser.name;
      if (reviewerName !== review.reviewer && onSaveReviewer) {
        onSaveReviewer(review, reviewerName);
      }
      onOpenReview(review.id);
      return;
    }
    setPendingOpen({ review, reviewerName: review.reviewer || "" });
  }

  function handleConfirm(reviewerName: string): void {
    if (!pendingOpen) return;
    const reviewId = pendingOpen.review.id;
    setPendingOpen(null);
    if (reviewerName !== pendingOpen.review.reviewer && onSaveReviewer) {
      onSaveReviewer(pendingOpen.review, reviewerName);
    }
    onOpenReview(reviewId);
  }

  return (
    <div className="review-table review-table--queue" role="table" aria-label="Review cases">
      <div className="review-table__row review-table__row--head" role="row">
        <span role="columnheader">심의 ID</span>
        <span role="columnheader">제목</span>
        <span role="columnheader">상품군</span>
        <span role="columnheader">요청 부서</span>
        <span role="columnheader">요청자</span>
        <span role="columnheader">상태</span>
        <span role="columnheader">위험도</span>
        <span role="columnheader">마감일</span>
        <span role="columnheader">담당자</span>
        <span role="columnheader">작업</span>
      </div>

      {isLoading ? (
        <div className="queue-empty-state">
          <Loader2 className="action-spinner" size={18} aria-hidden="true" />
          {loadingMessage}
        </div>
      ) : null}

      {!isLoading && rows.length === 0 ? (
        <div className="queue-empty-state">{emptyMessage ?? "아직 심의 요청이 없습니다."}</div>
      ) : null}

      {pendingOpen ? (
        <ReviewerConfirmToast
          pending={pendingOpen}
          onConfirm={handleConfirm}
          onCancel={() => setPendingOpen(null)}
        />
      ) : null}

      {rows.map((review) => {
        const waiting = isAnalysisWaiting(review.status);
        const failedStatus = review.status === "analysis_failed";
        const analysisState = analysisStates[review.id];
        const rowActions = actionsFor(review, activeRole);
        const canStart = rowActions.includes("start_analysis");
        const canOpen = rowActions.includes("open_workbench");
        const canViewAudit = rowActions.includes("view_audit");
        const openable = canOpen || canViewAudit;
        const activelyAnalyzing =
          activeAnalysisId === review.id ||
          analysisState?.status === "queued" ||
          analysisState?.status === "running" ||
          review.status === "analysis_queued" ||
          review.status === "analysis_in_progress";
        const analysisFailed =
          !activelyAnalyzing && (failedStatus || analysisState?.status === "failed");
        const analysisFailureText = analysisState?.errorMessage
          ? `분석 실패: ${analysisState.errorMessage}`
          : "";
        // analysis_failed surfaces 재시도 + 직접검토 (상세보기는 직접검토와 기능이 겹쳐 제외); a still-waiting
        // row that the poller marked failed keeps only the retry affordance.
        // 재업로드 대기(re_review_pending)는 분석 전이므로 시작 버튼('AI 재검토')을 노출한다.
        const isReReviewPending = review.status === "re_review_pending";
        const isReUpload = (review.currentVersion ?? 1) > 1;
        const showStartButton =
          waiting || failedStatus || isReReviewPending || activelyAnalyzing;
        const showWorkbench =
          canOpen && (review.status === "analysis_complete" || failedStatus);
        const showAudit =
          !waiting &&
          !failedStatus &&
          canViewAudit &&
          review.status !== "analysis_complete";
        // 승인 완료 건은 심의필이 정식 발급되기 전까지 '심의필 발급하기'로 안내한다.
        const certificateNeedsIssue =
          review.status === "approved" && review.certificateStatus !== "issued";
        const showStatusNote = !waiting && !openable && !showStartButton;
        const canDelete =
          canDeleteReviewHistory &&
          isFinalizedHistoryStatus(review.status) &&
          Boolean(onDeleteReviewHistory);
        const isDeleting = deletingReviewHistoryIds.includes(review.id);
        const reviewCurrentVersion = review.currentVersion ?? 1;
        const showVersionToggle = showVersionHistory && reviewCurrentVersion > 1;
        const isVersionExpanded = expandedVersionIds.has(review.id);
        const versionState = versionHistory[review.id];

        return (
          <Fragment key={review.id}>
          <div
            className="review-table__row"
            role="row"
            aria-label={`${review.title}`}
          >
            <span className="queue-id" role="cell">
              {review.id}
            </span>
            <strong role="cell">
              {review.title}
              {(review.currentVersion ?? 1) > 1 ? (
                <span className="requeue-badge" title="요청자가 수정본을 재업로드한 재심의 건입니다">
                  재업로드 v{review.currentVersion}
                </span>
              ) : null}
            </strong>
            <span role="cell">{productLabels[review.productType]}</span>
            <span role="cell">{requestDepartment(review)}</span>
            <span role="cell">{review.requester || "미기재"}</span>
            <span role="cell">
              <StatusBadge status={review.status} />
            </span>
            <span role="cell">
              {waiting || review.status === "analysis_queued" ? (
                <span className="risk-badge risk-badge--muted">분석 전</span>
              ) : (
                <RiskBadge level={review.highestRiskLevel} />
              )}
            </span>
            <span role="cell">{review.plannedPublishDate}</span>
            <span
              className="reviewer-editor"
              role="cell"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              {review.reviewer || "미배정"}
            </span>
            <span
              className={`queue-row-actions queue-row-actions--left${
                canDelete ? " queue-row-actions--delete" : ""
              }${analysisFailed ? " queue-row-actions--failed" : ""}`}
              role="cell"
              onClick={(event) => event.stopPropagation()}
            >
              {showStartButton ? (
                activelyAnalyzing ? (
                  <button
                    className="button button--small queue-row-action-button"
                    type="button"
                    disabled={!onOpenProgress}
                    title={onOpenProgress ? "분석 진행상황 보기" : undefined}
                    onClick={() => onOpenProgress?.(review)}
                  >
                    <Loader2 className="action-spinner" size={15} aria-hidden="true" />
                    {analysisState?.status === "queued" ? "대기중" : "분석중"}
                  </button>
                ) : (
                  <button
                    className="button button--small queue-row-action-button"
                    type="button"
                    disabled={!canStart}
                    onClick={() => onStartAnalysis(review)}
                  >
                    {analysisFailed ? (
                      <>
                        <PlayCircle size={15} aria-hidden="true" />
                        AI 분석 재시도
                      </>
                    ) : (
                      <>
                        <PlayCircle size={15} aria-hidden="true" />
                        {isReReviewPending ? "AI 재검토 시작" : "AI 분석 시작"}
                      </>
                    )}
                  </button>
                )
              ) : null}
              {analysisFailed && analysisFailureText ? (
                <span
                  className="queue-row-note queue-row-note--analysis-error"
                  title={analysisFailureText}
                  aria-label={analysisFailureText}
                >
                  {analysisFailureText}
                </span>
              ) : null}
              {showWorkbench ? (
                <button
                  className="button button--small button--primary queue-row-action-button"
                  type="button"
                  onClick={() => handleOpenReviewClick(review)}
                >
                  <ClipboardCheck size={15} aria-hidden="true" />
                  {failedStatus ? "직접검토" : isReUpload ? "재검토하기" : "검토하기"}
                </button>
              ) : null}
              {certificateNeedsIssue ? (
                <button
                  className="button button--small button--primary queue-row-action-button"
                  type="button"
                  onClick={() => onOpenReview(review.id)}
                >
                  <Stamp size={15} aria-hidden="true" />
                  심의필 발급하기
                </button>
              ) : showAudit ? (
                <button
                  className="button button--small queue-row-action-button queue-row-action-button--sm"
                  type="button"
                  onClick={() => onOpenReview(review.id)}
                >
                  상세보기
                </button>
              ) : null}
              {showVersionToggle ? (
                <button
                  className="icon-button icon-button--small queue-version-toggle"
                  type="button"
                  aria-expanded={isVersionExpanded}
                  aria-label={`심의 버전 이력 v1~v${reviewCurrentVersion}`}
                  title={`심의 버전 이력 v1~v${reviewCurrentVersion}`}
                  onClick={() => toggleVersionHistory(review.id)}
                >
                  <History size={18} aria-hidden="true" />
                </button>
              ) : null}
              {showStatusNote ? (
                <span className="queue-row-note">{statusLabels[review.status]}</span>
              ) : null}
              {canDelete ? (
                <button
                  className="icon-button icon-button--small icon-button--danger queue-row-delete-button"
                  type="button"
                  aria-label={`심의 이력 삭제: ${review.title}`}
                  title="심의 이력 삭제"
                  disabled={isDeleting}
                  onClick={() => onDeleteReviewHistory?.(review)}
                >
                  {isDeleting ? (
                    <Loader2 className="action-spinner" size={20} aria-hidden="true" />
                  ) : (
                    <Trash2 size={20} aria-hidden="true" />
                  )}
                </button>
              ) : null}
            </span>
          </div>
          {showVersionToggle && isVersionExpanded ? (
            <div className="queue-version-history" role="row">
              <div className="queue-version-history__cell" role="cell">
                <p className="queue-version-history__title">
                  <History size={15} aria-hidden="true" />
                  심의 버전 이력
                </p>
                {!versionState || versionState.status === "loading" ? (
                  <p className="queue-version-history__note">
                    <Loader2 className="action-spinner" size={15} aria-hidden="true" />
                    심의 버전 이력을 불러오는 중입니다.
                  </p>
                ) : versionState.status === "error" ? (
                  <p className="queue-version-history__note queue-version-history__note--error">
                    {versionState.message}
                  </p>
                ) : versionState.versions.length === 0 ? (
                  <p className="queue-version-history__note">표시할 버전 이력이 없습니다.</p>
                ) : (
                  <QueueVersionTimeline
                    versions={versionState.versions}
                    currentVersion={versionState.currentVersion}
                  />
                )}
              </div>
            </div>
          ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}
