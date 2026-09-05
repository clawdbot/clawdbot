import AppKit
import ApplicationServices
import ConcurrencyExtras
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct SettingsViewSmokeTests {
    @Test func `first Edit presents the selected cron job fields`() async throws {
        try await TestIsolation.withIsolatedState {
            let store = CronJobsStore(isPreview: true)
            store.seedPreviewJobs(
                [
                    CronJob(
                        id: "job-1",
                        agentId: "ops",
                        name: "Morning Check-in",
                        description: "Summary job",
                        enabled: true,
                        deleteAfterRun: nil,
                        createdAtMs: 1_700_000_000_000,
                        updatedAtMs: 1_700_000_100_000,
                        schedule: .cron(expr: "0 8 * * *", tz: "UTC"),
                        sessionTarget: .isolated,
                        wakeMode: .nextHeartbeat,
                        payload: .agentTurn(
                            message: "Summarize",
                            thinking: "low",
                            timeoutSeconds: 120,
                            deliver: nil,
                            channel: nil,
                            to: nil,
                            bestEffortDeliver: nil),
                        delivery: CronDelivery(
                            mode: .announce,
                            channel: "whatsapp",
                            to: "+15551234567",
                            bestEffort: true),
                        state: CronJobState(
                            nextRunAtMs: 1_700_000_200_000,
                            runningAtMs: nil,
                            lastRunAtMs: 1_700_000_050_000,
                            lastStatus: "ok",
                            lastError: nil,
                            lastDurationMs: 1200)),
                ],
                selectedJobID: "job-1",
                enabled: false)
            store.runEntries = [
                CronRunLogEntry(
                    ts: 1_700_000_050_000,
                    jobId: "job-1",
                    action: "finished",
                    status: "ok",
                    error: nil,
                    summary: "done",
                    runAtMs: 1_700_000_050_000,
                    durationMs: 1200,
                    nextRunAtMs: 1_700_000_200_000),
            ]

            try await withHostedCronSettings(store: store) { hosting, window in
                let elements = try await cronEditorAccessibilityElements(hosting)
                let edit = try #require(elements.first { element in
                    element.accessibilityRole?() == .button &&
                        [element.accessibilityLabel?(), element.accessibilityTitle?()].contains("Edit")
                })
                #expect(edit.accessibilityPerformPress?() == true)
                let deadline = ContinuousClock.now + .seconds(3)
                while window.attachedSheet == nil, ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(20))
                }
                let sheet = try #require(window.attachedSheet?.contentView)
                var values: [String] = []
                repeat {
                    sheet.layoutSubtreeIfNeeded()
                    values = try await cronEditorAccessibilityElements(sheet).compactMap { element -> String? in
                        let value: Any? = element.accessibilityValue?()
                        return value as? String
                    }
                    if values.contains("Morning Check-in") { break }
                    try await Task.sleep(for: .milliseconds(20))
                } while ContinuousClock.now < deadline
                #expect(values.contains("Morning Check-in"))
                #expect(values.contains("Summary job"))
                #expect(values.contains("0 8 * * *"))
            }
        }
    }

    @Test(arguments: [false, true])
    func `a visible Cron error without a handshake follows its selected Gateway`(replacePrimary: Bool) async throws {
        try await TestIsolation.withIsolatedState {
            AppStateStore.shared.connectionMode = .unconfigured
            let failure = LockIsolated("Gateway A unavailable")
            let fixture = CronSourceFixture(beforeEndpointLookup: {
                throw URLError(.cannotConnectToHost, userInfo: [NSLocalizedDescriptionKey: failure.value])
            })
            let store = CronJobsStore(gateway: fixture.gateway, endpointRevision: { fixture.endpoint.value.revision! })
            var control: ControlChannel? = ControlChannel(
                gateway: fixture.gateway, endpointRevision: { fixture.endpoint.value.revision! })
            @MainActor func cleanup() async {
                control = nil
                store.stop(.settings)
                await fixture.gateway.shutdown()
            }
            do {
                try await withHostedCronSettings(store: store, isActive: true) { hosting, _ in
                    let deadline = ContinuousClock.now + .seconds(2)
                    var visible: [String] = []
                    repeat {
                        visible = try await cronSettingsVisibleStrings(hosting)
                        if visible.contains(where: { $0.contains("Gateway A unavailable") }) { break }
                        try await Task.sleep(for: .milliseconds(20))
                    } while ContinuousClock.now < deadline
                    try #require(visible.contains(where: { $0.contains("Gateway A unavailable") }))
                    #expect(store.snapshot == nil)
                    #expect(fixture.requests.value.isEmpty)

                    if replacePrimary {
                        failure.setValue("Gateway B unavailable")
                        fixture.adoptB()
                    }
                    control?.endpointDidChange(.unavailable(
                        mode: .remote,
                        reason: failure.value,
                        routeRevision: fixture.endpoint.value.revision!))
                    let updateDeadline = ContinuousClock.now + .seconds(2)
                    repeat {
                        visible = try await cronSettingsVisibleStrings(hosting)
                        if !replacePrimary || !visible
                            .contains(where: { $0.contains("Gateway A unavailable") }) { break }
                        try await Task.sleep(for: .milliseconds(20))
                    } while ContinuousClock.now < updateDeadline

                    #expect(visible.contains(where: { $0.contains("Gateway A unavailable") }) == !replacePrimary)
                    #expect((store.lastError != nil) == !replacePrimary)
                    #expect(fixture.requests.value.isEmpty)
                }
            } catch {
                await cleanup()
                throw error
            }
            await cleanup()
        }
    }

    @Test(arguments: [false, true])
    func `Cron distinguishes a pending or failed replacement from a successful empty list`(
        emptySuccess: Bool) async throws
    {
        try await TestIsolation.withIsolatedState {
            AppStateStore.shared.connectionMode = .unconfigured
            let replacement = LockIsolated(false)
            let waiting = LockIsolated(false)
            let gate = GatewayConnectionSuspensionGate()
            let fixture = CronSourceFixture(beforeEndpointLookup: {
                guard replacement.value else { return }
                waiting.setValue(true)
                await gate.suspend()
                if !emptySuccess {
                    throw URLError(.cannotConnectToHost, userInfo: [
                        NSLocalizedDescriptionKey: "Gateway B unavailable",
                    ])
                }
            })
            let store = CronJobsStore(gateway: fixture.gateway, endpointRevision: { fixture.endpoint.value.revision! })
            @MainActor func cleanup() async {
                await gate.open()
                store.stop(.settings)
                await fixture.gateway.shutdown()
            }
            do {
                try await withHostedCronSettings(store: store, isActive: true) { hosting, _ in
                    let initial = try await waitForCronSettingsStrings(hosting) {
                        $0.contains { $0.contains("Gateway A") } && !store.isLoadingJobs
                    }
                    try #require(initial.contains { $0.contains("Gateway A") })
                    replacement.setValue(true)
                    fixture.emptyJobLists.setValue(true)
                    fixture.adoptB()
                    try await fixture.gateway.adoptSelectedEndpoint()
                    _ = try await waitForCronSettingsStrings(hosting) { _ in
                        store.snapshot == nil && !store.isLoadingJobs
                    }
                    let refresh = try await cronSettingsRefreshButton(hosting)
                    try #require(refresh.isAccessibilityEnabled?() == true)
                    try #require(refresh.accessibilityPerformPress?() == true)
                    let pending = try await waitForCronSettingsStrings(hosting) { visible in
                        waiting.value && store.isLoadingJobs && visible.contains("Loading cron jobs…")
                    }
                    try #require(waiting.value && store.isLoadingJobs)
                    #expect(pending.contains("Loading cron jobs…"))
                    #expect(!pending.contains("No cron jobs yet."))
                    #expect(!pending.contains { $0.contains("Gateway A") })
                    let pendingRefresh = try await cronSettingsRefreshButton(hosting)
                    #expect(pendingRefresh.isAccessibilityEnabled?() == false)

                    await gate.open()
                    let completed = try await waitForCronSettingsStrings(hosting) { visible in
                        !store.isLoadingJobs && (emptySuccess
                            ? (store.statusMessage == "No cron jobs yet." && visible.contains("No cron jobs yet."))
                            : visible.contains { $0.contains("Gateway B unavailable") })
                    }
                    try #require(!store.isLoadingJobs)
                    let completedRefresh = try await cronSettingsRefreshButton(hosting)
                    #expect(completedRefresh.isAccessibilityEnabled?() == true)
                    #expect(!completed.contains("Loading cron jobs…"))
                    #expect(completed.contains("No cron jobs yet.") == emptySuccess)
                    #expect(completed.contains { $0.contains("Gateway B unavailable") } == !emptySuccess)
                    #expect((store.snapshot != nil) == emptySuccess)
                    #expect(store.jobs.isEmpty)
                }
            } catch {
                await cleanup()
                throw error
            }
            await cleanup()
        }
    }

    @Test func `Gateway settings is visible`() {
        let tabs = SettingsTabGroup.defaultGroups(showDebug: false, showSystemAgent: false)
            .flatMap(\.tabs)
        #expect(tabs.contains(.gateways))
    }

    @Test func `OpenClaw settings require configured inference`() {
        #expect(!SystemAgentAvailability.shouldShow(configuredModel: nil))
        #expect(!SystemAgentAvailability.shouldShow(configuredModel: "   "))
        #expect(SystemAgentAvailability.shouldShow(configuredModel: "openai/gpt-5.5"))

        let hiddenTabs = SettingsTabGroup.defaultGroups(showDebug: false, showSystemAgent: false)
            .flatMap(\.tabs)
        let visibleTabs = SettingsTabGroup.defaultGroups(showDebug: false, showSystemAgent: true)
            .flatMap(\.tabs)
        #expect(!hiddenTabs.contains(.systemAgent))
        #expect(visibleTabs.contains(.systemAgent))
        #expect(SettingsRootView.normalizedTab(
            .systemAgent,
            showDebug: false,
            showSystemAgent: false) == .general)
        #expect(SettingsRootView.normalizedTab(
            .systemAgent,
            showDebug: false,
            showSystemAgent: true) == .systemAgent)
        let loadingSelection = SettingsRootView.tabSelection(
            requested: .systemAgent,
            showDebug: false,
            inferenceConfiguration: .loading)
        #expect(loadingSelection.selected == .general)
        #expect(loadingSelection.deferred == .systemAgent)
        let configuredSelection = SettingsRootView.tabSelection(
            requested: loadingSelection.deferred ?? .general,
            showDebug: false,
            inferenceConfiguration: .loaded("openai/gpt-5.5"))
        #expect(configuredSelection.selected == .systemAgent)
        #expect(configuredSelection.deferred == nil)
        let unconfiguredSelection = SettingsRootView.tabSelection(
            requested: .systemAgent,
            showDebug: false,
            inferenceConfiguration: .loaded(nil))
        #expect(unconfiguredSelection.selected == .general)
        #expect(unconfiguredSelection.deferred == nil)
        #expect(SettingsRootView.configurationAfterInferenceRefresh(
            current: .loaded("openai/gpt-5.5"),
            result: .failed) == .loaded("openai/gpt-5.5"))
        #expect(SettingsRootView.configurationAfterInferenceRefresh(
            current: .loaded("openai/gpt-5.5"),
            result: .confirmed(nil)) == .loaded(nil))
    }

    @Test func `OpenClaw preserves same route and resets for gateway changes`() {
        let stateDir = URL(fileURLWithPath: "/Users/tester/.openclaw")
        let directA = MacChatTranscriptCache.gatewayID(
            mode: .remote,
            localStateDir: stateDir,
            remoteTransport: .direct,
            directURL: URL(string: "wss://gateway.example.com/team-a"),
            sshTarget: "",
            sshRemotePort: 18789)
        let directB = MacChatTranscriptCache.gatewayID(
            mode: .remote,
            localStateDir: stateDir,
            remoteTransport: .direct,
            directURL: URL(string: "wss://gateway.example.com/team-b"),
            sshTarget: "",
            sshRemotePort: 18789)

        #expect(directA != directB)
        #expect(SettingsRootView.configRefreshPlan(
            selectedTab: .systemAgent,
            previousGatewayID: directA,
            currentGatewayID: directA) == .init(clearsPrevious: false, resetsSystemAgent: false))
        #expect(SettingsRootView.configRefreshPlan(
            selectedTab: .general,
            previousGatewayID: directA,
            currentGatewayID: directA) == .init(clearsPrevious: true, resetsSystemAgent: false))
        #expect(SettingsRootView.configRefreshPlan(
            selectedTab: .systemAgent,
            previousGatewayID: directA,
            currentGatewayID: directB) == .init(clearsPrevious: true, resetsSystemAgent: true))
    }
}

