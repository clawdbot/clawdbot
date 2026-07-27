// Sbx tests cover cli plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { findSbxSandboxByName } from "./cli.js";
import { resolveSbxPluginConfig } from "./config.js";

const spawnMocks = vi.hoisted(() => ({ spawnSbx: vi.fn() }));

vi.mock("./spawn.js", () => ({ spawnSbx: spawnMocks.spawnSbx }));

describe("findSbxSandboxByName", () => {
  const config = resolveSbxPluginConfig(undefined);

  afterEach(() => {
    spawnMocks.spawnSbx.mockReset();
  });

  it("parses the real `sbx ls --json` shape (an object with a sandboxes array)", async () => {
    spawnMocks.spawnSbx.mockResolvedValue({
      code: 0,
      stdout: Buffer.from(
        JSON.stringify({
          sandboxes: [{ name: "openclaw-a", status: "running" }, { name: "openclaw-b" }],
        }),
      ),
      stderr: Buffer.alloc(0),
    });

    await expect(findSbxSandboxByName({ config, name: "openclaw-a" })).resolves.toEqual({
      name: "openclaw-a",
      status: "running",
    });
    await expect(findSbxSandboxByName({ config, name: "openclaw-missing" })).resolves.toBeNull();
  });

  it("returns null for an empty sandbox list", async () => {
    spawnMocks.spawnSbx.mockResolvedValue({
      code: 0,
      stdout: Buffer.from(JSON.stringify({ sandboxes: [] })),
      stderr: Buffer.alloc(0),
    });

    await expect(findSbxSandboxByName({ config, name: "openclaw-a" })).resolves.toBeNull();
  });

  it("tolerates a bare array shape as a defensive fallback", async () => {
    spawnMocks.spawnSbx.mockResolvedValue({
      code: 0,
      stdout: Buffer.from(JSON.stringify([{ name: "openclaw-a" }])),
      stderr: Buffer.alloc(0),
    });

    await expect(findSbxSandboxByName({ config, name: "openclaw-a" })).resolves.toEqual({
      name: "openclaw-a",
    });
  });

  it("returns null when the CLI call fails", async () => {
    spawnMocks.spawnSbx.mockResolvedValue({
      code: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("daemon not running"),
    });

    await expect(findSbxSandboxByName({ config, name: "openclaw-a" })).resolves.toBeNull();
  });
});
