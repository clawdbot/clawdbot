import { afterEach, describe, expect, it, vi } from "vitest";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import { createWorkerCredentialMaterial, hashWorkerCredential } from "./credential.js";

afterEach(resetSecretRedactionRegistryForTest);

describe("worker credential material", () => {
  it("requests 32 random bytes and returns only an opaque digest for persistence", () => {
    const credential = ["worker", "credential", "fixture"].join("-");
    const generate = vi.fn(() => credential);
    const material = createWorkerCredentialMaterial(generate);

    expect(generate).toHaveBeenCalledWith(32);
    expect(material).toEqual({
      credential,
      credentialHash: hashWorkerCredential(credential),
    });
    expect(material.credentialHash).toHaveLength(43);
    expect(material.credentialHash).not.toContain(credential);
    expect(isSecretValueRegisteredForRedaction(credential)).toBe(true);
    expect(isSecretValueRegisteredForRedaction(material.credentialHash)).toBe(false);
  });

  it("generates a 32-byte production credential", () => {
    const material = createWorkerCredentialMaterial();
    expect(Buffer.from(material.credential, "base64url")).toHaveLength(32);
    expect(material.credentialHash).toHaveLength(43);
  });
});
