import AppKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct MenuSessionsInjectorTests {
    @Test func `anchors dynamic rows below controls and actions`() throws {
        let injector = MenuSessionsInjector()

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Header", action: nil, keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Send Heartbeats", action: nil, keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Browser Control", action: nil, keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Open Dashboard", action: nil, keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Open Chat", action: nil, keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Settings…", action: nil, keyEquivalent: ""))

        let footerSeparatorIndex = try #require(menu.items.lastIndex(where: { $0.isSeparatorItem }))
        #expect(injector.testingFindInsertIndex(in: menu) == footerSeparatorIndex)
        #expect(injector.testingFindNodesInsertIndex(in: menu) == footerSeparatorIndex)
    }

    @Test func `injects disconnected message`() {
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

    @Test func `injects session rows`() throws {
        let injector = MenuSessionsInjector()
        injector.setTestingControlChannelConnected(true)

        let defaults = SessionDefaults(model: "anthropic/claude-opus-4-6", contextTokens: 200_000)
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
                model: "claude-opus-4-6"),
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
                model: "claude-opus-4-6"),
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
        menu.addItem(NSMenuItem(title: "Browser Control", action: nil, keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Open Dashboard", action: nil, keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Settings…", action: nil, keyEquivalent: ""))

        injector.injectForTesting(into: menu)
        #expect(menu.items.contains { $0.tag == 9_415_557 })
        #expect(menu.items.contains { $0.tag == 9_415_557 && $0.isSeparatorItem })
        let sendHeartbeatsIndex = try #require(menu.items.firstIndex(where: { $0.title == "Send Heartbeats" }))
        let openDashboardIndex = try #require(menu.items.firstIndex(where: { $0.title == "Open Dashboard" }))
        let firstInjectedIndex = try #require(menu.items.firstIndex(where: { $0.tag == 9_415_557 }))
        let settingsIndex = try #require(menu.items.firstIndex(where: { $0.title == "Settings…" }))
        #expect(sendHeartbeatsIndex < firstInjectedIndex)
        #expect(openDashboardIndex < firstInjectedIndex)
        #expect(firstInjectedIndex < settingsIndex)
    }

    @Test func `cost usage submenu does not use injector delegate`() {
        let injector = MenuSessionsInjector()
        injector.setTestingControlChannelConnected(true)

        let summary = GatewayCostUsageSummary(
            updatedAt: Date().timeIntervalSince1970 * 1000,
            days: 1,
            daily: [
                GatewayCostUsageDay(
                    date: "2026-02-24",
                    input: 10,
                    output: 20,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 30,
                    totalCost: 0.12,
                    missingCostEntries: 0),
            ],
            totals: GatewayCostUsageTotals(
                input: 10,
                output: 20,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 30,
                totalCost: 0.12,
                missingCostEntries: 0))
        injector.setTestingCostUsageSummary(summary, errorText: nil)

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Header", action: nil, keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Send Heartbeats", action: nil, keyEquivalent: ""))

        injector.injectForTesting(into: menu)

        let usageCostItem = menu.items.first { $0.title == "Usage cost (30 days)" }
        #expect(usageCostItem != nil)
        #expect(usageCostItem?.submenu != nil)
        #expect(usageCostItem?.submenu?.delegate == nil)
    }
}
