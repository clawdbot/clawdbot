import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";

it.each(["success", "failure", "replaced", "replaced-during-refresh"])(
  "keeps recovery notifications, errors and refresh scoped to the connection (%s)",
  async (outcome) => {
    const recovery = createDeferred<unknown>();
    const list = createDeferred<unknown>();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.recover") {
        return await recovery.promise;
      }
      if (method === "sessions.list") {
        return await list.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { gateway, publish } = createGatewayHarness({
      request,
    } as unknown as GatewayBrowserClient);
    const sessions = createSessionCapability(gateway);
    const created = vi.fn();
    sessions.subscribeCreated(created);
    const operation = sessions.recover({ key: "agent:main:expired", agentId: "main" });
    const successor = { ok: true, key: "agent:main:recovered", sessionId: "successor" };

    if (outcome === "replaced") {
      publish(false);
    }
    if (outcome === "failure") {
      recovery.reject(new Error("recovery rejected"));
    } else {
      recovery.resolve(successor);
    }
    if (outcome === "success" || outcome === "replaced-during-refresh") {
      await waitForFast(() => expect(created).toHaveBeenCalledWith(successor.key));
      expect(request).toHaveBeenCalledWith(
        "sessions.list",
        expect.objectContaining({ agentId: "main" }),
      );
      if (outcome === "replaced-during-refresh") {
        publish(false);
      }
      list.resolve(sessionsResult([{ key: successor.key, kind: "direct", updatedAt: 1 }], 1));
    }

    await expect(operation).resolves.toEqual(outcome === "success" ? successor : null);
    expect(sessions.state.error).toBe(outcome === "failure" ? "recovery rejected" : null);
    if (outcome === "failure" || outcome === "replaced") {
      expect(created).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalledWith("sessions.list", expect.anything());
    }
    sessions.dispose();
  },
);
