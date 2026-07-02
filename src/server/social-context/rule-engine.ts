import { createHash } from "node:crypto";
import {
  compactTargetText,
  matchesAnyAlias,
  normalizeSocialContextText,
  uniqueStrings
} from "./normalize";
import type {
  CampaignIntent,
  FinancialPromoTerm,
  PriorControversyCase,
  SensitiveEvent,
  SensitiveEventTerm,
  SensitiveVisualSymbol,
  SocialContextDetectedItem,
  SocialContextFeatureSet,
  SocialContextMatch,
  SocialContextRiskLevel,
  SocialContextRiskResult,
  SocialRiskRule
} from "./types";

type CountryFeatures = {
  countryId: string;
  events: Array<SocialContextDetectedItem<SensitiveEvent>>;
  terms: Array<SocialContextDetectedItem<SensitiveEventTerm>>;
  symbols: Array<SocialContextDetectedItem<SensitiveVisualSymbol>>;
  financialTerms: Array<SocialContextDetectedItem<FinancialPromoTerm>>;
  campaignIntents: Array<SocialContextDetectedItem<CampaignIntent>>;
};

const HOLD_ACTION_RULE_IDS = new Set([
  "national_symbol_distortion_finance_promo",
  "country_sensitive_date_trauma_metaphor_finance_promo"
]);

const UNSAFE_KEYWORDS = [
  "급",
  "joke",
  "mascot",
  "power",
  "zero",
  "제로",
  "0원",
  "하락",
  "단독 표시",
  "별도 국가"
];

const DISTORTION_OR_PRICE_TAG_KEYWORDS = [
  "가격표",
  "price tag",
  "cashback",
  "캐시백",
  "할인",
  "특가",
  "쿠폰",
  "혜택",
  "단독 표시",
  "별도 국가",
  "누락",
  "distortion",
  "deformation",
  "floor",
  "gimmick"
];

const MAP_OR_FLAG_KEYWORDS = [
  "지도",
  "map",
  "국기",
  "flag",
  "국가 목록",
  "country list",
  "대만",
  "홍콩",
  "신장",
  "台湾",
  "香港",
  "新疆"
];

const SENSITIVE_SAFE_BLOCKLIST = [
  "genocide",
  "national_war_date",
  "war_memory",
  "war_harm",
  "chemical",
  "victim",
  "violence",
  "protest",
  "political",
  "military",
  "ethnic",
  "refugee",
  "displacement",
  "monarchy",
  "religious_sacred",
  "religious_afterlife",
  "regime",
  "dictator",
  "sovereignty_sensitive"
];

function stableHash(value: string) {
  return createHash("sha1").update(value).digest("hex").slice(0, 10);
}

function riskRank(riskLevel: SocialContextRiskLevel) {
  return riskLevel === "high" ? 3 : riskLevel === "caution" ? 2 : 1;
}

function highestRiskLevel(values: SocialContextRiskLevel[], fallback: SocialContextRiskLevel) {
  return values.reduce(
    (highest, value) => (riskRank(value) > riskRank(highest) ? value : highest),
    fallback
  );
}

function countryFeatures(features: SocialContextFeatureSet, countryId: string): CountryFeatures {
  return {
    countryId,
    events: features.detectedSensitiveEvents.filter((event) => event.item.countryId === countryId),
    terms: features.detectedSensitiveTerms.filter((term) => term.item.countryId === countryId),
    symbols: features.detectedVisualSymbolsByTextAlias.filter(
      (symbol) => symbol.item.countryId === countryId
    ),
    financialTerms: features.detectedFinancialPromoTerms,
    campaignIntents: features.detectedCampaignIntent
  };
}

function monthDayToDayOfYear(monthDay: string) {
  const [month, day] = monthDay.split("-").map(Number);
  const monthStarts = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

  if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined;
  }

  return monthStarts[month - 1] + day;
}

function isConcreteMonthDay(date: string) {
  return /^\d{2}-\d{2}$/.test(date);
}

function isWithinDateWindow(monthDay: string | undefined, event: SensitiveEvent) {
  if (!monthDay) {
    return false;
  }

  const plannedDay = monthDayToDayOfYear(monthDay);

  if (!plannedDay) {
    return false;
  }

  return (event.dates ?? []).some((date) => {
    if (!isConcreteMonthDay(date)) {
      return false;
    }

    const eventDay = monthDayToDayOfYear(date);

    if (!eventDay) {
      return false;
    }

    const distance = Math.abs(plannedDay - eventDay);
    const circularDistance = Math.min(distance, 365 - distance);

    return circularDistance <= (event.dateWindowDays ?? 0);
  });
}

