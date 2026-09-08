import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectAmbientInferenceBackends } from "./onboard-inference-ambient.js";

const tempHomes = new Set<string>();

async function createTempHome(): Promise<string> {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ambient-")));
  tempHomes.add(home);
  return home;
}

async function writeCredential(home: string, relativePath: string, value: unknown): Promise<void> {
  const filePath = path.join(home, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), "utf8");
}

afterEach(async () => {
  await Promise.all([...tempHomes].map((home) => fs.rm(home, { recursive: true, force: true })));
  tempHomes.clear();
});

describe("detectAmbientInferenceBackends", () => {
  it("returns a verified Codex candidate only for readable file credentials", async () => {
    const home = await createTempHome();
    expect(detectAmbientInferenceBackends({ HOME: home })).toEqual([]);

    await writeCredential(home, ".codex/auth.json", {
      auth_mode: "chatgpt",
      tokens: { access_token: "codex-access", refresh_token: "codex-refresh" },
    });

    expect(detectAmbientInferenceBackends({ HOME: home })).toEqual([
      expect.objectContaining({ kind: "codex-cli", credentials: true }),
    ]);
  });
});
