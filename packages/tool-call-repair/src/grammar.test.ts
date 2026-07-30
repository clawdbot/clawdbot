import { describe, expect, it } from "vitest";
import { scanXmlishToolCall, utf8ByteLengthWithinLimit } from "./grammar.js";

describe("scanXmlishToolCall", () => {
  it.each([
    "<function=read>",
    "<function=read></func",
    "<function=read><parameter=path>/tmp/file",
    "[tool:read]<parameter=path>/tmp/file",
    "[read]\n<parameter=path>/tmp/file",
  ])("keeps incomplete syntax as a prefix: %s", (raw) => {
    expect(scanXmlishToolCall(raw).kind).toBe("prefix");
  });

  it.each([
    "<function=get_system_info></function>",
    "<function=read><parameter=path>/tmp/file</parameter></function>",
    "[tool:read]<parameter=path>/tmp/file</parameter>",
    "[read]\n<parameter=path>/tmp/file</parameter></function>",
  ])("accepts the supported complete forms: %s", (raw) => {
    const scan = scanXmlishToolCall(`${raw}\nvisible`);
    expect(scan.kind).toBe("complete");
    if (scan.kind !== "complete") {
      return;
    }
    expect(scan.end).toBe(raw.length);
  });

  it("accepts 120-character names at both XML boundaries", () => {
    const name = "x".repeat(120);
    expect(
      scanXmlishToolCall(`<function=${name}><parameter=${name}>value</parameter></function>`).kind,
    ).toBe("complete");
  });

  it("preserves name case while matching XML tags case-insensitively", () => {
    const raw = "<FuNcTiOn=Read><PaRaMeTeR=Path>value</pArAmEtEr></fUnCtIoN>";
    const scan = scanXmlishToolCall(raw);

    expect(scan.kind).toBe("complete");
    if (scan.kind !== "complete") {
      return;
    }
    expect(raw.slice(scan.name.start, scan.name.end)).toBe("Read");
    const parameter = scan.parameters[0];
    expect(parameter && raw.slice(parameter.name.start, parameter.name.end)).toBe("Path");
  });

  it.each([
    "[tool:get_system_info]</function>",
    "[get_system_info]\n</function>",
    `<function=${"x".repeat(121)}></function>`,
    `<function=${"x".repeat(121)}`,
    `<function=read><parameter=${"x".repeat(121)}>value</parameter></function>`,
    `<function=read><parameter=${"x".repeat(121)}`,
  ])("rejects invalid or ambiguous executable forms: %s", (raw) => {
    expect(scanXmlishToolCall(raw).kind).toBe("invalid");
  });

  it("returns absolute name, parameter, payload, and call spans", () => {
    const call = [
      "<function=write>",
      "<parameter=content>",
      "  hello",
      "</parameter>",
      "</function>",
    ].join("\n");
    const raw = `  ${call}\nvisible`;
    const scan = scanXmlishToolCall(raw, 2);

    expect(scan.kind).toBe("complete");
    if (scan.kind !== "complete") {
      return;
    }
    expect(raw.slice(scan.name.start, scan.name.end)).toBe("write");
    expect(raw.slice(scan.payload.start, scan.payload.end)).toBe(
      "\n<parameter=content>\n  hello\n</parameter>\n",
    );
    expect(scan.parameters).toHaveLength(1);
    const parameter = scan.parameters[0];
    expect(parameter && raw.slice(parameter.name.start, parameter.name.end)).toBe("content");
    expect(parameter && raw.slice(parameter.value.start, parameter.value.end)).toBe("\n  hello\n");
    expect(scan.end).toBe(2 + call.length);
  });

  it("exposes an incomplete body span for UTF-8 limit enforcement", () => {
    const raw = `<function=read>${"\u00a0".repeat(128_001)}`;
    const scan = scanXmlishToolCall(raw);

    expect(scan.kind).toBe("prefix");
    if (scan.kind !== "prefix" || !scan.candidate?.payload) {
      return;
    }
    expect(raw.length).toBeLessThan(256_000);
    expect(
      utf8ByteLengthWithinLimit(
        raw,
        scan.candidate.payload.start,
        scan.candidate.payload.end,
        256_000,
      ),
    ).toBeNull();
  });

  it("excludes a partial function close from the payload cap", () => {
    const body = " ".repeat(255_999);
    const prefix = `<function=read>${body}</func`;
    const scan = scanXmlishToolCall(prefix);

    expect(scan.kind).toBe("prefix");
    if (scan.kind !== "prefix" || !scan.candidate?.payload) {
      return;
    }
    expect(
      utf8ByteLengthWithinLimit(
        prefix,
        scan.candidate.payload.start,
        scan.candidate.payload.end,
        256_000,
      ),
    ).toBe(255_999);
    expect(scanXmlishToolCall(`${prefix}tion>`).kind).toBe("complete");
  });

  it.each(["</func", "<param"])(
    "retains the complete optional-close call before an ambiguous %s prefix",
    (suffix) => {
      const complete = "[tool:read]<parameter=path>/tmp/file</parameter>";
      const scan = scanXmlishToolCall(`${complete}${suffix}`);

      expect(scan.kind).toBe("prefix");
      if (scan.kind !== "prefix") {
        return;
      }
      expect(scan.completeEnd).toBe(complete.length);
    },
  );

  it("retains the first visible byte after an invalid over-cap body prefix", () => {
    const visible = "Visible answer";
    const raw = `<function=read>${"\u00a0".repeat(128_001)}${visible}`;
    const scan = scanXmlishToolCall(raw);

    expect(scan.kind).toBe("invalid");
    if (scan.kind !== "invalid") {
      return;
    }
    expect(raw.slice(scan.at)).toBe(visible);
  });
});
