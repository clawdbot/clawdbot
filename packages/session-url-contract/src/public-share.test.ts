import { describe, expect, it } from "vitest";
import {
  buildControlUiPublicSessionSharePath,
  CONTROL_UI_PUBLIC_SESSION_SHARE_TOKEN_MAX_LENGTH,
  parseControlUiPublicSessionShareUrl,
} from "./public-share.js";

const TOKEN = `v1.${"a".repeat(96)}`;

describe("public session share URL", () => {
  it("round-trips only the opaque token under a mounted Control UI path", () => {
    const path = buildControlUiPublicSessionSharePath({ basePath: "/control", token: TOKEN });
    expect(path).toBe(`/control/share/session?token=${TOKEN}`);
    expect(
      parseControlUiPublicSessionShareUrl(
        new URL(path, "https://gateway.example.test"),
        "/control",
      ),
    ).toEqual({ token: TOKEN });
  });

  it.each([
    "/share/session/main/session-id?key=agent%3Amain%3Acurrent&share=" + "a".repeat(48),
    `/share/session?token=${TOKEN}&token=${TOKEN}`,
    `/share/session?token=${TOKEN}&draft=private`,
    "/share/session?token=v1.not+padded=",
    "/share/session?token=v2.opaque",
    `/share/session?token=v1.${"a".repeat(CONTROL_UI_PUBLIC_SESSION_SHARE_TOKEN_MAX_LENGTH)}`,
  ])("rejects noncanonical and retired URL shapes: %s", (path) => {
    expect(parseControlUiPublicSessionShareUrl(new URL(path, "https://gateway.example.test"))).toBe(
      null,
    );
  });
});
