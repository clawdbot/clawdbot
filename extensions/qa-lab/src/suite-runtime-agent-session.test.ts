import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  readEffectiveTools,
  readRawQaSessionStore,
  readSkillStatus,
} from "./suite-runtime-agent-session.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { cleanup, makeTempDir } = createTempDirHarness();

afterEach(cleanup);

describe("qa suite runtime agent session helpers", () => {
  const gatewayCall = vi.fn();
  const env = {
    gateway: { call: gatewayCall },
    primaryModel: "openai/gpt-5.5",
    alternateModel: "openai/gpt-5.5-mini",
    providerMode: "mock-openai",
  } as never;

  beforeEach(() => {
    gatewayCall.mockReset();
  });

  it("creates sessions and trims the returned key", async () => {
    gatewayCall.mockResolvedValueOnce({ key: "  session-1  " });

    await expect(createSession(env, "Test Session")).resolves.toBe("session-1");
    expect(gatewayCall).toHaveBeenCalledWith(
      "sessions.create",
      { label: "Test Session" },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it("reads effective tool ids once and drops blanks", async () => {
    gatewayCall.mockResolvedValueOnce({
      groups: [
        { tools: [{ id: "alpha" }, { id: " beta " }] },
        { tools: [{ id: "alpha" }, { id: "" }, {}] },
      ],
    });

    await expect(readEffectiveTools(env, "session-1")).resolves.toEqual(new Set(["alpha", "beta"]));
  });

  it("reads skill status for the default qa agent", async () => {
    gatewayCall.mockResolvedValueOnce({
      skills: [{ name: "alpha", eligible: true }],
    });

    await expect(readSkillStatus(env)).resolves.toEqual([{ name: "alpha", eligible: true }]);
    expect(gatewayCall).toHaveBeenCalledWith(
      "skills.status",
      { agentId: "qa" },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it("reads the raw qa session store from disk", async () => {
    const tempRoot = await makeTempDir("qa-session-store-");
    const storeDir = path.join(tempRoot, "state", "agents", "qa", "sessions");
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(
      path.join(storeDir, "sessions.json"),
      JSON.stringify({ "session-1": { sessionId: "session-1", status: "ready" } }),
      "utf8",
    );

    await expect(
      readRawQaSessionStore({
        gateway: { tempRoot },
      } as never),
    ).resolves.toEqual({
      "session-1": { sessionId: "session-1", status: "ready" },
    });
  });

  it("returns an empty session store when the file does not exist", async () => {
    const tempRoot = await makeTempDir("qa-session-store-missing-");

    await expect(
      readRawQaSessionStore({
        gateway: { tempRoot },
      } as never),
    ).resolves.toStrictEqual({});
  });
});
