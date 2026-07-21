import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

export type StringDictionary = Record<string, string>;

export type ModLoader =
  | "fabric"
  | "quilt"
  | "forge"
  | "neoforge"
  | "legacy"
  | "unknown";

export interface ModMetadata {
  loader: ModLoader;
  modId?: string;
  name?: string;
  version?: string;
  minecraftVersion?: string;
}

export interface ParsedMod {
  jarPath: string;
  jarName: string;
  namespaces: string[];
  metadata: ModMetadata;
  icon?: {
    bytes: Uint8Array;
    mimeType: string;
  };
}

/** A single namespace as it appeared in a single JAR. */
export interface ModTranslationSource {
  jarPath: string;
  jarName: string;
  namespace: string;
  englishPath?: string;
  japanesePath?: string;
  entries: StringDictionary;
  existingJapanese: StringDictionary;
}

/** Entries merged from every JAR that provides the namespace. */
export interface NamespaceTranslations {
  namespace: string;
  entries: StringDictionary;
  existingJapanese: StringDictionary;
  jarPaths: string[];
}

export type ArchiveWarningCode =
  | "INVALID_OUTER_ZIP"
  | "INVALID_JAR"
  | "INVALID_LANGUAGE_FILE"
  | "DUPLICATE_NAMESPACE_KEY";

export interface ArchiveWarning {
  code: ArchiveWarningCode;
  message: string;
  path?: string;
}

export interface ParsedModpack {
  mods: ParsedMod[];
  sources: ModTranslationSource[];
  namespaces: Record<string, NamespaceTranslations>;
  warnings: ArchiveWarning[];
}

/** A JAR supplied directly by the user, with its path relative to the input root. */
export interface ModJarInput {
  path: string;
  bytes: Uint8Array | ArrayBuffer;
}

export type JapaneseTranslations = Record<string, StringDictionary>;

export interface ResourcePackOptions {
  /** Minecraft resource-pack format. Defaults to 34 (Minecraft 1.21). */
  packFormat?: number;
  description?: string;
  /** Number of spaces used in generated JSON. Defaults to 2. */
  jsonIndent?: number;
  /** Only include translation keys belonging to these JAR paths. Defaults to every parsed JAR. */
  selectedJarPaths?: readonly string[];
  /** Include unchanged Japanese translations bundled with the selected MODs. Defaults to false. */
  includeBuiltinTranslations?: boolean;
  /** PNG bytes to use for pack.png instead of the built-in icon. */
  iconBytes?: Uint8Array;
}

interface LanguageCandidate {
  path: string;
  format: "json" | "lang";
  values: StringDictionary;
}

interface NamespaceCandidates {
  english: LanguageCandidate[];
  japanese: LanguageCandidate[];
}

const LANGUAGE_PATH = /^assets\/([^/]+)\/lang\/(en_us|ja_jp)\.(json|lang)$/i;

// A tiny 16x16 pixel-art translation icon. Keeping it inline avoids another
// network request and makes every generated pack self-contained.
const DEFAULT_PACK_ICON = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 16,
  0, 0, 0, 16, 8, 6, 0, 0, 0, 31, 243, 255, 97, 0, 0, 0, 93, 73, 68, 65, 84,
  120, 218, 99, 16, 146, 80, 251, 79, 9, 6, 27, 32, 83, 86, 64, 22, 70, 49, 64,
  105, 110, 255, 255, 135, 183, 182, 18, 133, 65, 106, 113, 26, 240, 243, 203,
  45, 188, 152, 62, 6, 104, 68, 79, 131, 99, 146, 13, 64, 215, 132, 206, 39,
  202, 0, 116, 76, 127, 23, 160, 27, 176, 207, 217, 6, 142, 201, 118, 1, 72,
  51, 217, 209, 8, 211, 76, 148, 11, 40, 78, 7, 100, 39, 101, 138, 50, 19, 37,
  24, 0, 28, 115, 129, 43, 183, 169, 164, 9, 0, 0, 0, 0, 73, 69, 78, 68, 174,
  66, 96, 130,
]);

function emptyDictionary(): StringDictionary {
  return Object.create(null) as StringDictionary;
}

