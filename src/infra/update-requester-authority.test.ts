import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureCliPluginRegistryLoaded } from "../cli/plugin-registry-loader.js";
import { runUpdateRepairLoop } from "./update-repair-agent.js";
import { createManagedUpdateRequesterAuthority } from "./update-requester-authority.js";

vi.mock("../cli/plugin-registry-loader.js", () => ({
  ensureCliPluginRegistryLoaded: vi.fn(),
}));
vi.mock("./update-repair-agent.runtime.js", () => ({}));

describe("managed update requester authority", () => {
  let root: string;
  let configPath: string;
  let env: NodeJS.ProcessEnv;
  const requester = { channel: "synthetic", senderId: "owner" };
  const allowed = JSON.stringify({ commands: { ownerAllowFrom: ["owner"] } });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "update-requester-authority-"));
    configPath = path.join(root, "openclaw.json");
    env = { HOME: root, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath };
    await fs.writeFile(configPath, allowed);
    vi.mocked(ensureCliPluginRegistryLoaded).mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("preserves registry load failures instead of reporting revocation", async () => {
    const error = new Error("Synthetic plugin bundle unavailable");
    vi.mocked(ensureCliPluginRegistryLoaded).mockRejectedValueOnce(error);
    const authority = await createManagedUpdateRequesterAuthority(requester, env);
    expect(() => authority.isCurrent()).toThrow(error);
    const validate = vi.fn();
    const onEvent = vi.fn();
    const result = await runUpdateRepairLoop({
      target: { installRoot: root, stateDir: root, configPath, workspaceDir: root },
      context: { error: "Synthetic validation failure", phase: "validating" },
      isCurrent: authority.isCurrent,
      validate,
      onEvent,
    });
    expect(result).toMatchObject({ status: "aborted", reason: error.message, attempts: [] });
    expect(onEvent).toHaveBeenCalledWith({
      type: "stopped",
      status: "aborted",
      reason: error.message,
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it("preserves config load failures during preparation", async () => {
    await fs.writeFile(configPath, "{");
    const authority = await createManagedUpdateRequesterAuthority(requester, env);
    expect(() => authority.isCurrent()).toThrow("JSON5");
  });

  it("distinguishes a failed policy recheck from revocation and reads recovered policy", async () => {
    const authority = await createManagedUpdateRequesterAuthority(requester, env);
    expect(authority.isCurrent()).toBe(true);
    await fs.writeFile(configPath, "{");
    expect(() => authority.isCurrent()).toThrow();
    await fs.writeFile(configPath, allowed);
    expect(authority.isCurrent()).toBe(true);
    await fs.writeFile(configPath, JSON.stringify({ commands: { ownerAllowFrom: ["other"] } }));
    expect(authority.isCurrent()).toBe(false);
  });
});
