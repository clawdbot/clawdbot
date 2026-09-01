import { generateSecureToken } from "../../infra/secure-random.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";

const NODE_WORKSPACE_TRANSFER_TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/** Mint one process-local bearer. Its owner stores every authority binding separately. */
export function mintNodeWorkspaceTransferToken(
  generateToken: (bytes: number) => string = generateSecureToken,
): string {
  const token = generateToken(NODE_WORKSPACE_TRANSFER_TOKEN_BYTES);
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error("Workspace transfer token generator returned an invalid bearer");
  }
  registerSecretValueForRedaction(token);
  return token;
}
