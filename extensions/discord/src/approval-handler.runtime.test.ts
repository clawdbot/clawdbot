// Discord tests cover approval handler plugin behavior.
import { describe, expect, it } from "vitest";
import { discordApprovalNativeRuntime } from "./approval-handler.runtime.js";
import { DiscordUiContainer } from "./ui.js";

async function buildExecApprovalPayloadText(commandText: string): Promise<string> {
  const pending = await discordApprovalNativeRuntime.presentation.buildPendingPayload({
    cfg: {} as never,
    accountId: "main",
    context: {
      token: "discord-token",
      config: {} as never,
    },
    request: {
      id: "approval-1",
      request: {
        command: commandText,
      },
      createdAtMs: 0,
      expiresAtMs: 1_000,
    },
    approvalKind: "exec",
    nowMs: 0,
    view: {
      approvalKind: "exec",
      phase: "pending",
      approvalId: "approval-1",
      title: "Exec Approval Required",
      commandText,
      commandPreview: null,
      expiresAtMs: 1_000,
      metadata: [],
      actions: [
        {
          label: "Allow",
          decision: "allow-once",
          style: "success",
          command: "/approve approval-1 allow-once",
          action: {
            type: "approval",
            approvalId: "approval-1",
            approvalKind: "exec",
            decision: "allow-once",
          },
        },
      ],
    },
  });
  return JSON.stringify(pending);
}

async function buildPluginApprovalPayloadText(params?: {
  severity?: "info" | "warning" | "critical";
  expiresAtMs?: number;
}): Promise<string> {
  const expiresAtMs = params?.expiresAtMs ?? 1_000;
  const pending = await discordApprovalNativeRuntime.presentation.buildPendingPayload({
    cfg: {} as never,
    accountId: "main",
    context: {
      token: "discord-token",
      config: {} as never,
    },
    request: {
      id: "plain-plugin-id",
      request: {
        title: "Install plugin",
        description: "Approve the requested plugin",
      },
      createdAtMs: 0,
      expiresAtMs,
    },
    approvalKind: "plugin",
    nowMs: 0,
    view: {
      approvalKind: "plugin",
      phase: "pending",
      approvalId: "plain-plugin-id",
      title: "Install plugin",
      description: "Approve the requested plugin",
      severity: params?.severity ?? "warning",
      pluginId: "example-plugin",
      toolName: "plugin.install",
      metadata: [],
      actions: [
        {
          label: "Deny",
          decision: "deny",
          style: "danger",
          command: "/approve plain-plugin-id deny",
          action: {
            type: "approval",
            approvalId: "plain-plugin-id",
            approvalKind: "plugin",
            decision: "deny",
          },
        },
      ],
      expiresAtMs,
    },
  } as never);
  return JSON.stringify(pending);
}

