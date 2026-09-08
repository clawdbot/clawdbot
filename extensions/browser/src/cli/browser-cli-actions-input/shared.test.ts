// Browser tests cover shared plugin behavior.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { readActionsPayload, readFields } from "./shared.js";

describe("readFields", () => {
  it.each([
    {
      name: "keeps explicit type",
      fields: '[{"ref":"6","type":"textbox","value":"hello"}]',
      expected: [{ ref: "6", type: "textbox", value: "hello" }],
    },
    {
      name: "defaults missing type to text",
      fields: '[{"ref":"7","value":"world"}]',
      expected: [{ ref: "7", type: "text", value: "world" }],
    },
    {
      name: "defaults blank type to text",
      fields: '[{"ref":"8","type":"   ","value":"blank"}]',
      expected: [{ ref: "8", type: "text", value: "blank" }],
    },
  ])("$name", async ({ fields, expected }) => {
    await expect(readFields({ fields })).resolves.toEqual(expected);
  });

  it("requires ref", async () => {
    await expect(readFields({ fields: '[{"type":"textbox","value":"world"}]' })).rejects.toThrow(
      "fields[0] must include ref",
    );
  });

  it("throws descriptive error on malformed JSON", async () => {
    await expect(readFields({ fields: "NOT JSON {{{" })).rejects.toThrow(
      "fields must be valid JSON.",
    );
  });

  it("throws descriptive error on empty fields", async () => {
    await expect(readFields({ fields: "" })).rejects.toThrow("fields are required");
  });

  it("rejects conflicting inline and file form fields", async () => {
    await expect(
      readFields({ fields: "[]", fieldsFile: "/tmp/openclaw-browser-fields.json" }),
    ).rejects.toThrow("Specify only one of --fields or --fields-file");
  });

  it("preserves oversized fields files that normalize to a small request", async () => {
    await withTempDir("openclaw-browser-fields-", async (tempDir) => {
      const fieldsPath = path.join(tempDir, "fields.json");
      await fs.writeFile(fieldsPath, `[${" ".repeat(1_048_577)}{"ref":"1","value":"ok"}]`);

      await expect(readFields({ fieldsFile: fieldsPath })).resolves.toEqual([
        { ref: "1", type: "text", value: "ok" },
      ]);
    });
  });
});

describe("readActionsPayload", () => {
  it("rejects conflicting inline and file actions before reading the file", async () => {
    await expect(
      readActionsPayload({ actions: "[]", actionsFile: "/tmp/openclaw-browser-actions.json" }),
    ).rejects.toThrow("Specify only one of --actions or --actions-file");
  });

  it("preserves inline actions larger than the file input ceiling", async () => {
    const actions = " ".repeat(1_000_001);
    await expect(readActionsPayload({ actions })).resolves.toBe(actions);
  });

  it("bounds action files with the same byte limit as stdin", async () => {
    const maxBytes = 1_000_000;
    await withTempDir("openclaw-browser-actions-", async (tempDir) => {
      const actionsPath = path.join(tempDir, "actions.json");
      await fs.writeFile(actionsPath, Buffer.alloc(maxBytes + 1, 0x20));
      await expect(readActionsPayload({ actionsFile: actionsPath })).rejects.toMatchObject({
        code: "too-large",
        message: expect.stringContaining("Split the batch plan into smaller files"),
      });

      await fs.writeFile(actionsPath, Buffer.alloc(maxBytes, 0x20));
      const payload = await readActionsPayload({ actionsFile: actionsPath });
      expect(Buffer.byteLength(payload)).toBe(maxBytes);
    });
  });

  it("follows a symlinked action file to its bounded target", async () => {
    const maxBytes = 1_000_000;
    await withTempDir("openclaw-browser-actions-", async (tempDir) => {
      const targetPath = path.join(tempDir, "actions-target.json");
      const linkPath = path.join(tempDir, "actions-link.json");
      await fs.writeFile(targetPath, Buffer.alloc(maxBytes, 0x20));
      await fs.symlink(targetPath, linkPath);

      const payload = await readActionsPayload({ actionsFile: linkPath });
      expect(Buffer.byteLength(payload)).toBe(maxBytes);
    });
  });

  it("rejects an oversized symlinked action file target", async () => {
    const maxBytes = 1_000_000;
    await withTempDir("openclaw-browser-actions-", async (tempDir) => {
      const targetPath = path.join(tempDir, "actions-target.json");
      const linkPath = path.join(tempDir, "actions-link.json");
      await fs.writeFile(targetPath, Buffer.alloc(maxBytes + 1, 0x20));
      await fs.symlink(targetPath, linkPath);

      await expect(readActionsPayload({ actionsFile: linkPath })).rejects.toMatchObject({
        code: "too-large",
        message: expect.stringContaining("Split the batch plan into smaller files"),
      });
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects FIFO action files without opening them",
    async () => {
      await withTempDir("openclaw-browser-actions-", async (tempDir) => {
        const fifoPath = path.join(tempDir, "actions.pipe");
        execFileSync("mkfifo", [fifoPath]);

        await expect(readActionsPayload({ actionsFile: fifoPath })).rejects.toThrow("regular file");
      });
    },
  );
});
