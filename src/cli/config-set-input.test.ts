// Config set input tests cover config value parsing from CLI input and files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseBatchSource } from "./config-set-input.js";

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

  it("rejects malformed --batch-file payloads", () => {
    withBatchFile("openclaw-config-set-input-invalid-", "{}", (batchPath) => {
      expect(() =>
        parseBatchSource({
          batchFile: batchPath,
        }),
      ).toThrow("--batch-file must be a JSON array.");
    });
  });
});
