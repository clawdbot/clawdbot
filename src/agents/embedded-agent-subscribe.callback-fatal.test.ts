// Child-process proof uses OpenClaw's real fatal unhandled-rejection handler so
// an accidentally detached callback rejection terminates the negative control.
import { describe, expect, it } from "vitest";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";

const fatalHandlerImport = `
  import { installUnhandledRejectionHandler } from "./src/infra/unhandled-rejections.ts";
  installUnhandledRejectionHandler();
`;

describe("embedded agent callback rejection containment", () => {
  it("proves the real process handler terminates an uncontained rejection", () => {
    const result = spawnNodeEvalSync(
      `${fatalHandlerImport}
       void Promise.reject(new Error("negative-control-rejection"));
       setTimeout(() => console.log("negative control survived"), 50);`,
      { imports: ["tsx"], timeout: 20_000 },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unhandled promise rejection");
    expect(result.stderr).toContain("negative-control-rejection");
    expect(result.stdout).not.toContain("negative control survived");
  });

  it("keeps the production assistant progress path alive when its callback rejects", () => {
    const result = spawnNodeEvalSync(
      `${fatalHandlerImport}
       import { subscribeEmbeddedAgentSession } from "./src/agents/embedded-agent-subscribe.ts";
       let emit = () => {};
       let callbackCalls = 0;
       const session = {
         subscribe(handler) {
           emit = handler;
           return () => {};
         },
       };
       subscribeEmbeddedAgentSession({
         session,
         runId: "fatal-handler-proof",
         onAgentEvent: async () => {
           callbackCalls += 1;
           throw new Error("assistant-progress-rejection");
         },
       });
       emit({
         type: "message_update",
         message: { role: "assistant" },
         assistantMessageEvent: { type: "text_delta", delta: "hello" },
       });
       setTimeout(() => {
         if (callbackCalls !== 1) {
           console.error("unexpected callback count: " + callbackCalls);
           process.exit(2);
         }
         console.log("assistant callback rejection contained");
       }, 50);`,
      { imports: ["tsx"], timeout: 20_000 },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("assistant callback rejection contained");
    expect(result.stderr).not.toContain("Unhandled promise rejection");
  });
});
