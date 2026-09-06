import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";

// Feedback discovery reads files; the session runtime is reserved for actual session operations.
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => {
  throw new Error("legacy file detection must not load the session runtime");
});

it("detects Teams feedback files without loading session storage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-doctor-cold-"));
  const stateDir = path.join(root, "state");
  const openStore = vi.fn(() => {
    throw new Error("detection must not open plugin state");
  });
  const params = {
    config: { agents: { list: [{ id: "work" }] } },
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context: { openPluginStateKeyedStore: openStore },
  };
  const migration = stateMigrations.find(
    (entry) => entry.id === "msteams-feedback-learnings-json-to-plugin-state",
  )!;
  try {
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    const storeDir = path.join(root, "import", "work");
    await fs.mkdir(storeDir, { recursive: true });
    const source = path.join(
      storeDir,
      `${Buffer.from("agent:work:msteams:channel:synthetic").toString("base64url")}.learnings.json`,
    );
    await fs.writeFile(source, JSON.stringify(["Use concise replies"]));
    await expect(
      migration.detectLegacyState({
        ...params,
        config: {
          ...params.config,
          session: { store: path.join(root, "import", "{agentId}") },
        },
      }),
    ).resolves.toMatchObject({ preview: [expect.stringContaining("1 file")] });
    expect(openStore).not.toHaveBeenCalled();
    await expect(fs.readFile(source, "utf8")).resolves.toBe('["Use concise replies"]');
    await expect(fs.readdir(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
