import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";

// Detection only locates legacy files; loading this barrel brings in session DB machinery.
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => {
  throw new Error("legacy file detection must not load the session runtime");
});

it("detects Codex sidecars without loading session storage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-cold-"));
  const stateDir = path.join(root, "state");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const openStore = vi.fn(() => {
    throw new Error("detection must not open plugin state");
  });
  const params = {
    config: { agents: { list: [{ id: "main" }] } },
    env,
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context: { openPluginStateKeyedStore: openStore },
  };
  const migration = stateMigrations[0]!;
  try {
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    const sessionsDir = path.join(root, "import", "main");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({ "agent:main:main": { sessionId: "legacy" } }),
    );
    const sidecar = path.join(sessionsDir, "legacy.jsonl.codex-app-server.json");
    await fs.writeFile(sidecar, "{}");
    await expect(
      migration.detectLegacyState({
        ...params,
        config: {
          ...params.config,
          session: { store: path.join(root, "import", "{agentId}", "sessions.json") },
        },
      }),
    ).resolves.toMatchObject({ preview: [expect.stringContaining("Codex app-server bindings")] });
    expect(openStore).not.toHaveBeenCalled();
    await expect(fs.readFile(sidecar, "utf8")).resolves.toBe("{}");
    await expect(fs.readdir(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
