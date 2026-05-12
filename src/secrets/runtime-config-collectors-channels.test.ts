import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ResolverContext } from "./runtime-shared.js";

const getBootstrapChannelSecrets = vi.fn();
const loadChannelSecretContractApi = vi.fn();

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelSecrets,
}));

vi.mock("./channel-contract-api.js", () => ({
  loadChannelSecretContractApi,
}));

function requireLoadChannelSecretContractApiCall(): {
  channelId?: unknown;
  config?: unknown;
  env?: unknown;
  loadablePluginOrigins?: unknown;
} {
  const [call] = loadChannelSecretContractApi.mock.calls;
  if (!call) {
    throw new Error("expected loadChannelSecretContractApi call");
  }
  const [params] = call;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("expected loadChannelSecretContractApi params to be an object");
  }
  return params;
}

describe("runtime channel config collectors", () => {
  beforeEach(() => {
    getBootstrapChannelSecrets.mockReset();
    loadChannelSecretContractApi.mockReset();
  });

  it("uses the bundled channel contract-api collector when bootstrap secrets are unavailable", async () => {
    const { collectChannelConfigAssignments } =
      await import("./runtime-config-collectors-channels.js");
    const collectRuntimeConfigAssignments = vi.fn();
    loadChannelSecretContractApi.mockReturnValue({
      collectRuntimeConfigAssignments,
    });
    getBootstrapChannelSecrets.mockReturnValue(undefined);
    const config = {
      channels: {
        imessage: {
          accounts: {
            ops: {},
          },
        },
      },
    } as OpenClawConfig;

    collectChannelConfigAssignments({
      config,
      defaults: undefined,
      context: {} as ResolverContext,
    });

    const loadCall = requireLoadChannelSecretContractApiCall();
    expect(loadCall.channelId).toBe("imessage");
    expect(loadCall.config).toBe(config);
    expect(loadCall.env).toBeUndefined();
    expect(loadCall.loadablePluginOrigins).toBeUndefined();
    expect(collectRuntimeConfigAssignments).toHaveBeenCalledOnce();
    expect(getBootstrapChannelSecrets).not.toHaveBeenCalled();
  });

  it("falls back to bootstrap secrets when no channel contract-api is published", async () => {
    const { collectChannelConfigAssignments } =
      await import("./runtime-config-collectors-channels.js");
    const collectRuntimeConfigAssignments = vi.fn();
    loadChannelSecretContractApi.mockReturnValue(undefined);
    getBootstrapChannelSecrets.mockReturnValue({
      collectRuntimeConfigAssignments,
    });
    const config = {
      channels: {
        legacy: {},
      },
    } as OpenClawConfig;

    collectChannelConfigAssignments({
      config,
      defaults: undefined,
      context: {} as ResolverContext,
    });

    const loadCall = requireLoadChannelSecretContractApiCall();
    expect(loadCall.channelId).toBe("legacy");
    expect(loadCall.config).toBe(config);
    expect(loadCall.env).toBeUndefined();
    expect(loadCall.loadablePluginOrigins).toBeUndefined();
    expect(getBootstrapChannelSecrets).toHaveBeenCalledWith("legacy");
    expect(collectRuntimeConfigAssignments).toHaveBeenCalledOnce();
  });
});
