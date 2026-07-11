// Control UI tests cover config behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSchemaResponse, ConfigSnapshot } from "../../api/types.ts";
import {
  applyConfigSnapshot,
  applyConfig,
  createRuntimeConfigCapability,
  ensureAgentConfigEntry,
  findAgentConfigEntryIndex,
  loadConfig,
  openConfigFile,
  resetConfigPendingChanges,
  saveConfig,
  stageDefaultAgentConfigEntry,
  updateConfigFormValue,
  updateConfigRawValue,
  type ConfigState,
} from "./index.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createGatewayHarness(client: GatewayBrowserClient) {
  let snapshot = { client, connected: true, sessionKey: "main" };
  const listeners = new Set<(next: typeof snapshot) => void>();
  return {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: typeof snapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    publish: (connected: boolean) => {
      snapshot = { client, connected, sessionKey: "main" };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

function createState(): ConfigState {
  return {
    applySessionKey: "main",
    client: null,
    configActiveSection: null,
    configActiveSubsection: null,
    configApplying: false,
    configForm: null,
    configFormDirty: false,
    configFormMode: "form",
    configFormOriginal: null,
    configIssues: [],
    configLoading: false,
    configRaw: "",
    configRawOriginal: "",
    configSaving: false,
    configSchema: null,
    configSchemaLoading: false,
    configSchemaVersion: null,
    configSearchQuery: "",
    configSnapshot: null,
    configDraftBaseHash: null,
    configUiHints: {},
    configValid: null,
    connected: false,
    lastError: null,
  };
}

function createRequestWithConfigGet() {
  return vi.fn().mockImplementation(async (method: string) => {
    if (method === "config.get") {
      return { config: {}, valid: true, issues: [], raw: "{\n}\n" };
    }
    return {};
  });
}

function requireRequestCall(request: ReturnType<typeof vi.fn>, index = 0): unknown[] {
  const call = request.mock.calls[index];
  if (!call) {
    throw new Error("expected client request call");
  }
  return call;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("applyConfigSnapshot", () => {
  it("does not clobber form edits while dirty", () => {
    const state = createState();
    state.configFormMode = "form";
    state.configFormDirty = true;
    state.configForm = { gateway: { mode: "local", port: 18789 } };
    state.configRaw = "{\n}\n";

    applyConfigSnapshot(state, {
      config: { gateway: { mode: "remote", port: 9999 } },
      valid: true,
      issues: [],
      raw: '{\n  "gateway": { "mode": "remote", "port": 9999 }\n}\n',
    });

    expect(state.configRaw).toBe(
      '{\n  "gateway": {\n    "mode": "local",\n    "port": 18789\n  }\n}\n',
    );
  });

  it("updates config form when clean", () => {
    const state = createState();
    applyConfigSnapshot(state, {
      sourceConfig: { gateway: { mode: "local" } },
      config: { gateway: { mode: "local", runtimeOnly: true } },
      valid: true,
      issues: [],
      raw: "{}",
    });

    expect(state.configForm).toEqual({ gateway: { mode: "local" } });
    expect(state.configSnapshot?.config).toEqual({
      gateway: { mode: "local", runtimeOnly: true },
    });
  });

  it("sets configRawOriginal when clean for change detection", () => {
    const state = createState();
    applyConfigSnapshot(state, {
      config: { gateway: { mode: "local" } },
      valid: true,
      issues: [],
      raw: '{ "gateway": { "mode": "local" } }',
    });

    expect(state.configRawOriginal).toBe('{ "gateway": { "mode": "local" } }');
    expect(state.configFormOriginal).toEqual({ gateway: { mode: "local" } });
  });

  it("preserves configRawOriginal when dirty", () => {
    const state = createState();
    state.configFormDirty = true;
    state.configRawOriginal = '{ "original": true }';
    state.configFormOriginal = { original: true };

    applyConfigSnapshot(state, {
      config: { gateway: { mode: "local" } },
      valid: true,
      issues: [],
      raw: '{ "gateway": { "mode": "local" } }',
    });

    // Original values should be preserved when dirty
    expect(state.configRawOriginal).toBe('{ "original": true }');
    expect(state.configFormOriginal).toEqual({ original: true });
  });

  it("keeps the draft base hash when preserving dirty edits across refreshes", () => {
    const state = createState();
    applyConfigSnapshot(state, {
      hash: "hash-original",
      config: { gateway: { mode: "local" } },
      valid: true,
      issues: [],
      raw: '{ "gateway": { "mode": "local" } }',
    });

    updateConfigFormValue(state, ["gateway", "mode"], "remote");
    applyConfigSnapshot(state, {
      hash: "hash-refreshed",
      config: { gateway: { mode: "external" } },
      valid: true,
      issues: [],
      raw: '{ "gateway": { "mode": "external" } }',
    });

    expect(state.configSnapshot?.hash).toBe("hash-refreshed");
    expect(state.configDraftBaseHash).toBe("hash-original");
    expect(state.configForm).toEqual({ gateway: { mode: "remote" } });
  });

  it("discards dirty form edits when explicitly requested", () => {
    const state = createState();
    state.configFormMode = "form";
    state.configFormDirty = true;
    state.configForm = { gateway: { mode: "local", port: 18789 } };
    state.configFormOriginal = { gateway: { mode: "local", port: 18789 } };
    state.configRawOriginal =
      '{\n  "gateway": {\n    "mode": "local",\n    "port": 18789\n  }\n}\n';

    applyConfigSnapshot(
      state,
      {
        hash: "hash-remote",
        config: { gateway: { mode: "remote", port: 9999 } },
        valid: true,
        issues: [],
        raw: '{\n  "gateway": { "mode": "remote", "port": 9999 }\n}\n',
      },
      { discardPendingChanges: true },
    );

    expect(state.configFormDirty).toBe(false);
    expect(state.configForm).toEqual({ gateway: { mode: "remote", port: 9999 } });
    expect(state.configFormOriginal).toEqual({ gateway: { mode: "remote", port: 9999 } });
    expect(state.configRaw).toBe('{\n  "gateway": { "mode": "remote", "port": 9999 }\n}\n');
    expect(state.configRawOriginal).toBe('{\n  "gateway": { "mode": "remote", "port": 9999 }\n}\n');
    expect(state.configDraftBaseHash).toBe("hash-remote");
  });

  it("keeps raw mode when editable config can be serialized without raw text", () => {
    const state = createState();
    state.configFormMode = "raw";

    applyConfigSnapshot(state, {
      sourceConfig: { gateway: { mode: "local" } },
      config: { gateway: { mode: "local", runtimeOnly: true } },
      valid: true,
      issues: [],
      raw: null,
    });

    expect(state.configFormMode).toBe("raw");
    expect(state.configRaw).toBe('{\n  "gateway": {\n    "mode": "local"\n  }\n}\n');
  });

  it("does not clobber raw edits while dirty", () => {
    const state = createState();
    state.configFormMode = "raw";
    applyConfigSnapshot(state, {
      hash: "hash-original",
      config: { gateway: { mode: "local" } },
      valid: true,
      issues: [],
      raw: '{\n  "gateway": { "mode": "local" }\n}\n',
    });

    updateConfigRawValue(state, '{\n  "gateway": { "mode": "remote" }\n}\n');
    applyConfigSnapshot(state, {
      hash: "hash-refreshed",
      config: { gateway: { mode: "external" } },
      valid: true,
      issues: [],
      raw: '{\n  "gateway": { "mode": "external" }\n}\n',
    });

    expect(state.configSnapshot?.hash).toBe("hash-refreshed");
    expect(state.configDraftBaseHash).toBe("hash-original");
    expect(state.configRaw).toBe('{\n  "gateway": { "mode": "remote" }\n}\n');
  });
});

describe("updateConfigRawValue", () => {
  it("tracks raw edits as pending changes", () => {
    const state = createState();
    applyConfigSnapshot(state, {
      hash: "hash-original",
      config: { gateway: { mode: "local" } },
      valid: true,
      issues: [],
      raw: '{\n  "gateway": { "mode": "local" }\n}\n',
    });

    updateConfigRawValue(state, '{\n  "gateway": { "mode": "remote" }\n}\n');

    expect(state.configFormDirty).toBe(true);
    expect(state.configDraftBaseHash).toBe("hash-original");

    updateConfigRawValue(state, '{\n  "gateway": { "mode": "local" }\n}\n');

    expect(state.configFormDirty).toBe(false);
    expect(state.configDraftBaseHash).toBe("hash-original");
  });
});

describe("loadConfig", () => {
  it("passes explicit reload mode through to snapshot application", async () => {
    const request = vi.fn().mockResolvedValue({
      config: { gateway: { mode: "remote" } },
      valid: true,
      issues: [],
      raw: '{\n  "gateway": { "mode": "remote" }\n}\n',
    });
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.configFormDirty = true;
    state.configForm = { gateway: { mode: "local" } };

    await loadConfig(state, { discardPendingChanges: true });

    expect(state.configFormDirty).toBe(false);
    expect(state.configForm).toEqual({ gateway: { mode: "remote" } });
    expect(state.configRawOriginal).toBe('{\n  "gateway": { "mode": "remote" }\n}\n');
  });
});

describe("createRuntimeConfigCapability", () => {
  it("rejects stale config and schema work after reconnecting the same client", async () => {
    const firstConfig = deferred<ConfigSnapshot>();
    const secondConfig = deferred<ConfigSnapshot>();
    const firstSchema = deferred<ConfigSchemaResponse>();
    const secondSchema = deferred<ConfigSchemaResponse>();
    const configRequests = [firstConfig, secondConfig];
    const schemaRequests = [firstSchema, secondSchema];
    const request = vi.fn((method: string) => {
      const pending = method === "config.get" ? configRequests.shift() : schemaRequests.shift();
      if (!pending) {
        throw new Error(`unexpected request: ${method}`);
      }
      return pending.promise;
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);

    const staleConfigLoad = runtimeConfig.ensureLoaded();
    const staleSchemaLoad = runtimeConfig.ensureSchemaLoaded();
    publish(false);
    publish(true);
    const currentConfigLoad = runtimeConfig.ensureLoaded();
    const currentSchemaLoad = runtimeConfig.ensureSchemaLoaded();

    firstConfig.resolve({ config: { source: "stale" }, valid: true, issues: [], raw: "{}" });
    firstSchema.reject(new Error("stale schema failure"));
    await Promise.all([staleConfigLoad, staleSchemaLoad]);

    expect(runtimeConfig.state.configSnapshot).toBeNull();
    expect(runtimeConfig.state.configSchema).toBeNull();
    expect(runtimeConfig.state.lastError).toBeNull();
    expect(runtimeConfig.state.configLoading).toBe(true);
    expect(runtimeConfig.state.configSchemaLoading).toBe(true);

    secondConfig.resolve({ config: { source: "current" }, valid: true, issues: [], raw: "{}" });
    secondSchema.resolve({
      schema: { type: "object" },
      uiHints: {},
      version: "current",
      generatedAt: "2026-07-09T00:00:00.000Z",
    });
    await Promise.all([currentConfigLoad, currentSchemaLoad]);

    expect(runtimeConfig.state.configSnapshot?.config).toEqual({ source: "current" });
    expect(runtimeConfig.state.configSchema).toEqual({ type: "object" });
    expect(runtimeConfig.state.configSchemaVersion).toBe("current");
    expect(runtimeConfig.state.configLoading).toBe(false);
    expect(runtimeConfig.state.configSchemaLoading).toBe(false);
    runtimeConfig.dispose();
  });

  it("keeps a replacement save isolated from stale same-client completion", async () => {
    const staleSave = deferred<void>();
    const currentSave = deferred<void>();
    let saveCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "config.set") {
        saveCount += 1;
        await (saveCount === 1 ? staleSave.promise : currentSave.promise);
        return {};
      }
      if (method === "config.get") {
        return {
          hash: "current-hash",
          config: { source: "current" },
          valid: true,
          issues: [],
          raw: '{"source":"current"}',
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    applyConfigSnapshot(runtimeConfig.state, {
      hash: "base-hash",
      config: { source: "base" },
      valid: true,
      issues: [],
      raw: '{"source":"base"}',
    });
    updateConfigFormValue(runtimeConfig.state, ["source"], "draft");

    const oldOperation = runtimeConfig.save();
    publish(false);
    publish(true);
    const currentOperation = runtimeConfig.save();

    staleSave.resolve();
    await expect(oldOperation).resolves.toBe(false);
    expect(runtimeConfig.state.configSaving).toBe(true);
    expect(runtimeConfig.state.configFormDirty).toBe(true);

    currentSave.resolve();
    await expect(currentOperation).resolves.toBe(true);
    expect(runtimeConfig.state.configSaving).toBe(false);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configSnapshot?.config).toEqual({ source: "current" });
    runtimeConfig.dispose();
  });
});

describe("openConfigFile", () => {
  it("surfaces failed open responses and copies the returned config path", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: false,
      path: "/tmp/openclaw.json",
      error: "Cannot open file in headless environment.",
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.lastError = "stale error";

    await openConfigFile(state);

    expect(request).toHaveBeenCalledWith("config.openFile", {});
    expect(writeText).toHaveBeenCalledWith("/tmp/openclaw.json");
    expect(state.lastError).toBe(
      "Cannot open file in headless environment.\n\nFile path copied to clipboard: /tmp/openclaw.json",
    );
  });

  it("includes the config path in the visible error when clipboard fallback fails", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: false,
      error: "Failed to open config file",
    });
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.configSnapshot = {
      config: {},
      path: "/tmp/from-snapshot.json",
      valid: true,
      issues: [],
    };

    await openConfigFile(state);

    expect(writeText).toHaveBeenCalledWith("/tmp/from-snapshot.json");
    expect(state.lastError).toBe(
      "Failed to open config file\n\nFile path: /tmp/from-snapshot.json",
    );
  });
});