function asBytes(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function baseName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function valueAsString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function firstVersion(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value.map(valueAsString).find(Boolean);
  }
  return valueAsString(value);
}

function parseFabricMetadata(bytes: Uint8Array): ModMetadata | undefined {
  try {
    const value = JSON.parse(strFromU8(bytes)) as Record<string, unknown>;
    const depends = value.depends as Record<string, unknown> | undefined;
    return {
      loader: "fabric",
      modId: valueAsString(value.id),
      name: valueAsString(value.name),
      version: valueAsString(value.version),
      minecraftVersion: firstVersion(depends?.minecraft),
    };
  } catch {
    return undefined;
  }
}

function parseQuiltMetadata(bytes: Uint8Array): ModMetadata | undefined {
  try {
    const root = JSON.parse(strFromU8(bytes)) as Record<string, unknown>;
    const loader = root.quilt_loader as Record<string, unknown> | undefined;
    if (!loader) return undefined;
    const metadata = loader.metadata as Record<string, unknown> | undefined;
    const depends = loader.depends as Array<Record<string, unknown>> | undefined;
    const minecraft = depends?.find((entry) => entry.id === "minecraft");
    return {
      loader: "quilt",
      modId: valueAsString(loader.id),
      name: valueAsString(metadata?.name),
      version: valueAsString(loader.version),
      minecraftVersion: firstVersion(minecraft?.versions),
    };
  } catch {
    return undefined;
  }
}

function tomlString(text: string, key: string): string | undefined {
  const match = text.match(
    new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "m"),
  );
  return match?.[1]?.trim() || undefined;
}

function parseTomlMetadata(
  bytes: Uint8Array,
  loader: "forge" | "neoforge",
): ModMetadata {
  const text = strFromU8(bytes);
  const minecraftDependency = text.match(
    /\[\[dependencies\.[^\]]+\]\][\s\S]*?modId\s*=\s*["']minecraft["'][\s\S]*?versionRange\s*=\s*["']([^"']+)["']/i,
  );
  return {
    loader,
    modId: tomlString(text, "modId"),
    name: tomlString(text, "displayName"),
    version: tomlString(text, "version"),
    minecraftVersion: minecraftDependency?.[1]?.trim() || undefined,
  };
}

function parseLegacyMetadata(bytes: Uint8Array): ModMetadata | undefined {
  try {
    const value = JSON.parse(strFromU8(bytes)) as unknown;
    const first = Array.isArray(value) ? value[0] : value;
    if (!first || typeof first !== "object") return undefined;
    const metadata = first as Record<string, unknown>;
    return {
      loader: "legacy",
      modId: valueAsString(metadata.modid),
      name: valueAsString(metadata.name),
      version: valueAsString(metadata.version),
      minecraftVersion: valueAsString(metadata.mcversion),
    };
  } catch {
    return undefined;
  }
}

function parseManifestMetadata(bytes: Uint8Array): ModMetadata | undefined {
  const unfolded = strFromU8(bytes).replace(/\r?\n /g, "");
  const fields = emptyDictionary();
  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      fields[line.slice(0, separator).trim().toLowerCase()] = line
        .slice(separator + 1)
        .trim();
    }
  }
  const name = fields["implementation-title"];
  const version = fields["implementation-version"];
  if (!name && !version) return undefined;
  return { loader: "unknown", name, version };
}

function findEntry(
  entries: Record<string, Uint8Array>,
  wantedPath: string,
): Uint8Array | undefined {
  const match = Object.entries(entries).find(
    ([path]) => canonicalArchivePath(path) === canonicalArchivePath(wantedPath),
  );
  return match?.[1];
}

function canonicalArchivePath(path: string): string {
  return normalizePath(path).replace(/^\/+/, "").toLowerCase();
}

function imageMimeType(path: string): string | undefined {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".png")) return "image/png";
  if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lowerPath.endsWith(".gif")) return "image/gif";
  if (lowerPath.endsWith(".webp")) return "image/webp";
  return undefined;
}

