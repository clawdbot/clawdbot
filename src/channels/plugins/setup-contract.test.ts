import { describe, expect, it, vi } from "vitest";
import { defineChannelSetupContract } from "./setup-contract.js";

describe("defineChannelSetupContract", () => {
  it("requires field keys to match camelCased long flag names", () => {
    expect(() =>
      defineChannelSetupContract({
        fields: {
          credential: {
            kind: "string",
            cli: { flags: "--token <value>", description: "Credential" },
          },
        },
        adapter: { applyAccountConfig: ({ cfg }) => cfg },
      }),
    ).toThrow('Channel setup field "credential" must match camelCased long flag name "token"');

    expect(() =>
      defineChannelSetupContract({
        fields: {
          apiToken: {
            kind: "string",
            cli: { flags: "--api-token <value>", description: "API token" },
          },
        },
        adapter: { applyAccountConfig: ({ cfg }) => cfg },
      }),
    ).not.toThrow();
  });

  it("publishes the validated map key over a field-owned key property", () => {
    const contract = defineChannelSetupContract({
      fields: {
        apiToken: {
          key: "credential",
          kind: "string",
          cli: { flags: "--api-token <value>", description: "API token" },
        } as const,
      },
      adapter: { applyAccountConfig: ({ cfg }) => cfg },
    });

    expect(contract.metadata.fields[0]?.key).toBe("apiToken");
  });

  it("requires negated flags to resolve to the same field key", () => {
    expect(() =>
      defineChannelSetupContract({
        fields: {
          tenant: {
            kind: "boolean",
            cli: {
              flags: "--tenant",
              negatedFlags: "--no-other",
              description: "Tenant mode",
            },
          },
        },
        adapter: { applyAccountConfig: ({ cfg }) => cfg },
      }),
    ).toThrow('Channel setup field "tenant" must match camelCased long flag name "other"');

    expect(() =>
      defineChannelSetupContract({
        fields: {
          useEnv: {
            kind: "boolean",
            cli: {
              flags: "--use-env",
              negatedFlags: "--no-use-env",
              description: "Use environment credentials",
            },
          },
        },
        adapter: { applyAccountConfig: ({ cfg }) => cfg },
      }),
    ).not.toThrow();
  });

  it("parses channel-owned fields and gives adapters inferred input types", () => {
    const applyAccountConfig = vi.fn(
      ({
        input,
      }: {
        input: {
          name?: string;
          token?: string;
          transport?: "external-native" | "container";
          port?: number;
          allowFrom?: string[];
          useEnv?: boolean;
        };
      }) => {
        void input.token;
        return {};
      },
    );
    const contract = defineChannelSetupContract({
      fields: {
        token: {
          kind: "string",
          cli: { flags: "--token <token>", description: "Bot token" },
        },
        transport: {
          kind: "choice",
          choices: ["external-native", "container"],
          cli: { flags: "--transport <kind>", description: "Transport kind" },
        },
        port: {
          kind: "integer",
          cli: { flags: "--port <port>", description: "HTTP port" },
        },
        allowFrom: {
          kind: "string-list",
          cli: { flags: "--allow-from <ids>", description: "Allowed sender ids" },
        },
        useEnv: {
          kind: "boolean",
          cli: { flags: "--use-env", description: "Use environment credentials" },
        },
      },
      adapter: {
        applyAccountConfig,
      },
    });

    const parsed = contract.parseInput({
      name: "work",
      token: "secret",
      transport: "container",
      port: "8080",
      allowFrom: "alice,bob",
      useEnv: true,
    });

    expect(parsed).toEqual({
      ok: true,
      value: {
        name: "work",
        token: "secret",
        transport: "container",
        port: 8080,
        allowFrom: ["alice", "bob"],
        useEnv: true,
      },
    });
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    expect(
      contract.applyAccountConfig({ cfg: {}, accountId: "default", input: parsed.value }),
    ).toEqual({});
    expect(applyAccountConfig).toHaveBeenCalledWith({
      cfg: {},
      accountId: "default",
      input: {
        name: "work",
        token: "secret",
        transport: "container",
        port: 8080,
        allowFrom: ["alice", "bob"],
        useEnv: true,
      },
    });
  });

  it("rejects unsupported fields and invalid channel-owned values", () => {
    const contract = defineChannelSetupContract({
      fields: {
        transport: {
          kind: "choice",
          choices: ["external-native", "container"],
          cli: { flags: "--transport <kind>", description: "Transport kind" },
        },
        port: {
          kind: "integer",
          cli: { flags: "--port <port>", description: "HTTP port" },
        },
      },
      adapter: {
        applyAccountConfig: ({ cfg }) => cfg,
      },
    });

    expect(contract.parseInput({ token: "wrong channel" })).toEqual({
      ok: false,
      error: "Unsupported setup option: token",
    });
    expect(contract.parseInput({ transport: "managed" })).toEqual({
      ok: false,
      error: 'transport must be one of: "external-native", "container".',
    });
    expect(contract.parseInput({ port: "8.5" })).toEqual({
      ok: false,
      error: "port must be a non-negative integer.",
    });
  });

  it("projects serializable CLI metadata from the same field definition", () => {
    const contract = defineChannelSetupContract({
      fields: {
        token: {
          kind: "string",
          sensitive: true,
          cli: { flags: "--token <token>", description: "Bot token" },
        },
        mode: {
          kind: "choice",
          choices: ["socket", "http"],
          cli: { flags: "--mode <mode>", description: "Connection mode" },
        },
      },
      adapter: {
        applyAccountConfig: ({ cfg }) => cfg,
      },
    });

    expect(contract.metadata).toEqual({
      fields: [
        {
          key: "token",
          kind: "string",
          sensitive: true,
          cli: { flags: "--token <token>", description: "Bot token" },
        },
        {
          key: "mode",
          kind: "choice",
          choices: ["socket", "http"],
          cli: { flags: "--mode <mode>", description: "Connection mode" },
        },
      ],
    });
  });
});