describe("updateConfigFormValue", () => {
  it("seeds from snapshot when form is null", () => {
    const state = createState();
    state.configSnapshot = {
      sourceConfig: { channels: { telegram: { botToken: "t" } }, gateway: { mode: "local" } },
      config: {
        channels: { telegram: { botToken: "t" } },
        gateway: { mode: "local", runtimeOnly: true },
      },
      valid: true,
      issues: [],
      raw: "{}",
    };

    updateConfigFormValue(state, ["gateway", "port"], 18789);

    expect(state.configFormDirty).toBe(true);
    expect(state.configForm).toEqual({
      channels: { telegram: { botToken: "t" } },
      gateway: { mode: "local", port: 18789 },
    });
  });

  it("keeps raw in sync while editing the form", () => {
    const state = createState();
    state.configSnapshot = {
      config: { gateway: { mode: "local" } },
      valid: true,
      issues: [],
      raw: "{\n}\n",
    };

    updateConfigFormValue(state, ["gateway", "port"], 18789);

    expect(state.configRaw).toBe(
      '{\n  "gateway": {\n    "mode": "local",\n    "port": 18789\n  }\n}\n',
    );
  });

  it("clears dirty when a form edit returns to the original value", () => {
    const state = createState();
    applyConfigSnapshot(state, {
      config: { gateway: { mode: "local", port: 18789 } },
      valid: true,
      issues: [],
      raw: '{\n  "gateway": {\n    "mode": "local",\n    "port": 18789\n  }\n}\n',
    });

    updateConfigFormValue(state, ["gateway", "port"], 3000);
    expect(state.configFormDirty).toBe(true);

    updateConfigFormValue(state, ["gateway", "port"], 18789);

    expect(state.configFormDirty).toBe(false);
  });

  it("removes only automatically added plugin allow entries", () => {
    const state = createState();
    applyConfigSnapshot(state, {
      hash: "hash-plugins",
      config: {
        plugins: {
          allow: ["openai"],
          entries: {
            deepseek: { enabled: false },
          },
        },
      },
      valid: true,
      issues: [],
      raw: "{}",
    });

    updateConfigFormValue(state, ["plugins", "entries", "deepseek", "enabled"], true);

    expect(state.configForm).toEqual({
      plugins: {
        allow: ["openai", "deepseek"],
        entries: {
          deepseek: { enabled: true },
        },
      },
    });
    expect(state.configFormDirty).toBe(true);

    updateConfigFormValue(state, ["plugins", "entries", "deepseek", "enabled"], false);

    expect(state.configForm).toEqual({
      plugins: {
        allow: ["openai"],
        entries: {
          deepseek: { enabled: false },
        },
      },
    });
    expect(state.configFormDirty).toBe(false);

    updateConfigFormValue(state, ["plugins", "entries", "deepseek", "enabled"], true);
    updateConfigFormValue(state, ["plugins", "allow"], ["openai", "deepseek", "firecrawl"]);
    updateConfigFormValue(state, ["plugins", "entries", "deepseek", "enabled"], false);

    expect(state.configForm).toEqual({
      plugins: {
        allow: ["openai", "deepseek", "firecrawl"],
        entries: {
          deepseek: { enabled: false },
        },
      },
    });
    expect(state.configFormDirty).toBe(true);
  });

  it("preserves empty plugin allowlists when enabling a plugin", () => {
    const state = createState();
    applyConfigSnapshot(state, {
      hash: "hash-plugins",
      config: {
        plugins: {
          allow: [],
          entries: {
            deepseek: { enabled: false },
          },
        },
      },
      valid: true,
      issues: [],
      raw: "{}",
    });

    updateConfigFormValue(state, ["plugins", "entries", "deepseek", "enabled"], true);

    expect(state.configForm).toEqual({
      plugins: {
        allow: [],
        entries: {
          deepseek: { enabled: true },
        },
      },
    });
    expect(state.configFormDirty).toBe(true);

    updateConfigFormValue(state, ["plugins", "entries", "deepseek", "enabled"], false);

    expect(state.configForm).toEqual({
      plugins: {
        allow: [],
        entries: {
          deepseek: { enabled: false },
        },
      },
    });
    expect(state.configFormDirty).toBe(false);
  });
});

