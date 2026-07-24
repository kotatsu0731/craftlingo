/// <reference types="vite/client" />

import type {
  ChatCompletionParams,
  Wllama,
  WllamaLogger,
} from "@wllama/wllama/esm/index.js";
import wllamaWasmUrl from "@wllama/wllama/esm/wasm/wllama.wasm?url";
import { validatePlaceholders } from "./placeholders";

export const LFM_MODEL = {
  id: "lfm2_5_1_2b_jp",
  label: "LFM2.5 1.2B JP",
  description: "軽量・WebGPU非対応PC向け（CPU）",
  url: "https://huggingface.co/LiquidAI/LFM2.5-1.2B-JP-202606-GGUF/resolve/main/LFM2.5-1.2B-JP-202606-Q4_K_M.gguf",
} as const;

export type LfmModel = typeof LFM_MODEL.id;

export interface TranslationInput {
  key: string;
  source: string;
}

export interface TranslationResult {
  translations: Record<string, string>;
  rejected: string[];
}

export interface LfmDiagnostic {
  level: "warning" | "error";
  message: string;
}

export type LfmDiagnosticListener = (diagnostic: LfmDiagnostic) => void;

export interface LfmLoadProgress {
  loaded: number;
  total: number;
}

export type LfmLoadProgressCallback = (progress: LfmLoadProgress) => void;

interface TranslationResponse {
  translations: Array<{ id?: number; text?: string }>;
}

const TRANSLATION_SCHEMA = {
  type: "object",
  properties: {
    translations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          text: { type: "string" },
        },
        required: ["id", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["translations"],
  additionalProperties: false,
} as const;

const WLLAMA_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "minecraft_translations",
    schema: TRANSLATION_SCHEMA,
    strict: true,
  },
} as const satisfies NonNullable<ChatCompletionParams["response_format"]>;

type WllamaLoadOptions = NonNullable<Parameters<Wllama["loadModelFromUrl"]>[1]>;

const WLLAMA_BASE_LOAD_OPTIONS = {
  // Wllama's ModelManager stores the GGUF in its CacheManager (OPFS by
  // default) and reopens it by source URL on later runtime instances.
  useCache: true,
  n_gpu_layers: 0,
  jinja: true,
} satisfies Omit<WllamaLoadOptions, "log_level">;

const WLLAMA_CACHE_DIRECTORY = "cache";
const WLLAMA_METADATA_PREFIX = "__metadata__";

interface StorageHint {
  sha256: string;
}

/**
 * Keeps Wllama's cache in OPFS and rejects interrupted downloads before
 * Wllama mistakes them for complete content-addressed files.
 */
class ValidatedOpfsStorageBackend {
  isSupported(): boolean {
    return typeof navigator !== "undefined"
      && typeof navigator.storage?.getDirectory === "function";
  }

  private async getDirectory(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(WLLAMA_CACHE_DIRECTORY, { create: true });
  }

  async read(key: string): Promise<Blob | null> {
    try {
      const directory = await this.getDirectory();
      const handle = await directory.getFileHandle(key);
      return handle.getFile();
    } catch {
      return null;
    }
  }

  async write(key: string, stream: ReadableStream): Promise<void> {
    const directory = await this.getDirectory();
    const handle = await directory.getFileHandle(key, { create: true });
    const writable = await handle.createWritable();
    try {
      await stream.pipeTo(writable);
    } catch (error) {
      await writable.abort(error).catch(() => undefined);
      await directory.removeEntry(key).catch(() => undefined);
      throw error;
    }
  }

  async getSize(key: string, hint?: StorageHint): Promise<number> {
    const file = await this.read(key);
    if (!file) return -1;
    if (!hint) return file.size;

    const metadataFile = await this.read(`${WLLAMA_METADATA_PREFIX}${key}`);
    if (!metadataFile) return -1;
    try {
      const metadata = JSON.parse(await metadataFile.text()) as {
        originalSize?: number;
        sha256?: string;
      };
      if (metadata.originalSize !== file.size) return -1;
      if (metadata.sha256 && metadata.sha256 !== hint.sha256) return -1;
      return file.size;
    } catch {
      return -1;
    }
  }

  async list(): Promise<Array<{ key: string; size: number }>> {
    const directory = await this.getDirectory();
    const entries = (directory as FileSystemDirectoryHandle & {
      entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    }).entries();
    const result: Array<{ key: string; size: number }> = [];
    for await (const [key, handle] of entries) {
      if (handle.kind !== "file") continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      result.push({ key, size: file.size });
    }
    return result;
  }

