import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import {
  buildJapaneseResourcePack,
  mergeParsedModpacks,
  parseLegacyLang,
  parseModJarFiles,
  parseModpackArchive,
  removeModFromParsedModpack,
} from "./modArchive";

function encodedFiles(files: Record<string, string>): Record<string, Uint8Array> {
  return Object.fromEntries(
    Object.entries(files).map(([path, contents]) => [path, strToU8(contents)]),
  );
}

function jar(files: Record<string, string>): Uint8Array {
  return zipSync(encodedFiles(files));
}

function modpack(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files);
}

function decodedJson(bytes: Uint8Array): unknown {
  return JSON.parse(strFromU8(bytes));
}

describe("parseLegacyLang", () => {
  it("parses comments, escaped separators, unicode, and continued lines", () => {
    const parsed = parseLegacyLang(String.raw`
# Old Forge language file
item.example.name=Steel\ Wrench
tooltip.example=First \
line
key\=with\=equals:値\u3002
`);

    expect({ ...parsed }).toEqual({
      "item.example.name": "Steel Wrench",
      "tooltip.example": "First line",
      "key=with=equals": "値。",
    });
  });
});

describe("parseModpackArchive", () => {
  it("extracts every namespace and keeps bundled Japanese translations", () => {
    const fabricJar = jar({
      "fabric.mod.json": JSON.stringify({
        schemaVersion: 1,
        id: "example",
        name: "Example Mod",
        version: "1.2.3",
        depends: { minecraft: ">=1.21" },
      }),
      "assets/example/lang/en_us.lang": [
        "item.example.wrench=Old Wrench",
        "item.example.gear=Gear",
      ].join("\n"),
      "assets/example/lang/en_us.json": JSON.stringify({
        "item.example.wrench": "Wrench",
        "block.example.machine": "Machine",
      }),
      "assets/example/lang/ja_jp.json": JSON.stringify({
        "item.example.wrench": "レンチ",
      }),
      "assets/helper/lang/en_US.lang": "gui.helper.title=Helper Screen",
    });
    const forgeJar = jar({
      "META-INF/mods.toml": [
        "[[mods]]",
        'modId="forge_example"',
        'version="2.0.0"',
        'displayName="Forge Example"',
        "[[dependencies.forge_example]]",
        'modId="minecraft"',
        'versionRange="[1.20.1,1.21)"',
      ].join("\n"),
      "assets/forge_example/lang/en_us.json": JSON.stringify({
        "item.forge_example.hammer": "Hammer",
      }),
      "assets/forge_example/lang/ja_JP.lang":
        "item.forge_example.hammer=ハンマー",
    });

    const parsed = parseModpackArchive(
      modpack({
        "mods/example.jar": fabricJar,
        "optional/forge-example.JAR": forgeJar,
        "README.txt": strToU8("ignored"),
      }),
    );

    expect(parsed.warnings).toEqual([]);
    expect(parsed.mods).toHaveLength(2);
    expect(parsed.mods[0]).toMatchObject({
      jarPath: "mods/example.jar",
      namespaces: ["example", "helper"],
      metadata: {
        loader: "fabric",
        modId: "example",
        name: "Example Mod",
        version: "1.2.3",
        minecraftVersion: ">=1.21",
      },
    });
    expect(parsed.mods[1].metadata).toEqual({
      loader: "forge",
      modId: "forge_example",
      name: "Forge Example",
      version: "2.0.0",
      minecraftVersion: "[1.20.1,1.21)",
    });
    expect({ ...parsed.namespaces.example.entries }).toEqual({
      "item.example.wrench": "Wrench",
      "item.example.gear": "Gear",
      "block.example.machine": "Machine",
    });
    expect({ ...parsed.namespaces.example.existingJapanese }).toEqual({
      "item.example.wrench": "レンチ",
    });
    expect({ ...parsed.namespaces.helper.entries }).toEqual({
      "gui.helper.title": "Helper Screen",
    });
    expect(parsed.sources.find((source) => source.namespace === "example")).toMatchObject({
      jarName: "example.jar",
      englishPath: "assets/example/lang/en_us.json",
      japanesePath: "assets/example/lang/ja_jp.json",
    });
  });

  it("returns useful warnings without discarding translations from valid JARs", () => {
    const validJar = jar({
      "assets/shared/lang/en_us.json": JSON.stringify({ greeting: "Hello" }),
      "assets/broken/lang/en_us.json": "[]",
    });
    const conflictingJar = jar({
      "assets/shared/lang/en_us.json": JSON.stringify({ greeting: "Hi" }),
    });

    const parsed = parseModpackArchive(
      modpack({
        "a.jar": validJar,
        "b.jar": conflictingJar,
        "not-a-zip.jar": strToU8("broken"),
      }),
    );

    expect(parsed.namespaces.shared.entries.greeting).toBe("Hello");
    expect(parsed.warnings.map((warning) => warning.code)).toEqual([
      "INVALID_LANGUAGE_FILE",
      "DUPLICATE_NAMESPACE_KEY",
      "INVALID_JAR",
    ]);
  });

  it("reports an invalid outer ZIP as data instead of throwing", () => {
    const parsed = parseModpackArchive(strToU8("not a zip"));

    expect(parsed.mods).toEqual([]);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0].code).toBe("INVALID_OUTER_ZIP");
  });
});

