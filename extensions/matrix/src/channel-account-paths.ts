import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import type { PinnedDispatcherPolicy, SsrFPolicy } from "openclaw/plugin-sdk/infra-runtime";
import { formatMatrixErrorMessage } from "./matrix/errors.js";
import type { MatrixProbe } from "./matrix/probe.js";
import type { CoreConfig } from "./types.js";

type ResolveMatrixAuth = (params: { cfg: CoreConfig; accountId?: string }) => Promise<{
  homeserver: string;
  accessToken: string;
  userId: string;
  deviceId?: string;
  allowPrivateNetwork?: boolean;
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
}>;

type ProbeMatrix = (params: {
  homeserver: string;
  accessToken: string;
  userId: string;
  deviceId?: string;
  timeoutMs: number;
  accountId?: string;
  allowPrivateNetwork?: boolean;
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
}) => Promise<MatrixProbe>;

type SendMessageMatrix = (
  to: string,
  message: string,
  options?: { accountId?: string },
) => Promise<unknown>;

export function createMatrixProbeAccount(params: {
  resolveMatrixAuth: ResolveMatrixAuth;
  probeMatrix: ProbeMatrix;
}) {
  return async ({
    account,
    timeoutMs,
    cfg,
  }: {
    account: { accountId?: string };
    timeoutMs?: number;
    cfg: unknown;
  }): Promise<MatrixProbe> => {
    try {
      const auth = await params.resolveMatrixAuth({
        cfg: cfg as CoreConfig,
        accountId: account.accountId,
      });
      return await params.probeMatrix({
        homeserver: auth.homeserver,
        accessToken: auth.accessToken,
        userId: auth.userId,
        deviceId: auth.deviceId,
        timeoutMs: timeoutMs ?? 5_000,
        accountId: account.accountId,
        allowPrivateNetwork: auth.allowPrivateNetwork,
        ssrfPolicy: auth.ssrfPolicy,
        dispatcherPolicy: auth.dispatcherPolicy,
      });
    } catch (err) {
      return {
        ok: false,
        error: formatMatrixErrorMessage(err),
        elapsedMs: 0,
      };
    }
  };
}

export function createMatrixPairingText(sendMessageMatrix: SendMessageMatrix) {
  return {
    idLabel: "matrixUserId",
    message: PAIRING_APPROVED_MESSAGE,
    normalizeAllowEntry: createPairingPrefixStripper(/^matrix:/i),
    notify: async ({
      id,
      message,
      accountId,
    }: {
      id: string;
      message: string;
      accountId?: string;
    }) => {
      await sendMessageMatrix(`user:${id}`, message, accountId ? { accountId } : {});
    },
  };
}
