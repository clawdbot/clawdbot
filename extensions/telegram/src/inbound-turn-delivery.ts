export type TelegramInboundTurnDeliveryEnd = () => void;

type ActiveTurn = {
  outboundTo: string;
  outboundAccountId?: string;
  markInboundTurnDelivered: () => void;
};

const registry = new Map<string, ActiveTurn>();

export function beginTelegramInboundTurnDeliveryCorrelation(
  sessionKey: string | undefined,
  turn: ActiveTurn,
): TelegramInboundTurnDeliveryEnd {
  const key = sessionKey?.trim();
  if (!key) {
    return () => {};
  }
  registry.set(key, turn);
  return () => {
    registry.delete(key);
  };
}

export function notifyTelegramInboundTurnOutboundSuccess(params: {
  sessionKey: string | undefined;
  to: string;
  accountId?: string | null;
}): void {
  const key = params.sessionKey?.trim();
  if (!key) {
    return;
  }
  const turn = registry.get(key);
  if (!turn || turn.outboundTo !== params.to) {
    return;
  }
  if (turn.outboundAccountId && params.accountId && params.accountId !== turn.outboundAccountId) {
    return;
  }
  turn.markInboundTurnDelivered();
}
