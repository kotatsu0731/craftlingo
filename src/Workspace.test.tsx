import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "./App";
import { GemmaTranslator, type TranslationResult } from "./lib/gemmaTranslator";
import { LfmTranslator } from "./lib/lfmTranslator";
import {
  parseModJarFiles,
  type JapaneseTranslations,
  type ParsedModpack,
} from "./lib/modArchive";

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`${text} button was not rendered`);
  return button;
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function parsedJar(path: string, namespace: string, key = "key"): ParsedModpack {
  return parseModJarFiles([{
    path,
    bytes: zipSync({
      [`assets/${namespace}/lang/en_us.json`]: strToU8(JSON.stringify({
        [key]: `${namespace} value`,
      })),
    }),
  }]);
}

function StatusHarness({ parsed }: { parsed: ParsedModpack }) {
  const [translations, setTranslations] = useState<JapaneseTranslations>({
    example: {
      "item.example.manual": "手動訳",
      "item.example.builtin": "組み込み訳",
    },
  });
  const [translationOrigins, setTranslationOrigins] = useState<
    Record<string, Record<string, "ai" | "manual">>
  >({});
  return (
    <Workspace
      fileName="example.jar"
      parsed={parsed}
      translations={translations}
      onTranslations={setTranslations}
      translationOrigins={translationOrigins}
      onTranslationOrigins={setTranslationOrigins}
      onParsed={vi.fn()}
      glossary={{}}
      onReset={vi.fn()}
    />
  );
}

function statusForKey(container: HTMLElement, key: string): string | undefined {
  const row = Array.from(container.querySelectorAll("tbody tr"))
    .find((candidate) => candidate.querySelector(".key-text")?.textContent === key);
  return row?.querySelector(".translation-status")?.textContent ?? undefined;
}

function browserJar(name: string, namespace: string): File {
  const bytes = zipSync({
    [`assets/${namespace}/lang/en_us.json`]: strToU8(JSON.stringify({ key: "Value" })),
  });
  const file = new File([bytes], name, { type: "application/java-archive" });
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: async () => buffer.slice(0),
  });
  return file;
}

class ParsingWorker {
  onmessage: ((event: MessageEvent<{ result: ParsedModpack }>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(request: { type: "jars"; files: Array<{ path: string; bytes: ArrayBuffer }> }) {
    const result = parseModJarFiles(request.files);
    queueMicrotask(() => this.onmessage?.({ data: { result } } as MessageEvent<{ result: ParsedModpack }>));
  }

  terminate() {}
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "gpu");
});

