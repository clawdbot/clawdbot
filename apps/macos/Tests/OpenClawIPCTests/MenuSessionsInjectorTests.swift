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
        let contextItem = menu.items.first { $0.tag == 9_415_557 && $0.title == "Context" }
        #expect(contextItem != nil)
        #expect(contextItem?.submenu != nil)
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
                    provider: "openai",
                    displayName: "Codex",
                    windows: [GatewayUsageWindow(label: "day", usedPercent: 3, resetAt: nil)],
                    plan: nil,
                    error: nil),
            ])
        injector.setTestingUsageSummary(usage)

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
        let contextItem = try #require(menu.items.first { $0.tag == 9_415_557 && $0.title == "Context" })
        let contextSubmenu = try #require(contextItem.submenu)
        #expect(menu.items.count(where: { $0.tag == 9_415_557 && $0.title == "Context" }) == 1)
        #expect(menu.items.contains { $0.tag == 9_415_557 && $0.isSeparatorItem })
        #expect(contextSubmenu.items.compactMap { $0.representedObject as? String }.count(where: { [
            "main",
            "discord:group:alpha",
        ].contains($0) }) == 2)
        #expect(contextSubmenu.items.allSatisfy { $0.title != "Usage cost (30 days)" })
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

        let contextItem = menu.items.first { $0.tag == 9_415_557 && $0.title == "Context" }
        #expect(contextItem?.submenu?.items.allSatisfy { $0.title != "Usage cost (30 days)" } == true)
        let usageCostItem = menu.items.first { $0.title == "Usage cost (30 days)" }
        #expect(usageCostItem != nil)
        #expect(usageCostItem?.submenu != nil)
        #expect(usageCostItem?.submenu?.delegate == nil)
    }

    @Test func `completed provider error remains visible in usage section`() throws {
        let payload = Data(
            #"{"updatedAt":1,"providers":[{"provider":"openai","displayName":"OpenAI","windows":[],"plan":null,"error":"Request timed out"}]}"#
                .utf8)
        let summary = try JSONDecoder().decode(GatewayUsageSummary.self, from: payload)
        let row = try #require(summary.primaryRows().first)
        #expect(row.detailText() == "Request timed out")

        let injector = MenuSessionsInjector()
        injector.setTestingControlChannelConnected(true)
        injector.setTestingUsageSummary(
            GatewayUsageSummary(updatedAt: 0, providers: [], refreshing: false))
        let quiet = Self.makeMenuShell()
        injector.injectForTesting(into: quiet)
        let quietItems = quiet.items.count(where: { $0.tag == 9_415_557 })

        injector.setTestingUsageSummary(summary)
        let menu = Self.makeMenuShell()
        injector.injectForTesting(into: menu)

        #expect(menu.items.count(where: { $0.tag == 9_415_557 }) == quietItems + 3)
    }

    @Test func `cold incomplete usage converges without starting the cache ttl`() async {
        let injector = MenuSessionsInjector()
        injector.setTestingControlChannelConnected(true)
        injector.setTestingUsageRetryInterval(0)
        let events = UsageLoadEvents()
        injector.setTestingUsageLoadDidFinish { events.finished() }
        var calls = 0
        injector.setTestingUsageLoader {
            calls += 1
            if calls == 1 {
                return GatewayUsageSummary(updatedAt: 1, providers: [], refreshing: true)
            }
            return GatewayUsageSummary(updatedAt: 2, providers: [], refreshing: false)
        }

        await injector.refreshUsageCacheForTesting(force: true)
        #expect(injector.testingUsageCacheUpdatedAt == nil)
        #expect(await events.waitFor(count: 2))
        #expect(calls == 2)
        #expect(injector.testingUsageCacheUpdatedAt != nil)
    }

    @Test func `incomplete usage retry is bounded`() async {
        let injector = MenuSessionsInjector()
        injector.setTestingControlChannelConnected(true)
        injector.setTestingUsageRetryInterval(0)
        let events = UsageLoadEvents()
        injector.setTestingUsageLoadDidFinish { events.finished() }
        injector.setTestingUsageRetryDidExhaust { events.exhausted() }
        injector.setTestingUsageLoader {
            GatewayUsageSummary(updatedAt: 1, providers: [], refreshing: true)
        }

        await injector.refreshUsageCacheForTesting(force: true)
        #expect(await events.waitFor(count: 4))
        #expect(await events.waitForExhaustion())
        #expect(injector.testingUsageCacheUpdatedAt == nil)
    }

    @Test func `open menu repaint does not restart exhausted usage retries`() async {
        let injector = MenuSessionsInjector()
        injector.setTestingControlChannelConnected(true)
        injector.setTestingUsageRetryInterval(0)
        injector.setTestingSnapshot(
            SessionStoreSnapshot(
                storePath: "/tmp/sessions.json",
                defaults: SessionDefaults(model: "anthropic/claude-opus-4-6", contextTokens: 200_000),
                rows: []),
            errorText: nil)
        injector.setTestingCostUsageSummary(nil, errorText: nil)
        injector.setTestingUsageSummary(
            GatewayUsageSummary(updatedAt: 0, providers: [], refreshing: false))
        let events = UsageLoadEvents()
        injector.setTestingUsageLoadDidFinish { events.finished() }
        injector.setTestingUsageRetryDidExhaust { events.exhausted() }
        var calls = 0
        injector.setTestingUsageLoader {
            calls += 1
            return GatewayUsageSummary(updatedAt: 1, providers: [], refreshing: true)
        }

        let menu = Self.makeMenuShell()
        injector.menuWillOpen(menu)
        for _ in 0..<100 {
            await Task.yield()
        }
        await injector.refreshUsageCacheForTesting(force: true)
        #expect(await events.waitFor(count: 4))
        #expect(await events.waitForExhaustion())

        // AppKit asks the delegate to update the still-open menu after its rows
        // change. That repaint belongs to the same retry lifecycle.
        injector.menuWillOpen(menu)
        for _ in 0..<10000 {
            await Task.yield()
        }

        #expect(calls == 4)
        injector.menuDidClose(menu)
        injector.menuWillOpen(menu)
        #expect(await events.waitFor(count: 8))
        #expect(calls == 8)
        injector.menuDidClose(menu)
    }

    @Test func `closing menu cancels pending usage retry`() async {
        let injector = MenuSessionsInjector()
        injector.setTestingControlChannelConnected(true)
        injector.setTestingUsageRetryInterval(0.1)
        injector.setTestingSnapshot(
            SessionStoreSnapshot(
                storePath: "/tmp/sessions.json",
                defaults: SessionDefaults(model: "anthropic/claude-opus-4-6", contextTokens: 200_000),
                rows: []),
            errorText: nil)
        injector.setTestingCostUsageSummary(nil, errorText: nil)
        let events = UsageLoadEvents()
        injector.setTestingUsageLoadDidFinish { events.finished() }
        var calls = 0
        injector.setTestingUsageLoader {
            calls += 1
            return GatewayUsageSummary(updatedAt: 1, providers: [], refreshing: true)
        }

        let menu = Self.makeMenuShell()
        injector.menuWillOpen(menu)
        #expect(await events.waitFor(count: 1))
        #expect(calls == 1)

        injector.menuDidClose(menu)
        try? await Task.sleep(nanoseconds: 200_000_000)

        #expect(calls == 1)
    }

    @Test func `rejected usage retries preserve a visible stalled section`() async {
        let injector = MenuSessionsInjector()
        injector.setTestingControlChannelConnected(true)
        injector.setTestingUsageRetryInterval(0)
        let events = UsageLoadEvents()
        injector.setTestingUsageLoadDidFinish { events.finished() }
        injector.setTestingUsageRetryDidExhaust { events.exhausted() }

        injector.setTestingUsageSummary(
            GatewayUsageSummary(updatedAt: 0, providers: [], refreshing: false))
        let quiet = Self.makeMenuShell()
        injector.injectForTesting(into: quiet)
        let quietItems = quiet.items.count(where: { $0.tag == 9_415_557 })

        var calls = 0
        injector.setTestingUsageLoader {
            calls += 1
            if calls == 1 {
                return GatewayUsageSummary(updatedAt: 1, providers: [], refreshing: true)
            }
            throw UsageLoadTestError.unavailable
        }

        await injector.refreshUsageCacheForTesting(force: true)
        #expect(await events.waitFor(count: 4))
        #expect(await events.waitForExhaustion())
        #expect(calls == 4)
        #expect(injector.testingCachedUsageSummary?.refreshing == true)
        #expect(injector.testingUsageCacheUpdatedAt == nil)

        let stalled = Self.makeMenuShell()
        injector.injectForTesting(into: stalled)
        #expect(stalled.items.count(where: { $0.tag == 9_415_557 }) == quietItems + 3)
        #expect(stalled.items.contains(where: {
            $0.title == "Usage did not finish loading. Close and reopen this menu to retry."
        }))
    }

    @Test func `stalled usage keeps a visible menu section`() async {
        let injector = MenuSessionsInjector()
        injector.setTestingControlChannelConnected(true)
        injector.setTestingUsageRetryInterval(0)
        let events = UsageLoadEvents()
        injector.setTestingUsageLoadDidFinish { events.finished() }
        injector.setTestingUsageRetryDidExhaust { events.exhausted() }

        // An operator with no usage providers still gets no usage section.
        injector.setTestingUsageSummary(
            GatewayUsageSummary(updatedAt: 1, providers: [], refreshing: false))
        let quiet = Self.makeMenuShell()
        injector.injectForTesting(into: quiet)
        let quietItems = quiet.items.count(where: { $0.tag == 9_415_557 })

        injector.setTestingUsageLoader {
            GatewayUsageSummary(updatedAt: 1, providers: [], refreshing: true)
        }
        await injector.refreshUsageCacheForTesting(force: true)
        #expect(await events.waitForExhaustion())

        // Spent budget with the marker still set: separator, header, and the
        // stalled row, never the silent menu an empty provider list produces.
        let stalled = Self.makeMenuShell()
        injector.injectForTesting(into: stalled)
        #expect(stalled.items.count(where: { $0.tag == 9_415_557 }) == quietItems + 3)
    }

    private static func makeMenuShell() -> NSMenu {
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Header", action: nil, keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Send Heartbeats", action: nil, keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Settings…", action: nil, keyEquivalent: ""))
        return menu
    }

    @Test func `late usage result from a replaced gateway is ignored`() async {
        let injector = MenuSessionsInjector()
        injector.setTestingControlChannelConnected(true)
        let loads = DeferredUsageLoads()
        injector.setTestingUsageLoader { try await loads.load() }

        let first = Task { await injector.refreshUsageCacheForTesting(force: true) }
        #expect(await loads.waitForRequests(count: 1))
        let second = Task { await injector.refreshUsageCacheForTesting(force: true) }
        #expect(await loads.waitForRequests(count: 2))

        loads.complete(
            at: 1,
            with: GatewayUsageSummary(updatedAt: 2, providers: [], refreshing: false))
        await second.value
        loads.complete(
            at: 0,
            with: GatewayUsageSummary(updatedAt: 1, providers: [], refreshing: false))
        await first.value

        #expect(injector.testingCachedUsageSummary?.updatedAt == 2)
    }

    @Test func `fresh no-op does not invalidate a forced usage load`() async {
        let injector = MenuSessionsInjector()
        injector.setTestingControlChannelConnected(true)
        injector.setTestingUsageSummary(
            GatewayUsageSummary(updatedAt: 1, providers: [], refreshing: false))
        let loads = DeferredUsageLoads()
        injector.setTestingUsageLoader { try await loads.load() }

        let forced = Task { await injector.refreshUsageCacheForTesting(force: true) }
        #expect(await loads.waitForRequests(count: 1))
        await injector.refreshUsageCacheForTesting(force: false)
        loads.complete(
            at: 0,
            with: GatewayUsageSummary(updatedAt: 2, providers: [], refreshing: false))
        await forced.value

        #expect(injector.testingCachedUsageSummary?.updatedAt == 2)
    }

    @Test func `status text keeps useful error detail`() {
        let injector = MenuSessionsInjector()
        let longError = """
        Gateway connection dropped; gateway likely restarted.
        Reconnect after the gateway finishes booting.
        Details that should stay readable instead of collapsing into one tiny menu ellipsis.
        """

        let normalized = injector.testingControlChannelStatusText(for: .degraded(longError))

        #expect(normalized.contains("Gateway connection dropped"))
        #expect(normalized.contains("Reconnect after"))
        #expect(normalized.count <= 180)
        #expect(!normalized.contains("\n"))
    }

    @Test func `node status text distinguishes paired disconnected nodes`() {
        let pairedDisconnected = Self.node(id: "paired", paired: true, connected: false)
        let unpairedDisconnected = Self.node(id: "unpaired", paired: false, connected: false)
        let connected = Self.node(id: "connected", paired: true, connected: true)

        #expect(NodeMenuEntryFormatter.roleText(pairedDisconnected) == "paired · disconnected")
        #expect(NodeMenuEntryFormatter.roleText(unpairedDisconnected) == "unpaired · disconnected")
        #expect(NodeMenuEntryFormatter.roleText(connected) == "paired · connected")
    }

    @Test func `sorted node entries include paired disconnected nodes`() {
        let injector = MenuSessionsInjector()
        defer { NodesStore.shared.nodes = [] }
        NodesStore.shared.nodes = [
            Self.node(id: "ignored", paired: false, connected: false, displayName: "Ignored"),
            Self.node(id: "paired", paired: true, connected: false, displayName: "MacBook"),
            Self.node(id: "connected", paired: true, connected: true, displayName: "iPhone"),
        ]

        let entries = injector.testingSortedNodeEntries()
        #expect(entries.map(\.nodeId) == ["connected", "paired"])
    }

    private static func node(
        id: String,
        paired: Bool,
        connected: Bool,
        displayName: String? = nil) -> NodeInfo
    {
        NodeInfo(
            nodeId: id,
            displayName: displayName ?? id,
            platform: "macOS 26.3.1",
            version: nil,
            coreVersion: nil,
            uiVersion: nil,
            deviceFamily: "Mac",
            modelIdentifier: nil,
            remoteIp: nil,
            caps: nil,
            commands: nil,
            permissions: nil,
            paired: paired,
            connected: connected)
    }
}