function normalizedIncludesAny(sourceText: string, aliases: string[]) {
  return Boolean(matchesAnyAlias(sourceText, aliases));
}

function typeMatchesAny(value: string | undefined, desiredTypes: string[]) {
  if (!value) {
    return false;
  }

  const normalizedValue = normalizeSocialContextText(value).replace(/-/g, "_");

  return desiredTypes.some((desiredType) => {
    const desired = normalizeSocialContextText(desiredType).replace(/-/g, "_");

    if (normalizedValue === desired || normalizedValue.includes(desired)) {
      return true;
    }

    if (desired === "war_harm") {
      return (
        normalizedValue.includes("war") ||
        normalizedValue.includes("chemical") ||
        normalizedValue.includes("victim") ||
        normalizedValue.includes("harm") ||
        normalizedValue.includes("diaspora")
      );
    }

    if (desired === "genocide_memory") {
      return (
        normalizedValue.includes("genocide") ||
        normalizedValue.includes("regime") ||
        normalizedValue.includes("dictator")
      );
    }

    if (desired === "political_memory_symbol") {
      return (
        normalizedValue.includes("political") ||
        normalizedValue.includes("democracy") ||
        normalizedValue.includes("tiananmen")
      );
    }

    if (desired === "state_violence") {
      return (
        normalizedValue.includes("coup") ||
        normalizedValue.includes("military") ||
        normalizedValue.includes("dictator") ||
        normalizedValue.includes("regime")
      );
    }

    if (desired === "humanitarian_visual") {
      return (
        normalizedValue.includes("humanitarian") ||
        normalizedValue.includes("refugee") ||
        normalizedValue.includes("displacement") ||
        normalizedValue.includes("ethnic") ||
        normalizedValue.includes("victim")
      );
    }

    if (desired.includes("religious") && normalizedValue.includes("religious")) {
      return true;
    }

    if (desired.includes("protest") || desired.includes("political")) {
      return (
        normalizedValue.includes("protest") ||
        normalizedValue.includes("political") ||
        normalizedValue.includes("democracy") ||
        normalizedValue.includes("military") ||
        normalizedValue.includes("coup")
      );
    }

    if (desired.includes("monarchy") && normalizedValue.includes("monarchy")) {
      return true;
    }

    if (
      desired === "national_site" &&
      normalizedValue.includes("national") &&
      normalizedValue.includes("site")
    ) {
      return true;
    }

    return false;
  });
}

function containsTermTypeAny(country: CountryFeatures, desiredTypes: string[]) {
  return country.terms.some((term) => typeMatchesAny(term.item.termType, desiredTypes));
}

function containsSensitiveTermTypeAny(country: CountryFeatures, desiredTypes: string[]) {
  return (
    country.terms.some((term) => typeMatchesAny(term.item.termType, desiredTypes)) ||
    country.symbols.some((symbol) => typeMatchesAny(symbol.item.symbolType, desiredTypes)) ||
    country.events.some((event) =>
      (event.item.eventType ?? []).some((eventType) => typeMatchesAny(eventType, desiredTypes))
    )
  );
}

function containsSymbolTypeAny(country: CountryFeatures, desiredTypes: string[]) {
  return (
    country.symbols.some((symbol) => typeMatchesAny(symbol.item.symbolType, desiredTypes)) ||
    country.terms.some((term) => typeMatchesAny(term.item.termType, desiredTypes))
  );
}

function campaignIntentAnyOf(country: CountryFeatures, desiredIds: string[]) {
  return country.campaignIntents.some((intent) => desiredIds.includes(intent.item.id));
}

function dateMatchesSensitiveEvent(features: SocialContextFeatureSet, country: CountryFeatures) {
  return country.events.some((event) => {
    if (isWithinDateWindow(features.plannedPublishMonthDay, event.item)) {
      return true;
    }

    const eventHasConcreteDate = (event.item.dates ?? []).some(isConcreteMonthDay);

    if (!eventHasConcreteDate) {
      return event.item.sensitivityLevel === "high";
    }

    return false;
  });
}

function eventTypeAny(country: CountryFeatures, desiredTypes: string[]) {
  return country.events.some((event) => {
    const eventTypes = event.item.eventType ?? [];
    const holidayLike =
      desiredTypes.includes("family_holiday") || desiredTypes.includes("new_year");

    return (
      eventTypes.some((eventType) => typeMatchesAny(eventType, desiredTypes)) ||
      (holidayLike &&
        eventTypes.some((eventType) =>
          typeMatchesAny(eventType, [
            "family_holiday",
            "new_year",
            "water_festival",
            "national_holiday",
            "buddhist_holiday",
            "ancestor_memorial",
            "national_day",
            "independence",
            "holiday_money_custom"
          ])
        ))
    );
  });
}

