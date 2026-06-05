// Qa Matrix plugin module implements docker runtime behavior.
import {
  createQaDockerRuntime,
  type QaDockerFetchLike as FetchLike,
  type QaDockerRunCommand as RunCommand,
} from "openclaw/plugin-sdk/qa-runtime";

export type { FetchLike, RunCommand };

const dockerRuntime = createQaDockerRuntime({
  auditContext: "qa-matrix-docker-health-check",
});

export const {
  execCommand,
  fetchHealthUrl,
  resolveComposeServiceUrl,
  resolveHostPort,
  waitForDockerServiceHealth,
  waitForHealth,
} = dockerRuntime;
