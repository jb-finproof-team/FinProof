import type { ReviewCase } from "@/domain/types";
import type { ExtractedDocument } from "@/server/analysis/review-analysis-pipeline";
import {
  compactTargetText,
  matchesAnyAlias,
  normalizeSocialContextText,
  uniqueStrings
} from "./normalize";
import type {
  CampaignIntent,
  FinancialPromoTerm,
  SafeContext,
  SensitiveEvent,
  SensitiveEventTerm,
  SensitiveVisualSymbol,
  SocialContextCountry,
  SocialContextDetectedItem,
  SocialContextFeatureSet,
  SocialContextKgSeedData
} from "./types";

type ReviewLike = Pick<
  ReviewCase,
  | "title"
  | "affiliate"
  | "productType"
  | "channelType"
  | "plannedPublishDate"
  | "promotionalCopy"
  | "disclosure"
  | "productDescription"
>;

const AFFILIATE_COUNTRIES: Array<{ pattern: RegExp; countryId: string }> = [
  { pattern: /ppc\s?bank|캄보디아|cambodia/i, countryId: "cambodia" },
  { pattern: /vietnam|베트남/i, countryId: "vietnam" },
  { pattern: /myanmar|미얀마/i, countryId: "myanmar" },
  { pattern: /china|중국/i, countryId: "china" },
  { pattern: /thailand|태국/i, countryId: "thailand" }
];

const EXTRA_PROMOTION_ALIASES = [
  "광고",
  "배너",
  "이벤트",
  "혜택",
  "프로모션",
  "campaign",
  "banner",
  "ad",
  "advertisement"
];

function aliasesFromRecord(...values: Array<string | string[] | undefined>) {
  return uniqueStrings(
    values
      .flatMap((value) => (Array.isArray(value) ? value : value ? [value] : []))
      .flatMap(expandAlias)
  );
}

function expandAlias(value: string) {
  const normalized = value.trim();

  if (!normalized) {
    return [];
  }

  const splitParts = normalized
    .split(/\s*(?:\/|·|\||,|;)\s*/g)
    .map((part) => part.replace(/^[([{]+|[)\]}]+$/g, "").trim())
    .filter(Boolean);

  return uniqueStrings([normalized, ...splitParts]);
}

function monthDayFromDate(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const match = value.match(/(?:^|\D)(\d{1,2})-(\d{1,2})(?:\D|$)/);

  if (!match) {
    return undefined;
  }

  const month = Number(match[1]);
  const day = Number(match[2]);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined;
  }

  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function textPieces(review: ReviewLike, extractedDocuments: ExtractedDocument[]) {
  return [
    review.title,
    review.promotionalCopy,
    review.disclosure,
    review.productDescription,
    review.affiliate,
    review.productType,
    ...review.channelType,
    ...extractedDocuments.map((document) => document.text)
  ].filter((text): text is string => typeof text === "string" && text.trim().length > 0);
}

function joinedSourceText(review: ReviewLike, extractedDocuments: ExtractedDocument[]) {
  return textPieces(review, extractedDocuments).join("\n");
}

function candidateTargetTexts(review: ReviewLike, extractedDocuments: ExtractedDocument[]) {
  const pieces = [
    review.promotionalCopy,
    review.title,
    review.productDescription,
    review.disclosure,
    ...extractedDocuments.map((document) => document.text)
  ]
    .map((text) => compactTargetText(text, 220))
    .filter(Boolean);

  return uniqueStrings(pieces).slice(0, 6);
}

function detectCountryIds(
  review: ReviewLike,
  sourceText: string,
  countries: SocialContextCountry[]
) {
  const countryIds = new Set<string>();
  const reviewContext = `${review.affiliate} ${review.title} ${sourceText}`;

  for (const mapping of AFFILIATE_COUNTRIES) {
    if (mapping.pattern.test(reviewContext)) {
      countryIds.add(mapping.countryId);
    }
  }

  for (const country of countries) {
    const matchedAlias = matchesAnyAlias(
      reviewContext,
      aliasesFromRecord(country.countryId, country.nameKo, country.nameEn, country.nameLocal)
    );

    if (matchedAlias) {
      countryIds.add(country.countryId);
    }
  }

  return [...countryIds];
}