@MainActor
private func withHostedCronSettings(
    store: CronJobsStore,
    isActive: Bool = false,
    _ body: (NSHostingView<CronSettings>, NSWindow) async throws -> Void) async throws
{
    _ = AppKitTestSupport.application
    let view = CronSettings(store: store, channelsStore: ChannelsStore(isPreview: true), isActive: isActive)
    let hosting = NSHostingView(rootView: view)
    hosting.frame = NSRect(x: 0, y: 0, width: 1000, height: 800)
    let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = hosting
    defer {
        if let sheet = window.attachedSheet { window.endSheet(sheet) }
        window.orderOut(nil)
        window.contentView = nil
        window.close()
    }
    window.orderFront(nil)
    hosting.layoutSubtreeIfNeeded()
    try await body(hosting, window)
}

@MainActor
private func cronSettingsRefreshButton(_ hosting: NSView) async throws -> AnyObject {
    let elements = try await cronEditorAccessibilityElements(hosting)
    return try #require(elements.first { element in
        element.accessibilityRole?() == .button &&
            [element.accessibilityLabel?(), element.accessibilityTitle?()].contains("Refresh")
    })
}

@MainActor
private func waitForCronSettingsStrings(
    _ hosting: NSView,
    until condition: ([String]) -> Bool) async throws -> [String]
{
    let deadline = ContinuousClock.now + .seconds(3)
    var visible: [String] = []
    repeat {
        visible = try await cronSettingsVisibleStrings(hosting)
        if condition(visible) { return visible }
        try await Task.sleep(for: .milliseconds(20))
    } while ContinuousClock.now < deadline
    return visible
}

@MainActor
private func cronSettingsVisibleStrings(_ hosting: NSView) async throws -> [String] {
    hosting.layoutSubtreeIfNeeded()
    return try await cronEditorAccessibilityElements(hosting).flatMap { element -> [String] in
        let value: Any? = element.accessibilityValue?()
        return [element.accessibilityLabel?(), element.accessibilityTitle?(), value as? String].compactMap(\.self)
    }
}

@MainActor
private func cronEditorAccessibilityElements(_ root: NSView) async throws -> [AnyObject] {
    // SwiftUI materializes its virtual accessibility children after a real client request.
    let result = await Task.detached {
        let application = AXUIElementCreateApplication(ProcessInfo.processInfo.processIdentifier)
        var windows: CFTypeRef?
        return AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &windows)
    }.value
    try #require(result == .success)
    var elements: [AnyObject] = []
    var visited = Set<ObjectIdentifier>()
    func visit(_ element: AnyObject) {
        guard visited.insert(ObjectIdentifier(element)).inserted else { return }
        elements.append(element)
        for child in element.accessibilityChildren?() ?? [] {
            visit(child as AnyObject)
        }
    }
    visit(root)
    return elements
}
