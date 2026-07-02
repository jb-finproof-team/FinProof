import type { ReviewCase } from "@/domain/types";
import { loadSocialContextKgSeedData } from "./data-loader";
import { extractSocialContextFeatures } from "./feature-extractor";
import { evaluateSocialContextRules } from "./rule-engine";
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

describe("evaluateSocialContextRules", () => {
  it("matches every curated country example against its expected social context rule", () => {
    const seedData = loadSocialContextKgSeedData();

    for (const testCase of seedData.testCases) {
      const features = extractSocialContextFeatures({
        review: reviewFromTestCase(testCase),
        extractedDocuments: [],
        seedData
      });
      const result = evaluateSocialContextRules({
        features,
        rules: seedData.socialRiskRules,
        priorControversyCases: seedData.priorControversyCases
      });
      const matchedRuleIds = result.matches.map((match) => match.ruleId);
      const expectedMatch = result.matches.find((match) =>
        testCase.expectedMatchedRuleIds.includes(match.ruleId)
      );

      expect(matchedRuleIds, testCase.id).toEqual(
        expect.arrayContaining(testCase.expectedMatchedRuleIds)
      );
      expect(expectedMatch?.riskLevel, testCase.id).toBe(testCase.expectedRiskLevel);
      expect(expectedMatch?.suggestedAction, testCase.id).toBe(testCase.expectedSuggestedAction);
    }
  });
});
