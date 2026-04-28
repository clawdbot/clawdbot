import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { toAcpRuntimeError } from "./errors.js";
import type { AcpRuntime, AcpRuntimeEvent } from "./types.js";

export type AcpRuntimeAdapterContractParams = {
  createRuntime: () => Promise<AcpRuntime> | AcpRuntime;
  agentId?: string;
  successPrompt?: string;
  errorPrompt?: string;
  includeControlChecks?: boolean;
  assertSuccessEvents?: (events: AcpRuntimeEvent[]) => void | Promise<void>;
  assertErrorOutcome?: (params: {
    events: AcpRuntimeEvent[];
    thrown: unknown;
  }) => void | Promise<void>;
};

export async function runAcpRuntimeAdapterContract(
  params: AcpRuntimeAdapterContractParams,
): Promise<void> {
  const runtime = await params.createRuntime();
  const sessionKey = `agent:${params.agentId ?? "codex"}:acp:contract-${randomUUID()}`;
  const agent = params.agentId ?? "codex";

  const handle = await runtime.ensureSession({
    sessionKey,
    agent,
    mode: "persistent",
  });
  expect(handle.sessionKey).toBe(sessionKey);
  expect(handle.backend.trim()).not.toHaveLength(0);
  expect(handle.runtimeSessionName.trim()).not.toHaveLength(0);

  const successEvents: AcpRuntimeEvent[] = [];
  for await (const event of runtime.runTurn({
    handle,
    text: params.successPrompt ?? "contract-success",
    mode: "prompt",
    requestId: `contract-success-${randomUUID()}`,
  })) {
    successEvents.push(event);
  }
  expect(
    successEvents.some(
      (event) =>
        event.type === "done" ||
        event.type === "text_delta" ||
        event.type === "status" ||
        event.type === "tool_call",
    ),
  ).toBe(true);
  expect(successEvents.some((event) => event.type === "done")).toBe(true);
  await params.assertSuccessEvents?.(successEvents);

  if (params.includeControlChecks ?? true) {
    if (runtime.getStatus) {
      const status = await runtime.getStatus({ handle });
      expect(status).toBeDefined();
      expect(typeof status).toBe("object");
    }
    if (runtime.setMode) {
      await runtime.setMode({
        handle,
        mode: "contract",
      });
    }
    if (runtime.setConfigOption) {
      await runtime.setConfigOption({
        handle,
        key: "contract_key",
        value: "contract_value",
      });
    }
  }

  let errorThrown: unknown = null;
  const errorEvents: AcpRuntimeEvent[] = [];
  const errorPrompt = normalizeOptionalString(params.errorPrompt);
  if (errorPrompt) {
    try {
      for await (const event of runtime.runTurn({
        handle,
        text: errorPrompt,
        mode: "prompt",
        requestId: `contract-error-${randomUUID()}`,
      })) {
        errorEvents.push(event);
      }
    } catch (error) {
      errorThrown = error;
    }
    const sawErrorEvent = errorEvents.some((event) => event.type === "error");
    expect(Boolean(errorThrown) || sawErrorEvent).toBe(true);
    if (errorThrown) {
      const acpError = toAcpRuntimeError({
        error: errorThrown,
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "ACP runtime contract expected an error turn failure.",
      });
      expect(acpError.code.length).toBeGreaterThan(0);
      expect(acpError.message.length).toBeGreaterThan(0);
    }
  }
  await params.assertErrorOutcome?.({
    events: errorEvents,
    thrown: errorThrown,
  });

  await runtime.cancel({
    handle,
    reason: "contract-cancel",
  });
  await runtime.close({
    handle,
    reason: "contract-close",
  });
}
