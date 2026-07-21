import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App, { reconcileTranslations, selectionFromDrop } from "./App";
import type { ParsedModpack } from "./lib/modArchive";

function directoryReader(batches: FileSystemEntry[][]): FileSystemDirectoryReader {
  let index = 0;
  return {
    readEntries(callback) {
      callback(batches[index++] ?? []);
    },
  } as FileSystemDirectoryReader;
}

describe("App", () => {
  it("renders the Japanese upload workspace", () => {
    const html = renderToString(<App />);

    expect(html).toContain("CraftLingo");
    expect(html).toContain("ZIP・JAR・フォルダーをドロップ");
    expect(html).toContain("ZIP / JARを選択");
    expect(html).toContain("フォルダーを選択");
    expect(html).toContain("100% ローカル処理");
  });

  it("opens the mobile sidebar and closes it after navigating to the glossary", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<App />));
    const menuButton = container.querySelector<HTMLButtonElement>('[aria-controls="main-sidebar"]')!;
    expect(menuButton.getAttribute("aria-expanded")).toBe("false");

    await act(async () => menuButton.click());
    expect(menuButton.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("#main-sidebar")?.classList.contains("open")).toBe(true);
    expect(container.textContent).toContain("翻訳履歴");

    const glossaryButton = Array.from(container.querySelectorAll<HTMLButtonElement>(".nav-item"))
      .find((button) => button.textContent?.includes("共通用語集"))!;
    await act(async () => glossaryButton.click());

    expect(menuButton.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("#main-sidebar")?.classList.contains("open")).toBe(false);
    expect(container.querySelector(".glossary-page h1")?.textContent).toBe("共通用語集");

    await act(async () => root.unmount());
    container.remove();
  });

  it("recursively collects dropped folder files with their relative paths", async () => {
    const jarFile = new File(["jar bytes"], "example.jar");
    const readNested = directoryReader([
      [],
    ]);
    const fileEntry = {
      isFile: true,
      isDirectory: false,
      name: "example.jar",
      fullPath: "/mods/optional/example.jar",
      file: (callback: FileCallback) => callback(jarFile),
    } as FileSystemFileEntry;
    // Returning entries in more than one batch verifies that recursion keeps
    // reading until the API signals completion with an empty batch.
    let nestedRead = 0;
    readNested.readEntries = (callback) => {
      callback(nestedRead++ === 0 ? [fileEntry] : []);
    };
    const nestedEntry = {
      isFile: false,
      isDirectory: true,
      name: "optional",
      fullPath: "/mods/optional",
      createReader: () => readNested,
    } as FileSystemDirectoryEntry;
    const rootEntry = {
      isFile: false,
      isDirectory: true,
      name: "mods",
      fullPath: "/mods",
      createReader: () => directoryReader([[nestedEntry], []]),
    } as FileSystemDirectoryEntry;
    const dataTransfer = {
      items: [{ kind: "file", webkitGetAsEntry: () => rootEntry }],
      files: [],
    } as unknown as DataTransfer;

    const selected = await selectionFromDrop(dataTransfer);

    expect(selected).toMatchObject({ label: "mods", source: "folder" });
    expect(selected?.files).toEqual([{
      file: jarFile,
      path: "mods/optional/example.jar",
    }]);
  });

  it("keeps user translations only for keys that survive a MOD change", () => {
    const parsed: ParsedModpack = {
      mods: [],
      sources: [],
      warnings: [],
      namespaces: {
        shared: {
          namespace: "shared",
          entries: { kept: "Kept", added: "Added" },
          existingJapanese: { added: "追加済み", bundled_only: "同梱" },
          jarPaths: ["second.jar"],
        },
      },
    };

    expect(reconcileTranslations(parsed, {
      shared: { kept: "ユーザー訳", removed: "削除対象" },
      deleted_namespace: { old: "削除対象" },
    })).toEqual({
      shared: {
        kept: "ユーザー訳",
        added: "追加済み",
        bundled_only: "同梱",
      },
    });
  });
});
