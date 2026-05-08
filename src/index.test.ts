import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { applyTemplate, runLegacyCliEntry } from "./index.js";

describe("legacy root entry", () => {
  it("routes the package root export to the pure library entry", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      exports?: Record<string, unknown>;
      main?: string;
    };

    expect(packageJson.main).toBe("dist/index.js");
    expect(packageJson.exports?.["."]).toBe("./dist/index.js");
  });

  it("does not run CLI bootstrap when imported as a library dependency", async () => {
    const runCli = vi.fn(async () => undefined);

    expect(applyTemplate("Hello {{MessageSid}}", { MessageSid: "operator" })).toBe(
      "Hello operator",
    );

    await runLegacyCliEntry(["openclaw", "status"], { runCli });
    expect(runCli).toHaveBeenCalledWith(["openclaw", "status"]);
  });
});