function containsNoSacredMockery(features: SocialContextFeatureSet, country: CountryFeatures) {
  const hasUnsafeSensitiveTerm = country.terms.some((term) => {
    if (term.item.unsafeWhenUsedAsMetaphor) {
      return true;
    }

    return SENSITIVE_SAFE_BLOCKLIST.some((blockedType) =>
      typeMatchesAny(term.item.termType, [blockedType])
    );
  });
  const hasUnsafeSymbol = country.symbols.some((symbol) =>
    SENSITIVE_SAFE_BLOCKLIST.some((blockedType) =>
      typeMatchesAny(symbol.item.symbolType, [blockedType])
    )
  );
  const hasUnsafeKeyword = normalizedIncludesAny(features.sourceText, UNSAFE_KEYWORDS);

  return !hasUnsafeSensitiveTerm && !hasUnsafeSymbol && !hasUnsafeKeyword;
}

function safeContextMatched(features: SocialContextFeatureSet, countryId: string) {
  return features.safeContextHints.some((hint) => hint.item.countryId === countryId);
}

function safeCulturalContextIs(
  features: SocialContextFeatureSet,
  countryId: string,
  expected: boolean
) {
  const matched = safeContextMatched(features, countryId);

  return expected ? matched : !matched;
}

function safeOfficialRespectContextIs(
  features: SocialContextFeatureSet,
  countryId: string,
  expected: boolean
) {
  const matched =
    safeContextMatched(features, countryId) ||
    normalizedIncludesAny(features.sourceText, ["공식", "존중", "기념", "official", "respect"]);

  return expected ? matched : !matched;
}

function marketingMaterialHasMapOrFlag(
  features: SocialContextFeatureSet,
  country: CountryFeatures
) {
  return (
    normalizedIncludesAny(features.sourceText, MAP_OR_FLAG_KEYWORDS) ||
    country.symbols.some((symbol) =>
      typeMatchesAny(symbol.item.symbolType, [
        "sovereignty_sensitive_flag",
        "sovereignty_sensitive_map"
      ])
    )
  );
}

function symbolDistortedOrUsedAsPriceTag(features: SocialContextFeatureSet) {
  return normalizedIncludesAny(features.sourceText, DISTORTION_OR_PRICE_TAG_KEYWORDS);
}

function ruleConditionsMet(
  rule: SocialRiskRule,
  features: SocialContextFeatureSet,
  country: CountryFeatures
) {
  const conditions = rule.conditions;

  if (conditions.dateMatchesSensitiveEvent && !dateMatchesSensitiveEvent(features, country)) {
    return false;
  }

  if (
    conditions.containsSensitiveTermTypeAny &&
    !containsSensitiveTermTypeAny(country, conditions.containsSensitiveTermTypeAny)
  ) {
    return false;
  }

  if (
    conditions.containsTermTypeAny &&
    !containsTermTypeAny(country, conditions.containsTermTypeAny)
  ) {
    return false;
  }

  if (
    conditions.containsSymbolTypeAny &&
    !containsSymbolTypeAny(country, conditions.containsSymbolTypeAny)
  ) {
    return false;
  }

  if (conditions.containsFinancialPromoTerm && country.financialTerms.length === 0) {
    return false;
  }

  if (
    conditions.campaignIntentAnyOf &&
    !campaignIntentAnyOf(country, conditions.campaignIntentAnyOf)
  ) {
    return false;
  }

  if (
    typeof conditions.safeCulturalContext === "boolean" &&
    !safeCulturalContextIs(features, country.countryId, conditions.safeCulturalContext)
  ) {
    return false;
  }

  if (
    typeof conditions.safeOfficialRespectContext === "boolean" &&
    !safeOfficialRespectContextIs(
      features,
      country.countryId,
      conditions.safeOfficialRespectContext
    )
  ) {
    return false;
  }

  if (
    conditions.marketingMaterialHasMapOrFlag &&
    !marketingMaterialHasMapOrFlag(features, country)
  ) {
    return false;
  }

  if (
    conditions.symbolDistortedOrUsedAsPriceTag &&
    !symbolDistortedOrUsedAsPriceTag(features) &&
    rule.id !== "national_symbol_distortion_finance_promo"
  ) {
    return false;
  }

  if (conditions.eventTypeAny && !eventTypeAny(country, conditions.eventTypeAny)) {
    return false;
  }

  if (conditions.containsNoSacredMockery && !containsNoSacredMockery(features, country)) {
    return false;
  }

  return true;
}

