import { Engine, type Message, type Tool } from "@litert-lm/core";
import { validatePlaceholders } from "./placeholders";

export type GemmaModel = "e2b" | "e4b";

export interface TranslationInput {
  key: string;
  source: string;
}

export interface TranslationResult {
  translations: Record<string, string>;
  rejected: string[];
}

export interface GemmaDiagnostic {
  level: "warning" | "error";
  message: string;
}

export type GemmaDiagnosticListener = (diagnostic: GemmaDiagnostic) => void;

function stringifyDebugObject(value: object): string {
  const visited = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(value, (_key, nested) => {
      if (typeof nested === "bigint") return `${nested}n`;
      if (typeof nested === "function") return `[Function ${nested.name || "anonymous"}]`;
      if (typeof nested === "symbol") return String(nested);
      if (nested === undefined) return "undefined";
      if (typeof nested === "object" && nested !== null) {
        if (visited.has(nested)) return "[Circular]";
        visited.add(nested);
      }
      if (isErrorLike(nested)) {
        return {
          name: nested.name,
          message: nested.message,
          stack: nested.stack,
          cause: nested.cause,
        };
      }
      return nested;
    }, 2);
    if (serialized !== undefined) return serialized;
  } catch {
    // Some runtime and library objects are circular or deliberately opaque.
  }
  return String(value);
}

interface ErrorLike {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
}

function isErrorLike(value: unknown): value is ErrorLike & object {
  return value instanceof Error || (
    typeof value === "object"
    && value !== null
    && "name" in value
    && typeof value.name === "string"
    && "message" in value
    && typeof value.message === "string"
  );
}

/** Preserves the fields needed to diagnose native, runtime, and library failures. */
export function formatDebugValue(value: unknown, seen = new WeakSet<object>()): string {
  if (isErrorLike(value)) {
    if (seen.has(value)) return "[Circular Error]";
    seen.add(value);

    const lines = [`name: ${value.name}`, `message: ${value.message}`];
    if (value.stack) lines.push(`stack:\n${value.stack}`);
    if ("cause" in value && value.cause !== undefined) {
      lines.push(`cause:\n${formatDebugValue(value.cause, seen)}`);
    }
    return lines.join("\n");
  }
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "object") return stringifyDebugObject(value);
  return String(value);
}

export function formatDebugArguments(values: readonly unknown[]): string {
  return values.map((value) => formatDebugValue(value)).join("\n");
}

export const GEMMA_MODELS: Record<
  GemmaModel,
  { label: string; description: string; url: string }
> = {
  e2b: {
    label: "Gemma 4 E2B",
    description: "標準・多くのPC向け",
    url: "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm",
  },
  e4b: {
    label: "Gemma 4 E4B",
    description: "高品質・高性能PC向け",
    url: "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm",
  },
};

const MODEL_CACHE_DIRECTORY = "craftlingo-models";
const pendingModelSources = new Map<GemmaModel, Promise<string | Blob>>();

interface CachedModelMetadata {
  sourceUrl: string;
  size: number;
}

type ModelStorage = Pick<StorageManager, "getDirectory"> & Partial<Pick<StorageManager, "persist">>;

function cacheFileNames(model: GemmaModel): { model: string; metadata: string } {
  return {
    model: `${model}.litertlm`,
    metadata: `${model}.json`,
  };
}

async function readCachedModel(
  directory: FileSystemDirectoryHandle,
  model: GemmaModel,
): Promise<Blob | undefined> {
  const names = cacheFileNames(model);

  try {
    const [modelFile, metadataFile] = await Promise.all([
      directory.getFileHandle(names.model).then((handle) => handle.getFile()),
      directory.getFileHandle(names.metadata).then((handle) => handle.getFile()),
    ]);
    const metadata = JSON.parse(await metadataFile.text()) as CachedModelMetadata;
    if (
      metadata.sourceUrl !== GEMMA_MODELS[model].url
      || metadata.size <= 0
      || metadata.size !== modelFile.size
    ) {
      return undefined;
    }
    return modelFile;
  } catch {
    return undefined;
  }
}

