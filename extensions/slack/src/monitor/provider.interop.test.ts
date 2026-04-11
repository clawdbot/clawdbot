import { describe, expect, it } from "vitest";
import { __testing } from "./provider.js";

describe("resolveSlackBoltInterop", () => {
  function FakeApp() {}
  function FakeHTTPReceiver() {}

  it("uses the default import when it already exposes named exports", () => {
    const resolved = __testing.resolveSlackBoltInterop({
      defaultImport: {
        App: FakeApp,
        HTTPReceiver: FakeHTTPReceiver,
      },
      namespaceImport: {},
    });

    expect(resolved).toEqual({
      App: FakeApp,
      HTTPReceiver: FakeHTTPReceiver,
    });
  });

  it("uses nested default export when the default import is a wrapper object", () => {
    const resolved = __testing.resolveSlackBoltInterop({
      defaultImport: {
        default: {
          App: FakeApp,
          HTTPReceiver: FakeHTTPReceiver,
        },
      },
      namespaceImport: {},
    });

    expect(resolved).toEqual({
      App: FakeApp,
      HTTPReceiver: FakeHTTPReceiver,
    });
  });

  it("uses the namespace receiver when the default import is the App constructor itself", () => {
    const resolved = __testing.resolveSlackBoltInterop({
      defaultImport: FakeApp,
      namespaceImport: {
        HTTPReceiver: FakeHTTPReceiver,
      },
    });

    expect(resolved).toEqual({
      App: FakeApp,
      HTTPReceiver: FakeHTTPReceiver,
    });
  });

  it("uses namespace.default when it exposes named exports", () => {
    const resolved = __testing.resolveSlackBoltInterop({
      defaultImport: undefined,
      namespaceImport: {
        default: {
          App: FakeApp,
          HTTPReceiver: FakeHTTPReceiver,
        },
      },
    });

    expect(resolved).toEqual({
      App: FakeApp,
      HTTPReceiver: FakeHTTPReceiver,
    });
  });

  it("falls back to the namespace import when it exposes named exports", () => {
    const resolved = __testing.resolveSlackBoltInterop({
      defaultImport: undefined,
      namespaceImport: {
        App: FakeApp,
        HTTPReceiver: FakeHTTPReceiver,
      },
    });

    expect(resolved).toEqual({
      App: FakeApp,
      HTTPReceiver: FakeHTTPReceiver,
    });
  });

  it("throws when the module cannot be resolved", () => {
    expect(() =>
      __testing.resolveSlackBoltInterop({
        defaultImport: null,
        namespaceImport: {},
      }),
    ).toThrow("Unable to resolve @slack/bolt App/HTTPReceiver exports");
  });
});
