import type { PlacementStandingGrantMintSpec } from "./operator-approval-placement-grants.js";
import type { CronStandingGrantMintSpec } from "./operator-approval-standing-grants.js";

/** Closed set of derivative grants minted by an allow-always resolution. */
export type OperatorStandingGrantMintSpec =
  | ({ kind: "cron" } & CronStandingGrantMintSpec)
  | ({ kind: "placement" } & PlacementStandingGrantMintSpec);
