// Release Scenarios Assertions tests cover release scenarios assertions script behavior.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

function runAssertion(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [ASSERTIONS_SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(),
    },
  });
}

function writeAuthProfileStoreSqlite(agentDir: string, store: unknown) {
  mkdirSync(agentDir, { recursive: true });
  const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_profile_store (
        store_key TEXT NOT NULL PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `
        INSERT INTO auth_profile_store (store_key, store_json, updated_at)
        VALUES (?, ?, ?)
      `,
    ).run("primary", JSON.stringify(store), Date.now());
  } finally {
    db.close();
  }
}

describe("release scenario assertions", () => {
  it("rejects loose mock OpenAI port args", () => {
    const result = runAssertion(["configure-mock-openai", "1e3"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("mock OpenAI port must be a TCP port from 1 to 65535");
    expect(result.stderr).toContain('"1e3"');
  });

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

  it("rejects oversized JSON artifacts before parsing release scenario outputs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-scenarios-"));
    const outputPath = path.join(root, "describe.json");
    const requestLogPath = path.join(root, "requests.jsonl");

    try {
      writeFileSync(
        outputPath,
        `DO_NOT_DUMP_OLD_JSON${"x".repeat(2 * 1024 * 1024)}\nrecent json tail`,
        "utf8",
      );
      writeFileSync(requestLogPath, "/v1/responses\n", "utf8");

      const result = runAssertion(["assert-image-describe", outputPath, requestLogPath]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("JSON artifact exceeded");
      expect(result.stderr).toContain("recent json tail");
      expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_JSON");
      expect(result.stderr.length).toBeLessThan(80 * 1024);
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

  it("accepts OpenAI env refs from the SQLite auth profile store", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-scenarios-"));
    const home = path.join(root, "home");
    const stateDir = path.join(home, ".openclaw");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const configPath = path.join(stateDir, "openclaw.json");

    try {
      writeJson(configPath, {
        auth: {
          profiles: {
            "openai:api-key": { provider: "openai", mode: "api_key" },
          },
        },
      });
      writeAuthProfileStoreSqlite(agentDir, {
        version: 1,
        profiles: {
          "openai:api-key": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      });

      const result = runAssertion(["assert-openai-env-ref", "sk-test-raw-key"], {
        HOME: home,
        OPENCLAW_CONFIG_PATH: configPath,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects SQLite auth profile stores without a usable OpenAI env ref", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-scenarios-"));
    const home = path.join(root, "home");
    const stateDir = path.join(home, ".openclaw");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const configPath = path.join(stateDir, "openclaw.json");

    try {
      writeJson(configPath, {
        auth: {
          profiles: {
            "openai:api-key": { provider: "openai", mode: "api_key" },
          },
        },
      });
      writeAuthProfileStoreSqlite(agentDir, {
        version: 1,
        profiles: {
          "openai:api-key": { note: "OPENAI_API_KEY" },
        },
      });

      const result = runAssertion(["assert-openai-env-ref", "sk-test-raw-key"], {
        HOME: home,
        OPENCLAW_CONFIG_PATH: configPath,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("OpenAI env ref was not persisted");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects inline OpenAI keys in the SQLite auth profile store", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-scenarios-"));
    const home = path.join(root, "home");
    const stateDir = path.join(home, ".openclaw");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const configPath = path.join(stateDir, "openclaw.json");

    try {
      writeJson(configPath, {
        auth: {
          profiles: {
            "openai:api-key": { provider: "openai", mode: "api_key" },
          },
        },
      });
      writeAuthProfileStoreSqlite(agentDir, {
        version: 1,
        profiles: {
          "openai:api-key": {
            type: "api_key",
            provider: "openai",
            key: "sk-test-raw-key",
          },
        },
      });

      const result = runAssertion(["assert-openai-env-ref", "sk-test-raw-key"], {
        HOME: home,
        OPENCLAW_CONFIG_PATH: configPath,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("raw OpenAI key was persisted");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects raw OpenAI keys leaked outside the SQLite auth profile store", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-scenarios-"));
    const home = path.join(root, "home");
    const stateDir = path.join(home, ".openclaw");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const configPath = path.join(stateDir, "openclaw.json");

    try {
      writeJson(configPath, {
        auth: {
          profiles: {
            "openai:api-key": { provider: "openai", mode: "api_key" },
          },
        },
        models: {
          providers: {
            openai: { apiKey: "sk-test-raw-key" },
          },
        },
      });
      writeAuthProfileStoreSqlite(agentDir, {
        version: 1,
        profiles: {
          "openai:api-key": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      });

      const result = runAssertion(["assert-openai-env-ref", "sk-test-raw-key"], {
        HOME: home,
        OPENCLAW_CONFIG_PATH: configPath,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("raw OpenAI key was persisted");
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
