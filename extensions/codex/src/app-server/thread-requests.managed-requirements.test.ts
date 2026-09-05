import { describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import type { JsonObject } from "./protocol.js";
import {
  assertCodexManagedRequirementsDoNotOverrideToolPolicy,
  buildCodexThreadConfiguration,
  readCodexManagedRequirementsFingerprint,
} from "./thread-requests.js";

const cwd = "/protected/native-workspace";
const managedRequirements = {
  hooks: {
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "managed-hook" }] }],
  },
  featureRequirements: { hooks: true },
};
const managedHook = {
  key: "/managed/requirements.toml:pre_tool_use:0:0",
  isManaged: true,
  enabled: true,
  trustStatus: "managed",
};
const ordinaryHook = {
  key: "/protected/.codex/hooks.json:session_start:0:0",
  isManaged: false,
  enabled: true,
  trustStatus: "trusted",
};
const disabledHook = {
  ...ordinaryHook,
  key: "/protected/.codex/config.toml:stop:0:0",
  enabled: false,
  trustStatus: "untrusted",
};
const inventory = {
  cwd,
  hooks: [managedHook, ordinaryHook, disabledHook],
  warnings: [],
  errors: [],
};
const managedHooksConfig = {
  "features.hooks": true,
  hooks: {
    state: {
      [ordinaryHook.key]: { enabled: false },
      [disabledHook.key]: { enabled: false },
    },
  },
};

function createRequest(
  requirements: unknown = managedRequirements,
  hookInventory: unknown = inventory,
) {
  return vi.fn(async (method: string) => {
    if (method === "configRequirements/read") {
      return { requirements };
    }
    if (method === "hooks/list") {
      return { data: [hookInventory] };
    }
    throw new Error(`Unexpected native request: ${method}`);
  });
}

describe("configured app-server managed requirements", () => {
  it.each(["interactive", "scheduled"])(
    "admits %s managed hooks with a session patch disabling every ordinary hook",
    async (mode) => {
      const request = createRequest();
      const allowedManagedRequirementsFingerprint =
        mode === "scheduled"
          ? await readCodexManagedRequirementsFingerprint({ request } as never)
          : undefined;
      const signal = new AbortController().signal;

      await expect(
        assertCodexManagedRequirementsDoNotOverrideToolPolicy(
          { request } as never,
          {
            cwd,
            restrictedToolSurface: true,
            protectedNativeContext: true,
            allowConfiguredManagedHooks: mode === "interactive",
            allowedManagedRequirementsFingerprint,
          },
          signal,
        ),
      ).resolves.toMatchObject({ config: managedHooksConfig, fingerprint: expect.any(String) });
      expect(request).toHaveBeenCalledWith("hooks/list", { cwds: [cwd] }, { signal });
    },
  );

  it("keeps hook admission after ring-zero restriction patches without restoring native extras", () => {
    const { config }: { config: JsonObject } = buildCodexThreadConfiguration(
      { toolsAllow: ["openclaw"], modelId: "test-model" } as never,
      {
        appServer: resolveCodexAppServerRuntimeOptions({}),
        hostSystemAgentActive: true,
        nativeCodeModeEnabled: false,
        managedHooksConfig,
      },
    );

    expect(config["features.hooks"]).toBe(true);
    expect(config.hooks).toMatchObject(managedHooksConfig.hooks);
    expect(config.hooks).toMatchObject({ SessionEnd: [], Interrupt: [] });
    expect(config).toMatchObject({
      "features.plugins": false,
      "features.shell_tool": false,
      "features.multi_agent": false,
      "orchestrator.mcp.enabled": false,
      notify: [],
    });
  });

  it.each([
    { requirements: null, hooks: [] },
    { requirements: {}, hooks: [] },
    { requirements: { hooks: {} }, hooks: [] },
    { requirements: { hooks: managedRequirements.hooks }, hooks: [] },
  ])(
    "does not activate hooks without enabled managed policy: $requirements",
    async ({ requirements, hooks }) => {
      const request = createRequest(requirements, { ...inventory, hooks });

      await expect(
        assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
          cwd,
          restrictedToolSurface: true,
          protectedNativeContext: true,
          allowConfiguredManagedHooks: true,
        }),
      ).resolves.toBeUndefined();
    },
  );

  it("preserves already enabled managed hooks without a feature requirement", async () => {
    const request = createRequest({ hooks: managedRequirements.hooks });

    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
        cwd,
        restrictedToolSurface: true,
        protectedNativeContext: true,
        allowConfiguredManagedHooks: true,
      }),
    ).resolves.toMatchObject({ config: managedHooksConfig, fingerprint: expect.any(String) });
  });

  it.each([
    { ...inventory, cwd: "/different/workspace" },
    { ...inventory, warnings: ["hook source could not be read"] },
    { ...inventory, errors: [{ message: "config could not be read" }] },
    { ...inventory, hooks: [{ ...ordinaryHook, isManaged: "false" }] },
    { ...inventory, hooks: [{ ...ordinaryHook, key: "" }] },
    { ...inventory, hooks: [{ ...ordinaryHook, enabled: undefined }] },
    { ...inventory, hooks: [ordinaryHook, { ...ordinaryHook, isManaged: true }] },
    { ...inventory, hooks: [ordinaryHook] },
    { ...inventory, hooks: [] },
  ])(
    "rejects unverifiable hook inventory before granting activation: %#",
    async (hookInventory) => {
      const request = createRequest(managedRequirements, hookInventory);

      await expect(
        assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
          cwd,
          restrictedToolSurface: true,
          protectedNativeContext: true,
          allowConfiguredManagedHooks: true,
        }),
      ).rejects.toThrow("hooks/list");
    },
  );

  it.each([
    {
      options: { restrictedToolSurface: true },
      requirements: managedRequirements,
      error: "cannot override managed hooks",
    },
    {
      options: {
        restrictedToolSurface: true,
        protectedNativeContext: true,
        allowConfiguredManagedHooks: true,
      },
      requirements: {
        ...managedRequirements,
        featureRequirements: { hooks: true, shell_tool: true },
      },
      error: "required feature shell_tool",
    },
  ])(
    "keeps unrelated authority and feature restrictions: $error",
    async ({ options, requirements, error }) => {
      const request = createRequest(requirements);

      await expect(
        assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
          ...options,
          cwd,
        }),
      ).rejects.toThrow(error);
      expect(request.mock.calls.some(([method]) => method === "hooks/list")).toBe(false);
    },
  );

  it("fails closed when managed requirements change after scheduled authorization", async () => {
    const request = createRequest();
    const allowedManagedRequirementsFingerprint = await readCodexManagedRequirementsFingerprint({
      request: createRequest({ hooks: {} }),
    } as never);

    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
        cwd,
        restrictedToolSurface: true,
        protectedNativeContext: true,
        allowedManagedRequirementsFingerprint,
      }),
    ).rejects.toThrow("managed requirements changed");
    expect(request.mock.calls.some(([method]) => method === "hooks/list")).toBe(false);
  });
});
