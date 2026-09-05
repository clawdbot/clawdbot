import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";

const UUID_PATTERN = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const PERSONAL_AUTH_PROFILE_PATTERN = new RegExp(
  `^personal:(${UUID_PATTERN}|${GATEWAY_OWNER_PROFILE_ID}):${UUID_PATTERN}$`,
  "u",
);

// Reserve only generated locators; shared profile names such as personal:work remain valid.
export function isUserModelAuthProfileId(authProfileId: string): boolean {
  return parseUserModelAuthProfileId(authProfileId) !== undefined;
}

/** A storage locator only; the live owner and exact credential still need to exist. */
export function parseUserModelAuthProfileId(
  authProfileId: string,
): { ownerProfileId: string } | undefined {
  const ownerProfileId = PERSONAL_AUTH_PROFILE_PATTERN.exec(authProfileId)?.[1];
  return ownerProfileId ? { ownerProfileId } : undefined;
}
