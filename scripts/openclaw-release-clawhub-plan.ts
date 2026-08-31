#!/usr/bin/env -S node --import tsx
// OpenClaw release ClawHub plan CLI emits release workflow routing as JSON.

import { pathToFileURL } from "node:url";
import {
  buildOpenClawReleaseClawHubPlan,
  parseOpenClawReleaseClawHubPlanArgs,
} from "./lib/openclaw-release-clawhub-plan.ts";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseOpenClawReleaseClawHubPlanArgs(process.argv.slice(2));
  const plan = await buildOpenClawReleaseClawHubPlan(args);
  console.log(JSON.stringify(plan, null, 2));
}