  async delete(key: string): Promise<void> {
    try {
      const directory = await this.getDirectory();
      await directory.removeEntry(key);
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
    }
  }
}

const DESKTOP_PROFILE = {
  loadOptions: { n_ctx: 8192 },
  maxTokens: 4096,
  recommendedBatchSize: 25,
} as const;

const MOBILE_PROFILE = {
  // Mobile Firefox commonly runs Wllama without pthreads. Keeping both the
  // KV cache and prompt evaluation batch smaller avoids long, memory-heavy
  // work before the first generated token appears.
  loadOptions: { n_ctx: 4096, n_batch: 128 },
  // Chat completion is non-streaming because the result is constrained JSON.
  // Use one entry so Firefox can commit visible progress after each response.
  maxTokens: 512,
  recommendedBatchSize: 1,
} as const;

function isMobileRuntime(): boolean {
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent ?? "";
  return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)
    || (/Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1);
}

function getRuntimeProfile() {
  return isMobileRuntime() ? MOBILE_PROFILE : DESKTOP_PROFILE;
}

/** Recommended number of translation entries per Wllama completion. */
export function getRecommendedLfmBatchSize(): number {
  return getRuntimeProfile().recommendedBatchSize;
}

function isTranslationResponse(value: unknown): value is TranslationResponse {
  return Boolean(
    value
    && typeof value === "object"
    && "translations" in value
    && Array.isArray(value.translations),
  );
}

function extractJsonCandidates(raw: string): string[] {
  const candidates = [raw.trim()];
  for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1].trim());
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }
  return [...new Set(candidates.filter(Boolean))];
}

/** Accepts constrained JSON as well as a fenced JSON fallback from the model. */
export function parseLfmResponse(raw: string): TranslationResponse {
  let lastError: unknown;
  for (const candidate of extractJsonCandidates(raw)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isTranslationResponse(parsed)) return parsed;
      lastError = new Error("translations 配列がありません。");
    } catch (error) {
      lastError = error;
    }
  }

  const error = new Error("LFMの応答が有効な翻訳JSONではありません。", {
    cause: lastError,
  });
  throw error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("翻訳処理が中断されました。", "AbortError");
}

function formatLogArguments(values: readonly unknown[]): string {
  return values.map((value) => {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }).join("\n");
}

