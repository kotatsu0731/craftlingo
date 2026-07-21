import { beforeEach, describe, expect, it, vi } from "vitest";

const wllamaMock = vi.hoisted(() => {
  interface MockCompletionOptions {
    abortSignal?: AbortSignal;
    messages: Array<{ role: string; content?: string | null }>;
    [key: string]: unknown;
  }

  class MockWllama {
    static instances: MockWllama[] = [];

    loaded = false;
    readonly pathConfig: unknown;
    readonly config: unknown;
    readonly loadModelFromUrl = vi.fn(async (_url?: unknown, _options?: unknown) => {
      this.loaded = true;
    });
    readonly createChatCompletion = vi.fn<(options: MockCompletionOptions) => Promise<unknown>>();
    readonly exit = vi.fn(async () => {
      this.loaded = false;
    });

    constructor(pathConfig: unknown, config: unknown) {
      this.pathConfig = pathConfig;
      this.config = config;
      MockWllama.instances.push(this);
    }

    isModelLoaded(): boolean {
      return this.loaded;
    }
  }

  return { MockWllama };
});

vi.mock("@wllama/wllama/esm/index.js", () => ({
  LogLevel: { ERROR: 4 },
  Wllama: wllamaMock.MockWllama,
}));

import {
  getRecommendedLfmBatchSize,
  LFM_MODEL,
  LfmTranslator,
  parseLfmResponse,
} from "./lfmTranslator";

function completion(content: string) {
  return {
    choices: [{ message: { role: "assistant", content } }],
  };
}

function currentRuntime(): InstanceType<typeof wllamaMock.MockWllama> {
  const runtime = wllamaMock.MockWllama.instances.at(-1);
  if (!runtime) throw new Error("Wllama was not constructed");
  return runtime;
}

function currentLogger(): { warn: (...values: unknown[]) => void } {
  const { logger } = currentRuntime().config as {
    logger: { warn: (...values: unknown[]) => void };
  };
  return logger;
}

beforeEach(() => {
  vi.restoreAllMocks();
  wllamaMock.MockWllama.instances.length = 0;
});

describe("LFM model configuration", () => {
  it("points to the official Q4_K_M GGUF", () => {
    expect(LFM_MODEL).toMatchObject({
      id: "lfm2_5_1_2b_jp",
      url: expect.stringContaining("LiquidAI/LFM2.5-1.2B-JP-202606-GGUF"),
    });
    expect(LFM_MODEL.url).toMatch(/Q4_K_M\.gguf$/);
  });

  it("loads the bundled WASM runtime in CPU-only mode and reuses it", async () => {
    const translator = new LfmTranslator();

    await translator.load();
    await translator.load();

    expect(wllamaMock.MockWllama.instances).toHaveLength(1);
    const runtime = currentRuntime();
    expect(runtime.pathConfig).toEqual({
      default: expect.stringContaining("wllama.wasm"),
    });
    expect(runtime.loadModelFromUrl).toHaveBeenCalledOnce();
    expect(runtime.loadModelFromUrl).toHaveBeenCalledWith(LFM_MODEL.url, expect.objectContaining({
      useCache: true,
      n_ctx: 8192,
      n_gpu_layers: 0,
      jinja: true,
      log_level: 4,
    }));
    expect(runtime.loadModelFromUrl.mock.calls[0][1]).not.toHaveProperty("n_batch");
    expect(getRecommendedLfmBatchSize()).toBe(25);
    expect(translator.model).toBe(LFM_MODEL.id);

    await translator.dispose();

    expect(runtime.exit).toHaveBeenCalledOnce();
    expect(translator.model).toBeUndefined();
  });

  it("opts into Wllama's persistent cache on every runtime instance", async () => {
    const first = new LfmTranslator();
    await first.load();
    await first.dispose();

    const reopened = new LfmTranslator();
    await reopened.load();

    expect(wllamaMock.MockWllama.instances).toHaveLength(2);
    for (const runtime of wllamaMock.MockWllama.instances) {
      expect(runtime.loadModelFromUrl).toHaveBeenCalledWith(
        LFM_MODEL.url,
        expect.objectContaining({ useCache: true }),
      );
    }
  });

  it("uses Wllama's smaller context and prompt batch on mobile", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Android 15; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0",
    );
    const translator = new LfmTranslator();

    await translator.load();

    const runtime = currentRuntime();
    expect(runtime.loadModelFromUrl).toHaveBeenCalledWith(LFM_MODEL.url, expect.objectContaining({
      n_ctx: 4096,
      n_batch: 128,
    }));
    expect(getRecommendedLfmBatchSize()).toBe(1);
  });

  it("forwards native Wllama download progress from load", async () => {
    const translator = new LfmTranslator();
    const progress = vi.fn();

    await translator.load(LFM_MODEL.id, progress);

    const options = currentRuntime().loadModelFromUrl.mock.calls[0][1] as {
      progressCallback?: (value: { loaded: number; total: number }) => void;
    };
    options.progressCallback?.({ loaded: 128, total: 512 });
    expect(progress).toHaveBeenCalledWith({ loaded: 128, total: 512 });
  });

  it("treats a restored context checkpoint as an internal trace", async () => {
    const translator = new LfmTranslator();
    const diagnostics = vi.fn();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    translator.setDiagnosticListener(diagnostics);
    await translator.load();

    currentLogger().warn(
      "slot update_slots: id 0 | task 219 | restored context checkpoint "
      + "(pos_min = 76, pos_max = 76, n_tokens = 77, n_past = 77, size = 0.157 MiB)",
    );

    expect(debug).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
    expect(diagnostics).not.toHaveBeenCalled();
  });
});

