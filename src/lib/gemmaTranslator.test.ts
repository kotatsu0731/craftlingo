import { describe, expect, it, vi } from "vitest";
import {
  GEMMA_MODELS,
  GemmaTranslator,
  formatDebugArguments,
  formatDebugValue,
  getModelSource,
  parseJsonResponse,
  parseTranslationMessage,
} from "./gemmaTranslator";

class MemoryFileHandle {
  private contents = { size: 0, text: async () => "" } as File;

  constructor(private readonly failWrites = false) {}

  async getFile(): Promise<File> {
    return this.contents as File;
  }

  async createWritable(): Promise<FileSystemWritableFileStream> {
    if (this.failWrites) throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    let size = 0;
    let text = "";
    const handle = this;
    const append = (chunk: BlobPart) => {
      if (typeof chunk === "string") {
        text += chunk;
        size += new TextEncoder().encode(chunk).byteLength;
      } else if (chunk instanceof ArrayBuffer) {
        size += chunk.byteLength;
      } else if (ArrayBuffer.isView(chunk)) {
        size += chunk.byteLength;
      } else {
        size += chunk.size;
      }
    };
    const save = () => {
      handle.contents = { size, text: async () => text } as File;
    };
    const stream = new WritableStream<BlobPart>({
      write: append,
      close: save,
    });
    return Object.assign(stream, {
      async write(chunk: BlobPart) {
        append(chunk);
      },
      async close() {
        save();
      },
    }) as FileSystemWritableFileStream;
  }
}

class MemoryDirectoryHandle {
  private readonly files = new Map<string, MemoryFileHandle>();

  constructor(private readonly failWrites = false) {}

  async getDirectoryHandle(): Promise<FileSystemDirectoryHandle> {
    return this as unknown as FileSystemDirectoryHandle;
  }

  async getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<FileSystemFileHandle> {
    let handle = this.files.get(name);
    if (!handle && options?.create) {
      handle = new MemoryFileHandle(this.failWrites);
      this.files.set(name, handle);
    }
    if (!handle) throw new DOMException("Not found", "NotFoundError");
    return handle as unknown as FileSystemFileHandle;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name)) throw new DOMException("Not found", "NotFoundError");
  }
}