describe("resetConfigPendingChanges", () => {
  it("restores the original form and raw config snapshot", () => {
    const state = createState();
    state.configSnapshot = {
      config: { gateway: { mode: "local" } },
      valid: true,
      issues: [],
      raw: '{\n  "gateway": { "mode": "local" }\n}\n',
    };
    state.configFormOriginal = { gateway: { mode: "local" } };
    state.configRawOriginal = '{\n  "gateway": { "mode": "local" }\n}\n';
    state.configForm = { gateway: { mode: "remote", port: 3000 } };
    state.configRaw = '{\n  "gateway": { "mode": "remote", "port": 3000 }\n}\n';
    state.configFormDirty = true;

    resetConfigPendingChanges(state);

    expect(state.configFormDirty).toBe(false);
    expect(state.configForm).toEqual({ gateway: { mode: "local" } });
    expect(state.configRaw).toBe('{\n  "gateway": { "mode": "local" }\n}\n');
  });

  it("preserves an intentionally empty original raw config", () => {
    const state = createState();
    state.configSnapshot = {
      config: {},
      valid: true,
      issues: [],
      raw: "",
    };
    state.configFormOriginal = {};
    state.configRawOriginal = "";
    state.configForm = { gateway: { mode: "remote" } };
    state.configRaw = '{\n  "gateway": { "mode": "remote" }\n}\n';
    state.configFormDirty = true;

    resetConfigPendingChanges(state);

    expect(state.configFormDirty).toBe(false);
    expect(state.configForm).toStrictEqual({});
    expect(state.configRaw).toBe("");
  });
});