// llama.cpp emits this slot-cache event at TRACE level, but Wllama currently
// forwards it through logger.warn. It is a successful cache restore, not a
// condition that needs to be shown in CraftLingo's warning log.
function isWllamaContextCheckpointTrace(values: readonly unknown[]): boolean {
  const message = formatLogArguments(values);
  return /\bslot update_slots:.*\brestored context checkpoint\s*\(/s.test(message);
}

function buildMessages(entries: TranslationInput[], glossary: Record<string, string>) {
  const payload = entries.map((entry, id) => ({
    id,
    key: entry.key,
    source: entry.source,
  }));

  return [
    {
      role: "system" as const,
      content:
        "You are a professional Japanese localizer for Minecraft mods. Translate every source into natural Japanese. Preserve every printf token, {0} token, formatting code, and escaped newline exactly. Keep item names concise and tooltips natural. Return only the requested JSON object.",
    },
    {
      role: "user" as const,
      content:
        `Translate every English source. Apply the glossary when relevant, but do not translate keys. Return exactly one translation for every numeric input ID.\n\nGlossary:\n${JSON.stringify(glossary)}\n\nInput:\n${JSON.stringify({ entries: payload })}`,
    },
  ];
}

export class LfmTranslator {
  private runtime?: Wllama;
  private loadedModel?: LfmModel;
  private diagnosticListener?: LfmDiagnosticListener;
  private maxTokens: number = DESKTOP_PROFILE.maxTokens;

  get model(): LfmModel | undefined {
    return this.loadedModel;
  }

  setDiagnosticListener(listener: LfmDiagnosticListener | undefined): void {
    this.diagnosticListener = listener;
  }

  async load(
    model: LfmModel = LFM_MODEL.id,
    progressCallback?: LfmLoadProgressCallback,
  ): Promise<void> {
    if (this.runtime?.isModelLoaded() && this.loadedModel === model) return;
    await this.disposeRuntime();

    const { CacheManager, LogLevel, Wllama } = await import("@wllama/wllama/esm/index.js");
    const profile = getRuntimeProfile();
    const runtime = new Wllama({ default: wllamaWasmUrl }, {
      cacheManager: new CacheManager([new ValidatedOpfsStorageBackend()]),
      logger: this.createLogger(),
    });
    try {
      await runtime.loadModelFromUrl(LFM_MODEL.url, {
        ...WLLAMA_BASE_LOAD_OPTIONS,
        ...profile.loadOptions,
        progressCallback,
        // Wllama's bundled llama-server emits normal context sizing and
        // disabled-speculation messages through console.warn. Keep native
        // errors, while avoiding false warnings in CraftLingo's detail log.
        log_level: LogLevel.ERROR,
      });
      this.runtime = runtime;
      this.loadedModel = model;
      this.maxTokens = profile.maxTokens;
    } catch (error) {
      await runtime.exit().catch(() => undefined);
      throw error;
    }
  }

  async translate(
    entries: TranslationInput[],
    glossary: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<TranslationResult> {
    const runtime = this.runtime;
    if (!runtime?.isModelLoaded()) throw new Error("LFMモデルが読み込まれていません。");
    if (entries.length === 0) return { translations: {}, rejected: [] };

    throwIfAborted(signal);
    const messages = buildMessages(entries, glossary);
    let rawResponse = "";

    try {
      const response = await runtime.createChatCompletion({
        messages,
        abortSignal: signal,
        response_format: WLLAMA_RESPONSE_FORMAT,
        max_tokens: this.maxTokens,
        temperature: 0.2,
        top_k: 40,
        top_p: 0.9,
        penalty_repeat: 1.05,
        cache_prompt: true,
      });
      throwIfAborted(signal);
      rawResponse = response.choices[0]?.message.content ?? "";
    } catch (error) {
      if (signal?.aborted) throwIfAborted(signal);
      throw error;
    }

    let parsed: TranslationResponse;
    try {
      parsed = parseLfmResponse(rawResponse);
    } catch (error) {
      this.emitDiagnostic("warning", "LFMの応答JSONを解析できませんでした。再試行します。", error);
      throwIfAborted(signal);
      try {
        const retry = await runtime.createChatCompletion({
          messages: [
            ...messages,
            { role: "assistant", content: rawResponse },
            {
              role: "user",
              content: "The previous response was invalid. Return only the complete JSON object with one translation for every input ID.",
            },
          ],
          abortSignal: signal,
          response_format: WLLAMA_RESPONSE_FORMAT,
          max_tokens: this.maxTokens,
          temperature: 0.1,
          penalty_repeat: 1.05,
          cache_prompt: true,
        });
        throwIfAborted(signal);
        parsed = parseLfmResponse(retry.choices[0]?.message.content ?? "");
      } catch (retryError) {
        if (signal?.aborted) throwIfAborted(signal);
        this.emitDiagnostic("error", "再試行したLFMの応答JSONも解析できませんでした。", retryError);
        return { translations: {}, rejected: entries.map((entry) => entry.key) };
      }
    }

    const translations: Record<string, string> = {};
    const rejected: string[] = [];

    for (const translation of parsed.translations) {
      if (
        typeof translation.id !== "number"
        || !Number.isInteger(translation.id)
        || typeof translation.text !== "string"
      ) continue;
      const sourceEntry = entries[translation.id];
      if (!sourceEntry) continue;
      if (!validatePlaceholders(sourceEntry.source, translation.text)) {
        rejected.push(sourceEntry.key);
        continue;
      }
      translations[sourceEntry.key] = translation.text;
    }

    for (const entry of entries) {
      if (!(entry.key in translations) && !rejected.includes(entry.key)) rejected.push(entry.key);
    }
    return { translations, rejected };
  }

  async dispose(): Promise<void> {
    await this.disposeRuntime();
  }

  private createLogger(): WllamaLogger {
    return {
      debug: console.debug.bind(console),
      log: console.log.bind(console),
      warn: (...values: unknown[]) => {
        if (isWllamaContextCheckpointTrace(values)) {
          console.debug(...values);
          return;
        }
        console.warn(...values);
        this.emitDiagnostic("warning", "[Wllama console.warn]", ...values);
      },
      error: (...values: unknown[]) => {
        console.error(...values);
        this.emitDiagnostic("error", "[Wllama console.error]", ...values);
      },
    };
  }

  private emitDiagnostic(
    level: LfmDiagnostic["level"],
    prefix: string,
    ...values: unknown[]
  ): void {
    const detail = values.length > 0 ? `\n${formatLogArguments(values)}` : "";
    this.diagnosticListener?.({ level, message: `${prefix}${detail}` });
  }

  private async disposeRuntime(): Promise<void> {
    const runtime = this.runtime;
    this.runtime = undefined;
    this.loadedModel = undefined;
    this.maxTokens = DESKTOP_PROFILE.maxTokens;
    if (runtime) await runtime.exit();
  }
}
