import { readStringParam } from "../runtime-api.js";

export function readDiscordParentIdParam(
  params: Record<string, unknown>,
): string | null | undefined {
  if (params.clearParent === true) {
    return null;
  }
  if (params.parentId === null) {
    return null;
  }
  return readStringParam(params, "parentId");
}
