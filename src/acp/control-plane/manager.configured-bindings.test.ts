/** Tests configured binding controls against the real ACP manager lifecycle. */
import { describe, expect, it, vi } from "vitest";
import { buildConfiguredAcpSessionKey } from "../persistent-bindings.types.js";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager configured bindings", () => {
  installAcpSessionManagerTestLifecycle();

  it("keeps startup omission but rejects live binding changes before overwriting accepted thinking", async () => {
    const managerModule = await import("./manager.js");
    const { ensureConfiguredAcpBindingSession } =
      await import("../persistent-bindings.lifecycle.js");
    const runtimeState = createRuntime();
    runtimeState.setConfigOption.mockImplementation(async ({ key, value }) => {
      if (value === "off") {
        throw new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", "Live off is unsupported");
      }
      return {
        configOptions: [{ id: "thinking", currentValue: key === "model" ? "medium" : value }],
      };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const spec = {
      channel: "discord" as const,
      accountId: "default",
      conversationId: "configured-thinking",
      agentId: "codex",
      mode: "persistent" as const,
      thinking: "off",
    };
    const sessionKey = buildConfiguredAcpSessionKey(spec);
    let currentMeta: SessionAcpMeta | undefined;
    hoisted.readAcpSessionEntryMock.mockImplementation(() =>
      currentMeta ? { sessionKey, storeSessionKey: sessionKey, acp: currentMeta } : null,
    );
    hoisted.upsertAcpSessionMetaMock.mockImplementation(
      ({
        mutate,
      }: {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta },
        ) => SessionAcpMeta | null | undefined;
      }) => {
        currentMeta = mutate(currentMeta, { acp: currentMeta }) ?? currentMeta;
        return { sessionId: "configured-session", updatedAt: Date.now(), acp: currentMeta };
      },
    );
    const manager = new AcpSessionManager();
    const getManager = vi.spyOn(managerModule, "getAcpSessionManager").mockReturnValue(manager);
    const ensure = (thinking?: string) =>
      ensureConfiguredAcpBindingSession({ cfg: baseCfg, spec: { ...spec, thinking } });
    const runTurn = (requestId: string) =>
      manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey,
        text: requestId,
        mode: "prompt",
        requestId,
      });
    try {
      expect(await ensure("off")).toEqual({ ok: true, sessionKey });
      await runTurn("first");
      await runTurn("second");
      expect(currentMeta?.runtimeOptions?.thinking).toBe("off");

      expect(await ensure("high")).toEqual({ ok: true, sessionKey });
      await runTurn("third");
      const acceptedMeta = currentMeta;
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await ensure("off")).toEqual({
          ok: false,
          sessionKey,
          error: "Live off is unsupported",
        });
        expect(currentMeta).toEqual(acceptedMeta);
      }
      expect(await ensure()).toEqual({ ok: true, sessionKey });
      await runTurn("fourth");
      expect(currentMeta?.runtimeOptions?.thinking).toBe("high");
      expect(runtimeState.ensureSession).toHaveBeenCalledOnce();
      expect(runtimeState.close).not.toHaveBeenCalled();
      expect(runtimeState.runTurn).toHaveBeenCalledTimes(4);
      runtimeState.setConfigOption.mockClear();
      expect(
        await ensureConfiguredAcpBindingSession({
          cfg: baseCfg,
          spec: { ...spec, model: "openai/gpt-5.6-luna", thinking: "high" },
        }),
      ).toEqual({ ok: true, sessionKey });
      expect(
        runtimeState.setConfigOption.mock.calls.map(([input]) => [input.key, input.value]),
      ).toEqual([
        ["model", "openai/gpt-5.6-luna"],
        ["thinking", "high"],
      ]);
      expect(currentMeta?.runtimeOptions).toEqual({
        model: "openai/gpt-5.6-luna",
        thinking: "high",
      });
    } finally {
      getManager.mockRestore();
    }
  });
});
