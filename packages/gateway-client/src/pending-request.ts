/** Owned settlement, cleanup, and timing state for one Gateway wire request. */
export type GatewayPendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  expectFinal: boolean;
  acceptedNotified: boolean;
  onAccepted?: (payload: unknown) => void;
  cleanup?: () => void;
  unbounded: boolean;
  method: string;
  startedAtMs: number;
};
