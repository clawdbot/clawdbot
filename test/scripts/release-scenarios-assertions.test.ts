import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/release-scenarios/assertions.mjs";
const DISABLE_EXPERIMENTAL_WARNING = "--disable-warning=ExperimentalWarning";

function nodeOptionsWithoutExperimentalWarnings(): string {
  const current = process.env.NODE_OPTIONS ?? "";
  return current.includes(DISABLE_EXPERIMENTAL_WARNING)
    ? current
    : [current, DISABLE_EXPERIMENTAL_WARNING].filter(Boolean).join(" ");
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runAssertion(args: string[]) {
  return spawnSync(process.execPath, [ASSERTIONS_SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(),
    },
  });
}

describe("release scenario assertions", () => {
  it("scans large files when checking release scenario output text", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-scenarios-"));
    const outputPath = path.join(root, "output.log");

    try {
      const needlePrefix = "release-market";
      writeFileSync(
        outputPath,
        `${"x".repeat(64 * 1024 - needlePrefix.length)}${needlePrefix}place-plugin:v2\n`,
        "utf8",
      );

      const result = runAssertion([
        "assert-file-contains",
        outputPath,
        "release-marketplace-plugin:v2",
      ]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("bounds release output text assertion diagnostics", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-scenarios-"));
    const outputPath = path.join(root, "output.log");

    try {
      writeFileSync(
        outputPath,
        `DO_NOT_DUMP_OLD_OUTPUT${"x".repeat(70 * 1024)}\nrecent output tail\n`,
        "utf8",
      );

      const result = runAssertion(["assert-file-contains", outputPath, "missing"]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Output tail:");
      expect(result.stderr).toContain("recent output tail");
      expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_OUTPUT");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("scans large request logs for image describe responses", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-scenarios-"));
    const outputPath = path.join(root, "describe.json");
    const requestLogPath = path.join(root, "requests.jsonl");

    try {
      writeJson(outputPath, {
        capability: "image.describe",
        ok: true,
        outputs: [{ provider: "openai", text: "OPENCLAW_E2E_OK describe" }],
      });
      const endpointPrefix = "/v1/res";
      writeFileSync(
        requestLogPath,
        `${"x".repeat(64 * 1024 - endpointPrefix.length)}${endpointPrefix}ponses\n`,
        "utf8",
      );

      const result = runAssertion(["assert-image-describe", outputPath, requestLogPath]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("scans large request logs for image generation requests", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-scenarios-"));
    const outputPath = path.join(root, "generate.json");
    const requestLogPath = path.join(root, "requests.jsonl");
    const imagePath = path.join(root, "generated.png");

    try {
      writeFileSync(imagePath, "png", "utf8");
      writeJson(outputPath, {
        capability: "image.generate",
        ok: true,
        outputs: [{ mimeType: "image/png", path: imagePath }],
        provider: "openai",
      });
      const endpointPrefix = "/v1/images/gener";
      writeFileSync(
        requestLogPath,
        `${"x".repeat(64 * 1024 - endpointPrefix.length)}${endpointPrefix}ations\n`,
        "utf8",
      );

      const result = runAssertion(["assert-image-generate", outputPath, requestLogPath]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("passes when the installed package version matches the candidate version", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-scenarios-"));
    const packageRoot = path.join(root, "openclaw");

    try {
      writeJson(path.join(packageRoot, "package.json"), {
        name: "openclaw",
        version: "2026.5.26",
      });

      const result = runAssertion([
        "assert-package-version",
        packageRoot,
        "2026.5.26",
        "candidate",
      ]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("fails when the global install still points at the baseline version", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-scenarios-"));
    const packageRoot = path.join(root, "openclaw");

    try {
      writeJson(path.join(packageRoot, "package.json"), {
        name: "openclaw",
        version: "2026.5.22",
      });

      const result = runAssertion([
        "assert-package-version",
        packageRoot,
        "2026.5.26",
        "candidate",
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "candidate package version mismatch: expected 2026.5.26, got 2026.5.22",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
