// Check Protocol Event Coverage tests cover gateway event extraction and drift comparison.
import { describe, expect, it } from "vitest";
import {
  compareEventCoverage,
  extractGatewayEventNames,
  extractKotlinEnumStringConstants,
  extractKotlinHandledEvents,
  extractSwiftHandledEvents,
  extractSwiftStaticStringConstants,
} from "../../scripts/check-protocol-event-coverage.mjs";

const GATEWAY_LIST_FIXTURE = `
export const GATEWAY_EVENTS = [
  "connect.challenge",
  "chat",
  // comment noise
  "session.message",
  "tick",
  "health",
  "terminal.data",
  "terminal.exit",
  "presence",
  "cron",
  "shutdown",
  GATEWAY_EVENT_UPDATE_AVAILABLE,
];
`;

const GATEWAY_CONSTANTS_FIXTURE = `
export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;
`;

describe("extractGatewayEventNames", () => {
  it("collects literals and resolves identifiers", () => {
    const names = extractGatewayEventNames(GATEWAY_LIST_FIXTURE, GATEWAY_CONSTANTS_FIXTURE);
    expect(names).toContain("connect.challenge");
    expect(names).toContain("update.available");
    expect(names).toHaveLength(11);
  });

  it("fails loudly when the array is missing", () => {
    expect(() => extractGatewayEventNames("export const OTHER = [];", "")).toThrow(
      /GATEWAY_EVENTS/,
    );
  });

  it("fails loudly on unresolved identifiers", () => {
    expect(() => extractGatewayEventNames(GATEWAY_LIST_FIXTURE, "")).toThrow(
      /GATEWAY_EVENT_UPDATE_AVAILABLE/,
    );
  });
});

describe("extractSwiftHandledEvents", () => {
  it("collects switch case literals and comparisons, skipping nested and non-event code", () => {
    const constants = extractSwiftStaticStringConstants(`
      enum SomeBridge {
        static let requestedKind = "exec.approval.requested"
      }
    `);
    const source = `
      static func mapEventFrame(_ evt: EventFrame) -> Event? {
        switch evt.event {
        case "tick":
            return .tick
        case "chat", "session.message":
            guard let payload = evt.payload else { return nil }
            switch payload.kind {
            case "nested.ignored":
                return nil
            default:
                return .chat
            }
        case SomeBridge.requestedKind:
            return .approval
        default:
            return nil
        }
      }
      func other(_ status: String) {
        switch status {
        case "ok", "completed":
            break
        default:
            break
        }
      }
      if evt.event == "connect.challenge" { return }
    `;
    const handled = extractSwiftHandledEvents(source, constants);
    expect([...handled].toSorted()).toEqual([
      "chat",
      "connect.challenge",
      "exec.approval.requested",
      "session.message",
      "tick",
    ]);
  });

  it("extracts only type-scoped static string constants", () => {
    const constants = extractSwiftStaticStringConstants(`
      enum ApprovalBridge {
        static let requestedKind = "exec.approval.requested"
        private static let nested = makeValue {
          "not.an.event"
        }
      }
      let requestedKind = "wrong.global.value"
    `);

    expect([...constants]).toEqual([["ApprovalBridge.requestedKind", "exec.approval.requested"]]);
  });

  it("does not resolve qualified constants inside quoted case labels", () => {
    const constants = extractSwiftStaticStringConstants(`
      enum ApprovalBridge {
        static let requestedKind = "exec.approval.requested"
      }
    `);
    const handled = extractSwiftHandledEvents(
      `
        switch evt.event {
        case "ApprovalBridge.requestedKind":
          return .approval
        default:
          return nil
        }
      `,
      constants,
    );

    expect(handled).toEqual(new Set(["ApprovalBridge.requestedKind"]));
  });
});

