import AppKit
import Darwin
import Foundation
import SwiftUI
import Testing
@testable import OpenClaw

struct HealthStoreStateTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["OPENCLAW_TEST_HEALTH_RENDER_DIR"] != nil))
    @MainActor func `health settings render`() async throws {
        let environment = ProcessInfo.processInfo.environment
        let output = try URL(fileURLWithPath: #require(environment["OPENCLAW_TEST_HEALTH_RENDER_DIR"]))
        let home = try URL(fileURLWithPath: #require(environment["CFFIXED_USER_HOME"]))
        try #require(FileManager.default.homeDirectoryForCurrentUser.resolvingSymlinksInPath() == home)
        try #require(URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath() == home)
        let suite = try #require(AppProfile.current.defaultsSuiteName)
        try #require(AppDefaults.standard.persistentDomain(forName: suite)?.isEmpty ?? true)
        try #require(OpenClawPaths.stateDirURL == home.appendingPathComponent("state", isDirectory: true))
        try #require(OpenClawConfigFile.loadDict().isEmpty)
        let canary = try #require(environment["OPENCLAW_TEST_HEALTH_DENIED_FILE"])
        try #require((try? Data(contentsOf: URL(fileURLWithPath: canary))) == nil)
        try Self.requireNetworkDenied()

        // The isolated helper runs only this test. Keep detached view tasks on fixtures until process exit.
        await ConfigStore._testSetOverrides(.init(isRemoteMode: { false }, loadLocal: { [:] }))
        let tailscale = TailscaleService(
            isInstalled: false,
            isRunning: false,
            appInstallationProbe: { false },
            cliInstallationProbe: { false },
            statusDataLoader: { _ in throw URLError(.notConnectedToInternet) })
        let state = AppState(preview: true)
        state.connectionMode = .local
        state.isPaused = true
        for (name, channelId, fields, expected) in [
            (
                "ready",
                "telegram",
                ["running": true, "connected": true, "lifecycle": "ready"] as [String: Any],
                "Telegram ready"),
            (
                "startup-grace",
                "telegram",
                [
                    "running": true, "connected": false, "lifecycle": "starting", "lastStartAt": 1_772_798_370_000,
                ],
                "Telegram running"),
            (
                "stale-socket",
                "telegram",
                [
                    "running": true, "connected": true, "lifecycle": "ready", "healthState": "stale-socket",
                    "lastStartAt": 1_772_794_800_000, "lastTransportActivityAt": 1_772_796_540_000,
                ],
                "Telegram degraded · stale-socket"),
            ("disabled", "telegram", ["enabled": false, "running": false], "Telegram disabled"),
            (
                "probe-permission",
                "imessage",
                Self.permissionProbeChannel,
                "iMessage degraded · \(Self.permissionProbeError) (status unknown)"),
        ] {
            try Self.withSnapshot([channelId: fields], order: [channelId]) { store in
                let hosting = NSHostingView(rootView: ConnectionSettingsView(state: state, isActive: false)
                    // Capture the view's light canvas, not transparent text over the window's excluded background.
                        .background(.white)
                        .environment(tailscale)
                        .environment(\.locale, Locale(identifier: "en_US"))
                        .environment(\.colorScheme, .light))
                hosting.appearance = NSAppearance(named: .aqua)
                hosting.frame = NSRect(x: 0, y: 0, width: 900, height: 1000)
                let window = NSWindow(contentRect: hosting.frame, styleMask: [], backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.contentView = hosting
                defer {
                    window.contentView = nil
                    window.close()
                }
                hosting.layoutSubtreeIfNeeded()
                let bitmap = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
                hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
                let png = try #require(bitmap.representation(using: .png, properties: [:]))
                try png.write(to: output.appendingPathComponent("\(name).png"))
                #expect(store.summaryLine == expected)
            }
        }
    }

    private static func requireNetworkDenied() throws {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        if descriptor < 0 {
            try #require(errno == EPERM || errno == EACCES)
            return
        }
        defer { close(descriptor) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = UInt16(9).bigEndian
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        try #require(result == -1 && (errno == EPERM || errno == EACCES))
    }

    @Test @MainActor func `current channel lifecycle reports healthy`() throws {
        try Self.withSnapshot([
            "telegram": ["running": true, "connected": true, "lifecycle": "ready"],
        ]) { store in
            #expect(store.state == .ok)
            #expect(store.summaryLine == "Telegram ready")
        }
    }

    @Test @MainActor func `linked channel probe failure degrades state`() throws {
        try Self.withSnapshot([
            "whatsapp": [
                "linked": true,
                "authAgeMs": 1,
                "probe": ["ok": false, "status": 503, "error": "gateway connect failed", "elapsedMs": 12],
                "lastProbeAt": 1_772_798_400_000,
            ],
        ], order: ["whatsapp"]) { store in
            switch store.state {
            case let .degraded(message):
                #expect(!message.isEmpty)
            default:
                Issue.record("Expected degraded state when probe fails for linked channel")
            }

            #expect(store.summaryLine.contains("probe degraded"))
        }
    }

    @Test @MainActor func `current channel selection skips an unconfigured entry`() throws {
        try Self.withSnapshot([
            "disabled": ["configured": false, "running": false, "connected": false, "lifecycle": "stopped"],
            "telegram": ["running": true, "connected": true, "lifecycle": "ready"],
        ], order: ["disabled", "telegram"]) { store in
            #expect(store.state == .ok)
            #expect(store.summaryLine == "Telegram ready")
        }
    }

    @Test @MainActor func `current channel probe failure degrades state`() throws {
        for (channelId, fields, label, expected) in [
            ("imessage", Self.permissionProbeChannel, "iMessage", "\(Self.permissionProbeError) (status unknown)"),
            // Generic imsg timeouts exercise formatting, not the FDA-only public probe redactor.
            ("imessage", [
                "probe": ["ok": false, "error": "imsg rpc timeout (chats.list)"],
                "running": true, "lifecycle": "starting", "lastStartAt": 1_772_798_395_000,
            ], "iMessage", "Health check timed out"),
            ("telegram", [
                "probe": ["ok": false, "status": 503, "error": "gateway connect failed", "elapsedMs": 12],
                "lastProbeAt": 1_772_798_400_000,
                "running": true,
                "connected": true,
                "lifecycle": "ready",
            ], "Telegram", "gateway connect failed (status 503, 12ms)"),
        ] {
            try Self.withSnapshot([channelId: fields], order: [channelId]) { store in
                #expect(store.state == .degraded(expected))
                #expect(store.summaryLine == "\(label) degraded · \(expected)")
            }
        }
    }

    @Test @MainActor func `fallback channel with last error is not healthy`() throws {
        try Self.withChannel([
            "running": true,
            "connected": true,
            "lifecycle": "ready",
            "lastError": "polling failed",
        ], unlinkedFirst: true) { store in
            #expect(store.state == .linkingNeeded)
            #expect(store.summaryLine == "Not linked — run openclaw login")
        }
    }

    @Test(arguments: [
        ("starting", true),
        ("recovering", false),
    ])
    @MainActor func `fresh lifecycle without health state respects gateway grace`(
        lifecycle: String, running: Bool) throws
    {
        // The collector omits healthState when grace is healthy and the producer supplied no state.
        for unlinkedFirst in [false, true] {
            try Self.withChannel([
                "running": running,
                "connected": false,
                "lifecycle": lifecycle,
                "lastStartAt": 1_772_798_370_000,
            ], unlinkedFirst: unlinkedFirst) { store in
                #expect(store.state == (unlinkedFirst ? .degraded("Not linked") : .ok))
                #expect(store.summaryLine.contains("Telegram"))
            }
        }
    }

    @Test(arguments: [
        ("starting", "starting"),
        ("recovering", "reconnecting"),
        ("recovering", "error"),
        ("recovering", "sync-paused"),
    ])
    @MainActor func `matrix informational health states remain healthy during grace`(
        lifecycle: String, healthState: String) throws
    {
        // Matrix preserves producer strings, including error without lastError and future SDK states.
        var fields: [String: Any] = [
            "running": true,
            "connected": false,
            "lifecycle": lifecycle,
            "healthState": healthState,
            "lastStartAt": 1_772_798_370_000,
        ]
        if lifecycle == "recovering" {
            fields["lastStartAt"] = 1_772_794_800_000
            fields["lastDisconnect"] = ["at": 1_772_798_395_000]
        }
        for unlinkedFirst in [false, true] {
            try Self.withChannel(fields, channelId: "matrix", unlinkedFirst: unlinkedFirst) { store in
                #expect(store.state == (unlinkedFirst ? .degraded("Not linked") : .ok))
                #expect(store.summaryLine.contains("Matrix"))
            }
        }
    }

    @Test(arguments: [
        ("starting", true, "disconnected"),
        ("recovering", true, "disconnected"),
        ("recovering", false, "not-running"),
    ])
    @MainActor func `expired lifecycle reports the gateway failure reason`(
        lifecycle: String, running: Bool, reason: String) throws
    {
        var fields: [String: Any] = [
            "running": running,
            "connected": false,
            "lifecycle": lifecycle,
            "lastStartAt": 1_772_798_100_000,
            "healthState": reason,
        ]
        if lifecycle == "recovering" {
            fields["lastDisconnect"] = ["at": 1_772_798_220_000]
        }
        for unlinkedFirst in [false, true] {
            try Self.withChannel(fields, unlinkedFirst: unlinkedFirst) { store in
                #expect(store.state == (unlinkedFirst ? .linkingNeeded : .degraded(reason)))
                if !unlinkedFirst {
                    #expect(store.summaryLine.contains(reason))
                }
            }
        }
    }

    @Test(arguments: ["stale-socket", "ingress-unavailable"])
    @MainActor func `gateway failure overrides ready transport flags`(reason: String) throws {
        var fields: [String: Any] = [
            "running": true,
            "connected": true,
            "lifecycle": "ready",
            "lastStartAt": 1_772_794_800_000,
            "healthState": reason,
        ]
        if reason == "stale-socket" {
            fields["lastTransportActivityAt"] = 1_772_796_540_000
        } else {
            fields["lastTransportActivityAt"] = 1_772_798_395_000
            fields["ingressUnavailable"] = true
        }
        for unlinkedFirst in [false, true] {
            try Self.withChannel(fields, unlinkedFirst: unlinkedFirst) { store in
                #expect(store.state == (unlinkedFirst ? .linkingNeeded : .degraded(reason)))
                if !unlinkedFirst {
                    #expect(store.summaryLine.contains(reason))
                }
            }
        }
        fields["linked"] = true
        fields["authAgeMs"] = 1
        try Self.withChannel(fields, channelId: "whatsapp", unlinkedFirst: false) { store in
            #expect(store.state == .degraded(reason))
            #expect(store.summaryLine.contains(reason))
        }
    }

    @Test(arguments: [false, true])
    @MainActor func `unlinked channels cannot provide a healthy fallback`(whatsappFirst: Bool) throws {
        try Self.withSnapshot([
            "whatsapp": Self.unlinkedWhatsApp,
            "zalouser": ["configured": true, "linked": false, "running": false],
        ], order: whatsappFirst ? ["whatsapp", "zalouser"] : ["zalouser", "whatsapp"]) { store in
            #expect(store.state == .linkingNeeded)
            #expect(store.summaryLine == "Not linked — run openclaw login")
        }
    }

    @Test(arguments: [nil, false, true] as [Bool?])
    @MainActor func `selected disabled channels remain inactive`(linked: Bool?) throws {
        let channel = linked == nil ? "telegram" : "whatsapp"
        let label = linked == nil ? "Telegram" : "WhatsApp"
        var fields: [String: Any] = ["enabled": false, "configured": true, "running": false]
        if let linked {
            fields["linked"] = linked
            fields["connected"] = false
            fields["lifecycle"] = "stopped"
            fields["healthState"] = "stopped"
        }
        var channels = [channel: fields]
        var order = [channel]
        if linked == nil {
            channels["matrix"] = [
                "configured": true, "running": true, "connected": true, "lifecycle": "ready",
                "healthState": "healthy",
            ]
            order.append("matrix")
        }
        try Self.withSnapshot(channels, order: order) { store in
            #expect(store.state == .unknown)
            #expect(store.summaryLine == "\(label) disabled")
        }
    }

    @Test @MainActor func `disabled channels cannot provide a healthy fallback`() throws {
        try Self.withSnapshot([
            "whatsapp": Self.unlinkedWhatsApp,
            "telegram": ["enabled": false, "configured": true, "running": false],
        ], order: ["whatsapp", "telegram"]) { store in
            #expect(store.state == .linkingNeeded)
            #expect(store.summaryLine == "Not linked — run openclaw login")
        }
    }

    @Test(arguments: [nil, true] as [Bool?])
    @MainActor func `enabled and unspecified channels remain eligible`(enabled: Bool?) throws {
        var fields: [String: Any] = [
            "configured": true, "running": true, "connected": true, "lifecycle": "ready",
        ]
        if let enabled { fields["enabled"] = enabled }
        try Self.withSnapshot(["telegram": fields], order: ["telegram"]) { store in
            #expect(store.state == .ok)
            #expect(store.summaryLine == "Telegram ready")
        }
        try Self.withSnapshot([
            "whatsapp": Self.unlinkedWhatsApp,
            "telegram": fields,
        ], order: ["whatsapp", "telegram"]) { store in
            #expect(store.state == .degraded("Not linked"))
            #expect(store.summaryLine == "Telegram ok · Not linked — run openclaw login")
        }
    }

    private static let permissionProbeError =
        "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway."

    private static var permissionProbeChannel: [String: Any] {
        // Public health preserves this sanitized FDA error without an HTTP status; startup has no lastError yet.
        [
            "probe": ["ok": false, "error": self.permissionProbeError],
            "running": true, "lifecycle": "starting", "lastStartAt": 1_772_798_395_000,
        ]
    }

    private static var unlinkedWhatsApp: [String: Any] {
        [
            "configured": true, "linked": false, "running": false, "connected": false,
            "healthState": "stopped", "lifecycle": "stopped",
        ]
    }

    @MainActor private static func withChannel(
        _ fields: [String: Any],
        channelId: String = "telegram",
        unlinkedFirst: Bool,
        body: @MainActor (HealthStore) throws -> Void) throws
    {
        var channels = [channelId: fields]
        var order = [channelId]
        if unlinkedFirst {
            channels["whatsapp"] = Self.unlinkedWhatsApp
            order.insert("whatsapp", at: 0)
        }
        try self.withSnapshot(channels, order: order, body: body)
    }

    @MainActor private static func withSnapshot(
        _ channels: [String: [String: Any]],
        order: [String] = ["telegram"],
        body: @MainActor (HealthStore) throws -> Void) throws
    {
        let accounts = channels.mapValues { fields in
            var account: [String: Any] = ["accountId": "default", "configured": true]
            account.merge(fields) { _, value in value }
            return account
        }
        // Fixed Gateway response time keeps grace and expired lifecycle fixtures deterministic.
        let fixture: [String: Any] = [
            "ok": true,
            "ts": 1_772_798_400_000,
            "durationMs": 2,
            "channels": accounts,
            "channelOrder": order,
            "channelLabels": [
                "telegram": "Telegram", "matrix": "Matrix", "whatsapp": "WhatsApp", "zalouser": "Zalo Personal",
                "disabled": "Disabled", "imessage": "iMessage",
            ],
            "heartbeatSeconds": 60,
            "sessions": ["path": "/tmp/sessions.json", "count": 0, "recent": []],
        ]
        let data = try JSONSerialization.data(withJSONObject: fixture)
        let snap = try #require(decodeHealthSnapshot(from: data))
        let store = HealthStore.shared
        let previousSnapshot = store.snapshot
        let previousError = store.lastError
        defer { store.__setSnapshotForTest(previousSnapshot, lastError: previousError) }

        store.__setSnapshotForTest(snap, lastError: nil)
        try body(store)
    }
}
