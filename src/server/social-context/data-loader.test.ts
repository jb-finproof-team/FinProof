import { existsSync } from "node:fs";
import path from "node:path";
import {
  loadSocialContextKgSeedData,
  resetSocialContextKgSeedDataCacheForTest
} from "./data-loader";

describe("loadSocialContextKgSeedData", () => {
  beforeEach(() => {
    resetSocialContextKgSeedDataCacheForTest();
  });

  it("loads the deterministic combined JSON seed dataset without committing the raw zip", () => {
    const seedData = loadSocialContextKgSeedData();

    expect(seedData.countries.map((country) => country.countryId).sort()).toEqual([
      "cambodia",
      "china",
      "myanmar",
      "thailand",
      "vietnam"
    ]);
    expect(seedData.socialRiskRules.map((rule) => rule.id)).toContain(
      "country_sensitive_date_trauma_metaphor_finance_promo"
    );
    expect(seedData.testCases).toHaveLength(25);
    expect(
      existsSync(path.join(process.cwd(), "data", "social-context", "multicountry", "combined"))
    ).toBe(true);
    expect(
      existsSync(
        path.join(
          process.cwd(),
          "data",
          "social-context",
          "finproof_multicountry_social_context_kg_seed_data.zip"
        )
      )
    ).toBe(false);
  });
});
