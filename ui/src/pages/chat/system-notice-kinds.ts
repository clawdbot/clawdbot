import type { toolIcons } from "../../components/icons-tools.ts";

type SystemNoticeKind = {
  icon: keyof typeof toolIcons;
  labelKey: string;
  // Fixed operator summary shown instead of the raw model prompt. Omit when the
  // producer emits variable, informative text (reasons, doctor hints) that must
  // stay visible; the notice then keeps the message body under the kind label.
  summaryKey?: string;
};

const systemNoticeKinds: Readonly<Record<string, SystemNoticeKind>> = {
  main_session_restart_recovery: {
    icon: "cpu",
    labelKey: "chat.systemNotice.restartRecovery.label",
    summaryKey: "chat.systemNotice.restartRecovery.summary",
  },
  "restart-sentinel": {
    icon: "cpu",
    labelKey: "chat.systemNotice.gatewayRestarted.label",
  },
};

export function resolveSystemNoticeKind(
  sourceTool: string | undefined,
): SystemNoticeKind | undefined {
  return sourceTool === undefined ? undefined : systemNoticeKinds[sourceTool];
}
