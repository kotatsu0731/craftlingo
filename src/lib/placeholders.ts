// A space is technically a valid printf flag, but treating it as one makes
// ordinary percentages such as `100% complete` look like the `% c` conversion.
// Minecraft translation strings use the remaining printf flags; `%s`, indexed
// `%1$s`, and `%%` continue to be recognized.
const PLACEHOLDER_PATTERN = /%(?:\d+\$)?[-#+0,(<]*\d*(?:\.\d+)?[a-zA-Z%]|\{\d+(?:,[^{}]+)?\}|§[0-9a-fk-or]|\\[nrt]/gi;

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