describe("agent config helpers", () => {
  it("finds explicit agent entries", () => {
    expect(
      findAgentConfigEntryIndex(
        {
          agents: {
            list: [{ id: "main" }, { id: "assistant" }],
          },
        },
        "assistant",
      ),
    ).toBe(1);
  });

  it("creates an agent override entry when editing an inherited agent", () => {
    const state = createState();
    state.configSnapshot = {
      config: {
        agents: {
          defaults: { model: "openai/gpt-5" },
        },
        tools: { profile: "messaging" },
      },
      valid: true,
      issues: [],
      raw: "{\n}\n",
    };

    const index = ensureAgentConfigEntry(state, "main");

    expect(index).toBe(0);
    expect(state.configFormDirty).toBe(true);
    expect(state.configForm).toEqual({
      agents: {
        defaults: { model: "openai/gpt-5" },
        list: [{ id: "main" }],
      },
      tools: { profile: "messaging" },
    });
  });

  it("reuses the existing agent entry instead of duplicating it", () => {
    const state = createState();
    state.configSnapshot = {
      config: {
        agents: {
          list: [{ id: "main", model: "openai/gpt-5" }],
        },
      },
      valid: true,
      issues: [],
      raw: "{\n}\n",
    };

    const index = ensureAgentConfigEntry(state, "main");

    expect(index).toBe(0);
    expect(state.configFormDirty).toBe(false);
    expect(state.configForm).toBeNull();
  });

  it("reuses an agent entry that already exists in the pending form state", () => {
    const state = createState();
    state.configSnapshot = {
      config: {},
      valid: true,
      issues: [],
      raw: "{\n}\n",
    };

    updateConfigFormValue(state, ["agents", "list", 0, "id"], "main");

    const index = ensureAgentConfigEntry(state, "main");

    expect(index).toBe(0);
    expect(state.configForm).toEqual({
      agents: {
        list: [{ id: "main" }],
      },
    });
  });

  it("sets default via agents.list[].default instead of agents.defaultId", () => {
    const state = createState();
    state.configSnapshot = {
      config: {
        agents: {
          list: [{ id: "alpha", default: true }, { id: "beta" }],
        },
      },
      valid: true,
      issues: [],
      raw: "{\n}\n",
    };

    const updated = stageDefaultAgentConfigEntry(state, "beta");

    expect(updated).toBe(true);
    expect(state.configFormDirty).toBe(true);
    expect(state.configForm).toEqual({
      agents: {
        list: [{ id: "alpha" }, { id: "beta", default: true }],
      },
    });
  });

  it("does not stage agents.defaultId when the target agent is absent", () => {
    const state = createState();
    state.configSnapshot = {
      config: {
        agents: {
          list: [{ id: "alpha", default: true }],
        },
      },
      valid: true,
      issues: [],
      raw: "{\n}\n",
    };

    const updated = stageDefaultAgentConfigEntry(state, "beta");

    expect(updated).toBe(false);
    expect(state.configFormDirty).toBe(false);
    expect(state.configForm).toBeNull();
  });
});

