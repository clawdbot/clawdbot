import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCommandReferenceMarkdown,
  COMMAND_REFERENCE_DOC_PATH,
  runCommandReferenceGenerator,
} from "../../scripts/generate-command-reference-doc.js";

describe("generate command reference docs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the checked-in command reference current", () => {
    expect(readFileSync(COMMAND_REFERENCE_DOC_PATH, "utf8")).toBe(buildCommandReferenceMarkdown());
  });

  it("documents public static commands and unknown effect semantics", () => {
    const content = buildCommandReferenceMarkdown();

    expect(content).toContain("`tools`");
    expect(content).toContain("`config`");
    expect(content).toContain("An **Unknown** effect");
    expect(content).not.toContain("undefined");
  });

  it("requires exactly one update mode", () => {
    expect(runCommandReferenceGenerator([])).toBe(1);
    expect(runCommandReferenceGenerator(["--write", "--check"])).toBe(1);
  });

  it("keeps public docs stable when private command gates are enabled", () => {
    const baseline = buildCommandReferenceMarkdown();
    vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "1");
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");

    expect(buildCommandReferenceMarkdown()).toBe(baseline);
    expect(process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI).toBe("1");
    expect(process.env.OPENCLAW_EXPERIMENTAL_CLAWS).toBe("1");
  });
});
