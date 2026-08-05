import { describe, expect, it } from "vitest";
import { isAcpMachineOutput } from "./acp-output-mode.js";

describe("isAcpMachineOutput", () => {
  it("recognizes acp info after root options", () => {
    expect(isAcpMachineOutput(["node", "openclaw", "acp", "info"])).toBe(true);
    expect(isAcpMachineOutput(["node", "openclaw", "--profile", "qa", "acp", "info"])).toBe(true);
  });

  it("does not classify ACP protocol or client commands as one-shot JSON", () => {
    expect(isAcpMachineOutput(["node", "openclaw", "acp"])).toBe(false);
    expect(isAcpMachineOutput(["node", "openclaw", "acp", "native"])).toBe(false);
    expect(isAcpMachineOutput(["node", "openclaw", "acp", "client"])).toBe(false);
  });
});
