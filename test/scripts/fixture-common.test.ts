// Fixture Common tests cover shared E2E fixture file/assertion helpers.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assert,
  json,
  readJson,
  requireArg,
  write,
  writeJson,
} from "../../scripts/e2e/lib/fixtures/common.mjs";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("fixture common helpers", () => {
  it("writes nested text and formatted JSON files", () => {
    const root = makeTempDir(tempDirs, "openclaw-fixture-common-");
    const textPath = path.join(root, "nested", "fixture.txt");
    const jsonPath = path.join(root, "config", "fixture.json");

    write(textPath, "contents");
    writeJson(jsonPath, { enabled: true, nested: { value: 1 } });

    expect(readFileSync(textPath, "utf8")).toBe("contents");
    expect(readFileSync(jsonPath, "utf8")).toBe(
      `${JSON.stringify({ enabled: true, nested: { value: 1 } }, null, 2)}\n`,
    );
    expect(readJson(jsonPath)).toEqual({ enabled: true, nested: { value: 1 } });
    expect(json({ ok: true })).toBe(`${JSON.stringify({ ok: true }, null, 2)}\n`);
  });

  it("rejects missing required arguments and failed assertions", () => {
    expect(requireArg("value", "field")).toBe("value");
    expect(() => requireArg("", "field")).toThrow("field is required");
    expect(() => assert(false, "fixture failed")).toThrow("fixture failed");
    expect(() => assert(true, "fixture failed")).not.toThrow();
  });
});
