// Config set input tests cover config value parsing from CLI input and files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasProviderBuilderOptions,
  parseBatchSource,
  parseConfigSetCurrentExpectation,
  type ConfigSetOptions,
} from "./config-set-input.js";

function withBatchFile<T>(prefix: string, contents: string, run: (batchPath: string) => T): T {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const batchPath = path.join(tempDir, "batch.json");
  fs.writeFileSync(batchPath, contents, "utf8");
  try {
    return run(batchPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("config set input parsing", () => {
  it("does not treat retired provider bypass fields as builder options", () => {
    const retired = {
      providerAllowInsecurePath: true,
      providerAllowSymlinkCommand: true,
    } as ConfigSetOptions;

    expect(hasProviderBuilderOptions(retired)).toBe(false);
    expect(hasProviderBuilderOptions({ providerTrustedDir: ["/usr/local/bin"] })).toBe(true);
  });

  it("parses absent and strict JSON current-value expectations", () => {
    expect(parseConfigSetCurrentExpectation({ expectCurrentAbsent: true })).toEqual({
      kind: "absent",
    });
    expect(parseConfigSetCurrentExpectation({ expectCurrentJson: "null" })).toEqual({
      kind: "json",
      value: null,
    });
    expect(
      parseConfigSetCurrentExpectation({ expectCurrentJson: '{"enabled":true,"ports":[1,2]}' }),
    ).toEqual({
      kind: "json",
      value: { enabled: true, ports: [1, 2] },
    });
  });

  it.each([
    {
      name: "both expectation flags",
      options: { expectCurrentAbsent: true, expectCurrentJson: "null" },
      message: "choose either --expect-current-absent or --expect-current-json",
    },
    {
      name: "malformed expected JSON",
      options: { expectCurrentJson: "{enabled:true}" },
      message: "--expect-current-json must be valid JSON",
    },
    {
      name: "non-finite expected number",
      options: { expectCurrentJson: "1e999" },
      message: "--expect-current-json must be valid JSON",
    },
    {
      name: "batch mode",
      options: { expectCurrentAbsent: true, batchJson: "[]" },
      message: "cannot be combined with batch mode",
    },
    {
      name: "dry-run",
      options: { expectCurrentAbsent: true, dryRun: true },
      message: "cannot be combined with --dry-run",
    },
  ] as const)("rejects $name with a current-value expectation", ({ options, message }) => {
    expect(() => parseConfigSetCurrentExpectation(options)).toThrow(message);
  });

  it("returns null when no batch options are provided", () => {
    expect(parseBatchSource({})).toBeNull();
  });

  it("rejects using both --batch-json and --batch-file", () => {
    expect(() =>
      parseBatchSource({
        batchJson: "[]",
        batchFile: "/tmp/batch.json",
      }),
    ).toThrow("Use either --batch-json or --batch-file, not both.");
  });

  it("parses valid --batch-json payloads", () => {
    const parsed = parseBatchSource({
      batchJson:
        '[{"path":"gateway.auth.mode","value":"token"},{"path":"channels.discord.token","ref":{"source":"env","provider":"default","id":"DISCORD_BOT_TOKEN"}},{"path":"secrets.providers.default","provider":{"source":"env"}}]',
    });
    expect(parsed).toEqual([
      {
        path: "gateway.auth.mode",
        value: "token",
      },
      {
        path: "channels.discord.token",
        ref: {
          source: "env",
          provider: "default",
          id: "DISCORD_BOT_TOKEN",
        },
      },
      {
        path: "secrets.providers.default",
        provider: {
          source: "env",
        },
      },
    ]);
  });

  it.each([
    { name: "malformed payload", batchJson: "{", message: "Failed to parse --batch-json:" },
    {
      name: "empty batch payload",
      batchJson: "[]",
      message: "--batch-json must contain at least one config update.",
    },
    {
      name: "non-array payload",
      batchJson: '{"path":"gateway.auth.mode","value":"token"}',
      message: "--batch-json must be a JSON array.",
    },
    {
      name: "entry without path",
      batchJson: '[{"value":"token"}]',
      message: "--batch-json[0].path is required.",
    },
    {
      name: "entry with multiple mode keys",
      batchJson: '[{"path":"gateway.auth.mode","value":"token","provider":{"source":"env"}}]',
      message: "--batch-json[0] must include exactly one of: value, ref, provider.",
    },
  ] as const)("rejects $name", ({ batchJson, message }) => {
    expect(() => parseBatchSource({ batchJson })).toThrow(message);
  });

  it("parses valid --batch-file payloads", () => {
    withBatchFile(
      "openclaw-config-set-input-",
      '[{"path":"gateway.auth.mode","value":"token"}]',
      (batchPath) => {
        const parsed = parseBatchSource({
          batchFile: batchPath,
        });
        expect(parsed).toEqual([
          {
            path: "gateway.auth.mode",
            value: "token",
          },
        ]);
      },
    );
  });

  it("rejects --batch-file when the file does not exist", () => {
    expect(() =>
      parseBatchSource({
        batchFile: "/nonexistent/path/batch.json5",
      }),
    ).toThrow("--batch-file not found: /nonexistent/path/batch.json5");
  });

  it("rejects a directory passed as --batch-file", () => {
    const batchPath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-set-directory-"));
    try {
      expect(() => parseBatchSource({ batchFile: batchPath })).toThrow(
        `--batch-file must be a regular file: ${batchPath}. Choose a JSON5 input file and try again.`,
      );
    } finally {
      fs.rmSync(batchPath, { recursive: true, force: true });
    }
  });

  it("rejects malformed --batch-file payloads", () => {
    withBatchFile("openclaw-config-set-input-invalid-", "{}", (batchPath) => {
      expect(() =>
        parseBatchSource({
          batchFile: batchPath,
        }),
      ).toThrow("--batch-file must be a JSON array.");
    });
  });

  it("rejects empty --batch-file payloads", () => {
    withBatchFile("openclaw-config-set-input-empty-", "[]", (batchPath) => {
      expect(() => parseBatchSource({ batchFile: batchPath })).toThrow(
        "--batch-file must contain at least one config update.",
      );
    });
  });

  it("rejects --batch-file payloads above the config mutation limit", () => {
    withBatchFile(
      "openclaw-config-set-input-oversized-",
      " ".repeat(8 * 1024 * 1024 + 1),
      (batchPath) => {
        expect(() => parseBatchSource({ batchFile: batchPath })).toThrow(
          "--batch-file exceeds the 8 MiB supported maximum (8388608 bytes)",
        );
      },
    );
  });

  it("accepts --batch-file at exactly the size limit", () => {
    const content = '[{"path":"gateway.port","value":19000}]'.padEnd(8 * 1024 * 1024, " ");
    withBatchFile("openclaw-config-set-input-boundary-", content, (batchPath) => {
      const parsed = parseBatchSource({ batchFile: batchPath });
      expect(parsed).toEqual([{ path: "gateway.port", value: 19000 }]);
    });
  });

  it("rejects batch entries with non-finite numbers", () => {
    expect(() =>
      parseBatchSource({
        batchJson: '[{"path":"channels.custom.timeout","value":1e999}]',
      }),
    ).toThrow("Value must be a finite number");
  });
});
