import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import {
  createManager,
  createMockOptions,
  waitForAcceptedApproval,
} from "./plugin-approval.test-support.js";

describe("createPluginApprovalHandlers display bounds", () => {
  let manager: ExecApprovalManager<PluginApprovalRequestPayload>;

  beforeEach(() => {
    manager = createManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("truncates a title whose sanitized form exceeds the display limit", async () => {
    const handlers = createPluginApprovalHandlers(manager);
    const respond = vi.fn();
    const opts = createMockOptions(
      "plugin.approval.request",
      {
        title: `spoof${"‮".repeat(20)}x`,
        description: "plain description",
        twoPhase: true,
      },
      { respond },
    );
    const handlerPromise = expectDefined(
      handlers["plugin.approval.request"],
      'handlers["plugin.approval.request"] test invariant',
    )(opts);
    const approvalId = await waitForAcceptedApproval(respond);
    const stored = manager.getSnapshot(approvalId)?.request;
    expect(stored?.title).toMatch(/…$/u);
    expect(Array.from(stored?.title ?? "")).toHaveLength(80);
    manager.resolve(approvalId, "deny");
    await handlerPromise;
  });

  it("stores ampersand-heavy titles literally instead of channel-encoding them", async () => {
    const handlers = createPluginApprovalHandlers(manager);
    const respond = vi.fn();
    const title = `deploy ${"&".repeat(35)} now`;
    const opts = createMockOptions(
      "plugin.approval.request",
      {
        title,
        description: "plain description",
        twoPhase: true,
      },
      { respond },
    );
    const handlerPromise = expectDefined(
      handlers["plugin.approval.request"],
      'handlers["plugin.approval.request"] test invariant',
    )(opts);
    const approvalId = await waitForAcceptedApproval(respond);
    const stored = manager.getSnapshot(approvalId)?.request;
    expect(stored?.title).toBe(title);
    expect(stored?.title).not.toContain("&amp;");
    manager.resolve(approvalId, "deny");
    await handlerPromise;
  });
});