async function removeCacheEntry(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await directory.removeEntry(name);
  } catch {
    // Missing and partially written cache entries are both safe to ignore.
  }
}

async function writeMetadata(
  directory: FileSystemDirectoryHandle,
  name: string,
  metadata: CachedModelMetadata,
): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(JSON.stringify(metadata));
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

/**
 * Returns a model stored in the browser's origin-private file system. The URL
 * is used only when persistent browser storage is unavailable.
 */
async function loadModelSource(
  model: GemmaModel,
  storage: ModelStorage | undefined,
  fetchModel: typeof fetch,
): Promise<string | Blob> {
  if (!storage || typeof storage.getDirectory !== "function") return GEMMA_MODELS[model].url;

  let directory: FileSystemDirectoryHandle;
  try {
    await storage.persist?.().catch(() => false);
    const root = await storage.getDirectory();
    directory = await root.getDirectoryHandle(MODEL_CACHE_DIRECTORY, { create: true });
  } catch (error) {
    console.warn("モデル用の永続ストレージを利用できません。", error);
    return GEMMA_MODELS[model].url;
  }

  const cached = await readCachedModel(directory, model);
  if (cached) return cached;

  const names = cacheFileNames(model);
  await removeCacheEntry(directory, names.metadata);

  const response = await fetchModel(GEMMA_MODELS[model].url, { credentials: "same-origin" });
  if (!response.ok || !response.body) {
    throw new Error(`モデルのダウンロードに失敗しました (${response.status})`);
  }

  try {
    const handle = await directory.getFileHandle(names.model, { create: true });
    const writable = await handle.createWritable();
    await response.body.pipeTo(writable);

    const modelFile = await handle.getFile();
    const expectedSize = Number(response.headers.get("content-length"));
    if (modelFile.size === 0 || (expectedSize > 0 && modelFile.size !== expectedSize)) {
      throw new Error("保存したモデルのサイズがダウンロード結果と一致しません。");
    }

    await writeMetadata(directory, names.metadata, {
      sourceUrl: GEMMA_MODELS[model].url,
      size: modelFile.size,
    });
    return modelFile;
  } catch (error) {
    await Promise.all([
      removeCacheEntry(directory, names.model),
      removeCacheEntry(directory, names.metadata),
    ]);
    console.warn("モデルをローカルに保存できないため、URLから直接読み込みます。", error);
    return GEMMA_MODELS[model].url;
  }
}

export function getModelSource(
  model: GemmaModel,
  storage: ModelStorage | undefined = typeof navigator === "undefined" ? undefined : navigator.storage,
  fetchModel: typeof fetch = fetch,
): Promise<string | Blob> {
  const pending = pendingModelSources.get(model);
  if (pending) return pending;

  const loading = loadModelSource(model, storage, fetchModel).finally(() => {
    if (pendingModelSources.get(model) === loading) pendingModelSources.delete(model);
  });
  pendingModelSources.set(model, loading);
  return loading;
}

