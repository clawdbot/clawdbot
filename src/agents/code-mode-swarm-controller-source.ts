/** Guest-side Swarm helpers injected into the isolated QuickJS controller. */
export const CODE_MODE_SWARM_CONTROLLER_SOURCE = String.raw`
  class SwarmAgentError extends Error {
    constructor(runId, status, detail) {
      super("Swarm agent " + runId + " " + status + ": " + detail);
      this.name = "SwarmAgentError";
      this.runId = runId;
      this.status = status;
    }
  }

  function swarmNote(kind, value) {
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError(kind + " note must be a non-empty string");
    }
    void request("swarmNote", [{ kind, text: value }], { queue: true }).catch(() => {});
  }

  async function runAgent(prompt, options = {}) {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new TypeError("agents.run prompt must be a non-empty string");
    }
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("agents.run options must be an object");
    }
    if (options.phase !== undefined && (typeof options.phase !== "string" || !options.phase.trim())) {
      throw new TypeError("agents.run phase must be a non-empty string");
    }
    // Match the submitted contract even when callers reuse options while the child runs.
    const structured = options.schema !== undefined;
    if (options.phase !== undefined) swarmNote("phase", options.phase);
    const spawned = await request("agentSpawn", [prompt, options], { queue: true });
    const completion = await request("agentWait", [spawned.runId], { queue: true });
    if (!completion || completion.status !== "done") {
      const runId = completion?.runId ?? spawned.runId ?? "unknown";
      const status = completion?.status ?? "failed";
      const detail = [completion?.error, completion?.schemaError, completion?.result].find(
        (value) => typeof value === "string" && value.trim()
      ) || "collector returned no result";
      throw new SwarmAgentError(runId, status, detail);
    }
    return structured ? completion.structured : completion.result;
  }
`;