describe("discordApprovalNativeRuntime", () => {
  it("keeps create-only nonce fields out of the shared multi-target payload", async () => {
    const pending = await discordApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "main",
      context: { token: "discord-token", config: {} as never },
      request: {
        id: "approval-1",
        request: { command: "hostname" },
        createdAtMs: 0,
        expiresAtMs: 1_000,
      },
      approvalKind: "exec",
      nowMs: 0,
      view: {
        approvalKind: "exec",
        phase: "pending",
        approvalId: "approval-1",
        title: "Exec Approval Required",
        commandText: "hostname",
        commandPreview: null,
        expiresAtMs: 1_000,
        metadata: [],
        actions: [],
      },
    });

    expect(pending.body).not.toHaveProperty("nonce");
    expect(pending.body).not.toHaveProperty("enforce_nonce");
  });

  it("encodes the explicit owner kind in exec and plugin approval buttons", async () => {
    const execPayload = await buildExecApprovalPayloadText("hostname");
    expect(execPayload).toContain("execapproval:kind=exec;id=approval-1;action=allow-once");
    expect(execPayload).toContain('"allowed_mentions":{"parse":[]}');
    await expect(buildPluginApprovalPayloadText()).resolves.toContain(
      "execapproval:kind=plugin;id=plain-plugin-id;action=deny",
    );
  });

  it.each([
    { severity: "info" as const, accentColor: 0x5865f2 },
    { severity: "warning" as const, accentColor: 0xfaa61a },
    { severity: "critical" as const, accentColor: 0xed4245 },
  ])("preserves $severity plugin approval styling and clamps expiry", async (params) => {
    const payload = await buildPluginApprovalPayloadText({
      severity: params.severity,
      expiresAtMs: -1,
    });

    expect(payload).toContain(`"accent_color":${params.accentColor}`);
    expect(payload).toContain("Expires <t:0:R>");
  });

  it.each([
    {
      approvalKind: "exec",
      phase: "resolved",
      decision: "allow-once",
      label: "Allowed (once)",
      accentColor: 0x57f287,
    },
    {
      approvalKind: "exec",
      phase: "resolved",
      decision: "allow-always",
      label: "Allowed (always)",
      accentColor: 0x5865f2,
    },
    {
      approvalKind: "exec",
      phase: "resolved",
      decision: "deny",
      label: "Denied",
      accentColor: 0xed4245,
    },
    {
      approvalKind: "plugin",
      phase: "resolved",
      decision: "allow-once",
      label: "Allowed (once)",
      accentColor: 0x57f287,
    },
    {
      approvalKind: "plugin",
      phase: "resolved",
      decision: "allow-always",
      label: "Allowed (always)",
      accentColor: 0x5865f2,
    },
    {
      approvalKind: "plugin",
      phase: "resolved",
      decision: "deny",
      label: "Denied",
      accentColor: 0xed4245,
    },
    { approvalKind: "exec", phase: "expired", label: "Expired", accentColor: 0x99aab5 },
    { approvalKind: "plugin", phase: "expired", label: "Expired", accentColor: 0x99aab5 },
  ] as const)(
    "preserves $approvalKind $phase approval components and terminal preview limits ($label)",
    async (scenario) => {
      const plugin = scenario.approvalKind === "plugin";
      const commandLimit = plugin ? 700 : 500;
      const secondaryLimit = plugin ? 1_000 : 300;
      const command = `${"x".repeat(commandLimit)}😀`;
      const secondary = `${"y".repeat(secondaryLimit)}😀`;
      const view = {
        approvalId: "approval-<@123>",
        approvalKind: scenario.approvalKind,
        phase: scenario.phase,
        title: plugin ? command : "Exec Approval Required",
        metadata: [{ label: "agent", value: "crew" }],
        ...(plugin
          ? { description: secondary, severity: "critical" }
          : { commandText: command, commandPreview: secondary }),
        ...(scenario.phase === "resolved"
          ? { decision: scenario.decision, resolvedBy: "<@456>" }
          : {}),
      };
      const args = {
        cfg: {} as never,
        accountId: "main",
        context: { token: "discord-token", config: {} as never },
        view,
      };
      const result =
        scenario.phase === "resolved"
          ? await discordApprovalNativeRuntime.presentation.buildResolvedResult(args as never)
          : await discordApprovalNativeRuntime.presentation.buildExpiredResult(args as never);

      expect(result.kind).toBe("update");
      if (result.kind !== "update") {
        return;
      }
      expect(result.payload).toBeInstanceOf(DiscordUiContainer);
      if (!(result.payload instanceof DiscordUiContainer)) {
        return;
      }
      const container = result.payload.serialize();
      expect(container).toMatchObject({
        accent_color: scenario.accentColor,
        components: expect.arrayContaining([
          { content: `## ${plugin ? "Plugin" : "Exec"} Approval: ${scenario.label}`, type: 10 },
          { content: `### Command\n\`\`\`\n${"x".repeat(commandLimit)}...\n\`\`\``, type: 10 },
          {
            content: `### Shell Preview\n\`\`\`\n${"y".repeat(secondaryLimit)}...\n\`\`\``,
            type: 10,
          },
          { content: "- agent: crew", type: 10 },
          { content: "-# ID: approval\\-\\<@123\\>", type: 10 },
          {
            content:
              scenario.phase === "resolved"
                ? "Resolved by \\<@456\\>"
                : "This approval request has expired.",
            type: 10,
          },
        ]),
      });
      expect(JSON.stringify(container)).not.toContain("custom_id");
    },
  );

  it("does not split emoji graphemes when truncating exec command previews", async () => {
    const prefix = "a".repeat(999);

    await expect(buildExecApprovalPayloadText(`${prefix}😀x`)).resolves.toContain(`${prefix}...`);
    await expect(buildExecApprovalPayloadText(`${prefix}🇺🇸x`)).resolves.toContain(`${prefix}...`);
  });

  it("routes origin approval updates to the Discord thread channel when threadId is present", async () => {
    const prepared = await discordApprovalNativeRuntime.transport.prepareTarget({
      cfg: {} as never,
      accountId: "main",
      context: {
        token: "discord-token",
        config: {} as never,
      },
      plannedTarget: {
        surface: "origin",
        reason: "preferred",
        target: {
          to: "123456789",
          threadId: "777888999",
        },
      },
      request: {
        id: "req-1",
        request: {
          command: "hostname",
        },
        createdAtMs: 0,
        expiresAtMs: 1_000,
      },
      approvalKind: "exec",
      view: {} as never,
      pendingPayload: {} as never,
    });

    expect(prepared).toEqual({
      dedupeKey: "777888999",
      target: {
        discordChannelId: "777888999",
      },
    });
  });
});
