import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  catalogSourceRevision,
  checkCatalogs,
  detectCatalogDrift,
  refreshCatalogs,
} from "../../scripts/localization-catalogs.js";

const SOURCE_PATH = "catalogs/en.json";
const TARGET_PATH = "catalogs/generated/zh-CN.json";
const SOURCE_MESSAGES = { "wizard.completion.title": "Shell completion" };

let root: string;

async function writeJson(relativePath: string, value: unknown) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeFixture() {
  await writeJson("registry.json", {
    schemaVersion: 1,
    areas: [
      {
        id: "wizard-core",
        namespace: "wizard",
        source: SOURCE_PATH,
        targets: [{ locale: "zh-CN", path: TARGET_PATH }],
        protectedLiterals: ["Shell"],
      },
    ],
  });
  await writeJson(SOURCE_PATH, {
    schemaVersion: 1,
    area: "wizard-core",
    messages: SOURCE_MESSAGES,
  });
  await writeJson(TARGET_PATH, {
    schemaVersion: 1,
    area: "wizard-core",
    locale: "zh-CN",
    sourceRevision: catalogSourceRevision(SOURCE_MESSAGES),
    sourceMessages: SOURCE_MESSAGES,
    generation: {
      workflow: "test",
      provider: "fixture",
      model: "fixture",
      sourceCommit: "a".repeat(40),
      glossaryRevision: "none",
      validation: "passed",
    },
    messages: { "wizard.completion.title": "Shell 补全" },
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openclaw-localization-catalogs-"));
  await writeFixture();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("localization catalog authoring", () => {
  it("accepts a current generated catalog", async () => {
    await expect(checkCatalogs({ root, registryPath: "registry.json" })).resolves.toBeUndefined();
  });

  it("reports English source drift without provider credentials", async () => {
    await writeJson(SOURCE_PATH, {
      schemaVersion: 1,
      area: "wizard-core",
      messages: { "wizard.completion.title": "Shell completion setup" },
    });

    await expect(detectCatalogDrift({ root, registryPath: "registry.json" })).resolves.toEqual([
      expect.stringContaining("is stale"),
    ]);
  });

  it("blocks English source drift before translated output is refreshed", async () => {
    await writeJson(SOURCE_PATH, {
      schemaVersion: 1,
      area: "wizard-core",
      messages: { "wizard.completion.title": "Shell completion setup" },
    });

    await expect(checkCatalogs({ root, registryPath: "registry.json" })).rejects.toThrow(
      "is stale",
    );
  });

  it("blocks generated output with placeholder drift", async () => {
    const messages = { "wizard.completion.title": "Shell completion for {shell}" };
    await writeJson(SOURCE_PATH, { schemaVersion: 1, area: "wizard-core", messages });
    const generated = JSON.parse(await readFile(path.join(root, TARGET_PATH), "utf8"));
    generated.sourceRevision = catalogSourceRevision(messages);
    generated.sourceMessages = messages;
    generated.messages["wizard.completion.title"] = "Shell 补全";
    await writeJson(TARGET_PATH, generated);

    await expect(checkCatalogs({ root, registryPath: "registry.json" })).rejects.toThrow(
      "placeholder-mismatch",
    );
  });

  it("validates malformed generated output even when the English source has moved", async () => {
    await writeJson(SOURCE_PATH, {
      schemaVersion: 1,
      area: "wizard-core",
      messages: { "wizard.completion.title": "Shell completion setup" },
    });
    const generated = JSON.parse(await readFile(path.join(root, TARGET_PATH), "utf8"));
    generated.messages["wizard.completion.title"] = "命令行补全";
    await writeJson(TARGET_PATH, generated);

    await expect(detectCatalogDrift({ root, registryPath: "registry.json" })).rejects.toThrow(
      'changed protected literal "Shell"',
    );
  });

  it("blocks generated output that changes a protected literal", async () => {
    const generated = JSON.parse(await readFile(path.join(root, TARGET_PATH), "utf8"));
    generated.messages["wizard.completion.title"] = "命令行补全";
    await writeJson(TARGET_PATH, generated);

    await expect(checkCatalogs({ root, registryPath: "registry.json" })).rejects.toThrow(
      'changed protected literal "Shell"',
    );
  });

  it("refreshes stale output with source-pinned generation evidence", async () => {
    await writeJson(SOURCE_PATH, {
      schemaVersion: 1,
      area: "wizard-core",
      messages: { "wizard.completion.title": "Shell completion setup" },
    });
    const translator = vi.fn(async () => new Map([["wizard.completion.title", "Shell 补全设置"]]));

    await expect(
      refreshCatalogs({
        root,
        registryPath: "registry.json",
        sourceCommit: "b".repeat(40),
        translator,
        write: true,
      }),
    ).resolves.toBe(1);
    await expect(checkCatalogs({ root, registryPath: "registry.json" })).resolves.toBeUndefined();

    const generated = JSON.parse(await readFile(path.join(root, TARGET_PATH), "utf8"));
    expect(generated.generation.sourceCommit).toBe("b".repeat(40));
    expect(generated.messages["wizard.completion.title"]).toBe("Shell 补全设置");
    expect(translator).toHaveBeenCalledOnce();
  });
});