describe("parseJsonResponse", () => {
  it("extracts JSON from a fenced response", () => {
    expect(parseJsonResponse(`Here is the result:\n\`\`\`json\n{
      "translations": [{"id": 0, "text": "鉄の{塊}"}]
    }\n\`\`\``)).toEqual({
      translations: [{ id: 0, text: "鉄の{塊}" }],
    });
  });

  it("repairs trailing commas without changing commas inside strings", () => {
    expect(parseJsonResponse(`{
      "translations": [
        {"id": 0, "text": "赤, 青",},
      ],
    }`)).toEqual({
      translations: [{ id: 0, text: "赤, 青" }],
    });
  });

  it("recovers entries when the model closes the array after every item", () => {
    expect(parseJsonResponse(`\`\`\`json
      {
        "translations": [
          {"id": 0, "text": "BetterGrassify 設定"}
        ],
        {"id": 1, "text": "Better草モード"}
        ],
        {"id": 2, "text": "赤, 青"}
        ]
      }
    \`\`\``)).toEqual({
      translations: [
        { id: 0, text: "BetterGrassify 設定" },
        { id: 1, text: "Better草モード" },
        { id: 2, text: "赤, 青" },
      ],
    });
  });

  it("skips an invalid brace block before the translation object", () => {
    expect(parseJsonResponse("Use {JSON}. Result: {\"translations\":[]}"))
      .toEqual({ translations: [] });
  });

  it("rejects incomplete JSON", () => {
    expect(() => parseJsonResponse('{"translations":['))
      .toThrow("モデルの応答が有効な翻訳JSONではありません");
  });

  it("keeps the original JSON parse failure as the cause", () => {
    try {
      parseJsonResponse('{"translations":invalid}');
      throw new Error("expected parseJsonResponse to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBeInstanceOf(SyntaxError);
    }
  });
});

describe("parseTranslationMessage", () => {
  it("reads constrained translations from tool-call arguments", () => {
    expect(parseTranslationMessage({
      role: "assistant",
      tool_calls: [{
        type: "function",
        function: {
          name: "submit_translations",
          arguments: {
            translations: [
              { id: 0, text: "BetterGrassify 設定" },
              { id: 1, text: "Better草モード" },
            ],
          },
        },
      }],
    })).toEqual({
      translations: [
        { id: 0, text: "BetterGrassify 設定" },
        { id: 1, text: "Better草モード" },
      ],
    });
  });
});

describe("GemmaTranslator.translate", () => {
  it("protects formatting codes, omits raw keys, and retries missing long entries separately", async () => {
    const pendingResponses = [
      [
        { id: 1, text: "CPU負荷" },
        { id: 2, text: "一部の設定は既定値に置き換えられます。現在の設定は一部上書きされる場合があります。" },
      ],
      [{
        id: 0,
        text: "Distant Horizons の描画品質をまとめて変更します。GPU使用率やフレームレートに応じて下げてください。",
      }],
      [{
        id: 0,
        text: "__CRAFTLINGO_FORMAT_0_0__一部の設定は既定値に置き換えられます。__CRAFTLINGO_FORMAT_0_1__現在の設定は一部上書きされる場合があります。__CRAFTLINGO_FORMAT_0_2__",
      }],
    ];
    const sentMessages: string[] = [];
    const deletedConversations: ReturnType<typeof vi.fn>[] = [];
    const engine = {
      createConversation: vi.fn().mockImplementation(async () => {
        const translations = pendingResponses.shift();
        const deleteConversation = vi.fn().mockResolvedValue(undefined);
        deletedConversations.push(deleteConversation);
        return {
          cancel: vi.fn(),
          delete: deleteConversation,
          sendMessage: vi.fn().mockImplementation(async (message: string) => {
            sentMessages.push(message);
            return {
              role: "assistant",
              tool_calls: [{
                type: "function",
                function: {
                  name: "submit_translations",
                  arguments: { translations },
                },
              }],
            };
          }),
        };
      }),
    };
    const translator = new GemmaTranslator();
    const diagnostics = vi.fn();
    translator.setDiagnosticListener(diagnostics);
    (translator as unknown as { engine: typeof engine }).engine = engine;

    await expect(translator.translate([
      {
        key: "distanthorizons.config.client.qualityPresetSetting.@tooltip",
        source: "Modifies a number of graphical settings to quickly change Distant Horizons' rendering quality. Lower this setting if your GPU is at max usage or you are having framerate issues.",
      },
      { key: "distanthorizons.config.client.threadPresetSetting", source: "CPU Load" },
      {
        key: "config.manager.warning.lose_some_config",
        source: "§eSome of your settings will be replaced with the modpack's defaults. §lYour current configs may be partially overwritten.§r",
      },
    ])).resolves.toEqual({
      translations: {
        "distanthorizons.config.client.qualityPresetSetting.@tooltip":
          "Distant Horizons の描画品質をまとめて変更します。GPU使用率やフレームレートに応じて下げてください。",
        "distanthorizons.config.client.threadPresetSetting": "CPU負荷",
        "config.manager.warning.lose_some_config":
          "§e一部の設定は既定値に置き換えられます。§l現在の設定は一部上書きされる場合があります。§r",
      },
      rejected: [],
    });

    expect(engine.createConversation).toHaveBeenCalledTimes(3);
    for (const message of sentMessages) {
      expect(message).not.toContain("\"key\"");
      expect(message).not.toContain("@tooltip");
    }
    expect(sentMessages[0]).not.toContain("§e");
    expect(sentMessages[0]).toContain("__CRAFTLINGO_FORMAT_2_0__");
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      level: "warning",
      message: expect.stringContaining("2件"),
    }));
    expect(deletedConversations).toHaveLength(3);
    for (const deleted of deletedConversations) expect(deleted).toHaveBeenCalledOnce();
  });

  it("rejects leaked or unresolved markers and retries each affected entry", async () => {
    const pendingResponses = [
      [
        { id: 0, text: "Energy" },
        { id: 1, text: "Fuel __CRAFTLINGO_FORMAT_0_0__" },
      ],
      [{ id: 0, text: "Energy __CRAFTLINGO_FORMAT_0_0__" }],
      [{ id: 0, text: "Fuel" }],
    ];
    const sentMessages: string[] = [];
    const engine = {
      createConversation: vi.fn().mockImplementation(async () => ({
        cancel: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockImplementation(async (message: string) => {
          sentMessages.push(message);
          return {
            role: "assistant",
            tool_calls: [{
              type: "function",
              function: {
                name: "submit_translations",
                arguments: { translations: pendingResponses.shift() },
              },
            }],
          };
        }),
      })),
    };
    const translator = new GemmaTranslator();
    (translator as unknown as { engine: typeof engine }).engine = engine;

    await expect(translator.translate([
      { key: "item.energy", source: "Energy: %s" },
      { key: "item.fuel", source: "Fuel" },
    ])).resolves.toEqual({
      translations: {
        "item.energy": "Energy %s",
        "item.fuel": "Fuel",
      },
      rejected: [],
    });

    expect(engine.createConversation).toHaveBeenCalledTimes(3);
    expect(sentMessages[0].match(/__CRAFTLINGO_FORMAT_\d+_\d+__/g)).toEqual([
      "__CRAFTLINGO_FORMAT_0_0__",
    ]);
  });

  it("cancels an in-flight conversation and preserves the abort reason", async () => {
    const controller = new AbortController();
    const reason = new DOMException("翻訳を一時停止しました。", "AbortError");
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let rejectGeneration!: (error: unknown) => void;
    const cancel = vi.fn(() => rejectGeneration(new Error("LiteRT generation cancelled")));
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const conversation = {
      cancel,
      delete: deleteConversation,
      sendMessage: vi.fn(() => new Promise<never>((_resolve, reject) => {
        rejectGeneration = reject;
        markStarted();
      })),
    };
    const engine = {
      createConversation: vi.fn().mockResolvedValue(conversation),
    };
    const translator = new GemmaTranslator();
    (translator as unknown as { engine: typeof engine }).engine = engine;

    const translating = translator.translate(
      [{ key: "item.test", source: "Test" }],
      {},
      controller.signal,
    );
    await started;
    controller.abort(reason);

    await expect(translating).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
    expect(deleteConversation).toHaveBeenCalledOnce();
  });
});