function textFromResponse(content: Message["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("翻訳処理が中断されました。", "AbortError");
}

interface TranslationResponse {
  translations: Array<{ id?: number; text?: string }>;
}

const SUBMIT_TRANSLATIONS_TOOL: Tool = {
  type: "function",
  function: {
    name: "submit_translations",
    description: "Submit every translated string in one structured response.",
    parameters: {
      type: "object",
      properties: {
        translations: {
          type: "array",
          description: "All translations, with one item for every input ID.",
          items: {
            type: "object",
            properties: {
              id: { type: "integer", description: "The unchanged numeric input ID." },
              text: { type: "string", description: "The Japanese translation." },
            },
            required: ["id", "text"],
          },
        },
      },
      required: ["translations"],
    },
  },
};

function isTranslationResponse(value: unknown): value is TranslationResponse {
  return Boolean(
    value
    && typeof value === "object"
    && "translations" in value
    && Array.isArray(value.translations),
  );
}

function isTranslationEntry(value: unknown): value is { id: number; text: string } {
  return Boolean(
    value
    && typeof value === "object"
    && "id" in value
    && typeof value.id === "number"
    && Number.isInteger(value.id)
    && value.id >= 0
    && "text" in value
    && typeof value.text === "string",
  );
}

function extractJsonObjects(raw: string): string[] {
  const candidates: string[] = [];

  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== "{") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < raw.length; index += 1) {
      const character = raw[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }

      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(raw.slice(start, index + 1));
          break;
        }
      }
    }
  }

  return candidates;
}

function removeTrailingCommas(json: string): string {
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < json.length; index += 1) {
    const character = json[index];
    if (inString) {
      repaired += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      repaired += character;
      continue;
    }

    if (character === ",") {
      let next = index + 1;
      while (/\s/.test(json[next] ?? "")) next += 1;
      if (json[next] === "}" || json[next] === "]") continue;
    }
    repaired += character;
  }

  return repaired;
}

export function parseJsonResponse(raw: string): TranslationResponse {
  let lastError: unknown;
  const recoveredEntries = new Map<number, { id: number; text: string }>();

  for (const candidate of extractJsonObjects(raw)) {
    for (const json of new Set([candidate, removeTrailingCommas(candidate)])) {
      try {
        const parsed = JSON.parse(json) as unknown;
        if (isTranslationResponse(parsed)) return parsed;
        if (isTranslationEntry(parsed)) recoveredEntries.set(parsed.id, parsed);
        lastError = new Error("translations 配列がありません。");
      } catch (error) {
        lastError = error;
      }
    }
  }

  // Gemma sometimes closes the translations array after every item, producing
  // `[{...}], {...}], {...}]`. Each entry is still valid JSON, so retain those
  // balanced objects instead of rejecting the whole batch.
  if (recoveredEntries.size > 0) {
    return { translations: [...recoveredEntries.values()] };
  }

  const detail = isErrorLike(lastError) ? ` (${lastError.message})` : "";
  const message = `モデルの応答が有効な翻訳JSONではありません${detail}`;
  if (lastError !== undefined) throw new Error(message, { cause: lastError });
  throw new Error(message);
}

export function parseTranslationMessage(message: Message): TranslationResponse {
  const toolCall = message.tool_calls?.find(
    (call) => call.function.name === "submit_translations",
  );
  if (toolCall && isTranslationResponse(toolCall.function.arguments)) {
    return toolCall.function.arguments;
  }
  return parseJsonResponse(textFromResponse(message.content));
}

export class GemmaTranslator {
  private engine?: Engine;
  private loadedModel?: GemmaModel;
  private diagnosticListener?: GemmaDiagnosticListener;

  get model(): GemmaModel | undefined {
    return this.loadedModel;
  }

  setDiagnosticListener(listener: GemmaDiagnosticListener | undefined): void {
    this.diagnosticListener = listener;
  }

  private async captureDiagnostics<T>(operation: () => Promise<T>): Promise<T> {
    const originalWarn = console.warn;
    const originalError = console.error;
    const interceptedWarn = (...values: unknown[]) => {
      originalWarn.apply(console, values);
      this.diagnosticListener?.({
        level: "warning",
        message: `[LiteRT-LM console.warn]\n${formatDebugArguments(values)}`,
      });
    };
    const interceptedError = (...values: unknown[]) => {
      originalError.apply(console, values);
      this.diagnosticListener?.({
        level: "error",
        message: `[LiteRT-LM console.error]\n${formatDebugArguments(values)}`,
      });
    };
    console.warn = interceptedWarn;
    console.error = interceptedError;
    try {
      return await operation();
    } finally {
      if (console.warn === interceptedWarn) console.warn = originalWarn;
      if (console.error === interceptedError) console.error = originalError;
    }
  }

