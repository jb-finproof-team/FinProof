import type { ReviewCase } from "@/domain/types";
import { loadSocialContextKgSeedData } from "./data-loader";
import { runSocialContextRiskAgent } from "./social-context-risk-agent";
import type { SocialContextTestCase } from "./types";

const affiliateByCountry: Record<string, string> = {
  cambodia: "PPCBank",
  vietnam: "JB Securities Vietnam",
  myanmar: "JB Capital Myanmar",
  china: "JB Financial China",
  thailand: "JB Thailand"
};

function reviewFromTestCase(testCase: SocialContextTestCase): ReviewCase {
  return {
    id: `review-${testCase.id}`,
    title: testCase.text,
    affiliate: affiliateByCountry[testCase.countryId] ?? "JB Financial",
    productType: testCase.productType as ReviewCase["productType"],
    channelType: testCase.channelType,
    plannedPublishDate: testCase.plannedPublishDate,
    status: "analysis_waiting",
    highestRiskLevel: "info",
    requester: "tester",
    reviewer: "reviewer",
    promotionalCopy: testCase.text,
    disclosure: "",
    productDescription: "",
    missingMaterials: [],
    files: [],
    issues: [],
    expectedDraft: "",
    currentVersion: 1
  };
}

describe("runSocialContextRiskAgent", () => {
  it("emits resolvable KG evidence and never recommends rejection", async () => {
    const seedData = loadSocialContextKgSeedData();

    for (const testCase of seedData.testCases) {
      const result = await runSocialContextRiskAgent({
        review: reviewFromTestCase(testCase),
        extractedDocuments: []
      });
      const expectedFinding = result.agentFindings.find((finding) =>
        result.matches.some(
          (match) =>
            finding.id === `finding-${match.id}` &&
            testCase.expectedMatchedRuleIds.includes(match.ruleId)
        )
      );
      const evidenceIds = new Set(result.evidenceCandidates.map((candidate) => candidate.id));

      expect(expectedFinding?.riskLevel, testCase.id).toBe(testCase.expectedRiskLevel);
      expect(expectedFinding?.suggestedAction, testCase.id).toBe(testCase.expectedSuggestedAction);
      expect(
        result.agentFindings.map((finding) => finding.suggestedAction),
        testCase.id
      ).not.toContain("reject");

      for (const finding of result.agentFindings) {
        expect(finding.agent).toBe("social_context_review");
        expect(finding.issueType).toBe("social_context_kg_risk");
        expect(finding.evidenceCandidateIds.length, testCase.id).toBeGreaterThan(0);
        expect(
          finding.evidenceCandidateIds.every((id) => evidenceIds.has(id)),
          testCase.id
        ).toBe(true);
      }
    }
  });

  it("uses internal policy evidence for KG rules and case history evidence for controversy memory", async () => {
    const result = await runSocialContextRiskAgent({
      review: reviewFromTestCase({
        id: "case-memory",
        countryId: "cambodia",
        plannedPublishDate: "2026-04-17",
        text: "Killing Fields급 수익률 이벤트",
        productType: "investment",
        channelType: ["SNS"],
        expectedRiskLevel: "high",
        expectedSuggestedAction: "hold",
        expectedMatchedRuleIds: ["country_sensitive_date_trauma_metaphor_finance_promo"]
      }),
      extractedDocuments: []
    });

    expect(result.evidenceCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceType: "internal_policy" }),
        expect.objectContaining({ sourceType: "case_history" })
      ])
    );
  });
});