function fabricIconPath(bytes: Uint8Array): string | undefined {
  try {
    const value = JSON.parse(strFromU8(bytes)) as Record<string, unknown>;
    if (typeof value.icon === "string" && value.icon.trim()) {
      return value.icon.trim();
    }
    if (!value.icon || typeof value.icon !== "object" || Array.isArray(value.icon)) {
      return undefined;
    }

    return Object.entries(value.icon as Record<string, unknown>)
      .flatMap(([size, path]) => {
        const numericSize = Number(size);
        return Number.isFinite(numericSize) && typeof path === "string" && path.trim()
          ? [{ size: numericSize, path: path.trim() }]
          : [];
      })
      .sort((left, right) => right.size - left.size)[0]?.path;
  } catch {
    return undefined;
  }
}

function iconAtPath(
  entries: Record<string, Uint8Array>,
  path: string | undefined,
): ParsedMod["icon"] {
  if (!path) return undefined;
  const mimeType = imageMimeType(path);
  if (!mimeType) return undefined;
  const bytes = findEntry(entries, path);
  return bytes ? { bytes, mimeType } : undefined;
}

function extractIcon(entries: Record<string, Uint8Array>): ParsedMod["icon"] {
  const fabric = findEntry(entries, "fabric.mod.json");
  const neoforge = findEntry(entries, "META-INF/neoforge.mods.toml");
  const forge = findEntry(entries, "META-INF/mods.toml");
  const declaredPaths = [
    fabric ? fabricIconPath(fabric) : undefined,
    neoforge ? tomlString(strFromU8(neoforge), "logoFile") : undefined,
    forge ? tomlString(strFromU8(forge), "logoFile") : undefined,
  ];

  for (const path of declaredPaths) {
    const icon = iconAtPath(entries, path);
    if (icon) return icon;
  }

  const sortedPaths = Object.keys(entries).sort((left, right) =>
    canonicalArchivePath(left).localeCompare(canonicalArchivePath(right)),
  );
  for (const wantedName of ["icon.png", "logo.png"]) {
    const path = sortedPaths.find(
      (candidate) => baseName(candidate).toLowerCase() === wantedName,
    );
    const icon = iconAtPath(entries, path);
    if (icon) return icon;
  }
  return undefined;
}

function extractMetadata(entries: Record<string, Uint8Array>): ModMetadata {
  const fabric = findEntry(entries, "fabric.mod.json");
  if (fabric) {
    const parsed = parseFabricMetadata(fabric);
    if (parsed) return parsed;
  }

  const quilt = findEntry(entries, "quilt.mod.json");
  if (quilt) {
    const parsed = parseQuiltMetadata(quilt);
    if (parsed) return parsed;
  }

  const neoforge = findEntry(entries, "META-INF/neoforge.mods.toml");
  if (neoforge) return parseTomlMetadata(neoforge, "neoforge");

  const forge = findEntry(entries, "META-INF/mods.toml");
  if (forge) return parseTomlMetadata(forge, "forge");

  const legacy = findEntry(entries, "mcmod.info");
  if (legacy) {
    const parsed = parseLegacyMetadata(legacy);
    if (parsed) return parsed;
  }

  const manifest = findEntry(entries, "META-INF/MANIFEST.MF");
  return manifest ? parseManifestMetadata(manifest) ?? { loader: "unknown" } : { loader: "unknown" };
}

function decodePropertiesEscape(value: string): string {
  return value.replace(/\\u([\da-fA-F]{4})|\\(.)/g, (_match, unicode, escaped) => {
    if (unicode) return String.fromCharCode(Number.parseInt(unicode, 16));
    switch (escaped) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "f":
        return "\f";
      default:
        return escaped;
    }
  });
}

function findUnescapedSeparator(line: string): number {
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (!escaped && (character === "=" || character === ":")) return index;
    if (!escaped && /\s/.test(character)) return index;
    if (character === "\\") escaped = !escaped;
    else escaped = false;
  }
  return -1;
}