describe("parseModJarFiles", () => {
  it("parses a directly selected JAR and preserves its relative path", () => {
    const parsed = parseModJarFiles([{
      path: "selected/example.jar",
      bytes: jar({
        "fabric.mod.json": JSON.stringify({
          id: "direct_example",
          name: "Direct Example",
          version: "3.0.0",
        }),
        "assets/direct_example/lang/en_us.json": JSON.stringify({ greeting: "Hello" }),
      }),
    }]);

    expect(parsed.warnings).toEqual([]);
    expect(parsed.mods[0]).toMatchObject({
      jarPath: "selected/example.jar",
      jarName: "example.jar",
      metadata: { loader: "fabric", modId: "direct_example", version: "3.0.0" },
    });
    expect(parsed.sources[0].jarPath).toBe("selected/example.jar");
    expect(parsed.namespaces.direct_example.jarPaths).toEqual(["selected/example.jar"]);
    expect(parsed.namespaces.direct_example.entries.greeting).toBe("Hello");
  });

  it("sorts recursively discovered JARs and reports warnings with folder paths", () => {
    const parsed = parseModJarFiles([
      {
        path: "pack/z/deep/broken.jar",
        bytes: strToU8("not a jar"),
      },
      {
        path: "pack/a/mod.jar",
        bytes: jar({
          "assets/example/lang/en_us.json": JSON.stringify({ key: "Value" }),
        }),
      },
    ]);

    expect(parsed.mods.map((mod) => mod.jarPath)).toEqual(["pack/a/mod.jar"]);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toMatchObject({
      code: "INVALID_JAR",
      path: "pack/z/deep/broken.jar",
    });
  });

  it("extracts a Fabric icon path case-insensitively and without a leading slash", () => {
    const parsed = parseModJarFiles([{
      path: "fabric.jar",
      bytes: jar({
        "fabric.mod.json": JSON.stringify({
          id: "fabric_icon",
          icon: "/assets/fabric_icon/ICON.PNG",
        }),
        "assets/fabric_icon/icon.png": "fabric png",
      }),
    }]);

    expect(parsed.mods[0].icon?.mimeType).toBe("image/png");
    expect(strFromU8(parsed.mods[0].icon!.bytes)).toBe("fabric png");
  });

  it("uses the largest numeric Fabric icon size", () => {
    const parsed = parseModJarFiles([{
      path: "fabric-sized.jar",
      bytes: jar({
        "fabric.mod.json": JSON.stringify({
          id: "fabric_sized_icon",
          icon: {
            "16": "assets/fabric_sized_icon/small.png",
            "128": "assets/fabric_sized_icon/large.webp",
            other: "assets/fabric_sized_icon/ignored.gif",
          },
        }),
        "assets/fabric_sized_icon/small.png": "small",
        "assets/fabric_sized_icon/large.webp": "large",
        "assets/fabric_sized_icon/ignored.gif": "ignored",
      }),
    }]);

    expect(parsed.mods[0].icon?.mimeType).toBe("image/webp");
    expect(strFromU8(parsed.mods[0].icon!.bytes)).toBe("large");
  });

  it("extracts NeoForge and Forge logoFile images", () => {
    const parsed = parseModJarFiles([
      {
        path: "neoforge.jar",
        bytes: jar({
          "META-INF/neoforge.mods.toml": [
            "[[mods]]",
            'modId="neoforge_icon"',
            'logoFile="images/neoforge.jpeg"',
          ].join("\n"),
          "images/neoforge.jpeg": "neoforge jpeg",
        }),
      },
      {
        path: "forge.jar",
        bytes: jar({
          "META-INF/mods.toml": [
            "[[mods]]",
            'modId="forge_icon"',
            'logoFile="forge-logo.gif"',
          ].join("\n"),
          "forge-logo.gif": "forge gif",
        }),
      },
    ]);

    const forge = parsed.mods.find((mod) => mod.jarPath === "forge.jar")!;
    const neoforge = parsed.mods.find((mod) => mod.jarPath === "neoforge.jar")!;
    expect(forge.icon?.mimeType).toBe("image/gif");
    expect(strFromU8(forge.icon!.bytes)).toBe("forge gif");
    expect(neoforge.icon?.mimeType).toBe("image/jpeg");
    expect(strFromU8(neoforge.icon!.bytes)).toBe("neoforge jpeg");
  });

  it("falls back to an icon.png basename and leaves unsupported or missing icons unset", () => {
    const parsed = parseModJarFiles([
      {
        path: "fallback.jar",
        bytes: jar({ "some/deep/Icon.PNG": "fallback png" }),
      },
      {
        path: "unsupported.jar",
        bytes: jar({
          "fabric.mod.json": JSON.stringify({
            id: "unsupported_icon",
            icon: "assets/unsupported/icon.svg",
          }),
          "assets/unsupported/icon.svg": "<svg />",
        }),
      },
      {
        path: "missing.jar",
        bytes: jar({
          "fabric.mod.json": JSON.stringify({
            id: "missing_icon",
            icon: "missing.png",
          }),
        }),
      },
    ]);

    const fallback = parsed.mods.find((mod) => mod.jarPath === "fallback.jar")!;
    expect(fallback.icon?.mimeType).toBe("image/png");
    expect(strFromU8(fallback.icon!.bytes)).toBe("fallback png");
    expect(parsed.mods.find((mod) => mod.jarPath === "unsupported.jar")?.icon).toBeUndefined();
    expect(parsed.mods.find((mod) => mod.jarPath === "missing.jar")?.icon).toBeUndefined();
  });

  it("rebuilds namespaces and duplicate warnings after adding and removing a JAR", () => {
    const first = parseModJarFiles([{
      path: "mods/first.jar",
      bytes: jar({
        "assets/shared/lang/en_us.json": JSON.stringify({
          conflict: "First",
          first_only: "First only",
        }),
        "assets/shared/lang/ja_jp.json": JSON.stringify({ first_only: "一番目" }),
      }),
    }]);
    const second = parseModJarFiles([{
      path: "mods/second.jar",
      bytes: jar({
        "assets/shared/lang/en_us.json": JSON.stringify({
          conflict: "Second",
          second_only: "Second only",
        }),
      }),
    }]);

    const merged = mergeParsedModpacks(first, second);

    expect(merged.namespaces.shared.entries.conflict).toBe("First");
    expect(merged.namespaces.shared.jarPaths).toEqual([
      "mods/first.jar",
      "mods/second.jar",
    ]);
    expect(merged.warnings).toContainEqual(expect.objectContaining({
      code: "DUPLICATE_NAMESPACE_KEY",
      path: "mods/second.jar",
    }));

    const removed = removeModFromParsedModpack(merged, "mods/first.jar");

    expect(removed.mods.map((mod) => mod.jarPath)).toEqual(["mods/second.jar"]);
    expect(removed.sources.every((source) => source.jarPath === "mods/second.jar")).toBe(true);
    expect({ ...removed.namespaces.shared.entries }).toEqual({
      conflict: "Second",
      second_only: "Second only",
    });
    expect(removed.namespaces.shared.existingJapanese).toEqual({});
    expect(removed.namespaces.shared.jarPaths).toEqual(["mods/second.jar"]);
    expect(removed.warnings.some(({ code }) => code === "DUPLICATE_NAMESPACE_KEY")).toBe(false);
  });
});

