import AppKit
import Testing
@testable import Moltbot

@Suite(.serialized)
@MainActor
struct MenuSessionsInjectorTests {
    @Test func injectsDisconnectedMessage() {
        let injector = MenuSessionsInjector()
        injector.setTestingControlChannelConnected(false)
        injector.setTestingSnapshot(nil, errorText: nil)

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Header", action: nil, keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Send Heartbeats", action: nil, keyEquivalent: ""))

        injector.injectForTesting(into: menu)
        #expect(menu.items.contains { $0.tag == 9_415_557 })
    }

    @Test func injectsSessionRows() {
        let injector = MenuSessionsInjector()
        injector.setTestingControlChannelConnected(true)

        let defaults = SessionDefaults(model: "anthropic/claude-opus-4-5", contextTokens: 200_000)
        let rows = [
            SessionRow(
                id: "main",
                key: "main",
                kind: .direct,
                displayName: nil,
                provider: nil,
                subject: nil,
                room: nil,
                space: nil,
                updatedAt: Date(),
                sessionId: "s1",
                thinkingLevel: "low",
                verboseLevel: nil,
                systemSent: false,
                abortedLastRun: false,
                tokens: SessionTokenStats(input: 10, output: 20, total: 30, contextTokens: 200_000),
                model: "claude-opus-4-5"),
            SessionRow(
                id: "discord:group:alpha",
                key: "discord:group:alpha",
                kind: .group,
                displayName: nil,
                provider: nil,
                subject: nil,
                room: nil,
                space: nil,
                updatedAt: Date(timeIntervalSinceNow: -60),
                sessionId: "s2",
                thinkingLevel: "high",
                verboseLevel: "debug",
                systemSent: true,
                abortedLastRun: true,
                tokens: SessionTokenStats(input: 50, output: 50, total: 100, contextTokens: 200_000),
                model: "claude-opus-4-5"),
        ]
        let snapshot = SessionStoreSnapshot(
            storePath: "/tmp/sessions.json",
            defaults: defaults,
            rows: rows)
        injector.setTestingSnapshot(snapshot, errorText: nil)

        let usage = GatewayUsageSummary(
            updatedAt: Date().timeIntervalSince1970 * 1000,
            providers: [
                GatewayUsageProvider(
                    provider: "anthropic",
                    displayName: "Claude",
                    windows: [GatewayUsageWindow(label: "5h", usedPercent: 12, resetAt: nil)],
                    plan: "Pro",
                    error: nil),
                GatewayUsageProvider(
                    provider: "openai-codex",
                    displayName: "Codex",
                    windows: [GatewayUsageWindow(label: "day", usedPercent: 3, resetAt: nil)],
                    plan: nil,
                    error: nil),
            ])
        injector.setTestingUsageSummary(usage, errorText: nil)

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Header", action: nil, keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Send Heartbeats", action: nil, keyEquivalent: ""))

        injector.injectForTesting(into: menu)
        #expect(menu.items.contains { $0.tag == 9_415_557 })
        #expect(menu.items.contains { $0.tag == 9_415_557 && $0.isSeparatorItem })
    }
}