describe("debug formatting", () => {
  it("preserves an error name, message, stack, and nested cause", () => {
    const cause = new TypeError("GPU device was lost");
    const error = new Error("Engine.create failed", { cause });
    error.stack = "Error: Engine.create failed\n    at litert.js:42:3";

    expect(formatDebugValue(error)).toBe([
      "name: Error",
      "message: Engine.create failed",
      "stack:\nError: Engine.create failed\n    at litert.js:42:3",
      "cause:\nname: TypeError",
      "message: GPU device was lost",
      `stack:\n${cause.stack}`,
    ].join("\n"));
  });

  it("keeps console warning strings and error details on separate lines", () => {
    const warning = new DOMException("Buffer allocation failed", "OperationError");
    const formatted = formatDebugArguments(["LiteRT warning:", warning]);

    expect(formatted).toContain("LiteRT warning:\nname: OperationError");
    expect(formatted).toContain("message: Buffer allocation failed");
    expect(formatted).toContain("stack:\n");
  });

  it("serializes every console argument including circular objects", () => {
    const details: { code: number; self?: unknown } = { code: 7 };
    details.self = details;

    expect(formatDebugArguments(["first", details, undefined])).toBe(
      'first\n{\n  "code": 7,\n  "self": "[Circular]"\n}\nundefined',
    );
  });
});

describe("getModelSource", () => {
  it("downloads a model once and reuses the persistent local file", async () => {
    const directory = new MemoryDirectoryHandle();
    const storage = {
      persist: vi.fn().mockResolvedValue(true),
      getDirectory: vi.fn().mockResolvedValue(directory),
    };
    const fetchModel = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-length": "3" },
    }));

    const [first, simultaneous] = await Promise.all([
      getModelSource("e2b", storage, fetchModel),
      getModelSource("e2b", storage, fetchModel),
    ]);
    const reopened = await getModelSource("e2b", storage, fetchModel);

    expect(first).toHaveProperty("size", 3);
    expect(simultaneous).toHaveProperty("size", 3);
    expect(reopened).toHaveProperty("size", 3);
    expect(fetchModel).toHaveBeenCalledOnce();
  });

  it("falls back to the URL loader when the model cannot be persisted", async () => {
    const directory = new MemoryDirectoryHandle(true);
    const storage = { getDirectory: vi.fn().mockResolvedValue(directory) };
    const fetchModel = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(getModelSource("e2b", storage, fetchModel))
      .resolves.toBe(GEMMA_MODELS.e2b.url);
    expect(fetchModel).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("lets the engine use its URL loader when persistent storage is unavailable", async () => {
    const fetchModel = vi.fn();

    await expect(getModelSource("e4b", undefined, fetchModel))
      .resolves.toBe(GEMMA_MODELS.e4b.url);
    expect(fetchModel).not.toHaveBeenCalled();
  });
});
