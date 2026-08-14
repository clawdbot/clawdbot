import { randomUUID } from "node:crypto";

const TRIGGER = "qa self yield follow-up";
const FOLLOW_UP_MESSAGE =
  "Subagent self yield qa remote job finished. Reply with only the exact marker.";

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(body)}\n`);
}

export default {
  id: "qa-self-yield-followup-subagent",
  register(api) {
    api.on("before_dispatch", async (event) => {
      if (!event.content.toLowerCase().includes(TRIGGER)) {
        return undefined;
      }
      // The kickoff reports its session key so the follow-up can target the same
      // paused session. Adoption is keyed on that session; a fresh key would
      // register an unrelated run instead of continuing this one.
      const childSessionKey = `agent:qa:subagent:qa-self-yield-${randomUUID()}`;
      let result;
      try {
        result = await api.runtime.subagent.run({
          sessionKey: childSessionKey,
          message: "Subagent self yield qa worker: pause until the remote job reports back.",
          deliver: false,
          // Binds the requester to the operator turn that triggered this hook, so
          // the announce this scenario waits for has a real audience to reach.
          completionDelivery: "current-requester",
        });
      } catch (error) {
        return {
          handled: true,
          text: `QA-SELF-YIELD-ERROR ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return {
        handled: true,
        text: `QA-SELF-YIELD-SPAWNED ${result.runId} ${childSessionKey}`,
      };
    });

    api.registerHttpRoute({
      path: "/qa/self-yield/follow-up",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      async handler(req, res) {
        // Hook and route handlers do not share a closure instance here, so the
        // caller supplies the paused session key the kickoff reported.
        const childSessionKey = (await readJsonBody(req))?.sessionKey;
        if (!childSessionKey) {
          writeJson(res, 409, { ok: false, error: "no kickoff session" });
          return true;
        }
        try {
          // Default delivery on purpose: a follow-up that named its own requester
          // would opt into its own audience and run as a sibling, which is the
          // path this proof must not take.
          const result = await api.runtime.subagent.run({
            sessionKey: childSessionKey,
            message: FOLLOW_UP_MESSAGE,
            deliver: false,
          });
          writeJson(res, 200, { ok: true, runId: result.runId });
        } catch (error) {
          writeJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return true;
      },
    });
  },
};