function detectByAlias<T>(
  items: T[],
  aliasesForItem: (item: T) => string[],
  sourceText: string
): Array<SocialContextDetectedItem<T>> {
  return items
    .map((item) => {
      const matchedAlias = matchesAnyAlias(sourceText, aliasesForItem(item));

      return matchedAlias ? { item, matchedAlias, sourceText } : undefined;
    })
    .filter((item): item is SocialContextDetectedItem<T> => Boolean(item));
}

function financialAliases(term: FinancialPromoTerm) {
  return aliasesFromRecord(term.labelKo, term.labelEn, term.aliases);
}

function detectFinancialTerms(review: ReviewLike, sourceText: string, terms: FinancialPromoTerm[]) {
  const productType = String(review.productType);

  return terms
    .map((term) => {
      const aliases = financialAliases(term);
      const matchedAlias = matchesAnyAlias(sourceText, aliases);
      const productTypeMatched =
        term.productTypes?.includes("all") || term.productTypes?.includes(productType);

      if (!matchedAlias && !productTypeMatched) {
        return undefined;
      }

      return {
        item: term,
        matchedAlias: matchedAlias ?? productType,
        sourceText
      };
    })
    .filter((item): item is SocialContextDetectedItem<FinancialPromoTerm> => Boolean(item));
}

function detectCampaignIntent(
  sourceText: string,
  intents: CampaignIntent[],
  financialTerms: Array<SocialContextDetectedItem<FinancialPromoTerm>>
) {
  const detected = detectByAlias(
    intents,
    (intent) => aliasesFromRecord(intent.id, intent.labelKo, intent.aliases),
    sourceText
  );

  if (
    financialTerms.length > 0 &&
    !detected.some((intent) => intent.item.id === "financial_product_ad")
  ) {
    const financialIntent = intents.find((intent) => intent.id === "financial_product_ad");

    if (financialIntent) {
      detected.push({
        item: financialIntent,
        matchedAlias: financialTerms[0]?.matchedAlias ?? "financial_product_ad",
        sourceText
      });
    }
  }

  if (
    matchesAnyAlias(sourceText, EXTRA_PROMOTION_ALIASES) &&
    !detected.some((intent) => intent.item.id === "promotion")
  ) {
    const promotion = intents.find((intent) => intent.id === "promotion");

    if (promotion) {
      detected.push({ item: promotion, matchedAlias: "promotion", sourceText });
    }
  }

  return detected;
}

function detectEvents(
  events: SensitiveEvent[],
  sourceText: string,
  detectedTerms: Array<SocialContextDetectedItem<SensitiveEventTerm>>,
  detectedSymbols: Array<SocialContextDetectedItem<SensitiveVisualSymbol>>
) {
  const detectedEventIds = new Set<string>();
  const results: Array<SocialContextDetectedItem<SensitiveEvent>> = [];
  const termEventIds = detectedTerms.flatMap((term) => term.item.associatedEventIds ?? []);
  const symbolEventIds = detectedSymbols.flatMap((symbol) => symbol.item.associatedEventIds ?? []);

  for (const event of events) {
    const matchedAlias = matchesAnyAlias(
      sourceText,
      aliasesFromRecord(event.nameKo, event.nameEn, event.nameLocal, event.aliases, event.contexts)
    );
    const associatedMatch =
      termEventIds.includes(event.id) ||
      symbolEventIds.includes(event.id) ||
      detectedTerms.some((term) => event.associatedTermIds?.includes(term.item.id)) ||
      detectedSymbols.some((symbol) => event.associatedSymbolIds?.includes(symbol.item.id));

    if (!matchedAlias && !associatedMatch) {
      continue;
    }

    detectedEventIds.add(event.id);
    results.push({
      item: event,
      matchedAlias:
        matchedAlias ??
        detectedTerms.find((term) => event.associatedTermIds?.includes(term.item.id))
          ?.matchedAlias ??
        detectedSymbols.find((symbol) => event.associatedSymbolIds?.includes(symbol.item.id))
          ?.matchedAlias ??
        event.nameKo,
      sourceText
    });
  }

  return results.filter((event, index) => {
    const firstIndex = results.findIndex((candidate) => candidate.item.id === event.item.id);
    return firstIndex === index && detectedEventIds.has(event.item.id);
  });
}

