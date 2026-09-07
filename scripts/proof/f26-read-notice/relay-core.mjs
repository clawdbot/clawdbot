import assert from "node:assert/strict";

export class ReadCase {
  constructor({ label, mode, connection, sessionKey, trigger }, now) {
    assert.match(label, /^[a-z0-9-]{1,80}$/);
    assert(["reject", "hold-reject", "pass"].includes(mode));
    assert(["publication", "refresh"].includes(trigger));
    assert(Number.isInteger(connection));
    assert.equal(typeof sessionKey, "string");
    assert(sessionKey.startsWith("agent:main:"));
    Object.assign(this, { label, mode, connection, sessionKey, trigger });
    this.state = trigger === "publication" ? "armed" : "awaiting-request";
    this.expiresAt = now + 30000;
  }

  publish(sequence) {
    assert.equal(this.state, "armed");
    this.triggerSequence = sequence;
    this.state = "awaiting-event";
  }

  event(connection, frame, sequence) {
    if (
      this.state !== "awaiting-event" ||
      connection !== this.connection ||
      sequence <= this.triggerSequence ||
      frame.event !== "chat.metadata.changed"
    )
      return false;
    this.publicationSequence = sequence;
    this.state = "awaiting-request";
    return true;
  }

  request(connection, frame, sequence, now) {
    if (
      this.state !== "awaiting-request" ||
      connection !== this.connection ||
      frame.method !== "chat.metadata" ||
      frame.params?.sessionKey !== this.sessionKey ||
      (this.trigger === "publication" && sequence <= this.publicationSequence)
    )
      return false;
    assert(now < this.expiresAt);
    this.requestID = frame.id;
    this.requestSequence = sequence;
    this.expiresAt = now + 12000;
    this.state = "awaiting-response";
    return true;
  }

  response(connection, frame, now) {
    if (
      this.state !== "awaiting-response" ||
      connection !== this.connection ||
      frame.id !== this.requestID
    ) {
      return "unrelated";
    }
    assert(now < this.expiresAt, "Case request deadline expired");
    if (!frame.ok) {
      this.state = "upstream-error";
      return "upstream-error";
    }
    this.state = this.mode === "hold-reject" ? "held" : "writing";
    return this.mode;
  }

  release({ connection, sessionKey, requestSequence }, now) {
    assert.equal(this.state, "held");
    assert(now < this.expiresAt, "Held request deadline expired");
    assert.equal(connection, this.connection);
    assert.notEqual(sessionKey, this.sessionKey);
    assert(requestSequence > this.requestSequence);
    this.state = "writing";
  }

  written() {
    assert.equal(this.state, "writing");
    this.state = "written";
  }

  get terminal() {
    return ["written", "invalid", "upstream-error"].includes(this.state);
  }
}
