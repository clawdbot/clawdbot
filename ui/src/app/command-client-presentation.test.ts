import { describe, expect, it, vi } from "vitest";
import { dispatchCommandClientPresentation } from "./command-client-presentation.ts";
import type { ApplicationContext } from "./context.ts";

function createContext(params: {
  scopes: string[];
  phase?: "connected" | "reconnecting";
  openResult?: boolean;
}) {
  const openDevicePairSetup = vi.fn(async () => params.openResult ?? true);
  const context = {
    gateway: {
      snapshot: {
        phase: params.phase ?? "connected",
        hello: { auth: { role: "operator", scopes: params.scopes } },
      },
    },
    overlays: { openDevicePairSetup },
  } as unknown as ApplicationContext;
  return { context, openDevicePairSetup };
}

describe("command client presentation dispatch", () => {
  it("opens device pairing for a connected administrator", async () => {
    const { context, openDevicePairSetup } = createContext({ scopes: ["operator.admin"] });

    await expect(
      dispatchCommandClientPresentation(context, { kind: "device-pairing" }),
    ).resolves.toBe(true);
    expect(openDevicePairSetup).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "pairing-only operator", scopes: ["operator.pairing"], phase: "connected" as const },
    {
      name: "pairing and Talk secrets operator",
      scopes: ["operator.pairing", "operator.talk.secrets"],
      phase: "connected" as const,
    },
    { name: "read-only operator", scopes: ["operator.read"], phase: "connected" as const },
    {
      name: "disconnected administrator",
      scopes: ["operator.admin"],
      phase: "reconnecting" as const,
    },
  ])("falls back for a $name", async ({ scopes, phase }) => {
    const { context, openDevicePairSetup } = createContext({ scopes, phase });

    await expect(
      dispatchCommandClientPresentation(context, { kind: "device-pairing" }),
    ).resolves.toBe(false);
    expect(openDevicePairSetup).not.toHaveBeenCalled();
  });

  it("uses the overlay's explicit handled result", async () => {
    const { context, openDevicePairSetup } = createContext({
      scopes: ["operator.admin"],
      openResult: false,
    });

    await expect(
      dispatchCommandClientPresentation(context, { kind: "device-pairing" }),
    ).resolves.toBe(false);
    expect(openDevicePairSetup).toHaveBeenCalledOnce();
  });

  it("fails closed for an unknown runtime action", async () => {
    const { context, openDevicePairSetup } = createContext({ scopes: ["operator.admin"] });

    await expect(
      dispatchCommandClientPresentation(context, { kind: "open-route" } as never),
    ).resolves.toBe(false);
    expect(openDevicePairSetup).not.toHaveBeenCalled();
  });
});
