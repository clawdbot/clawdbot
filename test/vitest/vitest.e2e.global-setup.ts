// Raw Vitest entrypoint; the project scheduler prepares these same artifacts
// before any selected shard and passes the existing prebuilt contract onward.
import { runE2eGlobalSetup } from "../../scripts/lib/vitest-build-prerequisites.mts";
export default async function setup() {
  await runE2eGlobalSetup();
}
