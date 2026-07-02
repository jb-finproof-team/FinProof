import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  CampaignIntent,
  FinancialPromoTerm,
  PriorControversyCase,
  SafeContext,
  SensitiveEvent,
  SensitiveEventTerm,
  SensitiveVisualSymbol,
  SocialContextCountry,
  SocialContextEdge,
  SocialContextKgSeedData,
  SocialContextTestCase,
  SocialRiskRule
} from "./types";

const EMPTY_SEED_DATA: SocialContextKgSeedData = {
  countries: [],
  sensitiveEvents: [],
  sensitiveEventTerms: [],
  sensitiveVisualSymbols: [],
  financialPromoTerms: [],
  campaignIntents: [],
  socialKgEdges: [],
  socialRiskRules: [],
  safeContexts: [],
  priorControversyCases: [],
  testCases: []
};

let cachedSeedData: SocialContextKgSeedData | undefined;

function combinedDataDir() {
  return path.join(process.cwd(), "data", "social-context", "multicountry", "combined");
}

function readJsonFile(fileName: string): unknown {
  const filePath = path.join(combinedDataDir(), fileName);

  return JSON.parse(readFileSync(filePath, "utf8"));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasStringId(value: unknown): value is { id: string } {
  return isObject(value) && typeof value.id === "string" && value.id.trim().length > 0;
}

function hasCountryId(value: unknown): value is { countryId: string } {
  return (
    isObject(value) && typeof value.countryId === "string" && value.countryId.trim().length > 0
  );
}

function dedupeById<T extends { id: string }>(items: T[]) {
  const seen = new Set<string>();

  return items.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }

    seen.add(item.id);
    return true;
  });
}

function dedupeCountries(items: SocialContextCountry[]) {
  const seen = new Set<string>();

  return items.filter((item) => {
    if (seen.has(item.countryId)) {
      return false;
    }

    seen.add(item.countryId);
    return true;
  });
}

function jsonArray<T>(
  fileName: string,
  predicate: (item: unknown) => item is T,
  options: { dedupe?: "id" | "countryId" } = {}
): T[] {
  const parsed = readJsonFile(fileName);

  if (!Array.isArray(parsed)) {
    return [];
  }

  const items = parsed.filter(predicate);

  if (options.dedupe === "id") {
    return dedupeById(items as Array<T & { id: string }>) as T[];
  }

  if (options.dedupe === "countryId") {
    return dedupeCountries(items as Array<T & SocialContextCountry>) as T[];
  }

  return items;
}

function isCountry(value: unknown): value is SocialContextCountry {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.countryId === "string" &&
    value.countryId.trim().length > 0 &&
    typeof value.nameKo === "string" &&
    typeof value.nameEn === "string"
  );
}

function isSensitiveEvent(value: unknown): value is SensitiveEvent {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.countryId === "string" &&
    value.countryId.trim().length > 0 &&
    typeof value.nameKo === "string"
  );
}

function isSensitiveEventTerm(value: unknown): value is SensitiveEventTerm {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.countryId === "string" &&
    value.countryId.trim().length > 0 &&
    typeof value.labelKo === "string" &&
    typeof value.termType === "string"
  );
}

function isSensitiveVisualSymbol(value: unknown): value is SensitiveVisualSymbol {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.countryId === "string" &&
    value.countryId.trim().length > 0 &&
    typeof value.labelKo === "string" &&
    typeof value.symbolType === "string"
  );
}

function isFinancialPromoTerm(value: unknown): value is FinancialPromoTerm {
  return isObject(value) && hasStringId(value) && typeof value.labelKo === "string";
}

function isCampaignIntent(value: unknown): value is CampaignIntent {
  return isObject(value) && hasStringId(value) && typeof value.labelKo === "string";
}

function isSocialContextEdge(value: unknown): value is SocialContextEdge {
  return (
    isObject(value) &&
    typeof value.from === "string" &&
    typeof value.relation === "string" &&
    typeof value.to === "string"
  );
}

function isSocialRiskRule(value: unknown): value is SocialRiskRule {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.nameKo === "string" &&
    Array.isArray(value.countryIds) &&
    isObject(value.conditions) &&
    (value.riskLevel === "info" || value.riskLevel === "caution" || value.riskLevel === "high") &&
    (value.suggestedAction === "approve" ||
      value.suggestedAction === "change_request" ||
      value.suggestedAction === "hold")
  );
}

function isSafeContext(value: unknown): value is SafeContext {
  return (
    isObject(value) && hasStringId(value) && hasCountryId(value) && typeof value.text === "string"
  );
}

function isPriorControversyCase(value: unknown): value is PriorControversyCase {
  return (
    isObject(value) && hasStringId(value) && hasCountryId(value) && typeof value.title === "string"
  );
}

function isSocialContextTestCase(value: unknown): value is SocialContextTestCase {
  return (
    isObject(value) && hasStringId(value) && hasCountryId(value) && typeof value.text === "string"
  );
}

export function resetSocialContextKgSeedDataCacheForTest() {
  cachedSeedData = undefined;
}

export function loadSocialContextKgSeedData(): SocialContextKgSeedData {
  if (cachedSeedData) {
    return cachedSeedData;
  }

  try {
    cachedSeedData = {
      countries: jsonArray("countries.json", isCountry, { dedupe: "countryId" }),
      sensitiveEvents: jsonArray("sensitive-events.json", isSensitiveEvent, { dedupe: "id" }),
      sensitiveEventTerms: jsonArray("sensitive-event-terms.json", isSensitiveEventTerm, {
        dedupe: "id"
      }),
      sensitiveVisualSymbols: jsonArray("sensitive-symbols-visual.json", isSensitiveVisualSymbol, {
        dedupe: "id"
      }),
      financialPromoTerms: jsonArray("financial-promo-terms.json", isFinancialPromoTerm, {
        dedupe: "id"
      }),
      campaignIntents: jsonArray("campaign-intents.json", isCampaignIntent, { dedupe: "id" }),
      socialKgEdges: jsonArray("social-kg-edges.json", isSocialContextEdge),
      socialRiskRules: jsonArray("social-risk-rules.json", isSocialRiskRule, { dedupe: "id" }),
      safeContexts: jsonArray("safe-contexts.json", isSafeContext, { dedupe: "id" }),
      priorControversyCases: jsonArray("prior-controversy-cases.json", isPriorControversyCase, {
        dedupe: "id"
      }),
      testCases: jsonArray("social-context-test-cases.json", isSocialContextTestCase, {
        dedupe: "id"
      })
    };

    return cachedSeedData;
  } catch {
    cachedSeedData = EMPTY_SEED_DATA;

    return cachedSeedData;
  }
}