function riskForRule(
  rule: SocialRiskRule,
  features: SocialContextFeatureSet,
  country: CountryFeatures
) {
  if (
    rule.id === "national_symbol_distortion_finance_promo" &&
    !symbolDistortedOrUsedAsPriceTag(features)
  ) {
    return "caution" satisfies SocialContextRiskLevel;
  }

  if (rule.id === "country_sensitive_date_trauma_metaphor_finance_promo") {
    const strongestSignal = highestRiskLevel(
      [
        ...country.terms.map((term) => term.item.sensitivityLevel ?? "caution"),
        ...country.symbols.map((symbol) => symbol.item.sensitivityLevel ?? "caution"),
        ...country.events.map((event) => event.item.sensitivityLevel ?? "caution")
      ],
      "caution"
    );
    const hasUnsafeMetaphor = country.terms.some((term) => term.item.unsafeWhenUsedAsMetaphor);
    const hasExactDate = country.events.some((event) =>
      isWithinDateWindow(features.plannedPublishMonthDay, event.item)
    );

    if (strongestSignal === "high" && (hasUnsafeMetaphor || hasExactDate)) {
      return "high" satisfies SocialContextRiskLevel;
    }

    return strongestSignal === "high" ? "high" : "caution";
  }

  return rule.riskLevel;
}

function actionForRule(
  rule: SocialRiskRule,
  riskLevel: SocialContextRiskLevel
): SocialContextMatch["suggestedAction"] {
  if (rule.suggestedAction === "approve") {
    return "approve";
  }

  if (riskLevel === "info") {
    return "approve";
  }

  return HOLD_ACTION_RULE_IDS.has(rule.id) || riskLevel === "high" ? "hold" : "change_request";
}

function relevantCountryIds(features: SocialContextFeatureSet, rules: SocialRiskRule[]) {
  if (features.detectedCountryIds.length > 0) {
    return features.detectedCountryIds;
  }

  return uniqueStrings(rules.flatMap((rule) => rule.countryIds));
}

function matchedAliases(country: CountryFeatures) {
  return uniqueStrings([
    ...country.events.map((event) => event.matchedAlias),
    ...country.terms.map((term) => term.matchedAlias),
    ...country.symbols.map((symbol) => symbol.matchedAlias),
    ...country.financialTerms.map((term) => term.matchedAlias),
    ...country.campaignIntents.map((intent) => intent.matchedAlias)
  ]);
}

function bestTargetText(features: SocialContextFeatureSet, country: CountryFeatures) {
  const aliases = matchedAliases(country);
  const target = features.candidateTargetTexts.find((candidate) =>
    aliases.some((alias) => matchesAnyAlias(candidate, [alias]))
  );

  return target ?? features.candidateTargetTexts[0] ?? compactTargetText(features.sourceText, 220);
}

function matchedDates(features: SocialContextFeatureSet, country: CountryFeatures) {
  const planned = features.plannedPublishMonthDay;
  const eventDates = country.events
    .filter((event) => isWithinDateWindow(planned, event.item))
    .flatMap((event) => event.item.dates ?? [])
    .filter(isConcreteMonthDay);

  return uniqueStrings([...(planned ? [planned] : []), ...eventDates]);
}

function matchedPath(rule: SocialRiskRule, country: CountryFeatures) {
  const eventNames = country.events.map((event) => event.item.nameKo);
  const terms = country.terms.map((term) => term.item.labelKo);
  const symbols = country.symbols.map((symbol) => symbol.item.labelKo);
  const financialTerms = country.financialTerms.map((term) => term.item.labelKo);

  return uniqueStrings([rule.nameKo, ...eventNames, ...terms, ...symbols, ...financialTerms]).join(
    " > "
  );
}

function rationale(
  rule: SocialRiskRule,
  riskLevel: SocialContextRiskLevel,
  country: CountryFeatures
) {
  const sensitiveSignals = uniqueStrings([
    ...country.events.map((event) => event.item.nameKo),
    ...country.terms.map((term) => term.item.labelKo),
    ...country.symbols.map((symbol) => symbol.item.labelKo)
  ]);
  const financialSignals = uniqueStrings(country.financialTerms.map((term) => term.item.labelKo));
  const signalText =
    sensitiveSignals.length > 0 ? ` 감지 신호: ${sensitiveSignals.join(", ")}.` : "";
  const financialText =
    financialSignals.length > 0 ? ` 금융 홍보 문맥: ${financialSignals.join(", ")}.` : "";

  return `${rule.rationaleTemplate}${signalText}${financialText} 판단 등급: ${riskLevel}.`;
}

