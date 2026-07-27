// Setup gateway config tests cover gateway prompt choices and config output.
import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { DEFAULT_DANGEROUS_NODE_COMMANDS } from "../gateway/node-command-policy.js";
import type { RuntimeEnv } from "../runtime.js";
import { withSecureTestNodeExecPath } from "../secrets/test-node-command.test-support.js";
import type { WizardPrompter, WizardSelectParams } from "./prompts.js";

const mocks = vi.hoisted(() => ({
  randomToken: vi.fn(),
  getTailnetHostname: vi.fn(),
}));

vi.mock("../commands/onboard-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("../commands/onboard-helpers.js")>();
  return {
    ...actual,
    randomToken: mocks.randomToken,
  };
});

vi.mock("../infra/tailscale.js", () => ({
  findTailscaleBinary: vi.fn(async () => undefined),
  getTailnetHostname: mocks.getTailnetHostname,
}));

import { configureGatewayForSetup } from "./setup.gateway-config.js";
import { resolveQuickstartGatewayDefaults } from "./setup.shared.js";

describe("configureGatewayForSetup", () => {
  function createPrompter(params: { selectQueue: string[]; textQueue: Array<string | undefined> }) {
    const selectQueue = [...params.selectQueue];
    const textQueue = [...params.textQueue];
    const select = vi.fn(async (paramsLocal: WizardSelectParams<unknown>) => {
      const next = selectQueue.shift();
      if (next !== undefined) {
        return next;
      }
      return paramsLocal.initialValue ?? paramsLocal.options[0]?.value;
    }) as unknown as WizardPrompter["select"];

    return buildWizardPrompter({
      select,
      text: vi.fn(async (paramsLocal) => {
        const value = textQueue.shift() as string;
        const error = typeof value === "string" ? paramsLocal.validate?.(value) : undefined;
        if (error) {
          throw new Error(error);
        }
        return value;
      }),
    });
  }

  function createRuntime(): RuntimeEnv {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
  }

  function createQuickstartGateway(authMode: "token" | "password") {
    return {
      hasExisting: false,
      port: 18789,
      bind: "loopback" as const,
      authMode,
      tailscaleMode: "off" as const,
      token: undefined,
      password: undefined,
      customBindHost: undefined,
      tailscaleResetOnExit: false,
    };
  }

  async function runGatewayConfig(params?: {
    flow?: "advanced" | "quickstart";
    bindChoice?: string;
    authChoice?: "token" | "password";
    tailscaleChoice?: "off" | "serve";
    textQueue?: Array<string | undefined>;
    nextConfig?: Record<string, unknown>;
  }) {
    const authChoice = params?.authChoice ?? "token";
    const prompter = createPrompter({
      selectQueue: [params?.bindChoice ?? "loopback", authChoice, params?.tailscaleChoice ?? "off"],
      textQueue: params?.textQueue ?? ["18789", undefined],
    });
    const runtime = createRuntime();
    return configureGatewayForSetup({
      flow: params?.flow ?? "advanced",
      baseConfig: {},
      nextConfig: params?.nextConfig ?? {},
      localPort: 18789,
      quickstartGateway: createQuickstartGateway(authChoice),
      prompter,
      runtime,
    });
  }

  it("generates a token when the prompt returns undefined", async () => {
    mocks.randomToken.mockReturnValue("generated-token");
    const result = await runGatewayConfig();

    expect(result.settings.gatewayToken).toBe("generated-token");
    expect(result.nextConfig.gateway?.nodes?.commands?.deny).toEqual(
      DEFAULT_DANGEROUS_NODE_COMMANDS,
    );
    expect(result.nextConfig.gateway?.nodes?.commands?.deny).not.toContain("screen.snapshot");
    expect(result.nextConfig.gateway?.nodes?.commands?.deny).toContain("screen.record");
  });

  it.each(["1e3", "0x1000"])("rejects loose gateway port input: %s", async (port) => {
    mocks.randomToken.mockReturnValue("generated-token");

    await expect(runGatewayConfig({ textQueue: [port] })).rejects.toThrow(
      "Use a port number from 1 to 65535",
    );
  });

  it("prefers OPENCLAW_GATEWAY_TOKEN during quickstart token setup", async () => {
    const prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "token-from-env";
    mocks.randomToken.mockReturnValue("generated-token");
    mocks.randomToken.mockClear();

    try {
      const result = await runGatewayConfig({
        flow: "quickstart",
        textQueue: [],
      });

      expect(result.settings.gatewayToken).toBe("token-from-env");
    } finally {
      if (prevToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
      }
    }
  });

  it("keeps OPENCLAW_GATEWAY_TOKEN in advanced flow when user confirms keeping existing", async () => {
    const prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "advanced-env-token";
    mocks.randomToken.mockReturnValue("should-not-be-used");
    mocks.randomToken.mockClear();

    try {
      const selectQueue = ["loopback", "token", "off"];
      const select = vi.fn(async (params: WizardSelectParams<unknown>) => {
        const next = selectQueue.shift();
        if (next !== undefined) {
          return next;
        }
        return params.initialValue ?? params.options[0]?.value;
      }) as unknown as WizardPrompter["select"];
      const text = vi.fn(async () => "18789") as unknown as WizardPrompter["text"];
      const confirm = vi.fn(async () => true);
      const prompter = buildWizardPrompter({ select, text, confirm });

      const result = await configureGatewayForSetup({
        flow: "advanced",
        baseConfig: {},
        nextConfig: {},
        localPort: 18789,
        quickstartGateway: {
          hasExisting: false,
          port: 18789,
          bind: "loopback",
          authMode: "token",
          tailscaleMode: "off",
          token: undefined,
          password: undefined,
          customBindHost: undefined,
          tailscaleResetOnExit: false,
        },
        prompter,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      });

      expect(result.settings.gatewayToken).toBe("advanced-env-token");
      expect(mocks.randomToken).not.toHaveBeenCalled();
    } finally {
      if (prevToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
      }
    }
  });

  it("does not add a Control UI auth bypass for fresh quickstart loopback setups", async () => {
    mocks.randomToken.mockReturnValue("generated-token");

    const result = await runGatewayConfig({
      flow: "quickstart",
      textQueue: [],
    });

    expect(result.nextConfig.gateway?.controlUi).toBeUndefined();
  });

  it("does not set password to literal 'undefined' when prompt returns undefined", async () => {
    mocks.randomToken.mockReturnValue("unused");
    const result = await runGatewayConfig({
      authChoice: "password",
    });

    const authConfig = result.nextConfig.gateway?.auth as { mode?: string; password?: string };
    expect(authConfig?.mode).toBe("password");
    expect(authConfig?.password).toBe("");
    expect(authConfig?.password).not.toBe("undefined");
  });

  it("seeds control UI allowed origins for non-loopback binds", async () => {
    mocks.randomToken.mockReturnValue("generated-token");
    const result = await runGatewayConfig({
      bindChoice: "lan",
    });

    expect(result.nextConfig.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:18789",
      "http://127.0.0.1:18789",
    ]);
  });

  it("honors secretInputMode=ref for gateway password prompts", async () => {
    const previous = process.env.OPENCLAW_GATEWAY_PASSWORD;
    process.env.OPENCLAW_GATEWAY_PASSWORD = "gateway-secret"; // pragma: allowlist secret
    try {
      const prompter = createPrompter({
        selectQueue: ["loopback", "password", "off", "env"],
        textQueue: ["18789", "OPENCLAW_GATEWAY_PASSWORD"],
      });
      const runtime = createRuntime();

      const result = await configureGatewayForSetup({
        flow: "advanced",
        baseConfig: {},
        nextConfig: {},
        localPort: 18789,
        quickstartGateway: createQuickstartGateway("password"),
        secretInputMode: "ref", // pragma: allowlist secret
        prompter,
        runtime,
      });

      expect(result.nextConfig.gateway?.auth?.mode).toBe("password");
      expect(result.nextConfig.gateway?.auth?.password).toEqual({
        source: "env",
        provider: "default",
        id: "OPENCLAW_GATEWAY_PASSWORD",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PASSWORD;
      } else {
        process.env.OPENCLAW_GATEWAY_PASSWORD = previous;
      }
    }
  });

  it("stores gateway token as SecretRef when secretInputMode=ref", async () => {
    const previous = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "token-from-env";
    try {
      const prompter = createPrompter({
        selectQueue: ["loopback", "token", "off", "env"],
        textQueue: ["18789", "OPENCLAW_GATEWAY_TOKEN"],
      });
      const runtime = createRuntime();

      const result = await configureGatewayForSetup({
        flow: "advanced",
        baseConfig: {},
        nextConfig: {},
        localPort: 18789,
        quickstartGateway: createQuickstartGateway("token"),
        secretInputMode: "ref", // pragma: allowlist secret
        prompter,
        runtime,
      });

      expect(result.nextConfig.gateway?.auth?.mode).toBe("token");
      expect(result.nextConfig.gateway?.auth?.token).toEqual({
        source: "env",
        provider: "default",
        id: "OPENCLAW_GATEWAY_TOKEN",
      });
      expect(result.settings.gatewayToken).toBe("token-from-env");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previous;
      }
    }
  });

  it("resolves quickstart exec SecretRefs for gateway token bootstrap", async () => {
    const quickstartGateway = {
      ...createQuickstartGateway("token"),
      token: {
        source: "exec" as const,
        provider: "gatewaytokens",
        id: "gateway/auth/token",
      },
    };
    const runtime = createRuntime();
    const prompter = createPrompter({
      selectQueue: [],
      textQueue: [],
    });

    const result = await withSecureTestNodeExecPath(async () =>
      configureGatewayForSetup({
        flow: "quickstart",
        baseConfig: {},
        nextConfig: {
          secrets: {
            providers: {
              gatewaytokens: {
                source: "exec",
                command: process.execPath,
                args: [
                  "-e",
                  "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const req=JSON.parse(input||'{}');const values={};for(const id of req.ids||[]){values[id]='token-from-exec';}process.stdout.write(JSON.stringify({protocolVersion:1,values}));});",
                ],
              },
            },
          },
        },
        localPort: 18789,
        quickstartGateway,
        prompter,
        runtime,
      }),
    );

    expect(result.nextConfig.gateway?.auth?.token).toEqual(quickstartGateway.token);
    expect(result.settings.gatewayToken).toBe("token-from-exec");
  });

  it("persists an explicit classic quickstart env token ref", async () => {
    const previous = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "token-from-env-ref";
    try {
      const quickstartGateway = resolveQuickstartGatewayDefaults(
        {},
        { gatewayTokenRefEnv: "OPENCLAW_GATEWAY_TOKEN" },
      );
      const result = await configureGatewayForSetup({
        flow: "quickstart",
        baseConfig: {},
        nextConfig: {},
        localPort: 18789,
        quickstartGateway,
        prompter: createPrompter({ selectQueue: [], textQueue: [] }),
        runtime: createRuntime(),
      });

      expect(result.nextConfig.gateway?.auth).toEqual({
        mode: "token",
        token: {
          source: "env",
          provider: "default",
          id: "OPENCLAW_GATEWAY_TOKEN",
        },
      });
      expect(result.settings.gatewayToken).toBe("token-from-env-ref");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previous;
      }
    }
  });

  it("persists classic quickstart overrides through gateway safety normalization", async () => {
    const password = ["classic", "gateway", "placeholder"].join("-");
    mocks.getTailnetHostname.mockResolvedValue("test-tailnet.ts.net");
    const note = vi.fn(async () => {});
    const prompter = buildWizardPrompter({ note });
    const quickstartGateway = resolveQuickstartGatewayDefaults(
      {},
      {
        gatewayPort: 19001,
        gatewayBind: "lan",
        gatewayAuth: "token",
        gatewayToken: "unused-token",
        gatewayPassword: password,
        tailscale: "funnel",
        tailscaleResetOnExit: true,
      },
    );

    const result = await configureGatewayForSetup({
      flow: "quickstart",
      baseConfig: {},
      nextConfig: {},
      localPort: 18789,
      quickstartGateway,
      prompter,
      runtime: createRuntime(),
    });

    expect(result.nextConfig.gateway).toMatchObject({
      port: 19001,
      bind: "loopback",
      auth: { mode: "password", password },
      tailscale: { mode: "funnel", resetOnExit: true },
    });
    expect(result.nextConfig.gateway?.auth?.token).toBeUndefined();
    expect(JSON.stringify(note.mock.calls)).not.toContain(password);
  });
});
