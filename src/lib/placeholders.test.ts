import { describe, expect, it } from "vitest";
import { categoryFromKey, extractPlaceholders, validatePlaceholders } from "./placeholders";

describe("placeholder utilities", () => {
  it("extracts Minecraft and printf placeholders", () => {
    expect(extractPlaceholders("§aEnergy: %1$s / %d\\n{0}"))
      .toEqual(["§a", "%1$s", "%d", "\\n", "{0}"]);
  });

  it("allows reordered placeholders but rejects missing ones", () => {
    expect(validatePlaceholders("%s: %d", "%d：%s")).toBe(true);
    expect(validatePlaceholders("%s: %d", "%s")).toBe(false);
  });

  it("groups translation keys", () => {
    expect(categoryFromKey("item.examplemod.wrench")).toBe("item");
    expect(categoryFromKey("")).toBe("other");
  });
});
