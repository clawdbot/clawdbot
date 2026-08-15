import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setReefRuntime } from "./runtime.js";
import { reefSetupWizard } from "./setup.js";
import {
  finalizeReefIdentityBinding,
  generateAndStoreKeys,
  loadKeys,
  loadReefIdentityBinding,
  reserveReefIdentityBinding,
} from "./state.js";
import { ReefRelayError, ReefTransportClient } from "./transport.js";

describe("Reef setup wizard identity binding", () => {
  let stateDir = "";

  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reef-setup-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function installRuntime() {
    const runtime = createPluginRuntimeMock();
    runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateSyncKeyedStoreForTests<T>("reef", {
        ...options,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
    runtime.state.resolveStateDir = () => stateDir;
    setReefRuntime(runtime);
    return runtime;
  }

  function bindIdentity(runtime: ReturnType<typeof installRuntime>, handle: string): void {
    finalizeReefIdentityBinding(
      runtime,
      reserveReefIdentityBinding(runtime, { handle, relayUrl: "https://reefwire.ai" }),
    );
  }

  it("rejects a different handle before reusing the stored identity keys", async () => {
    const runtime = installRuntime();
    bindIdentity(runtime, "existing");
    const textAnswers = [
      "https://reefwire.ai",
      "owner@example.com",
      "setup-session",
      "replacement",
    ];
    const prompter = {
      note: vi.fn(async () => undefined),
      text: vi.fn(async () => textAnswers.shift() ?? ""),
      select: vi.fn(async () => "code-only"),
    };

    await expect(
      reefSetupWizard.configureInteractive({ cfg: {}, prompter: prompter as never }),
    ).rejects.toThrow("already holds the Reef identity @existing");
  });

  it("persists the identity binding immediately after claiming the handle", async () => {
    const runtime = installRuntime();
    await generateAndStoreKeys(runtime);
    vi.spyOn(ReefTransportClient.prototype, "createHandle").mockResolvedValue({
      handle: "molty",
      key_epoch: 1,
    });
    const textAnswers = [
      "https://reefwire.ai",
      "owner@example.com",
      "setup-session",
      "molty",
      "gpt-5.6-terra",
      "REEF_GUARD_OPENAI_KEY",
      "reef-v1",
    ];
    const selectAnswers = ["code-only", "openai"];
    const prompter = {
      note: vi.fn(async () => undefined),
      text: vi.fn(async () => textAnswers.shift() ?? ""),
      select: vi.fn(async () => selectAnswers.shift()),
    };

    await reefSetupWizard.configureInteractive({ cfg: {}, prompter: prompter as never });

    expect(loadReefIdentityBinding(runtime)).toEqual({
      handle: "molty",
      relayUrl: "https://reefwire.ai",
    });
  });

  it("releases a reservation after a definitively rejected handle claim", async () => {
    const runtime = installRuntime();
    await generateAndStoreKeys(runtime);
    vi.spyOn(ReefTransportClient.prototype, "createHandle").mockRejectedValue(
      new ReefRelayError(409, "handle_unavailable"),
    );
    vi.spyOn(ReefTransportClient.prototype, "listFriends").mockRejectedValue(
      new ReefRelayError(401, "unknown_handle"),
    );
    const textAnswers = ["https://reefwire.ai", "owner@example.com", "setup-session", "molty"];
    const prompter = {
      note: vi.fn(async () => undefined),
      text: vi.fn(async () => textAnswers.shift() ?? ""),
      select: vi.fn(async () => "code-only"),
    };

    await expect(
      reefSetupWizard.configureInteractive({ cfg: {}, prompter: prompter as never }),
    ).rejects.toThrow("handle_unavailable");
    expect(loadReefIdentityBinding(runtime)).toBeUndefined();
  });

  it("keeps a binding after an ambiguous handle-claim failure", async () => {
    const runtime = installRuntime();
    await generateAndStoreKeys(runtime);
    vi.spyOn(ReefTransportClient.prototype, "createHandle").mockRejectedValue(
      new TypeError("connection reset"),
    );
    const textAnswers = ["https://reefwire.ai", "owner@example.com", "setup-session", "molty"];
    const prompter = {
      note: vi.fn(async () => undefined),
      text: vi.fn(async () => textAnswers.shift() ?? ""),
      select: vi.fn(async () => "code-only"),
    };

    await expect(
      reefSetupWizard.configureInteractive({ cfg: {}, prompter: prompter as never }),
    ).rejects.toThrow("connection reset");
    expect(loadReefIdentityBinding(runtime)).toEqual({
      handle: "molty",
      relayUrl: "https://reefwire.ai",
    });
  });

  it("keeps a binding when an ownership probe fails without proving non-ownership", async () => {
    const runtime = installRuntime();
    await generateAndStoreKeys(runtime);
    vi.spyOn(ReefTransportClient.prototype, "createHandle").mockRejectedValue(
      new ReefRelayError(409, "handle_unavailable"),
    );
    vi.spyOn(ReefTransportClient.prototype, "listFriends").mockRejectedValue(
      new ReefRelayError(401, "invalid_signature"),
    );
    const textAnswers = ["https://reefwire.ai", "owner@example.com", "setup-session", "molty"];
    const prompter = {
      note: vi.fn(async () => undefined),
      text: vi.fn(async () => textAnswers.shift() ?? ""),
      select: vi.fn(async () => "code-only"),
    };

    await expect(
      reefSetupWizard.configureInteractive({ cfg: {}, prompter: prompter as never }),
    ).rejects.toThrow("invalid_signature");
    expect(loadReefIdentityBinding(runtime)).toEqual({
      handle: "molty",
      relayUrl: "https://reefwire.ai",
    });
  });

  it("declares its persistence boundary before writing keys or creating the handle", async () => {
    const runtime = installRuntime();
    const beforePersistentEffect = vi.fn(async () => {
      await expect(loadKeys(runtime)).rejects.toMatchObject({ code: "ENOENT" });
    });
    vi.spyOn(ReefTransportClient.prototype, "createHandle").mockImplementation(async () => {
      expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
      return { handle: "molty", key_epoch: 1 };
    });
    const textAnswers = [
      "https://reefwire.ai",
      "owner@example.com",
      "setup-session",
      "molty",
      "gpt-5.6-terra",
      "REEF_GUARD_OPENAI_KEY",
      "reef-v1",
    ];
    const selectAnswers = ["code-only", "openai"];
    const prompter = {
      note: vi.fn(async () => undefined),
      text: vi.fn(async () => textAnswers.shift() ?? ""),
      select: vi.fn(async () => selectAnswers.shift()),
    };

    await reefSetupWizard.configureInteractive({
      cfg: {},
      prompter: prompter as never,
      options: { beforePersistentEffect },
    });

    expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
    await expect(loadKeys(runtime)).resolves.toBeDefined();
  });
});
