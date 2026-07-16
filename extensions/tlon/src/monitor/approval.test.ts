import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const cryptoMocks = vi.hoisted(() => ({
  randomBytes: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomBytes: cryptoMocks.randomBytes,
}));

let generateApprovalId: typeof import("./approval.js").generateApprovalId;

beforeAll(async () => {
  ({ generateApprovalId } = await import("./approval.js"));
});

beforeEach(() => {
  cryptoMocks.randomBytes.mockReset();
});

describe("generateApprovalId", () => {
  it("uses secure hex entropy while preserving the ID format", () => {
    cryptoMocks.randomBytes.mockReturnValueOnce(Buffer.from("a1b2c3", "hex"));
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_717_171_717_171);

    try {
      expect(generateApprovalId("dm")).toBe("dm-1717171717171-a1b2c3");
      expect(cryptoMocks.randomBytes).toHaveBeenCalledWith(3);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