describe("Workspace translation controls", () => {
  it("shows an extracted MOD icon and falls back when the image cannot load", async () => {
    const parsed = parsedJar("mods/example.jar", "example");
    parsed.mods[0].icon = {
      bytes: Uint8Array.from([137, 80, 78, 71]),
      mimeType: "image/png",
    };
    const NativeURL = URL;
    const createObjectURL = vi.fn((_blob: Blob) => "blob:example-icon");
    const revokeObjectURL = vi.fn();
    class MockURL extends NativeURL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    }
    vi.stubGlobal("URL", MockURL);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <Workspace
          fileName="example.jar"
          parsed={parsed}
          translations={{ example: {} }}
          onTranslations={vi.fn()}
          onParsed={vi.fn()}
          glossary={{}}
          onReset={vi.fn()}
        />,
      );
    });

    const icon = container.querySelector<HTMLImageElement>(".mod-list-icon img")!;
    expect(icon.src).toBe("blob:example-icon");
    expect(icon.alt).toBe("example.jar のアイコン");
    expect(createObjectURL).toHaveBeenCalledOnce();

    await act(async () => icon.dispatchEvent(new Event("error")));
    expect(container.querySelector(".mod-list-icon img")).toBeNull();
    expect(container.querySelector(".mod-list-icon svg")).toBeTruthy();

    await act(async () => root.unmount());
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:example-icon");
    container.remove();
  });

  it("shows the first available JAR icon for each namespace and keeps the placeholder otherwise", async () => {
    const parsed = parsedJar("mods/no-icon.jar", "shared");
    parsed.mods[0].namespaces.push("plain");
    parsed.mods.push({
      jarPath: "mods/with-icon.jar",
      jarName: "with-icon.jar",
      namespaces: ["shared"],
      metadata: { loader: "fabric", modId: "with_icon" },
      icon: {
        bytes: Uint8Array.from([82, 73, 70, 70]),
        mimeType: "image/webp",
      },
    });
    parsed.namespaces.shared.jarPaths.push("mods/with-icon.jar");
    parsed.namespaces.plain = {
      namespace: "plain",
      entries: { plain_key: "Plain value" },
      existingJapanese: {},
      jarPaths: ["mods/no-icon.jar"],
    };

    const NativeURL = URL;
    let nextIconUrl = 0;
    const createObjectURL = vi.fn((_blob: Blob) => `blob:namespace-icon-${nextIconUrl++}`);
    const revokeObjectURL = vi.fn();
    class MockURL extends NativeURL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    }
    vi.stubGlobal("URL", MockURL);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <Workspace
          fileName="example.zip"
          parsed={parsed}
          translations={{ plain: {}, shared: {} }}
          onTranslations={vi.fn()}
          onParsed={vi.fn()}
          glossary={{}}
          onReset={vi.fn()}
        />,
      );
    });

    const namespaceButton = (namespace: string) => Array.from(
      container.querySelectorAll<HTMLButtonElement>(".namespace-button"),
    ).find((button) => button.querySelector(".namespace-name")?.textContent === namespace)!;
    const sharedIcon = namespaceButton("shared")
      .querySelector<HTMLImageElement>(".namespace-icon img")!;
    expect(sharedIcon).toBeTruthy();
    expect(sharedIcon.alt).toBe("shared のアイコン");
    expect(sharedIcon.src).toMatch(/^blob:namespace-icon-/);
    expect(namespaceButton("plain").querySelector(".namespace-icon img")).toBeNull();
    expect(namespaceButton("plain").querySelector(".namespace-icon svg")).toBeTruthy();
    expect(createObjectURL.mock.calls.every(([blob]) => (blob as Blob).type === "image/webp"))
      .toBe(true);

    const sharedIconUrl = sharedIcon.src;
    await act(async () => root.unmount());
    expect(revokeObjectURL).toHaveBeenCalledWith(sharedIconUrl);
    container.remove();
  });

  it("shows untranslated, AI, manual, and builtin status tags for each key", async () => {
    const parsed: ParsedModpack = {
      mods: [{
        jarPath: "example.jar",
        jarName: "example.jar",
        namespaces: ["example"],
        metadata: { loader: "fabric", modId: "example" },
      }],
      sources: [],
      namespaces: {
        example: {
          namespace: "example",
          entries: {
            "item.example.untranslated": "Untranslated",
            "item.example.ai": "AI target",
            "item.example.manual": "Manual",
            "item.example.builtin": "Builtin",
          },
          existingJapanese: { "item.example.builtin": "組み込み訳" },
          jarPaths: ["example.jar"],
        },
      },
      warnings: [],
    };
    vi.spyOn(LfmTranslator.prototype, "load").mockResolvedValue();
    vi.spyOn(LfmTranslator.prototype, "translate").mockResolvedValue({
      translations: { "item.example.ai": "AI訳" },
      rejected: ["item.example.untranslated"],
    });
    vi.spyOn(LfmTranslator.prototype, "dispose").mockResolvedValue();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<StatusHarness parsed={parsed} />));

    expect(statusForKey(container, "item.example.untranslated")).toBe("未翻訳");
    expect(statusForKey(container, "item.example.manual")).toBe("手動修正");
    expect(statusForKey(container, "item.example.builtin")).toBe("ビルトイン");

    await act(async () => {
      buttonWithText(container, "未翻訳をAI翻訳").click();
      await nextTurn();
      await nextTurn();
    });

    expect(statusForKey(container, "item.example.untranslated")).toBe("未翻訳");
    expect(statusForKey(container, "item.example.ai")).toBe("AI翻訳済み");

    const builtinInput = container.querySelector<HTMLTextAreaElement>(
      '[aria-label="item.example.builtin の日本語訳"]',
    )!;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      valueSetter?.call(builtinInput, "編集した訳");
      builtinInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(statusForKey(container, "item.example.builtin")).toBe("手動修正");

    await act(async () => root.unmount());
    container.remove();
  });

  it("uses the LFM WebAssembly runtime when WebGPU is unavailable", async () => {
    const parsed: ParsedModpack = {
      mods: [{
        jarPath: "mods/example.jar",
        jarName: "example.jar",
        namespaces: ["example"],
        metadata: { loader: "fabric", modId: "example" },
      }],
      sources: [],
      namespaces: {
        example: {
          namespace: "example",
          entries: { "item.example.copper": "Copper Ingot" },
          existingJapanese: {},
          jarPaths: ["mods/example.jar"],
        },
      },
      warnings: [],
    };
    const load = vi.spyOn(LfmTranslator.prototype, "load").mockResolvedValue();
    const translate = vi.spyOn(LfmTranslator.prototype, "translate").mockResolvedValue({
      translations: { "item.example.copper": "銅インゴット" },
      rejected: [],
    });
    const dispose = vi.spyOn(LfmTranslator.prototype, "dispose").mockResolvedValue();
    const onTranslations = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <Workspace
          fileName="example.zip"
          parsed={parsed}
          translations={{ example: {} }}
          onTranslations={onTranslations}
          onParsed={vi.fn()}
          glossary={{ Copper: "銅" }}
          onReset={vi.fn()}
        />,
      );
    });

    expect((container.querySelector("#model") as HTMLSelectElement).value)
      .toBe("lfm2_5_1_2b_jp");
    expect(container.textContent).toContain("WASM / CPU（1スレッド・WebGPU不要）");

    await act(async () => {
      buttonWithText(container, "未翻訳をAI翻訳").click();
      await nextTurn();
      await nextTurn();
    });

    expect(load).toHaveBeenCalledWith("lfm2_5_1_2b_jp", expect.any(Function));
    expect(translate).toHaveBeenCalledOnce();
    expect(onTranslations).toHaveBeenCalledWith({
      example: { "item.example.copper": "銅インゴット" },
    });
    expect(dispose).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("WebGPUが必要です");

    await act(async () => root.unmount());
    container.remove();
  });

  it("pauses and retries an unfinished batch, then stops while retaining completed translations", async () => {
    Object.defineProperty(navigator, "gpu", { configurable: true, value: {} });
    const entries = Object.fromEntries(
      Array.from({ length: 26 }, (_, index) => [`item.example.${index}`, `Example ${index}`]),
    );
    const parsed: ParsedModpack = {
      mods: [{
        jarPath: "mods/example.jar",
        jarName: "example.jar",
        namespaces: ["example"],
        metadata: { loader: "fabric", modId: "example" },
      }],
      sources: [],
      namespaces: {
        example: {
          namespace: "example",
          entries,
          existingJapanese: {},
          jarPaths: ["mods/example.jar"],
        },
      },
      warnings: [],
    };

    vi.spyOn(GemmaTranslator.prototype, "load").mockResolvedValue();
    const dispose = vi.spyOn(GemmaTranslator.prototype, "dispose").mockResolvedValue();
    const translate = vi.spyOn(GemmaTranslator.prototype, "translate")
      .mockImplementation(async (batch, _glossary, signal): Promise<TranslationResult> => {
        if (batch.length === 25) {
          return {
            translations: Object.fromEntries(batch.map((entry) => [entry.key, `訳: ${entry.source}`])),
            rejected: [],
          };
        }

        return await new Promise<TranslationResult>((_resolve, reject) => {
          const abort = () => reject(signal?.reason);
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      });

    let translations: JapaneseTranslations = { example: {} };
    const onTranslations = vi.fn((next: JapaneseTranslations) => {
      translations = next;
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <Workspace
          fileName="example.zip"
          parsed={parsed}
          translations={translations}
          onTranslations={onTranslations}
          onParsed={vi.fn()}
          glossary={{}}
          onReset={vi.fn()}
        />,
      );
    });

    await act(async () => {
      buttonWithText(container, "未翻訳をAI翻訳").click();
      await nextTurn();
    });

    expect(buttonWithText(container, "一時停止").disabled).toBe(false);
    expect(buttonWithText(container, "終了").disabled).toBe(false);
    expect(buttonWithText(container, "MODを追加").disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="mods/example.jar を削除"]')?.disabled)
      .toBe(true);
    expect(Object.keys(translations.example)).toHaveLength(25);

    await act(async () => {
      buttonWithText(container, "一時停止").click();
      await nextTurn();
    });

    expect(buttonWithText(container, "再開").getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("モデルはメモリに保持されています");
    expect(dispose).not.toHaveBeenCalled();

    await act(async () => {
      buttonWithText(container, "再開").click();
      await nextTurn();
    });

    expect(translate).toHaveBeenCalledTimes(3);
    expect(translate.mock.calls[1][0]).toEqual(translate.mock.calls[2][0]);

    await act(async () => {
      buttonWithText(container, "終了").click();
      await nextTurn();
      await nextTurn();
    });

    expect(dispose).toHaveBeenCalledOnce();
    expect(Object.keys(translations.example)).toHaveLength(25);
    expect(translations.example["item.example.25"]).toBeUndefined();
    expect(container.textContent).toContain("モデルはアンロードされました");
    expect(buttonWithText(container, "未翻訳をAI翻訳").disabled).toBe(false);
    expect(buttonWithText(container, "MODを追加").disabled).toBe(false);

    await act(async () => root.unmount());
    container.remove();
  });

  it("adds a JAR from an accessible modal and merges its parsed sources", async () => {
    vi.stubGlobal("Worker", ParsingWorker);
    const parsed = parsedJar("first.jar", "first");
    const onParsed = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <Workspace
          fileName="first.jar"
          parsed={parsed}
          translations={{ first: {} }}
          onTranslations={vi.fn()}
          onParsed={onParsed}
          glossary={{}}
          onReset={vi.fn()}
        />,
      );
    });

    await act(async () => buttonWithText(container, "MODを追加").click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.getAttribute("aria-labelledby")).toBe("add-mod-title");
    const input = dialog?.querySelector<HTMLInputElement>('input[accept*=".jar"]');
    expect(input).toBeTruthy();
    Object.defineProperty(input!, "files", {
      configurable: true,
      value: [browserJar("second.jar", "second")],
    });

    await act(async () => {
      input!.dispatchEvent(new Event("change", { bubbles: true }));
      await nextTurn();
    });

    expect(onParsed).toHaveBeenCalledOnce();
    const next = onParsed.mock.calls[0][0] as ParsedModpack;
    expect(next.mods.map((mod) => mod.jarPath)).toEqual(["first.jar", "second.jar"]);
    expect(Object.keys(next.namespaces).sort()).toEqual(["first", "second"]);
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

  it("opens the resource-pack export modal with initialized and folded settings", async () => {
    const parsed = parsedJar("mods/example.jar", "example");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <Workspace
          fileName="example.zip"
          parsed={parsed}
          translations={{ example: { key: "訳" } }}
          onTranslations={vi.fn()}
          onParsed={vi.fn()}
          glossary={{}}
          onReset={vi.fn()}
        />,
      );
    });

    await act(async () => buttonWithText(container, "リソースパックを書き出す").click());

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector("h2")?.textContent).toBe("リソースパックを書き出す");
    expect(dialog.querySelector<HTMLInputElement>("#resource-pack-name")?.value)
      .toBe("example-ja_jp");
    expect(dialog.querySelector<HTMLInputElement>("#resource-pack-version")?.value)
      .toBe("v1");
    const minecraftVersion = dialog.querySelector<HTMLSelectElement>("#target-minecraft-version")!;
    expect(minecraftVersion.value).toBe("34");
    expect(minecraftVersion.selectedOptions[0].textContent)
      .toContain("Minecraft Java 1.21–1.21.1（pack format 34）");
    expect(Array.from(minecraftVersion.options).map((option) => option.textContent))
      .toContain("Minecraft Java 26.1（pack format 84）");
    expect(container.querySelector("#pack-format")).toBeNull();
    expect(dialog.querySelector<HTMLInputElement>("#resource-pack-icon")?.accept)
      .toContain("image/png");

    const modPicker = dialog.querySelector<HTMLDetailsElement>(".export-mod-picker")!;
    expect(modPicker.open).toBe(false);
    expect(modPicker.querySelector("summary")?.textContent).toContain("1 / 1件");
    const checkboxes = modPicker.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0].checked).toBe(false);
    expect(checkboxes[1].checked).toBe(true);

    await act(async () => checkboxes[1].click());
    expect(buttonWithText(dialog, "ZIPを書き出す").disabled).toBe(true);
    expect(dialog.textContent).toContain("書き出すMODを1件以上選択してください");

    await act(async () => root.unmount());
    container.remove();
  });

  it("shows an error instead of adding the same jarPath twice", async () => {
    vi.stubGlobal("Worker", ParsingWorker);
    const parsed = parsedJar("example.jar", "example");
    const onParsed = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <Workspace
          fileName="example.jar"
          parsed={parsed}
          translations={{ example: {} }}
          onTranslations={vi.fn()}
          onParsed={onParsed}
          glossary={{}}
          onReset={vi.fn()}
        />,
      );
    });
    await act(async () => buttonWithText(container, "MODを追加").click());
    const input = container.querySelector<HTMLInputElement>('[role="dialog"] input[accept*=".jar"]')!;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [browserJar("example.jar", "example")],
    });

    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await nextTurn();
    });

    expect(onParsed).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("すでに読み込まれています");

    await act(async () => root.unmount());
    container.remove();
  });

  it("confirms removal, rebuilds parsed data, and restores focus after Escape", async () => {
    const parsed = parsedJar("mods/example.jar", "example");
    const onParsed = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <Workspace
          fileName="example.zip"
          parsed={parsed}
          translations={{ example: { key: "ユーザー訳" } }}
          onTranslations={vi.fn()}
          onParsed={onParsed}
          glossary={{}}
          onReset={vi.fn()}
        />,
      );
    });

    const removeButton = container.querySelector<HTMLButtonElement>('[aria-label="mods/example.jar を削除"]')!;
    removeButton.focus();
    await act(async () => removeButton.click());
    expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-describedby"))
      .toBe("remove-mod-description");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(removeButton);

    await act(async () => removeButton.click());
    await act(async () => buttonWithText(container, "削除する").click());

    expect(onParsed).toHaveBeenCalledOnce();
    const next = onParsed.mock.calls[0][0] as ParsedModpack;
    expect(next.mods).toEqual([]);
    expect(next.sources).toEqual([]);
    expect(next.namespaces).toEqual({});

    await act(async () => root.unmount());
    container.remove();
  });
});
