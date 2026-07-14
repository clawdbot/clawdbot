import fs from "node:fs";
import { fileURLToPath } from "node:url";

const repliesPath = fileURLToPath(new URL("./deterministic-gateway-replies.txt", import.meta.url));
const gatewayReply = fs.readFileSync(repliesPath, "utf8").trim();
if (!gatewayReply) throw new Error(`Invalid deterministic replies file: ${repliesPath}`);

export const DETERMINISTIC_GATEWAY_PROVIDER = "dummy";
export const DETERMINISTIC_GATEWAY_MODEL = "dummy";
export const DETERMINISTIC_GATEWAY_MODEL_REF = `${DETERMINISTIC_GATEWAY_PROVIDER}/${DETERMINISTIC_GATEWAY_MODEL}`;
export const DETERMINISTIC_NOTE_MODEL = "note";
export const DETERMINISTIC_NOTE_MODEL_REF = `${DETERMINISTIC_GATEWAY_PROVIDER}/${DETERMINISTIC_NOTE_MODEL}`;
export const DETERMINISTIC_GATEWAY_REPLY = gatewayReply;
export function isDeterministicGatewayModel(provider: string, model: string): boolean {
  return (
    provider.trim().toLowerCase() === DETERMINISTIC_GATEWAY_PROVIDER &&
    [DETERMINISTIC_GATEWAY_MODEL, DETERMINISTIC_NOTE_MODEL].includes(model.trim().toLowerCase())
  );
}

export function isDeterministicNoteModel(provider: string, model: string): boolean {
  return (
    provider.trim().toLowerCase() === DETERMINISTIC_GATEWAY_PROVIDER &&
    model.trim().toLowerCase() === DETERMINISTIC_NOTE_MODEL
  );
}
