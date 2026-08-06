// Session path helper tests pin default store path contracts used by CLI commands.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveSessionFilePath,
  resolveStorePath,
  SessionStoreAgentIdRequiredError,
} from "./paths.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveSessionFilePath cross-root reroot", () => {
  it("re-roots foreign-root absolute paths when the file exists in the current sessions dir", () => {
    // Restored backups and moved state dirs persist absolute sessionFile
    // paths from the old root; migration must find the local copy.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reroot-")));
    tempDirs.push(root);
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "sess-1.jsonl"), "{}\n", "utf8");
    const foreign = "/nonexistent-old-root/.openclaw/agents/main/sessions/sess-1.jsonl";

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: foreign },
      { sessionsDir, agentId: "main" },
    );

    expect(resolved).toBe(path.join(sessionsDir, "sess-1.jsonl"));
  });

  it("keeps foreign-root absolute paths when no local copy exists", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reroot-keep-")));
    tempDirs.push(root);
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const foreign = "/nonexistent-old-root/.openclaw/agents/main/sessions/sess-2.jsonl";

    const resolved = resolveSessionFilePath(
      "sess-2",
      { sessionFile: foreign },
      { sessionsDir, agentId: "main" },
    );

    expect(resolved).toBe(foreign);
  });
});

describe("resolveStorePath", () => {
  it("resolves a fixed literal path without an agent owner", () => {
    const fixed = path.join(path.parse(process.cwd()).root, "shared", "sessions.json");
    expect(resolveStorePath(fixed)).toBe(path.resolve(fixed));
  });

  it("throws a typed error when an agent template has no owner", () => {
    expect(() => resolveStorePath("/state/agents/{agentId}/sessions.json")).toThrow(
      SessionStoreAgentIdRequiredError,
    );
  });

  it("uses the default agent store when session.store is absent or blank", () => {
    const stateDir = path.join(path.parse(process.cwd()).root, "openclaw-test-state");
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const expected = path.join(stateDir, "agents", "work", "sessions", "sessions.json");

    expect(resolveStorePath(undefined, { agentId: "work", env })).toBe(expected);
    expect(resolveStorePath("", { agentId: "work", env })).toBe(expected);
  });
});