function confidenceFor(
  rule: SocialRiskRule,
  riskLevel: SocialContextRiskLevel,
  country: CountryFeatures
) {
  const signalCount =
    country.events.length +
    country.terms.length +
    country.symbols.length +
    country.financialTerms.length;
  const base = riskLevel === "high" ? 0.9 : riskLevel === "caution" ? 0.84 : 0.78;

  return Math.min(
    0.98,
    base + Math.min(signalCount, 4) * 0.015 + (rule.riskLevel === "high" ? 0.02 : 0)
  );
}

function evidenceIdsFor(rule: SocialRiskRule, countryId: string, targetText: string) {
  return [`social-context-rule-${countryId}-${rule.id}-${stableHash(targetText)}`];
}

function matchedCaseIds(
  priorCases: PriorControversyCase[],
  rule: SocialRiskRule,
  countryId: string,
  sourceText: string
) {
  return priorCases
    .filter(
      (item) =>
        item.countryId === countryId &&
        (item.riskPatternIds ?? []).includes(rule.id) &&
        (item.triggerTerms ?? []).some((term) => normalizedIncludesAny(sourceText, [term]))
    )
    .map((item) => `social-context-case-${item.id}-${stableHash(sourceText)}`);
}

function buildMatch(input: {
  rule: SocialRiskRule;
  features: SocialContextFeatureSet;
  country: CountryFeatures;
  priorCases: PriorControversyCase[];
}): SocialContextMatch {
  const targetText = bestTargetText(input.features, input.country);
  const riskLevel = riskForRule(input.rule, input.features, input.country);
  const ruleEvidenceIds = evidenceIdsFor(input.rule, input.country.countryId, targetText);
  const caseEvidenceIds = matchedCaseIds(
    input.priorCases,
    input.rule,
    input.country.countryId,
    input.features.sourceText
  );

  return {
    id: `social-context-${input.country.countryId}-${input.rule.id}-${stableHash(targetText)}`,
    countryId: input.country.countryId,
    ruleId: input.rule.id,
    ruleName: input.rule.nameKo,
    riskLevel,
    suggestedAction: actionForRule(input.rule, riskLevel),
    targetText,
    matchedTerms: matchedAliases(input.country),
    matchedFinancialTerms: uniqueStrings(
      input.country.financialTerms.map((term) => term.item.labelKo)
    ),
    matchedSensitiveTerms: uniqueStrings([
      ...input.country.events.map((event) => event.item.nameKo),
      ...input.country.terms.map((term) => term.item.labelKo),
      ...input.country.symbols.map((symbol) => symbol.item.labelKo)
    ]),
    matchedDates: matchedDates(input.features, input.country),
    matchedPath: matchedPath(input.rule, input.country),
    rationale: rationale(input.rule, riskLevel, input.country),
    confidence: confidenceFor(input.rule, riskLevel, input.country),
    evidenceCandidateIds: [...ruleEvidenceIds, ...caseEvidenceIds],
    safeContextMatched: safeContextMatched(input.features, input.country.countryId)
  };
}

function dedupeMatches(matches: SocialContextMatch[]) {
  const byRuleAndCountry = new Map<string, SocialContextMatch>();

  for (const match of matches) {
    const key = `${match.countryId}:${match.ruleId}`;
    const previous = byRuleAndCountry.get(key);

    if (
      !previous ||
      match.confidence > previous.confidence ||
      riskRank(match.riskLevel) > riskRank(previous.riskLevel)
    ) {
      byRuleAndCountry.set(key, match);
    }
  }

  return [...byRuleAndCountry.values()].sort((left, right) => {
    const riskDelta = riskRank(right.riskLevel) - riskRank(left.riskLevel);

    return riskDelta === 0 ? right.confidence - left.confidence : riskDelta;
  });
}

export function evaluateSocialContextRules(input: {
  features: SocialContextFeatureSet;
  rules: SocialRiskRule[];
  priorControversyCases?: PriorControversyCase[];
}): SocialContextRiskResult {
  const countryIds = relevantCountryIds(input.features, input.rules);
  const matches: SocialContextMatch[] = [];

  for (const rule of input.rules) {
    for (const countryId of countryIds) {
      if (!rule.countryIds.includes(countryId)) {
        continue;
      }

      const country = countryFeatures(input.features, countryId);

      if (ruleConditionsMet(rule, input.features, country)) {
        matches.push(
          buildMatch({
            rule,
            features: input.features,
            country,
            priorCases: input.priorControversyCases ?? []
          })
        );
      }
    }
  }

  return { matches: dedupeMatches(matches) };
}