describe("applyConfig", () => {
  it("sends config.apply with raw and session key", async () => {
    const request = vi.fn().mockResolvedValue({});
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.applySessionKey = "agent:main:whatsapp:dm:+15555550123";
    state.configFormMode = "raw";
    state.configRaw = '{\n  agent: { workspace: "~/openclaw" }\n}\n';
    state.configSnapshot = {
      hash: "hash-123",
      raw: "{\n}\n",
    };

    await applyConfig(state);

    expect(request).toHaveBeenCalledWith("config.apply", {
      raw: '{\n  agent: { workspace: "~/openclaw" }\n}\n',
      baseHash: "hash-123",
      sessionKey: "agent:main:whatsapp:dm:+15555550123",
    });
  });

  it("coerces schema-typed values before config.apply in form mode", async () => {
    const request = createRequestWithConfigGet();
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.applySessionKey = "agent:main:web:dm:test";
    state.configFormMode = "form";
    state.configForm = {
      gateway: { port: "18789", debug: "true" },
    };
    state.configSchema = {
      type: "object",
      properties: {
        gateway: {
          type: "object",
          properties: {
            port: { type: "number" },
            debug: { type: "boolean" },
          },
        },
      },
    };
    state.configSnapshot = { hash: "hash-apply-1" };

    await applyConfig(state);

    const call = requireRequestCall(request);
    expect(call[0]).toBe("config.apply");
    const params = call[1] as {
      raw: string;
      baseHash: string;
      sessionKey: string;
    };
    const parsed = JSON.parse(params.raw) as {
      gateway: { port: unknown; debug: unknown };
    };
    expect(typeof parsed.gateway.port).toBe("number");
    expect(parsed.gateway.port).toBe(18789);
    expect(parsed.gateway.debug).toBe(true);
    expect(params.baseHash).toBe("hash-apply-1");
    expect(params.sessionKey).toBe("agent:main:web:dm:test");
  });
});