  async load(model: GemmaModel): Promise<void> {
    await this.captureDiagnostics(async () => {
      if (this.engine && this.loadedModel === model) return;
      await this.disposeEngine();
      const modelSource = await getModelSource(model);
      this.engine = await Engine.create({
        model: modelSource,
        mainExecutorSettings: { maxNumTokens: 8192 },
      });
      this.loadedModel = model;
    });
  }

  async translate(
    entries: TranslationInput[],
    glossary: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<TranslationResult> {
    return this.captureDiagnostics(async () => {
      if (!this.engine) throw new Error("Gemmaモデルが読み込まれていません。");
      if (entries.length === 0) return { translations: {}, rejected: [] };

      throwIfAborted(signal);

      const conversation = await this.engine.createConversation({
        enableConstrainedDecoding: true,
        preface: {
          messages: [
            {
              role: "system",
              content:
                "You are a professional Japanese localizer for Minecraft mods. Submit the result by calling submit_translations exactly once. Preserve every printf token, {0} token, formatting code, and escaped newline exactly. Keep item names concise and tooltips natural.",
            },
          ],
          tools: [SUBMIT_TRANSLATIONS_TOOL],
        },
      });

      const cancelConversation = () => conversation.cancel();
      signal?.addEventListener("abort", cancelConversation, { once: true });

      try {
        throwIfAborted(signal);
        const payload = entries.map((entry, id) => ({ id, key: entry.key, source: entry.source }));
        const response = await conversation.sendMessage(
          `Translate every English source into natural Japanese. Apply the glossary when relevant. Do not translate keys. Call submit_translations exactly once with one translation for every input ID.\n\nGlossary:\n${JSON.stringify(glossary)}\n\nInput:\n${JSON.stringify({ entries: payload })}`,
        );
        throwIfAborted(signal);
        const rawResponse = textFromResponse(response.content);
        let parsed: TranslationResponse;
        try {
          parsed = parseTranslationMessage(response);
        } catch (error) {
          console.warn("Gemmaの応答JSONを解析できませんでした。再試行します。", error, rawResponse);
          throwIfAborted(signal);
          const retry = await conversation.sendMessage(
            "Call submit_translations now exactly once. Its translations argument must contain the complete translation for every input ID. Do not reply with normal text.",
          );
          throwIfAborted(signal);
          const rawRetryResponse = textFromResponse(retry.content);
          try {
            parsed = parseTranslationMessage(retry);
          } catch (retryError) {
            console.error("再試行したGemmaの応答JSONも解析できませんでした。", retryError, rawRetryResponse);
            return { translations: {}, rejected: entries.map((entry) => entry.key) };
          }
        }
        const translations: Record<string, string> = {};
        const rejected: string[] = [];

        for (const entry of parsed.translations ?? []) {
          if (typeof entry.id !== "number" || typeof entry.text !== "string") continue;
          const sourceEntry = entries[entry.id];
          if (!sourceEntry) continue;
          if (!validatePlaceholders(sourceEntry.source, entry.text)) {
            rejected.push(sourceEntry.key);
            continue;
          }
          translations[sourceEntry.key] = entry.text;
        }

        for (const entry of entries) {
          if (!(entry.key in translations) && !rejected.includes(entry.key)) rejected.push(entry.key);
        }
        return { translations, rejected };
      } finally {
        signal?.removeEventListener("abort", cancelConversation);
        await conversation.delete();
      }
    });
  }

  async dispose(): Promise<void> {
    await this.captureDiagnostics(() => this.disposeEngine());
  }

  private async disposeEngine(): Promise<void> {
    if (this.engine) await this.engine.delete();
    this.engine = undefined;
    this.loadedModel = undefined;
  }
}

export function supportsWebGpu(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}