/** Parse the Java-properties subset used by legacy Minecraft `.lang` files. */
export function parseLegacyLang(text: string): StringDictionary {
  const result = emptyDictionary();
  const logicalLines: string[] = [];
  let pending = "";

  for (const physicalLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = pending + physicalLine;
    const trailingSlashes = line.match(/\\+$/)?.[0].length ?? 0;
    if (trailingSlashes % 2 === 1) {
      pending = line.slice(0, -1);
    } else {
      logicalLines.push(line);
      pending = "";
    }
  }
  if (pending) logicalLines.push(pending);

  for (const rawLine of logicalLines) {
    const line = rawLine.trimStart();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const separator = findUnescapedSeparator(line);
    if (separator < 0) {
      result[decodePropertiesEscape(line.trim())] = "";
      continue;
    }
    const rawKey = line.slice(0, separator).trimEnd();
    const rawValue = line.slice(separator).replace(/^[\s:=]+/, "");
    result[decodePropertiesEscape(rawKey)] = decodePropertiesEscape(rawValue);
  }
  return result;
}

function parseJsonLanguage(text: string): StringDictionary {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("language JSON must be an object");
  }
  const result = emptyDictionary();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`language value for ${JSON.stringify(key)} must be a string`);
    }
    result[key] = value;
  }
  return result;
}

function mergeCandidates(candidates: LanguageCandidate[]): {
  values: StringDictionary;
  preferredPath?: string;
} {
  const result = emptyDictionary();
  const sorted = [...candidates].sort((left, right) => {
    const formatOrder = Number(left.format === "json") - Number(right.format === "json");
    return formatOrder || left.path.localeCompare(right.path);
  });
  for (const candidate of sorted) Object.assign(result, candidate.values);
  return {
    values: result,
    preferredPath: sorted.at(-1)?.path,
  };
}

function addMergedEntries(
  target: StringDictionary,
  incoming: StringDictionary,
  namespace: string,
  jarPath: string,
  warnings: ArchiveWarning[],
): void {
  for (const [key, value] of Object.entries(incoming)) {
    if (Object.hasOwn(target, key) && target[key] !== value) {
      warnings.push({
        code: "DUPLICATE_NAMESPACE_KEY",
        message: `Namespace ${namespace} contains conflicting values for ${key}; keeping the first value.`,
        path: jarPath,
      });
      continue;
    }
    target[key] = value;
  }
}

function emptyParsedModpack(): ParsedModpack {
  return {
    mods: [],
    sources: [],
    namespaces: Object.create(null) as Record<string, NamespaceTranslations>,
    warnings: [],
  };
}

/**
 * Rebuild aggregate namespaces from per-JAR sources. Duplicate warnings are
 * deliberately recalculated because adding or removing a JAR can change both
 * the winning value and whether a conflict exists at all.
 */
export function rebuildParsedModpack(
  mods: readonly ParsedMod[],
  sources: readonly ModTranslationSource[],
  warnings: readonly ArchiveWarning[] = [],
): ParsedModpack {
  const result = emptyParsedModpack();
  result.mods = [...mods];
  result.sources = [...sources];
  result.warnings = warnings.filter(({ code }) => code !== "DUPLICATE_NAMESPACE_KEY");

  for (const source of result.sources) {
    const aggregate = result.namespaces[source.namespace] ?? {
      namespace: source.namespace,
      entries: emptyDictionary(),
      existingJapanese: emptyDictionary(),
      jarPaths: [],
    };
    addMergedEntries(
      aggregate.entries,
      source.entries,
      source.namespace,
      source.jarPath,
      result.warnings,
    );
    addMergedEntries(
      aggregate.existingJapanese,
      source.existingJapanese,
      source.namespace,
      source.jarPath,
      result.warnings,
    );
    if (!aggregate.jarPaths.includes(source.jarPath)) {
      aggregate.jarPaths.push(source.jarPath);
    }
    result.namespaces[source.namespace] = aggregate;
  }

  return result;
}

/** Merge newly parsed JARs into an existing workspace. */
export function mergeParsedModpacks(
  current: ParsedModpack,
  incoming: ParsedModpack,
): ParsedModpack {
  return rebuildParsedModpack(
    [...current.mods, ...incoming.mods],
    [...current.sources, ...incoming.sources],
    [...current.warnings, ...incoming.warnings],
  );
}

