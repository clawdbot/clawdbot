import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { piSessionStore } from "./pi-session-paths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("Pi session paths", () => {
  it("rejects Windows drive-less rooted session paths", () => {
    const originalPlatform = process.platform;
    try {
      Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
      expect(() => piSessionStore({ PI_CODING_AGENT_SESSION_DIR: "\\sessions" })).toThrow(
        "absolute or home-relative",
      );
      expect(() => piSessionStore({ PI_CODING_AGENT_SESSION_DIR: "C:\\sessions" })).not.toThrow();
      expect(() =>
        piSessionStore({ PI_CODING_AGENT_SESSION_DIR: "\\\\server\\share\\sessions" }),
      ).not.toThrow();
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  });

  it("trims the configured Pi agent directory", () => {
    const agentDir = path.join(os.tmpdir(), "pi-agent");
    expect(piSessionStore({ PI_CODING_AGENT_DIR: `  ${agentDir}  ` })).toEqual({
      root: path.join(agentDir, "sessions"),
      flat: false,
    });
  });

  it("resolves relative project and global session directories like Pi", async () => {
    const projectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-project-"));
    const agentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-agent-"));
    temporaryDirectories.push(projectDirectory, agentDirectory);
    await fs.mkdir(path.join(projectDirectory, ".pi"), { recursive: true });
    await fs.writeFile(
      path.join(projectDirectory, ".pi", "settings.json"),
      `${JSON.stringify({ sessionDir: "sessions" })}\n`,
    );
    const env = {
      HOME: projectDirectory,
      USERPROFILE: projectDirectory,
      PI_CODING_AGENT_DIR: agentDirectory,
    };

    expect(piSessionStore(env, projectDirectory)).toEqual({
      root: path.join(projectDirectory, ".pi", "sessions"),
      flat: true,
    });

    await fs.rm(path.join(projectDirectory, ".pi", "settings.json"));
    await fs.writeFile(
      path.join(agentDirectory, "settings.json"),
      `${JSON.stringify({ sessionDir: "custom-sessions" })}\n`,
    );
    expect(piSessionStore(env, projectDirectory)).toEqual({
      root: path.join(agentDirectory, "custom-sessions"),
      flat: true,
    });
  });
});
