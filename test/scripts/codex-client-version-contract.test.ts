// Codex Client Version Contract tests cover cross-plugin managed version alignment.
import fs from "node:fs";
import { describe, expect, it } from "vitest";

const CODEX_PACKAGE_JSON_URL = new URL("../../extensions/codex/package.json", import.meta.url);
const OPENAI_PROVIDER_URL = new URL("../../extensions/openai/openai-provider.ts", import.meta.url);
const OPENAI_CODEX_CLIENT_VERSION_PATTERN = /^const OPENAI_CODEX_CLIENT_VERSION = "([^"]+)";$/mu;

function readManagedCodexVersion(): string {
  const packageJson = JSON.parse(fs.readFileSync(CODEX_PACKAGE_JSON_URL, "utf8")) as {
    dependencies?: Record<string, unknown>;
  };
  const version = packageJson.dependencies?.["@openai/codex"];
  if (typeof version !== "string") {
    throw new Error("extensions/codex/package.json must pin @openai/codex exactly");
  }
  return version;
}

function readOpenAICodexClientVersion(): string {
  const providerSource = fs.readFileSync(OPENAI_PROVIDER_URL, "utf8");
  const version = OPENAI_CODEX_CLIENT_VERSION_PATTERN.exec(providerSource)?.[1];
  if (!version) {
    throw new Error("extensions/openai/openai-provider.ts must declare the Codex client version");
  }
  return version;
}

describe("Codex client version contract", () => {
  it("matches OpenAI model discovery to the managed Codex package", () => {
    expect(readOpenAICodexClientVersion()).toBe(readManagedCodexVersion());
  });
});
