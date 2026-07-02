const LATIN_OR_DIGIT = /[a-z0-9]/i;
const NON_LATIN_SCRIPT =
  /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Thai}]/u;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeSocialContextText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[!?.,;:]{2,}/g, (match) => match[0] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function isNonLatinScriptAlias(alias: string) {
  return NON_LATIN_SCRIPT.test(alias);
}

function hasLatinBoundary(text: string, start: number, end: number) {
  const before = start > 0 ? text[start - 1] : "";
  const after = end < text.length ? text[end] : "";

  return !LATIN_OR_DIGIT.test(before) && !LATIN_OR_DIGIT.test(after);
}

export function isMeaningfulAlias(alias: string) {
  const normalized = normalizeSocialContextText(alias);

  if (!normalized) {
    return false;
  }

  if (isNonLatinScriptAlias(normalized)) {
    return normalized.length >= 2;
  }

  return normalized.replace(/[^a-z0-9]/gi, "").length >= 2;
}

export function findAliasMatch(text: string, alias: string): string | undefined {
  if (!isMeaningfulAlias(alias)) {
    return undefined;
  }

  const normalizedText = normalizeSocialContextText(text);
  const normalizedAlias = normalizeSocialContextText(alias);

  if (!normalizedText || !normalizedAlias) {
    return undefined;
  }

  if (isNonLatinScriptAlias(normalizedAlias)) {
    return normalizedText.includes(normalizedAlias) ? alias : undefined;
  }

  const pattern = new RegExp(escapeRegExp(normalizedAlias), "giu");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(normalizedText))) {
    if (hasLatinBoundary(normalizedText, match.index, match.index + normalizedAlias.length)) {
      return alias;
    }
  }

  return undefined;
}

export function matchesAnyAlias(text: string, aliases: string[] = []): string | undefined {
  const sortedAliases = [...aliases]
    .filter(isMeaningfulAlias)
    .sort((left, right) => right.length - left.length);

  return sortedAliases.find((alias) => findAliasMatch(text, alias));
}

export function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function compactTargetText(value: string, maxLength = 180) {
  const normalized = value.replace(/\s+/g, " ").trim();

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}