function warningBelongsToJar(warning: ArchiveWarning, jarPath: string): boolean {
  return warning.path === jarPath || warning.path?.startsWith(`${jarPath}!/`) === true;
}

/** Remove one JAR and every aggregate value or warning derived from it. */
export function removeModFromParsedModpack(
  parsed: ParsedModpack,
  jarPath: string,
): ParsedModpack {
  return rebuildParsedModpack(
    parsed.mods.filter((mod) => mod.jarPath !== jarPath),
    parsed.sources.filter((source) => source.jarPath !== jarPath),
    parsed.warnings.filter((warning) => !warningBelongsToJar(warning, jarPath)),
  );
}

/**
 * Extract translations from one or more JARs. Paths are kept in metadata and
 * warnings so callers can preserve a selected folder's relative structure.
 */
export function parseModJarFiles(inputs: readonly ModJarInput[]): ParsedModpack {
  const result = emptyParsedModpack();
  const jars = [...inputs].sort((left, right) =>
    normalizePath(left.path).localeCompare(normalizePath(right.path)),
  );

  for (const jar of jars) {
    const jarPath = normalizePath(jar.path);
    let jarEntries: Record<string, Uint8Array>;
    try {
      jarEntries = unzipSync(asBytes(jar.bytes));
    } catch (error) {
      result.warnings.push({
        code: "INVALID_JAR",
        message: `Could not read ${jarPath}: ${error instanceof Error ? error.message : String(error)}`,
        path: jarPath,
      });
      continue;
    }

    const byNamespace = new Map<string, NamespaceCandidates>();
    for (const [rawPath, bytes] of Object.entries(jarEntries).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const path = normalizePath(rawPath);
      const match = path.match(LANGUAGE_PATH);
      if (!match) continue;
      const [, rawNamespace, rawLocale, rawFormat] = match;
      const namespace = rawNamespace.toLowerCase();
      const locale = rawLocale.toLowerCase();
      const format = rawFormat.toLowerCase() as "json" | "lang";

      let values: StringDictionary;
      try {
        const text = strFromU8(bytes).replace(/^\uFEFF/, "");
        values = format === "json" ? parseJsonLanguage(text) : parseLegacyLang(text);
      } catch (error) {
        result.warnings.push({
          code: "INVALID_LANGUAGE_FILE",
          message: `Could not parse ${path} in ${jarPath}: ${error instanceof Error ? error.message : String(error)}`,
          path: `${jarPath}!/${path}`,
        });
        continue;
      }

      const candidates = byNamespace.get(namespace) ?? { english: [], japanese: [] };
      candidates[locale === "en_us" ? "english" : "japanese"].push({
        path,
        format,
        values,
      });
      byNamespace.set(namespace, candidates);
    }

    const namespaces = [...byNamespace.keys()].sort();
    const metadata = extractMetadata(jarEntries);
    result.mods.push({
      jarPath,
      jarName: baseName(jarPath),
      namespaces,
      metadata,
      icon: extractIcon(jarEntries),
    });

    for (const namespace of namespaces) {
      const candidates = byNamespace.get(namespace)!;
      const english = mergeCandidates(candidates.english);
      const japanese = mergeCandidates(candidates.japanese);
      const source: ModTranslationSource = {
        jarPath,
        jarName: baseName(jarPath),
        namespace,
        englishPath: english.preferredPath,
        japanesePath: japanese.preferredPath,
        entries: english.values,
        existingJapanese: japanese.values,
      };
      result.sources.push(source);

      const aggregate = result.namespaces[namespace] ?? {
        namespace,
        entries: emptyDictionary(),
        existingJapanese: emptyDictionary(),
        jarPaths: [],
      };
      addMergedEntries(aggregate.entries, source.entries, namespace, jarPath, result.warnings);
      addMergedEntries(
        aggregate.existingJapanese,
        source.existingJapanese,
        namespace,
        jarPath,
        result.warnings,
      );
      aggregate.jarPaths.push(jarPath);
      result.namespaces[namespace] = aggregate;
    }
  }

  return result;
}

/**
 * Extract translation files from a ZIP containing one or more mod JARs.
 *
 * The function is synchronous and has no browser or filesystem dependencies,
 * which makes it safe to run inside a Web Worker.
 */
