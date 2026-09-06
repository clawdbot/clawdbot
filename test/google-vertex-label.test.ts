import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const EXPECTED_LABEL = "Gemini Enterprise Agent Platform (Vertex AI)";
const OLD_LABEL = "Google Vertex AI";
const OLD_DOC_HEADING = "Google Vertex and Gemini CLI";
const PROVIDER_ID = "google-vertex";

// Vitest is normally launched from the OpenClaw repository root.
const REPO_ROOT = process.cwd();

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function extractRegexValue(
  relativePath: string,
  text: string,
  pattern: RegExp,
  fieldName: string,
): string {
  const match = text.match(pattern);

  expect(match, `${relativePath}: could not locate ${fieldName}`).not.toBeNull();

  /*
   * The assertion above ensures that match should not be null.
   * This explicit check also satisfies TypeScript's type narrowing.
   */
  if (!match) {
    throw new Error(`${relativePath}: could not locate ${fieldName}`);
  }

  return match[1];
}

describe("Google Vertex provider label regression", () => {
  it("uses the new built-in provider display name", () => {
    const relativePath = "src/agents/sessions/provider-display-names.ts";
    const text = readText(relativePath);

    const actualLabel = extractRegexValue(
      relativePath,
      text,
      /"google-vertex":\s*"([^"]+)"/s,
      "built-in provider display name for google-vertex",
    );

    expect(actualLabel).toBe(EXPECTED_LABEL);
    expect(text).not.toContain(OLD_LABEL);
  });

  it("keeps the stable provider ID and new provider contract label", () => {
    const relativePath = "extensions/google/provider-contract-api.ts";
    const text = readText(relativePath);

    const providerBlockMatch = text.match(
      /export function createGoogleVertexProvider\(\): ProviderPlugin\s*\{\s*return\s*\{(?<body>[\s\S]*?)\n\s*\};\s*\}/,
    );

    expect(
      providerBlockMatch,
      `${relativePath}: could not locate createGoogleVertexProvider()`,
    ).not.toBeNull();

    if (!providerBlockMatch?.groups?.body) {
      throw new Error(`${relativePath}: could not locate createGoogleVertexProvider() body`);
    }

    const providerBlock = providerBlockMatch.groups.body;

    expect(providerBlock).toContain(`id: "${PROVIDER_ID}"`);

    const actualLabel = extractRegexValue(
      relativePath,
      providerBlock,
      /label:\s*"([^"]+)"/s,
      "provider contract label for google-vertex",
    );

    expect(actualLabel).toBe(EXPECTED_LABEL);
    expect(providerBlock).not.toContain(OLD_LABEL);
  });

  it("registers the Google Vertex provider", () => {
    const relativePath = "extensions/google/setup-api.ts";
    const text = readText(relativePath);

    expect(text).toContain("createGoogleVertexProvider");
    expect(text).toContain("api.registerProvider(createGoogleVertexProvider());");
  });

  it("uses the new provider label in the documentation", () => {
    const relativePath = "docs/concepts/model-providers.md";
    const text = readText(relativePath);

    expect(text).toContain(EXPECTED_LABEL);
    expect(text).not.toContain(OLD_DOC_HEADING);
  });

  it("keeps google-vertex in the plugin manifest", () => {
    const relativePath = "extensions/google/openclaw.plugin.json";
    const text = readText(relativePath);

    const manifest = JSON.parse(text) as {
      providers?: unknown;
    };

    expect(Array.isArray(manifest.providers)).toBe(true);

    if (!Array.isArray(manifest.providers)) {
      throw new Error(`${relativePath}: providers must be an array`);
    }

    expect(manifest.providers).toContain(PROVIDER_ID);
  });

  it("keeps the runtime provider ID while updating user-facing errors", () => {
    const relativePath = "packages/ai/src/providers/google-vertex.ts";
    const text = readText(relativePath);

    expect(text).toContain('StreamFunction<"google-vertex"');
    expect(text).toContain('createGoogleAssistantOutput(model, "google-vertex")');

    expect(text).toContain(`"${EXPECTED_LABEL} requires a project ID.`);
    expect(text).toContain(`"${EXPECTED_LABEL} requires a location.`);

    expect(text).not.toContain(OLD_LABEL);
    expect(text).not.toContain("Vertex AI requires");
  });

  it("uses the built-in provider display-name fallback", () => {
    const relativePath = "src/agents/sessions/model-registry.ts";
    const text = readText(relativePath);

    expect(text).toContain("BUILT_IN_PROVIDER_DISPLAY_NAMES[provider]");
  });
});
