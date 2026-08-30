import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  clearFirstRunActivationReceipt,
  persistFirstRunActivationReceipt,
  readFirstRunActivationReceipt,
} from "./first-run-activation-receipt.ts";

const receiptKey = "openclaw.modelSetup.pendingActivation.v1";
const deviceKey = "openclaw-device-identity-v1";
const privateKey = "high-entropy-device-private-key-never-in-receipts";

function createContext(options: { token?: string; deviceToken?: string } = {}): ApplicationContext {
  return {
    gateway: {
      snapshot: {
        phase: "connected",
        hello: {
          auth: options.deviceToken ? { deviceToken: options.deviceToken } : {},
        },
      },
      connection: {
        gatewayUrl: "wss://gateway.example/control?profile=work",
        token: options.token ?? "gateway-auth-token",
        password: "",
        bootstrapToken: "",
      },
    },
    agentSelection: { state: { selectedId: "main" } },
    // SAFETY: receipt ownership consumes only authenticated connection and agent state.
  } as unknown as ApplicationContext;
}

describe("first-run activation receipt", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem(deviceKey, JSON.stringify({ version: 1, privateKey }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("persists only bounded, device-keyed activation identity and never credentials", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const context = createContext();

    const receipt = persistFirstRunActivationReceipt(context, {
      kind: "codex-cli",
      modelRef: "openai/gpt-5.6-sol",
    });

    expect(receipt).toMatchObject({
      version: 1,
      gatewayUrl: "wss://gateway.example/control?profile=work",
      agentId: "main",
      modelRef: "openai/gpt-5.6-sol",
      kind: "codex-cli",
      deadlineMs: 495_000,
      owner: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const persisted = localStorage.getItem(receiptKey) ?? "";
    expect(persisted).not.toContain("gateway-auth-token");
    expect(persisted).not.toContain(privateKey);
    expect(readFirstRunActivationReceipt(context)).toEqual(receipt);
  });

  it.each([
    {
      name: "Gateway token",
      replace: (context: ApplicationContext) => {
        context.gateway.connection.token = "different-gateway-token";
      },
    },
    {
      name: "Gateway URL",
      replace: (context: ApplicationContext) => {
        context.gateway.connection.gatewayUrl = "wss://other.example/control?profile=work";
      },
    },
    {
      name: "selected agent",
      replace: (context: ApplicationContext) => {
        context.agentSelection.state.selectedId = "research";
      },
    },
    {
      name: "browser device identity",
      replace: () => {
        localStorage.setItem(deviceKey, JSON.stringify({ version: 1, privateKey: "replacement" }));
      },
    },
  ])("refuses a receipt after its $name changes", ({ replace }) => {
    const context = createContext();
    persistFirstRunActivationReceipt(context, {
      kind: "openai-api-key",
      modelRef: "openai/expected",
    });

    replace(context);

    expect(readFirstRunActivationReceipt(context)).toBeNull();
    expect(localStorage.getItem(receiptKey)).toBeNull();
  });

  it("binds paired-device authentication when no explicit Gateway credential exists", () => {
    const context = createContext({ token: "", deviceToken: "paired-device-token" });
    persistFirstRunActivationReceipt(context, {
      kind: "openai-api-key",
      modelRef: "openai/expected",
    });

    expect(readFirstRunActivationReceipt(context)?.modelRef).toBe("openai/expected");
    context.gateway.snapshot.hello!.auth!.deviceToken = "replacement-device-token";

    expect(readFirstRunActivationReceipt(context)).toBeNull();
    expect(localStorage.getItem(receiptKey)).toBeNull();
  });

  it("expires activation receipts after the request deadline plus its safety window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const context = createContext();
    persistFirstRunActivationReceipt(context, {
      kind: "openai-api-key",
      modelRef: "openai/expected",
    });

    vi.setSystemTime(156_000);

    expect(readFirstRunActivationReceipt(context)).toBeNull();
    expect(localStorage.getItem(receiptKey)).toBeNull();
  });

  it("rejects a tampered model without trusting or replaying its owner receipt", () => {
    const context = createContext();
    const receipt = persistFirstRunActivationReceipt(context, {
      kind: "openai-api-key",
      modelRef: "openai/expected",
    });
    localStorage.setItem(
      receiptKey,
      JSON.stringify({ ...receipt, modelRef: "anthropic/different" }),
    );

    expect(readFirstRunActivationReceipt(context)).toBeNull();
    expect(localStorage.getItem(receiptKey)).toBeNull();
  });

  it("fails closed without durable storage, a persisted device key, or authenticated credentials", () => {
    const context = createContext({ token: "" });
    const candidate = { kind: "openai-api-key", modelRef: "openai/expected" };

    expect(persistFirstRunActivationReceipt(context, candidate)).toBeNull();

    context.gateway.connection.token = "gateway-auth-token";
    localStorage.removeItem(deviceKey);
    expect(persistFirstRunActivationReceipt(context, candidate)).toBeNull();

    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("Browser storage disabled");
      },
      setItem: () => {
        throw new Error("Browser storage disabled");
      },
      removeItem: () => {
        throw new Error("Browser storage disabled");
      },
    });
    expect(persistFirstRunActivationReceipt(context, candidate)).toBeNull();
    expect(readFirstRunActivationReceipt(context)).toBeNull();
    expect(() => clearFirstRunActivationReceipt()).not.toThrow();
  });
});
