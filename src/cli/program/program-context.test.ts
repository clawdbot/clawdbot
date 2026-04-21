import { Command } from "commander";
import { describe, expect, it } from "vitest";
import type { ProgramContext } from "./context.js";
import { getProgramContext, setProgramContext } from "./program-context.js";

function makeCtx(version: string): ProgramContext {
  return {
    programVersion: version,
    channelOptions: ["quietchat"],
    messageChannelOptions: "quietchat",
    agentChannelOptions: "last|quietchat",
  };
}

describe("program context storage", () => {
  it("stores and retrieves context on a command instance", () => {
    const program = new Command();
    const ctx = makeCtx("1.2.3");
    setProgramContext(program, ctx);
    expect(getProgramContext(program)).toBe(ctx);
  });

  it("returns undefined when no context was set", () => {
    expect(getProgramContext(new Command())).toBeUndefined();
  });

  it("does not leak context between command instances", () => {
    const programA = new Command();
    const programB = new Command();
    const ctxA = makeCtx("a");
    const ctxB = makeCtx("b");
    setProgramContext(programA, ctxA);
    setProgramContext(programB, ctxB);

    expect(getProgramContext(programA)).toBe(ctxA);
    expect(getProgramContext(programB)).toBe(ctxB);
  });
});