describe("parseLfmResponse", () => {
  it("accepts constrained JSON and fenced JSON", () => {
    const expected = { translations: [{ id: 0, text: "銅インゴット" }] };

    expect(parseLfmResponse(JSON.stringify(expected))).toEqual(expected);
    expect(parseLfmResponse(`result:\n\`\`\`json\n${JSON.stringify(expected)}\n\`\`\``))
      .toEqual(expected);
  });

  it("rejects non-translation responses", () => {
    expect(() => parseLfmResponse("{}"))
      .toThrow("LFMの応答が有効な翻訳JSONではありません");
  });
});

describe("LfmTranslator.translate", () => {
  it("limits generated tokens on mobile", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36",
    );
    const translator = new LfmTranslator();
    await translator.load();
    const runtime = currentRuntime();
    runtime.createChatCompletion.mockResolvedValue(completion(JSON.stringify({
      translations: [{ id: 0, text: "テスト" }],
    })));

    await translator.translate([{ key: "item.test", source: "Test" }]);

    expect(runtime.createChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      max_tokens: 512,
    }));
  });

  it("returns valid translations and rejects missing or placeholder-damaged entries", async () => {
    const translator = new LfmTranslator();
    await translator.load();
    const runtime = currentRuntime();
    runtime.createChatCompletion.mockResolvedValue(completion(JSON.stringify({
      translations: [
        { id: 0, text: "%sを設置" },
        { id: 1, text: "スロットを使用" },
      ],
    })));

    await expect(translator.translate([
      { key: "message.place", source: "Place %s" },
      { key: "message.slot", source: "Use slot {0}" },
      { key: "message.missing", source: "Missing" },
    ], { Place: "設置" })).resolves.toEqual({
      translations: { "message.place": "%sを設置" },
      rejected: ["message.slot", "message.missing"],
    });

    expect(runtime.createChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      response_format: {
        type: "json_schema",
        json_schema: expect.objectContaining({
          name: "minecraft_translations",
          strict: true,
          schema: expect.objectContaining({
            required: ["translations"],
            additionalProperties: false,
          }),
        }),
      },
      cache_prompt: true,
      max_tokens: 4096,
    }));
    const options = runtime.createChatCompletion.mock.calls[0][0];
    expect(options.messages[1].content).toContain('"Place":"設置"');
    expect(options.messages[1].content).toContain('"key":"message.place"');
  });

  it("retries malformed JSON and rejects the batch after a second invalid response", async () => {
    const translator = new LfmTranslator();
    const diagnostics = vi.fn();
    translator.setDiagnosticListener(diagnostics);
    await translator.load();
    const runtime = currentRuntime();
    runtime.createChatCompletion
      .mockResolvedValueOnce(completion("not json"))
      .mockResolvedValueOnce(completion("still not json"));

    await expect(translator.translate([{ key: "item.test", source: "Test" }]))
      .resolves.toEqual({ translations: {}, rejected: ["item.test"] });
    expect(runtime.createChatCompletion).toHaveBeenCalledTimes(2);
    const [first, retry] = runtime.createChatCompletion.mock.calls;
    expect(first[0].response_format).toEqual(retry[0].response_format);
    expect(first[0].response_format).toMatchObject({
      type: "json_schema",
      json_schema: { strict: true },
    });
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ level: "warning" }));
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));
  });

  it("forwards interruption to Wllama and preserves the caller's abort reason", async () => {
    const translator = new LfmTranslator();
    await translator.load();
    const runtime = currentRuntime();
    runtime.createChatCompletion.mockImplementation((options) => new Promise((_, reject) => {
      options.abortSignal?.addEventListener("abort", () => reject(new Error("Wllama aborted")), {
        once: true,
      });
    }));
    const controller = new AbortController();
    const reason = new DOMException("翻訳を一時停止しました。", "AbortError");

    const translating = translator.translate([{ key: "item.test", source: "Test" }], {}, controller.signal);
    controller.abort(reason);

    await expect(translating).rejects.toBe(reason);
    expect(runtime.createChatCompletion.mock.calls[0][0].abortSignal).toBe(controller.signal);
  });

  it("requires a loaded model", async () => {
    const translator = new LfmTranslator();

    await expect(translator.translate([{ key: "item.test", source: "Test" }]))
      .rejects.toThrow("LFMモデルが読み込まれていません");
  });
});
