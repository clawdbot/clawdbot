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

describe("resolveSessionFilePath generated transcript names", () => {
  // `sessionFile` is persisted for the live session only, so every previous session in a
  // compaction chain arrives here with no locator at all. Without a name-based lookup those
  // transcripts resolve to a `<sessionId>.jsonl` that does not exist, and callers treat a
  // live transcript as missing.
  it("finds a `<iso-stamp>_<sessionId>.jsonl` transcript when the entry has no sessionFile", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-generated-")));
    tempDirs.push(root);
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionId = "31f8d80e-159f-405a-a2ae-90c0a2e8e1a3";
    const generated = `2026-08-08T23-07-16-077Z_${sessionId}.jsonl`;
    fs.writeFileSync(path.join(sessionsDir, generated), "{}\n", "utf8");

    const resolved = resolveSessionFilePath(sessionId, undefined, { sessionsDir, agentId: "main" });

    expect(resolved).toBe(path.join(sessionsDir, generated));
  });

  it("prefers the canonical `<sessionId>.jsonl` when it exists", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-canonical-")));
    tempDirs.push(root);
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionId = "31f8d80e-159f-405a-a2ae-90c0a2e8e1a3";
    fs.writeFileSync(path.join(sessionsDir, `${sessionId}.jsonl`), "{}\n", "utf8");
    fs.writeFileSync(
      path.join(sessionsDir, `2026-08-08T23-07-16-077Z_${sessionId}.jsonl`),
      "{}\n",
      "utf8",
    );

    const resolved = resolveSessionFilePath(sessionId, undefined, { sessionsDir, agentId: "main" });

    expect(resolved).toBe(path.join(sessionsDir, `${sessionId}.jsonl`));
  });

  it("keeps the canonical path for a session that has no transcript yet", () => {
    // New sessions must still be created as `<sessionId>.jsonl` rather than adopting
    // some unrelated file.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-fresh-")));
    tempDirs.push(root);
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "2026-08-08T23-07-16-077Z_11111111-2222-4333-8444-555555555555.jsonl"),
      "{}\n",
      "utf8",
    );
    const sessionId = "31f8d80e-159f-405a-a2ae-90c0a2e8e1a3";

    const resolved = resolveSessionFilePath(sessionId, undefined, { sessionsDir, agentId: "main" });

    expect(resolved).toBe(path.join(sessionsDir, `${sessionId}.jsonl`));
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
