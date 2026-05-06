import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildSecretRefCredentialMatrix,
  type SecretRefCredentialMatrixDocument,
} from "./credential-matrix.js";

function buildSecretRefCredentialMatrixJson(): string {
  return `${JSON.stringify(buildSecretRefCredentialMatrix(), null, 2)}\n`;
}

const previousBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const previousTrustBundledPluginsDir = process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;

process.env.OPENCLAW_BUNDLED_PLUGINS_DIR ??= "extensions";
process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR ??= "1";

afterAll(() => {
  if (previousBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = previousBundledPluginsDir;
  }
  if (previousTrustBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = previousTrustBundledPluginsDir;
  }
});

describe("secret target registry docs", () => {
  it("stays in sync with docs/reference/secretref-user-supplied-credentials-matrix.json", () => {
    const pathname = path.join(
      process.cwd(),
      "docs",
      "reference",
      "secretref-user-supplied-credentials-matrix.json",
    );
    const raw = fs.readFileSync(pathname, "utf8");
    const expected = buildSecretRefCredentialMatrixJson();

    expect(raw).toBe(expected);
  });

  it("stays in sync with docs/reference/secretref-credential-surface.md", () => {
    const matrixPath = path.join(
      process.cwd(),
      "docs",
      "reference",
      "secretref-user-supplied-credentials-matrix.json",
    );
    const matrixRaw = fs.readFileSync(matrixPath, "utf8");
    const matrix = JSON.parse(matrixRaw) as SecretRefCredentialMatrixDocument;

    const surfacePath = path.join(
      process.cwd(),
      "docs",
      "reference",
      "secretref-credential-surface.md",
    );
    const surface = fs.readFileSync(surfacePath, "utf8");
    const readMarkedCredentialList = (params: { start: string; end: string }): Set<string> => {
      const startIndex = surface.indexOf(params.start);
      const endIndex = surface.indexOf(params.end);
      expect(startIndex).toBeGreaterThanOrEqual(0);
      expect(endIndex).toBeGreaterThan(startIndex);
      const block = surface.slice(startIndex + params.start.length, endIndex);
      const credentials = new Set<string>();
      for (const line of block.split(/\r?\n/)) {
        const match = line.match(/^- `([^`]+)`/);
        if (!match) {
          continue;
        }
        const candidate = match[1];
        if (!candidate.includes(".")) {
          continue;
        }
        credentials.add(candidate);
      }
      return credentials;
    };

    const supportedFromDocs = readMarkedCredentialList({
      start: '[//]: # "secretref-supported-list-start"',
      end: '[//]: # "secretref-supported-list-end"',
    });
    const unsupportedFromDocs = readMarkedCredentialList({
      start: '[//]: # "secretref-unsupported-list-start"',
      end: '[//]: # "secretref-unsupported-list-end"',
    });

    const supportedFromMatrix = new Set(
      matrix.entries.map((entry) =>
        entry.configFile === "auth-profiles.json" && entry.refPath ? entry.refPath : entry.path,
      ),
    );
    const unsupportedFromMatrix = new Set(matrix.excludedMutableOrRuntimeManaged);

    expect([...supportedFromDocs].toSorted()).toEqual([...supportedFromMatrix].toSorted());
    expect([...unsupportedFromDocs].toSorted()).toEqual([...unsupportedFromMatrix].toSorted());
  });
});
