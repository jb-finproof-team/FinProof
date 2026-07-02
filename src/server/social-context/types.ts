import type { ReviewCase, ReviewIssue, RiskLevel } from "@/domain/types";

export type SocialContextRiskLevel = RiskLevel;

export type SocialContextSuggestedAction = Extract<
  ReviewIssue["suggestedAction"],
  "approve" | "change_request" | "hold"
>;

export type SocialContextCountry = {
  countryId: string;
  nameKo: string;
  nameEn: string;
  nameLocal?: string;
  priorityForJB?: string;
  relationshipType?: string[];
  languages?: string[];
  businessRationale?: string;
  sourceRefs?: string[];
};

export type SocialContextNode = {
  id: string;
  countryId?: string;
  labelKo?: string;
  labelEn?: string;
  labelLocal?: string;
  aliases?: string[];
  nodeType?: string;
};

export type SocialContextEdge = {
  from: string;
  relation: string;
  to: string;
  weight?: number;
  countryId?: string;
  note?: string;
};

export type SensitiveEvent = {
  id: string;
  countryId: string;
  nameKo: string;
  nameEn: string;
  nameLocal?: string;
  aliases?: string[];
  dates?: string[];
  dateWindowDays?: number;
  eventType?: string[];
  sensitivityLevel?: SocialContextRiskLevel;
  contexts?: string[];
  stakeholderGroups?: string[];
  associatedTermIds?: string[];
  associatedSymbolIds?: string[];
  reviewPolicy?: string;
  sourceRefs?: string[];
};

export type SensitiveEventTerm = {
  id: string;
  countryId: string;
  labelKo: string;
  labelEn?: string;
  labelLocal?: string;
  aliases?: string[];
  termType: string;
  sensitivityLevel?: SocialContextRiskLevel;
  associatedEventIds?: string[];
  unsafeWhenUsedAsMetaphor?: boolean;
  unsafeContexts?: string[];
  safeContexts?: string[];
  sourceRefs?: string[];
};

export type SensitiveVisualSymbol = {
  id: string;
  countryId: string;
  labelKo: string;
  labelEn?: string;
  labelLocal?: string;
  aliases?: string[];
  symbolType: string;
  sensitivityLevel?: SocialContextRiskLevel;
  associatedEventIds?: string[];
  unsafeContexts?: string[];
  safeContexts?: string[];
  sourceRefs?: string[];
};

export type FinancialPromoTerm = {
  id: string;
  labelKo: string;
  labelEn?: string;
  aliases?: string[];
  category?: string;
  productTypes?: string[];
};

export type CampaignIntent = {
  id: string;
  labelKo: string;
  aliases?: string[];
  commercialityWeight?: number;
};

export type SocialRiskRuleConditions = {
  dateMatchesSensitiveEvent?: boolean;
  containsSensitiveTermTypeAny?: string[];
  containsTermTypeAny?: string[];
  containsSymbolTypeAny?: string[];
  containsFinancialPromoTerm?: boolean;
  campaignIntentAnyOf?: string[];
  safeCulturalContext?: boolean;
  safeOfficialRespectContext?: boolean;
  marketingMaterialHasMapOrFlag?: boolean;
  symbolDistortedOrUsedAsPriceTag?: boolean;
  eventTypeAny?: string[];
  containsNoSacredMockery?: boolean;
};

export type SocialRiskRule = {
  id: string;
  nameKo: string;
  countryIds: string[];
  conditions: SocialRiskRuleConditions;
  riskLevel: SocialContextRiskLevel;
  suggestedAction: SocialContextSuggestedAction;
  rationaleTemplate: string;
  examples?: string[];
};

export type SafeContext = {
  id: string;
  countryId: string;
  text: string;
  expectedRisk: SocialContextRiskLevel;
  reason: string;
};

export type PriorControversyCase = {
  id: string;
  countryId: string;
  title: string;
  triggerTerms?: string[];
  riskPatternIds?: string[];
  lesson: string;
  recommendedAction?: SocialContextSuggestedAction;
  sourceRefs?: string[];
};

export type SocialContextKgSeedData = {
  countries: SocialContextCountry[];
  sensitiveEvents: SensitiveEvent[];
  sensitiveEventTerms: SensitiveEventTerm[];
  sensitiveVisualSymbols: SensitiveVisualSymbol[];
  financialPromoTerms: FinancialPromoTerm[];
  campaignIntents: CampaignIntent[];
  socialKgEdges: SocialContextEdge[];
  socialRiskRules: SocialRiskRule[];
  safeContexts: SafeContext[];
  priorControversyCases: PriorControversyCase[];
  testCases: SocialContextTestCase[];
};

export type SocialContextDetectedItem<T> = {
  item: T;
  matchedAlias: string;
  sourceText: string;
};

export type SocialContextFeatureSet = {
  plannedPublishMonthDay?: string;
  detectedCountryIds: string[];
  detectedSensitiveEvents: Array<SocialContextDetectedItem<SensitiveEvent>>;
  detectedSensitiveTerms: Array<SocialContextDetectedItem<SensitiveEventTerm>>;
  detectedFinancialPromoTerms: Array<SocialContextDetectedItem<FinancialPromoTerm>>;
  detectedVisualSymbolsByTextAlias: Array<SocialContextDetectedItem<SensitiveVisualSymbol>>;
  detectedCampaignIntent: Array<SocialContextDetectedItem<CampaignIntent>>;
  safeContextHints: Array<SocialContextDetectedItem<SafeContext>>;
  candidateTargetTexts: string[];
  sourceText: string;
};

export type SocialContextMatch = {
  id: string;
  countryId: string;
  ruleId: string;
  ruleName: string;
  riskLevel: SocialContextRiskLevel;
  suggestedAction: SocialContextSuggestedAction;
  targetText: string;
  matchedTerms: string[];
  matchedFinancialTerms: string[];
  matchedSensitiveTerms: string[];
  matchedDates: string[];
  matchedPath: string;
  rationale: string;
  confidence: number;
  evidenceCandidateIds: string[];
  safeContextMatched: boolean;
};

export type SocialContextRiskResult = {
  matches: SocialContextMatch[];
};

export type SocialContextTestCase = {
  id: string;
  countryId: string;
  plannedPublishDate: string;
  text: string;
  productType: ReviewCase["productType"] | "remittance" | string;
  channelType: string[];
  expectedRiskLevel: SocialContextRiskLevel;
  expectedSuggestedAction: SocialContextSuggestedAction;
  expectedMatchedRuleIds: string[];
  reason?: string;
};