describe("buildJapaneseResourcePack", () => {
  it("builds one pack, omits unchanged built-ins, and applies edited translations", () => {
    const parsed = parseModpackArchive(
      modpack({
        "one.jar": jar({
          "assets/alpha/lang/en_us.json": JSON.stringify({
            existing: "Existing",
            fresh: "Fresh",
          }),
          "assets/alpha/lang/ja_jp.json": JSON.stringify({
            existing: "既存",
            untouched: "そのまま",
          }),
          "assets/beta/lang/en_us.json": JSON.stringify({ only: "Only" }),
        }),
      }),
    );

    const output = unzipSync(
      buildJapaneseResourcePack(
        parsed,
        {
          alpha: {
            existing: "ユーザー編集",
            fresh: "新規",
            untouched: "そのまま",
          },
          beta: { only: "のみ" },
        },
        { packFormat: 48, description: "Test translations" },
      ),
    );

    expect(Object.keys(output).sort()).toEqual([
      "assets/alpha/lang/ja_jp.json",
      "assets/beta/lang/ja_jp.json",
      "pack.mcmeta",
      "pack.png",
    ]);
    expect([...output["pack.png"].slice(0, 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
    expect([...output["pack.png"].slice(16, 24)]).toEqual([
      0, 0, 0, 16, 0, 0, 0, 16,
    ]);
    expect(decodedJson(output["pack.mcmeta"])).toEqual({
      pack: { pack_format: 48, description: "Test translations" },
    });
    expect(decodedJson(output["assets/alpha/lang/ja_jp.json"])).toEqual({
      existing: "ユーザー編集",
      fresh: "新規",
    });
    expect(decodedJson(output["assets/beta/lang/ja_jp.json"])).toEqual({
      only: "のみ",
    });
  });

  it("uses an exact supported format range for pack formats 65 and newer", () => {
    const parsed = parseModpackArchive(modpack({}));
    const output = unzipSync(buildJapaneseResourcePack(
      parsed,
      {},
      { packFormat: 84, description: "Modern translations" },
    ));

    expect(decodedJson(output["pack.mcmeta"])).toEqual({
      pack: {
        min_format: 84,
        max_format: 84,
        description: "Modern translations",
      },
    });
  });

  it("limits output to selected JAR sources and accepts a custom icon", () => {
    const parsed = parseModpackArchive(
      modpack({
        "mods/one.jar": jar({
          "assets/shared/lang/en_us.json": JSON.stringify({
            first: "First",
          }),
        }),
        "mods/two.jar": jar({
          "assets/shared/lang/en_us.json": JSON.stringify({
            second: "Second",
          }),
          "assets/other/lang/en_us.json": JSON.stringify({
            other: "Other",
          }),
        }),
      }),
    );
    const iconBytes = Uint8Array.from([137, 80, 78, 71, 1, 2, 3]);

    const output = unzipSync(buildJapaneseResourcePack(
      parsed,
      {
        shared: {
          first: "一番目",
          second: "二番目",
          unrelated: "対象外",
        },
        other: { other: "その他" },
      },
      { selectedJarPaths: ["mods/one.jar"], iconBytes },
    ));

    expect(Object.keys(output).sort()).toEqual([
      "assets/shared/lang/ja_jp.json",
      "pack.mcmeta",
      "pack.png",
    ]);
    expect(decodedJson(output["assets/shared/lang/ja_jp.json"])).toEqual({
      first: "一番目",
    });
    expect(output["pack.png"]).toEqual(iconBytes);
  });

  it("optionally includes bundled translations while keeping edits as overrides", () => {
    const parsed = parseModpackArchive(
      modpack({
        "example.jar": jar({
          "assets/example/lang/en_us.json": JSON.stringify({
            edited: "Edited",
            unchanged: "Unchanged",
          }),
          "assets/example/lang/ja_jp.json": JSON.stringify({
            edited: "編集前",
            unchanged: "変更なし",
            japanese_only: "日本語のみ",
          }),
        }),
      }),
    );

    const output = unzipSync(buildJapaneseResourcePack(
      parsed,
      { example: { edited: "編集後", unchanged: "変更なし" } },
      { includeBuiltinTranslations: true },
    ));

    expect(decodedJson(output["assets/example/lang/ja_jp.json"])).toEqual({
      edited: "編集後",
      japanese_only: "日本語のみ",
      unchanged: "変更なし",
    });
  });

  it("rejects invalid pack formats", () => {
    const parsed = parseModpackArchive(modpack({}));
    expect(() =>
      buildJapaneseResourcePack(parsed, {}, { packFormat: 0 }),
    ).toThrow(/positive integer/);
  });
});