private enum UsageLoadTestError: Error {
    case unavailable
}

@MainActor
private final class UsageLoadEvents {
    private struct Snapshot: Sendable {
        let completed: Int
        let exhausted: Bool
    }

    private var completed = 0
    private var didExhaust = false
    private let stream: AsyncStream<Snapshot>
    private let continuation: AsyncStream<Snapshot>.Continuation

    init() {
        (self.stream, self.continuation) = AsyncStream.makeStream(
            of: Snapshot.self,
            bufferingPolicy: .bufferingNewest(1))
    }

    func finished() {
        self.completed += 1
        self.publish()
    }

    func exhausted() {
        self.didExhaust = true
        self.publish()
    }

    func waitFor(count: Int) async -> Bool {
        if self.completed >= count { return true }
        return await self.wait { $0.completed >= count }
    }

    func waitForExhaustion() async -> Bool {
        if self.didExhaust { return true }
        return await self.wait { $0.exhausted }
    }

    private func publish() {
        self.continuation.yield(Snapshot(completed: self.completed, exhausted: self.didExhaust))
    }

    private func wait(_ predicate: @escaping @Sendable (Snapshot) -> Bool) async -> Bool {
        let stream = self.stream
        return await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                for await snapshot in stream where predicate(snapshot) {
                    return true
                }
                return false
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                return false
            }
            let result = await group.next() ?? false
            group.cancelAll()
            return result
        }
    }
}

@MainActor
private final class DeferredUsageLoads {
    private var continuations: [CheckedContinuation<GatewayUsageSummary, Never>] = []

    func load() async throws -> GatewayUsageSummary {
        await withCheckedContinuation { continuation in
            self.continuations.append(continuation)
        }
    }

    func waitForRequests(count: Int) async -> Bool {
        for _ in 0..<100 where self.continuations.count < count {
            await Task.yield()
        }
        return self.continuations.count >= count
    }

    func complete(at index: Int, with summary: GatewayUsageSummary) {
        self.continuations[index].resume(returning: summary)
    }
}