export function parseModpackArchive(
  input: Uint8Array | ArrayBuffer,
): ParsedModpack {
  let outerEntries: Record<string, Uint8Array>;
  try {
    outerEntries = unzipSync(asBytes(input));
  } catch (error) {
    const result = emptyParsedModpack();
    result.warnings.push({
      code: "INVALID_OUTER_ZIP",
      message: `Could not read the input ZIP: ${error instanceof Error ? error.message : String(error)}`,
    });
    return result;
  }

  const jars = Object.entries(outerEntries)
    .filter(([path]) => normalizePath(path).toLowerCase().endsWith(".jar"))
    .map(([path, bytes]) => ({ path, bytes }));

  return parseModJarFiles(jars);
}

/** Build one Japanese resource pack for the selected per-JAR translation sources. */
export function buildJapaneseResourcePack(
  parsed: ParsedModpack,
  translations: JapaneseTranslations = {},
  options: ResourcePackOptions = {},
): Uint8Array {
  const packFormat = options.packFormat ?? 34;
  if (!Number.isInteger(packFormat) || packFormat <= 0) {
    throw new RangeError("packFormat must be a positive integer");
  }
  const jsonIndent = options.jsonIndent ?? 2;
  if (!Number.isInteger(jsonIndent) || jsonIndent < 0 || jsonIndent > 10) {
    throw new RangeError("jsonIndent must be an integer from 0 through 10");
  }

  const files: Record<string, Uint8Array> = Object.create(null) as Record<
    string,
    Uint8Array
  >;
  const description =
    options.description ?? "Japanese translations generated by Minecraft Translator";
  const packMetadata = packFormat < 65
    ? { pack_format: packFormat, description }
    : { min_format: packFormat, max_format: packFormat, description };
  files["pack.mcmeta"] = strToU8(
    `${JSON.stringify(
      { pack: packMetadata },
      null,
      jsonIndent,
    )}\n`,
  );
  files["pack.png"] = options.iconBytes ?? DEFAULT_PACK_ICON;

  const selectedJarPaths = options.selectedJarPaths === undefined
    ? undefined
    : new Set(options.selectedJarPaths.map(normalizePath));
  const sourcesByNamespace = new Map<
    string,
    { keys: Set<string>; existingJapanese: StringDictionary }
  >();
  for (const source of parsed.sources) {
    if (selectedJarPaths && !selectedJarPaths.has(source.jarPath)) continue;
    const selectedSource = sourcesByNamespace.get(source.namespace) ?? {
      keys: new Set<string>(),
      existingJapanese: emptyDictionary(),
    };
    for (const key of Object.keys(source.entries)) selectedSource.keys.add(key);
    for (const [key, value] of Object.entries(source.existingJapanese)) {
      selectedSource.keys.add(key);
      if (!Object.hasOwn(selectedSource.existingJapanese, key)) {
        selectedSource.existingJapanese[key] = value;
      }
    }
    sourcesByNamespace.set(source.namespace, selectedSource);
  }

  for (const namespace of [...sourcesByNamespace.keys()].sort()) {
    const source = sourcesByNamespace.get(namespace)!;
    const namespaceTranslations = translations[namespace] ?? {};
    const ordered = emptyDictionary();
    for (const key of [...source.keys].sort()) {
      const translated = namespaceTranslations[key];
      const hasTranslation = typeof translated === "string" && Boolean(translated.trim());
      const hasBuiltin = Object.hasOwn(source.existingJapanese, key);
      if (hasTranslation) {
        if (
          options.includeBuiltinTranslations
          || !hasBuiltin
          || translated !== source.existingJapanese[key]
        ) {
          ordered[key] = translated;
        }
      } else if (options.includeBuiltinTranslations && hasBuiltin) {
        ordered[key] = source.existingJapanese[key];
      }
    }
    files[`assets/${namespace}/lang/ja_jp.json`] = strToU8(
      `${JSON.stringify(ordered, null, jsonIndent)}\n`,
    );
  }

  return zipSync(files, { level: 6 });
}
