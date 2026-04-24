import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadCliSessionHistoryMessages,
  MAX_CLI_SESSION_HISTORY_FILE_BYTES,
  MAX_CLI_SESSION_HISTORY_MESSAGES,
} from "./session-history.js";

function createSessionTranscript(params: {
  rootDir: string;
  sessionId: string;
  agentId?: string;
  filePath?: string;
  messages?: string[];
}): string {
  const sessionFile =
    params.filePath ??
    path.join(
      params.rootDir,
      "agents",
      params.agentId ?? "main",
      "sessions",
      `${params.sessionId}.jsonl`,
    );
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: params.rootDir,
    })}\n`,
    "utf-8",
  );
  for (const [index, message] of (params.messages ?? []).entries()) {
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        id: `msg-${index}`,
        parentId: index > 0 ? `msg-${index - 1}` : null,
        timestamp: new Date(index + 1).toISOString(),
        message: {
          role: "user",
          content: message,
          timestamp: index + 1,
        },
      })}\n`,
      "utf-8",
    );
  }
  return sessionFile;
}

describe("loadCliSessionHistoryMessages", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the canonical session transcript instead of an arbitrary external path", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-outside-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-test",
      messages: ["expected history"],
    });
    const outsideFile = createSessionTranscript({
      rootDir: outsideDir,
      sessionId: "session-test",
      filePath: path.join(outsideDir, "stolen.jsonl"),
      messages: ["stolen history"],
    });

    try {
      expect(
        loadCliSessionHistoryMessages({
          sessionId: "session-test",
          sessionFile: outsideFile,
          sessionKey: "agent:main:main",
          agentId: "main",
        }),
      ).toMatchObject([{ role: "user", content: "expected history" }]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("keeps only the newest bounded history window", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-bounded",
      messages: Array.from(
        { length: MAX_CLI_SESSION_HISTORY_MESSAGES + 25 },
        (_, index) => `msg-${index}`,
      ),
    });

    try {
      const history = loadCliSessionHistoryMessages({
        sessionId: "session-bounded",
        sessionFile,
        sessionKey: "agent:main:main",
        agentId: "main",
      });
      expect(history).toHaveLength(MAX_CLI_SESSION_HISTORY_MESSAGES);
      expect(history[0]).toMatchObject({ role: "user", content: "msg-25" });
      expect(history.at(-1)).toMatchObject({
        role: "user",
        content: `msg-${MAX_CLI_SESSION_HISTORY_MESSAGES + 24}`,
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects symlinked transcripts instead of following them outside the sessions directory", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-outside-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const canonicalSessionFile = path.join(
      stateDir,
      "agents",
      "main",
      "sessions",
      "session-symlink.jsonl",
    );
    const outsideFile = createSessionTranscript({
      rootDir: outsideDir,
      sessionId: "session-symlink",
      filePath: path.join(outsideDir, "outside.jsonl"),
      messages: ["stolen history"],
    });
    fs.mkdirSync(path.dirname(canonicalSessionFile), { recursive: true });
    fs.symlinkSync(outsideFile, canonicalSessionFile);

    try {
      expect(
        loadCliSessionHistoryMessages({
          sessionId: "session-symlink",
          sessionFile: canonicalSessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
        }),
      ).toEqual([]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("drops oversized transcript files instead of loading them into hook payloads", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sessionFile = path.join(
      stateDir,
      "agents",
      "main",
      "sessions",
      "session-oversized.jsonl",
    );
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "x".repeat(MAX_CLI_SESSION_HISTORY_FILE_BYTES + 1), "utf-8");

    try {
      expect(
        loadCliSessionHistoryMessages({
          sessionId: "session-oversized",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
        }),
      ).toEqual([]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("honors custom session store roots when resolving hook history transcripts", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const customStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-store-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const storePath = path.join(customStoreDir, "sessions.json");
    fs.writeFileSync(storePath, "{}", "utf-8");
    const sessionFile = createSessionTranscript({
      rootDir: customStoreDir,
      sessionId: "session-custom-store",
      filePath: path.join(customStoreDir, "session-custom-store.jsonl"),
      messages: ["custom store history"],
    });

    try {
      expect(
        loadCliSessionHistoryMessages({
          sessionId: "session-custom-store",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
          config: {
            session: {
              store: storePath,
            },
          },
        }),
      ).toMatchObject([{ role: "user", content: "custom store history" }]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(customStoreDir, { recursive: true, force: true });
    }
  });
});