function safeContextScore(normalizedSource: string, safeContext: SafeContext) {
  const terms = normalizeSocialContextText(safeContext.text)
    .split(/[\s()[\]{}"'`.,:;!?/|]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);

  if (terms.length === 0) {
    return 0;
  }

  const matchedTerms = terms.filter((term) => normalizedSource.includes(term));

  return matchedTerms.length / terms.length;
}

function detectSafeContexts(sourceText: string, safeContexts: SafeContext[]) {
  const normalizedSource = normalizeSocialContextText(sourceText);

  return safeContexts
    .map((context) => {
      const matchedAlias = matchesAnyAlias(sourceText, [context.text]);

      if (matchedAlias || safeContextScore(normalizedSource, context) >= 0.45) {
        return {
          item: context,
          matchedAlias: matchedAlias ?? context.text,
          sourceText
        };
      }

      return undefined;
    })
    .filter((item): item is SocialContextDetectedItem<SafeContext> => Boolean(item));
}

function restrictByCountry<T extends { countryId: string }>(
  items: T[],
  countryIds: string[],
  fallbackToAll = true
) {
  if (countryIds.length === 0) {
    return fallbackToAll ? items : [];
  }

  return items.filter((item) => countryIds.includes(item.countryId));
}

function countriesFromDetectedItems(
  features: Pick<
    SocialContextFeatureSet,
    "detectedSensitiveEvents" | "detectedSensitiveTerms" | "detectedVisualSymbolsByTextAlias"
  >
) {
  return uniqueStrings([
    ...features.detectedSensitiveEvents.map((event) => event.item.countryId),
    ...features.detectedSensitiveTerms.map((term) => term.item.countryId),
    ...features.detectedVisualSymbolsByTextAlias.map((symbol) => symbol.item.countryId)
  ]);
}

export function extractSocialContextFeatures(input: {
  review: ReviewLike;
  extractedDocuments: ExtractedDocument[];
  seedData: SocialContextKgSeedData;
}): SocialContextFeatureSet {
  const sourceText = joinedSourceText(input.review, input.extractedDocuments);
  const initialCountryIds = detectCountryIds(input.review, sourceText, input.seedData.countries);
  const sensitiveTerms = detectByAlias(
    restrictByCountry(input.seedData.sensitiveEventTerms, initialCountryIds),
    (term) => aliasesFromRecord(term.labelKo, term.labelEn, term.labelLocal, term.aliases),
    sourceText
  );
  const visualSymbols = detectByAlias(
    restrictByCountry(input.seedData.sensitiveVisualSymbols, initialCountryIds),
    (symbol) =>
      aliasesFromRecord(symbol.labelKo, symbol.labelEn, symbol.labelLocal, symbol.aliases),
    sourceText
  );
  const events = detectEvents(
    restrictByCountry(input.seedData.sensitiveEvents, initialCountryIds),
    sourceText,
    sensitiveTerms,
    visualSymbols
  );
  const detectedCountryIds = uniqueStrings([
    ...initialCountryIds,
    ...countriesFromDetectedItems({
      detectedSensitiveEvents: events,
      detectedSensitiveTerms: sensitiveTerms,
      detectedVisualSymbolsByTextAlias: visualSymbols
    })
  ]);
  const financialTerms = detectFinancialTerms(
    input.review,
    sourceText,
    input.seedData.financialPromoTerms
  );
  const campaignIntents = detectCampaignIntent(
    sourceText,
    input.seedData.campaignIntents,
    financialTerms
  );

  return {
    plannedPublishMonthDay: monthDayFromDate(input.review.plannedPublishDate),
    detectedCountryIds,
    detectedSensitiveEvents: events,
    detectedSensitiveTerms: sensitiveTerms,
    detectedFinancialPromoTerms: financialTerms,
    detectedVisualSymbolsByTextAlias: visualSymbols,
    detectedCampaignIntent: campaignIntents,
    safeContextHints: detectSafeContexts(
      sourceText,
      restrictByCountry(input.seedData.safeContexts, detectedCountryIds)
    ),
    candidateTargetTexts: candidateTargetTexts(input.review, input.extractedDocuments),
    sourceText
  };
}
