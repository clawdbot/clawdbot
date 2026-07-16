import { describe, expect, it } from "vitest";
import { generateNotifyTwiml } from "./twiml.js";

describe("generateNotifyTwiml", () => {
  it("renders escaped xml with the requested voice", () => {
    expect(generateNotifyTwiml(`Call <ended> & "logged"`, "Polly.Joanna"))
      .toBe(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Call &lt;ended&gt; &amp; &quot;logged&quot;</Say>
  <Hangup/>
</Response>`);
  });
});
