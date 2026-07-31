// Discord plugin module implements exec approvals behavior.
import { ButtonStyle } from "discord-api-types/v10";
import {
  resolveApprovalOverGateway,
  type ApprovalResolveResult,
} from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { PendingApprovalView } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { ExecApprovalDecision } from "openclaw/plugin-sdk/approval-runtime";
import type {
  DiscordExecApprovalConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { parseExecApprovalData } from "../approval-custom-id.js";
import {
  DISCORD_APPROVAL_ALLOWED_MENTIONS,
  formatDiscordApprovalDisplayValue,
} from "../approval-message-safety.js";
import { getDiscordExecApprovalApprovers } from "../exec-approvals.js";
import {
  Button,
  Container,
  Separator,
  TextDisplay,
  type ButtonInteraction,
  type ComponentData,
  type MessagePayloadObject,
} from "../internal/discord.js";

type ExecApprovalButtonContext = {
  getApprovers: () => string[];
  resolveApproval: (
    approvalId: string,
    approvalKind: PendingApprovalView["approvalKind"],
    decision: ExecApprovalDecision,
  ) => Promise<ExecApprovalResolveResult>;
};

type ExecApprovalResolveResult =
  | { ok: true; resolution: ApprovalResolveResult }
  | { ok: false; reason: "error" | "not-found" };

function resolveTerminalLabel(approval: ApprovalResolveResult["approval"]): string {
  if (approval.status === "allowed") {
    return approval.decision === "allow-always" ? "Allowed always" : "Allowed once";
  }
  if (approval.status === "denied") {
    return "Denied";
  }
  return approval.status === "expired" ? "Expired" : "Cancelled";
}

function buildTerminalPayload(params: {
  approval: ApprovalResolveResult["approval"];
  applied: boolean;
}): MessagePayloadObject {
  const { approval } = params;
  const label = resolveTerminalLabel(approval);
  const accentColor =
    approval.status === "denied"
      ? "#ED4245"
      : approval.status === "allowed"
        ? "#57F287"
        : "#99AAB5";
  return {
    allowed_mentions: DISCORD_APPROVAL_ALLOWED_MENTIONS,
    components: [
      new Container(
        [
          new TextDisplay(params.applied ? "## Approval resolved" : "## Approval already resolved"),
          new TextDisplay(`Canonical result: **${label}**`),
          new Separator({ divider: false, spacing: "small" }),
          new TextDisplay(`-# ID: ${formatDiscordApprovalDisplayValue(approval.id)}`),
        ],
        { accentColor },
      ),
    ],
  };
}

function isStructuredApprovalNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const record = err as {
    gatewayCode?: unknown;
    details?: { reason?: unknown } | null;
  };
  if (record.gatewayCode === "APPROVAL_NOT_FOUND") {
    return true;
  }
  return (
    record.gatewayCode === "INVALID_REQUEST" && record.details?.reason === "APPROVAL_NOT_FOUND"
  );
}

class ExecApprovalButton extends Button {
  override label = "execapproval";
  customId = "execapproval:seed=1";
  override style = ButtonStyle.Primary;

  constructor(private readonly ctx: ExecApprovalButtonContext) {
    super();
  }

  override async run(interaction: ButtonInteraction, data: ComponentData): Promise<void> {
    const parsed = parseExecApprovalData(data);
    if (!parsed) {
      try {
        await interaction.reply({
          content: "This approval is no longer valid.",
          ephemeral: true,
        });
      } catch {}
      return;
    }

    const approvers = this.ctx.getApprovers();
    const userId = interaction.userId;
    if (!approvers.some((id) => id === userId)) {
      try {
        await interaction.reply({
          content: "⛔ You are not authorized to approve requests.",
          ephemeral: true,
        });
      } catch {}
      return;
    }

    const decisionLabel =
      parsed.action === "allow-once"
        ? "Allowed (once)"
        : parsed.action === "allow-always"
          ? "Allowed (always)"
          : "Denied";

    try {
      await interaction.acknowledge();
    } catch {}

    const result = await this.ctx.resolveApproval(
      parsed.approvalId,
      parsed.approvalKind,
      parsed.action,
    );
    if (!result.ok) {
      try {
        await interaction.followUp({
          content:
            result.reason === "not-found"
              ? `That approval request is no longer pending. It may have expired or already been resolved.`
              : `Failed to submit approval decision for **${decisionLabel}**. The request may have expired or already been resolved.`,
          ephemeral: true,
        });
      } catch {}
      return;
    }
    const terminalLabel = resolveTerminalLabel(result.resolution.approval);
    let terminalized = false;
    try {
      // Always terminalize the clicked message. Generic forwarding has no native
      // delivery receipt, and native event/local updates may safely race.
      await interaction.editReply(
        buildTerminalPayload({
          approval: result.resolution.approval,
          applied: result.resolution.applied,
        }),
      );
      terminalized = true;
    } catch {}
    if (!terminalized || !result.resolution.applied) {
      try {
        await interaction.followUp({
          content: result.resolution.applied
            ? `Approval resolved: ${terminalLabel}.`
            : `This approval was already resolved: ${terminalLabel}.`,
          ephemeral: true,
        });
      } catch {}
    }
  }
}

export function createExecApprovalButton(ctx: ExecApprovalButtonContext): Button {
  return new ExecApprovalButton(ctx);
}

export function createDiscordExecApprovalButtonContext(params: {
  cfg: OpenClawConfig;
  accountId: string;
  config: DiscordExecApprovalConfig;
  gatewayUrl?: string;
}): ExecApprovalButtonContext {
  return {
    getApprovers: () =>
      getDiscordExecApprovalApprovers({
        cfg: params.cfg,
        accountId: params.accountId,
        configOverride: params.config,
      }),
    resolveApproval: async (approvalId, approvalKind, decision) => {
      try {
        const resolution = await resolveApprovalOverGateway({
          cfg: params.cfg,
          approvalId,
          approvalKind,
          decision,
          gatewayUrl: params.gatewayUrl,
          clientDisplayName: `Discord approval (${params.accountId})`,
        });
        return { ok: true, resolution };
      } catch (err) {
        return {
          ok: false,
          reason: isStructuredApprovalNotFoundError(err) ? "not-found" : "error",
        };
      }
    },
  };
}
