const PLACEHOLDER_PATTERN = /%(?:\d+\$)?[-#+ 0,(<]*\d*(?:\.\d+)?[a-zA-Z%]|\{\d+(?:,[^{}]+)?\}|§[0-9a-fk-or]|\\[nrt]/gi;

export function extractPlaceholders(value: string): string[] {
  return value.match(PLACEHOLDER_PATTERN) ?? [];
}

export function validatePlaceholders(source: string, translated: string): boolean {
  const sourceTokens = extractPlaceholders(source).sort();
  const translatedTokens = extractPlaceholders(translated).sort();

  return (
    sourceTokens.length === translatedTokens.length &&
    sourceTokens.every((token, index) => token === translatedTokens[index])
  );
}

export function categoryFromKey(key: string): string {
  const category = key.split(".")[0]?.toLowerCase();
  return category || "other";
}