describe("extractKotlinHandledEvents", () => {
  it("collects literals and generated enum constants inside handler functions only", () => {
    const constants = extractKotlinEnumStringConstants(`
      enum class GatewayEvent(
        val rawValue: String,
      ) {
        ConnectChallenge("connect.challenge"),
        Health("health"),
        Other("other"),
        Modified("modified"),
        Commented("commented"),
        BlockCommented("block-commented"),
        NestedCommented("nested-commented"),
      }
    `);
    const source = `
      fun handleGatewayEvent(event: String, payloadJson: String?) {
        when (event) {
          "tick" -> {
            scope.launch { pollHealth() }
          }
          "chat" -> {
            when (parseKind(payloadJson)) {
              "nested.ignored" -> return
              else -> handleChat(payloadJson)
            }
          }
          "sessions.changed", "session.message" -> refresh()
          GatewayEvent.Health.rawValue, GatewayEvent.Other.rawValue -> refreshHealth()
          GatewayEvent.Modified.rawValue.uppercase() -> ignoreModifiedValue()
          // GatewayEvent.Commented.rawValue -> ignoreComment()
          /*
          GatewayEvent.BlockCommented.rawValue -> ignoreBlockComment()
          */
          /* outer
            /* inner */
            GatewayEvent.NestedCommented.rawValue -> ignoreNestedComment()
          */
          "slash//event", "block/*event*/" -> refreshCommentMarkers()
        }
      }
      private fun handleEvent(
        frame: JsonObject,
      ) {
        val event = frame["event"].asStringOrNull() ?: return
        val rawMarker = """/* raw string */ // raw string"""
        val templateMarker = "\${if (rawMarker.isEmpty()) "/* text */" else "// text"}"
        val slashMarker = '/'
        if (event == GatewayEvent.ConnectChallenge.rawValue) { return }
        if (event == GatewayEvent.Modified.rawValue.trim()) { ignoreModifiedValue() }
        // if (event == GatewayEvent.Commented.rawValue) { ignoreComment() }
        when {
          event == "when-condition" -> refreshCondition()
        }
        val isAssignment = event == "assignment"
        if (!isAssignment) { return }
        val other = keyEvent == "not.a.gateway.event"
      }
    `;
    const handled = extractKotlinHandledEvents(source, constants);
    expect([...handled].toSorted()).toEqual([
      "assignment",
      "block/*event*/",
      "chat",
      "connect.challenge",
      "health",
      "other",
      "session.message",
      "sessions.changed",
      "slash//event",
      "tick",
      "when-condition",
    ]);
  });

  it("extracts only enum-scoped constructor string values", () => {
    const constants = extractKotlinEnumStringConstants(`
      enum class GatewayEvent(
        val rawValue: String,
      ) {
        Tick("tick"),
        Chat("chat"),
      }
      val Tick = "wrong.global.value"
    `);

    expect([...constants]).toEqual([
      ["GatewayEvent.Tick", "tick"],
      ["GatewayEvent.Chat", "chat"],
    ]);
  });

  it("ignores event literals outside handler function bodies", () => {
    // Regression guard: predicate helpers that are not called from the
    // dispatch path must not count as coverage (false negative for the gate).
    const source = `
      internal fun gatewayEventInvalidatesNodesDevices(event: String): Boolean = event == "node.pair.requested" || event == "node.pair.resolved"
      fun topLevelNotAHandler(event: String) {
        if (event == "presence") { render() }
        when (event) {
          "cron" -> refresh()
        }
      }
      fun handleGatewayEvent(event: String) {
        if (event == "tick") { touch() }
      }
    `;
    const handled = extractKotlinHandledEvents(source);
    expect([...handled].toSorted()).toEqual(["tick"]);
  });
});

describe("compareEventCoverage", () => {
  const serverEvents = ["tick", "chat", "presence", "cron"];

  it("passes when every event is handled or allowlisted", () => {
    const errors = compareEventCoverage({
      client: "ios",
      serverEvents,
      handledEvents: new Set(["tick", "chat", "client.only.synthetic"]),
      allowlist: { presence: "not rendered", cron: "not surfaced" },
    });
    expect(errors).toEqual([]);
  });

  it("reports unhandled events missing from the allowlist", () => {
    const errors = compareEventCoverage({
      client: "android",
      serverEvents,
      handledEvents: new Set(["tick", "chat"]),
      allowlist: { presence: "not rendered" },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('[android] gateway event "cron"');
  });

  it("reports stale allowlist entries", () => {
    const errors = compareEventCoverage({
      client: "ios",
      serverEvents,
      handledEvents: new Set(["tick", "chat", "presence"]),
      allowlist: {
        presence: "now handled, should be removed",
        "gone.event": "no longer a gateway event",
        cron: "",
      },
    });
    expect(errors.some((error) => error.includes('"presence" is now handled'))).toBe(true);
    expect(errors.some((error) => error.includes('"gone.event" is not a gateway event'))).toBe(
      true,
    );
    expect(errors.some((error) => error.includes('"cron" needs a non-empty reason'))).toBe(true);
  });
});
