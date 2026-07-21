import { describe, expect, it, vi } from "vitest";
import {
  GEMMA_MODELS,
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
