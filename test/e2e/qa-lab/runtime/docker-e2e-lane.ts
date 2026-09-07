// Runs an existing Docker E2E lane through the QA Lab script scenario contract.
import {
  formatQaDockerE2eLaneUsage,
  listQaDockerE2eLaneNames,
  parseQaDockerE2eLaneArgs,
  runQaDockerE2eLane,
} from "./docker-e2e-lane.fixture.ts";

const args = parseQaDockerE2eLaneArgs(process.argv.slice(2));
if (args.kind === "help") {
  console.log(formatQaDockerE2eLaneUsage());
  process.exit(0);
}
if (args.kind === "list") {
  console.log(listQaDockerE2eLaneNames().join("\n"));
  process.exit(0);
}

const result = runQaDockerE2eLane(args.laneName);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
