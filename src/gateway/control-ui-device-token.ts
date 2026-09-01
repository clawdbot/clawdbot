// Paired-device operator token verification for Control UI read routes.
// Split out of http-auth-utils.ts: main's copy of that file already sits on the
// oxlint 700-line cap for src/**/*.ts, so this cluster has to live on its own.
import { verifyDeviceToken } from "../infra/device-pairing-tokens.js";
import { listDevicePairing } from "../infra/device-pairing.js";
import { verifyPairingToken } from "../infra/pairing-token.js";

const CONTROL_UI_OPERATOR_READ_SCOPE = "operator.read";
const CONTROL_UI_OPERATOR_ROLE = "operator";

export async function verifyControlUiDeviceReadToken(
  token: string,
  requiredSharedGatewaySessionGeneration: string | undefined,
): Promise<string[] | null> {
  const pairing = await listDevicePairing();
  for (const device of pairing.paired) {
    const operatorToken = device.tokens?.[CONTROL_UI_OPERATOR_ROLE];
    if (
      !operatorToken ||
      operatorToken.revokedAtMs ||
      !verifyPairingToken(token, operatorToken.token)
    ) {
      continue;
    }
    const verified = await verifyDeviceToken({
      deviceId: device.deviceId,
      token,
      role: CONTROL_UI_OPERATOR_ROLE,
      scopes: [CONTROL_UI_OPERATOR_READ_SCOPE],
      requiredSharedGatewaySessionGeneration,
    });
    return verified.ok ? [...operatorToken.scopes] : null;
  }
  return null;
}
