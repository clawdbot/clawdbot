import { GatewayRequestError } from "../../api/gateway.ts";

/** fs.listDir uses INVALID_REQUEST for host filesystem errors; only stable errno markers prove stale input. */
export function isMissingRestoredFolderError(error: unknown): boolean {
  return (
    error instanceof GatewayRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    /^(?:Error:\s+)?(?:ENOENT|ENOTDIR):/u.test(error.message)
  );
}
