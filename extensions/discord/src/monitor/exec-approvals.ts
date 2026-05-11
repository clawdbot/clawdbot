import { ButtonStyle } from "discord-api-types/v10";
import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { ExecApprovalDecision } from "openclaw/plugin-sdk/approval-runtime";
import type {
  DiscordExecApprovalConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { Button, type ButtonInteraction, type ComponentData } from "../internal/discord.js";
export { buildExecApprovalCustomId } from "../approval-handler.runtime.js";
import { getDiscordExecApprovalApprovers } from "../exec-approvals.js";

export { extractDiscordChannelId } from "../approval-native.js";
function decodeCustomIdValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseExecApprovalData(
  data: ComponentData,
): { approvalId: string; action: ExecApprovalDecision } | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const coerce = (value: unknown) =>
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  const rawId = coerce(data.id);
  const rawAction = coerce(data.action);
  if (!rawId || !rawAction) {
    return null;
  }
  const action = rawAction as ExecApprovalDecision;
  if (action !== "allow-once" && action !== "allow-always" && action !== "deny") {
    return null;
  }
  return {
    approvalId: decodeCustomIdValue(rawId),
    action,
  };
}

type ExecApprovalButtonContext = {
  getApprovers: () => string[];
  resolveApproval: (
    approvalId: string,
    decision: ExecApprovalDecision,
  ) => Promise<ExecApprovalResolveResult>;
};

type ExecApprovalResolveResult = { ok: true } | { ok: false; reason: "error" | "not-found" };

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

export class ExecApprovalButton extends Button {
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
          content: "⛔ You are not authorized to approve exec requests.",
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

    const result = await this.ctx.resolveApproval(parsed.approvalId, parsed.action);
    if (!result.ok && result.reason !== "not-found") {
      try {
        await interaction.followUp({
          content: `Failed to submit approval decision for **${decisionLabel}**. The request may have expired or already been resolved.`,
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
    resolveApproval: async (approvalId, decision) => {
      try {
        await resolveApprovalOverGateway({
          cfg: params.cfg,
          approvalId,
          decision,
          gatewayUrl: params.gatewayUrl,
          clientDisplayName: `Discord approval (${params.accountId})`,
        });
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason: isStructuredApprovalNotFoundError(err) ? "not-found" : "error",
        };
      }
    },
  };
}
