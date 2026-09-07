import { readUserProfileAliasRevision } from "../state/user-profile-events.js";

let revision = 0;

/** Marks Gateway access decisions stale across asynchronously yielded reads. */
export function bumpGatewayAccessRevision(): void {
  revision += 1;
}

export function readGatewayAccessRevision(): number {
  // Both owners advance monotonically; alias grants can change a page without changing its caller.
  return revision + readUserProfileAliasRevision();
}
