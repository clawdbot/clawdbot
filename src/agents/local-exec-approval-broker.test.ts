import { describe, expect, it, vi } from "vitest";
import {
  ExecApprovalRunAbortedError,
  getLocalExecApprovalBroker,
  runWithLocalExecApprovalHandler,
  type LocalExecApprovalRequest,
} from "./local-exec-approval-broker.js";

function approvalRequest(id: string) {
  return {
    id,
    command: "buzz messages send",
    host: "gateway" as const,
    security: "allowlist" as const,
    ask: "on-miss" as const,
    timeoutMs: 1_000,
  };
}

describe("LocalExecApprovalBroker", () => {
  it("preserves the two-phase registration contract", async () => {
    const requestApproval = vi.fn(async () => "allow-once" as const);
    await runWithLocalExecApprovalHandler({
      handler: requestApproval,
      run: async () => {
        const broker = getLocalExecApprovalBroker();
        expect(broker).toBeDefined();
        const registration = broker?.register(approvalRequest("approval-1"));

        expect(registration).toMatchObject({ id: "approval-1" });
        await expect(broker?.wait("approval-1")).resolves.toBe("allow-once");
        await expect(broker?.wait("approval-1")).resolves.toBeUndefined();
      },
    });
    expect(requestApproval).toHaveBeenCalledWith(
      {
        ...approvalRequest("approval-1"),
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
      expect.any(AbortSignal),
    );
  });

  it("rejects duplicate pending approval ids", async () => {
    await runWithLocalExecApprovalHandler({
      handler: async () => "deny",
      run: async () => {
        const broker = getLocalExecApprovalBroker();
        broker?.register(approvalRequest("approval-1"));

        expect(() => broker?.register(approvalRequest("approval-1"))).toThrow(
          'Exec approval "approval-1" is already pending',
        );
      },
    });
  });

  it("scopes brokers to the owning async execution", async () => {
    expect(getLocalExecApprovalBroker()).toBeUndefined();
    await runWithLocalExecApprovalHandler({
      handler: async () => "deny",
      run: async () => {
        const outer = getLocalExecApprovalBroker();
        expect(outer).toBeDefined();
        await runWithLocalExecApprovalHandler({
          handler: async () => "allow-once",
          run: async () => {
            await Promise.resolve();
            expect(getLocalExecApprovalBroker()).not.toBe(outer);
          },
        });
        expect(getLocalExecApprovalBroker()).toBe(outer);
      },
    });
    expect(getLocalExecApprovalBroker()).toBeUndefined();
  });

  it("distinguishes timeout from cancellation when the host handler does not settle", async () => {
    const controller = new AbortController();
    await runWithLocalExecApprovalHandler({
      handler: async () => await new Promise<never>(() => {}),
      signal: controller.signal,
      run: async () => {
        const broker = getLocalExecApprovalBroker();
        broker?.register({ ...approvalRequest("approval-1"), timeoutMs: 5 });
        await expect(broker?.wait("approval-1")).resolves.toBeNull();

        broker?.register(approvalRequest("approval-2"));
        controller.abort(new Error("turn cancelled"));
        await expect(broker?.wait("approval-2")).rejects.toBeInstanceOf(
          ExecApprovalRunAbortedError,
        );
      },
    });
  });

  it("rejects a handler decision that settles after the absolute deadline", async () => {
    let resolveDecision: (decision: "allow-once") => void = () => {};
    const decision = new Promise<"allow-once">((resolve) => {
      resolveDecision = resolve;
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    try {
      await runWithLocalExecApprovalHandler({
        handler: async () => await decision,
        run: async () => {
          const broker = getLocalExecApprovalBroker();
          broker?.register({ ...approvalRequest("approval-1"), timeoutMs: 1_000 });
          now.mockReturnValue(1_100);
          resolveDecision("allow-once");
          await expect(broker?.wait("approval-1")).resolves.toBeNull();
        },
      });
    } finally {
      now.mockRestore();
    }
  });

  it("rejects allow-always when ask policy permits one-shot approval only", async () => {
    await runWithLocalExecApprovalHandler({
      handler: async () => "allow-always",
      run: async () => {
        const broker = getLocalExecApprovalBroker();
        broker?.register({ ...approvalRequest("approval-1"), ask: "always" });
        await expect(broker?.wait("approval-1")).resolves.toBe("deny");
      },
    });
  });

  it("rejects decisions explicitly unavailable for the request", async () => {
    await runWithLocalExecApprovalHandler({
      handler: async () => "allow-always",
      run: async () => {
        const broker = getLocalExecApprovalBroker();
        broker?.register({
          ...approvalRequest("approval-1"),
          unavailableDecisions: ["allow-always"],
        });
        await expect(broker?.wait("approval-1")).resolves.toBe("deny");
      },
    });
  });

  it("keeps authorization policy private from host mutation", async () => {
    await runWithLocalExecApprovalHandler({
      handler: async (request) => {
        expect(Object.isFrozen(request.allowedDecisions)).toBe(true);
        try {
          (request.allowedDecisions as Array<"allow-once" | "allow-always" | "deny">).push(
            "allow-always",
          );
        } catch {}
        return "allow-always";
      },
      run: async () => {
        const broker = getLocalExecApprovalBroker();
        broker?.register({ ...approvalRequest("approval-1"), ask: "always" });
        await expect(broker?.wait("approval-1")).resolves.toBe("deny");
      },
    });
  });

  it("projects secrets and spoofable display text out of host requests", async () => {
    const projectedRequests: LocalExecApprovalRequest[] = [];
    const requestApproval = vi.fn(async (request: LocalExecApprovalRequest) => {
      projectedRequests.push(request);
      return "deny" as const;
    });
    await runWithLocalExecApprovalHandler({
      handler: requestApproval,
      run: async () => {
        const broker = getLocalExecApprovalBroker();
        broker?.register({
          ...approvalRequest("approval-1"),
          command: "echo sk-abc123\u200B456789012345678",
          commandArgv: ["echo", "must-not-leak"],
          env: {
            BUZZ_PRIVATE_KEY: "must-not-leak",
            SAFE: "visible-only-as-a-key",
          },
          warningText: "review\u2028sk-abc123456789012345678",
          systemRunPlan: {
            argv: ["echo", "must-not-leak"],
            cwd: "/tmp",
            commandText: "must-not-leak",
            commandPreview: "must-not-leak",
            agentId: "main",
            sessionKey: "agent:main:test",
          },
        });
        await broker?.wait("approval-1");
      },
    });

    const projected = projectedRequests[0];
    expect(projected).toMatchObject({
      envKeys: ["BUZZ_PRIVATE_KEY", "SAFE"],
      warningText: expect.stringContaining("\n"),
    });
    expect(JSON.stringify(projected)).not.toContain("must-not-leak");
    expect(JSON.stringify(projected)).not.toContain("sk-abc123");
    expect(projected?.command).not.toContain("\u200B");
    expect(projected?.warningText).not.toContain("\u2028");
    expect(projected).not.toHaveProperty("env");
    expect(projected).not.toHaveProperty("commandArgv");
    expect(projected).not.toHaveProperty("systemRunPlan");
  });

  it("rejects approvals registered through retained async context after the turn settles", async () => {
    const requestApproval = vi.fn(async () => "deny" as const);
    let resolveLateRegistration: (error: unknown) => void = () => {};
    const lateRegistration = new Promise<unknown>((resolve) => {
      resolveLateRegistration = resolve;
    });
    await runWithLocalExecApprovalHandler({
      handler: requestApproval,
      run: async () => {
        setImmediate(() => {
          try {
            getLocalExecApprovalBroker()?.register(approvalRequest("approval-late"));
            resolveLateRegistration(undefined);
          } catch (error) {
            resolveLateRegistration(error);
          }
        });
      },
    });

    await expect(lateRegistration).resolves.toMatchObject(
      new Error('Exec approval "approval-late" rejected because its local scope ended'),
    );
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("rejects waits through retained async context after the turn settles", async () => {
    let broker: ReturnType<typeof getLocalExecApprovalBroker>;
    await runWithLocalExecApprovalHandler({
      handler: async () => await new Promise<never>(() => {}),
      run: async () => {
        broker = getLocalExecApprovalBroker();
        broker?.register(approvalRequest("approval-late-wait"));
      },
    });

    await expect(broker?.wait("approval-late-wait")).rejects.toBeInstanceOf(
      ExecApprovalRunAbortedError,
    );
  });
});
