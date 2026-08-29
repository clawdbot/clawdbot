import Foundation
import Testing
@testable import OpenClaw

struct ControlChannelStateDebouncerTests {
    @Test func `terminal states apply immediately`() {
        let start = Date(timeIntervalSince1970: 1000)
        var debouncer = ControlChannelStateDebouncer(interval: 0.5, lastAppliedAt: start)

        let degradedDelay = debouncer.delayBeforeApplying(
            currentState: .connecting,
            newState: .degraded("gateway unavailable"),
            now: start.addingTimeInterval(0.1))
        #expect(degradedDelay != nil)

        let connectedDelay = debouncer.delayBeforeApplying(
            currentState: .connecting,
            newState: .connected,
            now: start.addingTimeInterval(0.2))
        #expect(connectedDelay == nil)

        let afterTerminalDelay = debouncer.delayBeforeApplying(
            currentState: .connected,
            newState: .connecting,
            now: start.addingTimeInterval(0.3))
        #expect(afterTerminalDelay == nil)
    }

    @Test func `nonterminal states are debounced within interval`() {
        let start = Date(timeIntervalSince1970: 1000)
        var debouncer = ControlChannelStateDebouncer(interval: 0.5, lastAppliedAt: start)

        let soonDelay = debouncer.delayBeforeApplying(
            currentState: .connecting,
            newState: .degraded("gateway unavailable"),
            now: start.addingTimeInterval(0.1))
        #expect(soonDelay != nil)
        #expect(abs((soonDelay ?? 0) - 0.4) < 0.001)

        let afterWindowDelay = debouncer.delayBeforeApplying(
            currentState: .connecting,
            newState: .degraded("gateway unavailable"),
            now: start.addingTimeInterval(0.6))
        #expect(afterWindowDelay == nil)
    }

    @Test func `deferred apply resets debounce window`() {
        let start = Date(timeIntervalSince1970: 1000)
        var debouncer = ControlChannelStateDebouncer(interval: 0.5, lastAppliedAt: start)

        debouncer.recordDeferredApply(at: start.addingTimeInterval(0.5))

        let delayAfterDeferredUpdate = debouncer.delayBeforeApplying(
            currentState: .degraded("gateway unavailable"),
            newState: .connecting,
            now: start.addingTimeInterval(0.7))
        #expect(delayAfterDeferredUpdate != nil)
        #expect(abs((delayAfterDeferredUpdate ?? 0) - 0.3) < 0.001)
    }
}

@MainActor
struct ControlChannelGatewayMessageTests {
    @Test(arguments: [
        URLError.Code.cannotFindHost,
        URLError.Code.cannotConnectToHost,
        URLError.Code.cancelled,
        URLError.Code.timedOut,
    ])
    func `direct gateway failures identify their actual endpoint`(code: URLError.Code) {
        let root: [String: Any] = [
            "gateway": [
                "mode": "remote",
                "remote": [
                    "transport": "direct",
                    "url": "ws://127.0.0.1:42674",
                ],
            ],
        ]

        let message = ControlChannel.friendlyGatewayMessage(URLError(code), configRoot: root)

        #expect(message.contains("127.0.0.1:42674"))
        #expect(!message.contains("SSH"))
    }

    @Test func `direct gateway diagnostics never expose URL credentials`() {
        let root: [String: Any] = [
            "gateway": [
                "mode": "remote",
                "remote": [
                    "transport": "direct",
                    "url": "wss://user:secret@gateway.example:9443/path?token=private",
                ],
            ],
        ]

        let message = ControlChannel.friendlyGatewayMessage(
            URLError(.cannotConnectToHost),
            configRoot: root)

        #expect(message.contains("gateway.example:9443"))
        #expect(!message.contains("secret"))
        #expect(!message.contains("private"))
    }

    @Test func `direct secure gateway diagnostics use the default TLS port`() {
        let root: [String: Any] = [
            "gateway": [
                "mode": "remote",
                "remote": [
                    "transport": "direct",
                    "url": "wss://gateway.example",
                ],
            ],
        ]

        let message = ControlChannel.friendlyGatewayMessage(
            URLError(.cannotConnectToHost),
            configRoot: root)

        #expect(message.contains("gateway.example:443"))
    }

    @Test func `direct IPv6 gateway diagnostics bracket the endpoint host`() {
        let root: [String: Any] = [
            "gateway": [
                "mode": "remote",
                "remote": [
                    "transport": "direct",
                    "url": "wss://[fd12:3456:789a::1]:9443",
                ],
            ],
        ]

        let message = ControlChannel.friendlyGatewayMessage(
            URLError(.cannotConnectToHost),
            configRoot: root)

        #expect(message.contains("[fd12:3456:789a::1]:9443"))
    }

    @Test func `SSH gateway failures preserve tunnel recovery guidance`() {
        let root: [String: Any] = [
            "gateway": [
                "mode": "remote",
                "remote": ["transport": "ssh"],
            ],
        ]

        let message = ControlChannel.friendlyGatewayMessage(
            URLError(.cannotConnectToHost),
            configRoot: root)

        #expect(message.contains("localhost:"))
        #expect(message.contains("SSH tunnel"))
    }

    @Test func `direct gateway handshake failures identify the remote endpoint`() {
        let root: [String: Any] = [
            "gateway": [
                "mode": "remote",
                "remote": [
                    "transport": "direct",
                    "url": "wss://gateway.example:9443",
                ],
            ],
        ]
        let error = NSError(
            domain: "Gateway",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "hello failed (unexpected response)"])

        let message = ControlChannel.friendlyGatewayMessage(error, configRoot: root)

        #expect(message.contains("gateway.example:9443"))
        #expect(!message.contains("SSH"))
    }

    @Test func `local gateway failures preserve local recovery guidance`() {
        let root: [String: Any] = ["gateway": ["mode": "local"]]

        let message = ControlChannel.friendlyGatewayMessage(
            URLError(.cannotConnectToHost),
            configRoot: root)

        #expect(message.contains("localhost:"))
        #expect(message.contains("ensure the gateway is running"))
        #expect(!message.contains("SSH"))
    }
}