describe("saveConfig", () => {
  it("submits generated raw text when the snapshot did not include raw text", async () => {
    const request = createRequestWithConfigGet();
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.configFormMode = "raw";
    applyConfigSnapshot(state, {
      hash: "hash-generated-raw",
      sourceConfig: { gateway: { mode: "local" } },
      config: { gateway: { mode: "local", runtimeOnly: true } },
      valid: true,
      issues: [],
      raw: null,
    });

    await saveConfig(state);

    expect(request).toHaveBeenCalledWith("config.set", {
      raw: '{\n  "gateway": {\n    "mode": "local"\n  }\n}\n',
      baseHash: "hash-generated-raw",
    });
  });

  it("submits the original draft base hash after a dirty config refresh", async () => {
    const request = createRequestWithConfigGet();
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.configFormMode = "form";
    applyConfigSnapshot(state, {
      hash: "hash-original",
      config: { gateway: { mode: "local" } },
      valid: true,
      issues: [],
      raw: '{\n  "gateway": { "mode": "local" }\n}\n',
    });
    updateConfigFormValue(state, ["gateway", "mode"], "remote");
    applyConfigSnapshot(state, {
      hash: "hash-refreshed",
      config: { gateway: { mode: "external" } },
      valid: true,
      issues: [],
      raw: '{\n  "gateway": { "mode": "external" }\n}\n',
    });

    await saveConfig(state);

    const call = requireRequestCall(request);
    expect(call[0]).toBe("config.set");
    const params = call[1] as { raw: string; baseHash: string };
    expect(params.baseHash).toBe("hash-original");
  });

  it("coerces schema-typed values before config.set in form mode", async () => {
    const request = createRequestWithConfigGet();
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.configFormMode = "form";
    state.configForm = {
      gateway: { port: "18789", enabled: "false" },
    };
    state.configSchema = {
      type: "object",
      properties: {
        gateway: {
          type: "object",
          properties: {
            port: { type: "number" },
            enabled: { type: "boolean" },
          },
        },
      },
    };
    state.configSnapshot = { hash: "hash-save-1" };

    await saveConfig(state);

    const call = requireRequestCall(request);
    expect(call[0]).toBe("config.set");
    const params = call[1] as { raw: string; baseHash: string };
    const parsed = JSON.parse(params.raw) as {
      gateway: { port: unknown; enabled: unknown };
    };
    expect(typeof parsed.gateway.port).toBe("number");
    expect(parsed.gateway.port).toBe(18789);
    expect(parsed.gateway.enabled).toBe(false);
    expect(params.baseHash).toBe("hash-save-1");
  });

  it("skips coercion when schema is not an object", async () => {
    const request = createRequestWithConfigGet();
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.configFormMode = "form";
    state.configForm = {
      gateway: { port: "18789" },
    };
    state.configSchema = "invalid-schema";
    state.configSnapshot = { hash: "hash-save-2" };

    await saveConfig(state);

    const call = requireRequestCall(request);
    expect(call[0]).toBe("config.set");
    const params = call[1] as { raw: string; baseHash: string };
    const parsed = JSON.parse(params.raw) as {
      gateway: { port: unknown };
    };
    expect(parsed.gateway.port).toBe("18789");
    expect(params.baseHash).toBe("hash-save-2");
  });

  it("drops stale loaded redacted placeholders before config.set in form mode", async () => {
    const request = createRequestWithConfigGet();
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.configFormMode = "form";
    state.configForm = {
      gateway: {
        mode: "remote",
        remote: {
          token: "__OPENCLAW_REDACTED__",
        },
      },
    };
    state.configFormOriginal = {
      gateway: {
        mode: "remote",
        remote: {
          token: "__OPENCLAW_REDACTED__",
        },
      },
    };
    state.configRawOriginal = '{\n  gateway: {\n    mode: "remote"\n  }\n}\n';
    state.configSnapshot = { hash: "hash-save-redacted" };

    await saveConfig(state);

    const call = requireRequestCall(request);
    expect(call[0]).toBe("config.set");
    const params = call[1] as { raw: string; baseHash: string };
    const parsed = JSON.parse(params.raw) as {
      gateway: { mode: string; remote?: { token?: string } };
    };
    expect(parsed).toEqual({
      gateway: {
        mode: "remote",
      },
    });
    expect(params.baseHash).toBe("hash-save-redacted");
  });

  it("submits source config instead of runtime-materialized provider defaults", async () => {
    const request = createRequestWithConfigGet();
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.configFormMode = "form";
    applyConfigSnapshot(state, {
      hash: "hash-source-provider",
      sourceConfig: {
        models: {
          providers: {
            openai: {
              agentRuntime: { id: "openai" },
            },
          },
        },
        ui: { theme: "light" },
      },
      config: {
        models: {
          providers: {
            openai: {
              agentRuntime: { id: "openai" },
              baseUrl: "",
            },
          },
        },
        ui: { theme: "light" },
      },
      valid: true,
      issues: [],
      raw: '{\n  "models": {\n    "providers": {\n      "openai": {\n        "agentRuntime": { "id": "openai" }\n      }\n    }\n  },\n  "ui": { "theme": "light" }\n}\n',
    });

    updateConfigFormValue(state, ["ui", "theme"], "dark");
    await saveConfig(state);

    const call = requireRequestCall(request);
    expect(call[0]).toBe("config.set");
    const params = call[1] as { raw: string; baseHash: string };
    const parsed = JSON.parse(params.raw) as {
      models: { providers: { openai: { agentRuntime: { id: string }; baseUrl?: string } } };
      ui: { theme: string };
    };
    expect(parsed.models.providers.openai.agentRuntime.id).toBe("openai");
    expect(parsed.models.providers.openai).not.toHaveProperty("baseUrl");
    expect(parsed.ui.theme).toBe("dark");
    expect(params.baseHash).toBe("hash-source-provider");
  });

  it("drops stale loaded redacted placeholders before config.apply and keeps session key", async () => {
    const request = createRequestWithConfigGet();
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.applySessionKey = "agent:main:web:dm:test";
    state.configFormMode = "form";
    state.configForm = {
      gateway: {
        remote: {
          token: "__OPENCLAW_REDACTED__",
        },
      },
      ui: { theme: "dark" },
    };
    state.configFormOriginal = {
      gateway: {
        remote: {
          token: "__OPENCLAW_REDACTED__",
        },
      },
      ui: { theme: "dark" },
    };
    state.configRawOriginal = '{\n  ui: { theme: "dark" }\n}\n';
    state.configSnapshot = { hash: "hash-apply-redacted" };

    await applyConfig(state);

    const call = requireRequestCall(request);
    expect(call[0]).toBe("config.apply");
    const params = call[1] as { raw: string; baseHash: string; sessionKey: string };
    expect(JSON.parse(params.raw)).toEqual({
      ui: { theme: "dark" },
    });
    expect(params.baseHash).toBe("hash-apply-redacted");
    expect(params.sessionKey).toBe("agent:main:web:dm:test");
  });
});
