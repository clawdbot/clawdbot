import AppKit
import ConcurrencyExtras
import Foundation
import Observation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct StatusMenuSummariesTests {
    @Test func `Automations shows the full enabled count beyond its preview`() async throws {
        try await self.withFixture(cronJobCount: 201) { fixture in
            fixture.recordCronProof(["stage": "fixture-entered"])
            do {
                _ = try await fixture.control.request(method: "health")
                fixture.recordCronProof([
                    "stage": "health-returned", "connected": String(fixture.control.state == .connected),
                ])
                try #require(fixture.control.state == .connected)
                let lease = try #require(await fixture.gateway.captureServerLease())
                await fixture.cron.refreshJobs()
                let jobs = fixture.cron.jobs
                fixture.recordCronProof([
                    "stage": "refresh-returned", "storeJobs": String(jobs.count),
                    "firstJob": jobs.first?.id ?? "absent", "lastJob": jobs.last?.id ?? "absent",
                    "selectedRevision": fixture.gateway.selectedEndpointRevision.map(String.init) ?? "absent",
                    "leaseRevision": lease.endpointRevision.map(String.init) ?? "absent",
                    "routeCurrent": String(fixture.gateway.serverLeaseMatchesCurrentRoute(lease)),
                    "leaseCurrent": String(fixture.gateway.serverLeaseMatchesCurrentState(lease)),
                ])
                _ = AppKitTestSupport.application
                let item = NSMenuItem()
                fixture.summaries.configureAutomations(item)
                let preview = try #require(item.submenu).items.filter {
                    ($0.representedObject as? String)?.hasPrefix("cron.job.") == true
                }
                fixture.recordCronProof(["stage": "row-configured", "previewCount": String(preview.count)])
                let row = try #require(item.view)
                row.appearance = NSAppearance(named: .aqua)
                let window = NSWindow(contentRect: row.frame, styleMask: [.titled], backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.contentView = row
                defer {
                    window.orderOut(nil)
                    window.contentView = nil
                    window.close()
                    item.view = nil
                }
                window.orderFront(nil)
                row.layoutSubtreeIfNeeded()
                let texts = try await cronSummaryProofTexts(
                    in: row, title: item.title, fixtureEvents: fixture.cronProofEvents.value)
                try #require(fixture.gateway.serverLeaseMatchesCurrentRoute(lease))
                try #require(!jobs.isEmpty)
                try #require(fixture.requests.value.contains { $0.method == "cron.list" && $0.owner == "A" })
                try #require(preview.count == 8)
                let text = try #require(texts.first { $0.hasPrefix("\(item.title), ") })
                #expect(text == "\(item.title), 201")
            } catch {
                let nsError = error as NSError
                fixture.recordCronProof([
                    "stage": "failed", "errorDomain": nsError.domain, "errorCode": String(nsError.code),
                ])
                throw error
            }
        }
    }

    @Test
    func `retiring a Gateway invalidates the observed usage cache`() async throws {
        try await self.withFixture { fixture in
            try await fixture.populate()
            // Reopen the fresh cache so no pending result can supply an unrelated invalidation.
            fixture.summaries.menuDidClose()
            fixture.summaries.refresh {}
            _ = try await fixture.control.request(method: "health")
            let changed = LockIsolated(false)
            withObservationTracking {
                _ = fixture.summaries.usageSummary
            } onChange: {
                changed.setValue(true)
            }
            fixture.revision.setValue(2)
            await fixture.gateway.shutdown()
            try await fixture.waitUntil { changed.value }
            #expect(fixture.summaries.usageSummary == nil)
            #expect(!fixture.hasCostChart)
        }
    }

    @Test(arguments: ["unchanged", "reconnect", "replacement"])
    func `cached usage and cost belong to their selected Gateway`(_ transition: String) async throws {
        try await self.withFixture { fixture in
            try await fixture.populate()
            fixture.summaries.menuDidClose()
            let lease = try #require(await fixture.gateway.captureServerLease())
            if transition == "replacement" {
                fixture.revision.setValue(2)
            } else if transition == "reconnect" {
                fixture.session.latestTask()?.emitReceiveFailure()
                try await fixture.waitUntil { !fixture.gateway.serverLeaseMatchesCurrentState(lease) }
                _ = try await fixture.gateway.acquireServerLease()
            }

            // AppKit renders these cached values before any asynchronous refresh.
            #expect((fixture.summaries.usageSummary != nil) == (transition != "replacement"))
            #expect(fixture.summaries.hasUsage == (transition != "replacement"))
            #expect(fixture.hasCostChart == (transition != "replacement"))
        }
    }

    @Test(arguments: [false, true])
    func `new Primary refreshes usage inside the previous Gateway cache window`(keepMenuOpen: Bool) async throws {
        try await self.withFixture { fixture in
            try await fixture.populate()
            if !keepMenuOpen { fixture.summaries.menuDidClose() }
            fixture.revision.setValue(2)
            _ = try await fixture.control.request(method: "health")
            if !keepMenuOpen { fixture.summaries.refresh {} }

            try await fixture.waitUntil {
                fixture.summaries.usageSummary?.contains("Gateway B") == true &&
                    fixture.requests.value.contains { $0.owner == "B" && $0.method == "usage.cost" }
            }
            #expect(fixture.requests.value.contains { $0.owner == "B" && $0.method == "usage.status" })
            #expect(!fixture.hasCostChart)
        }
    }

    @Test(arguments: ["unchanged", "replacement", "closed"])
    func `cold usage retry belongs to its visible Gateway`(_ transition: String) async throws {
        try await self.withFixture { fixture in
            fixture.coldUsage.setValue(true)
            _ = try await fixture.control.request(method: "health")
            fixture.summaries.refresh {}
            try await fixture.waitUntil {
                fixture.requests.value.contains { $0.method == "usage.status" }
            }
            if transition == "closed" {
                fixture.summaries.menuDidClose()
                try await Task.sleep(for: .milliseconds(5200))
                #expect(fixture.requests.value.filter { $0.method == "usage.status" }.count == 1)
                return
            }
            let owner = transition == "replacement" ? "B" : "A"
            if transition == "replacement" {
                fixture.revision.setValue(2)
                _ = try await fixture.control.request(method: "health")
                try await fixture.waitUntil {
                    fixture.requests.value.contains { $0.method == "usage.status" && $0.owner == "B" }
                }
            }
            // The client retry interval is five seconds; allow its one timer to fire.
            try await fixture.waitUntil(timeout: .seconds(6)) {
                fixture.summaries.usageSummary?.contains("Gateway \(owner)") == true
            }
            #expect(fixture.requests.value.filter { $0.method == "usage.status" && $0.owner == owner }.count == 2)
            #expect(!fixture.summaries.isUsageStalled)
        }
    }

    private func withFixture(
        cronJobCount: Int = 0,
        _ operation: (UsageGatewayFixture) async throws -> Void) async throws
    {
        try await TestIsolation.withIsolatedState {
            let state = AppStateStore.shared
            let previousMode = state.connectionMode
            let previousAccent = state.profileAccentHex
            state.connectionMode = .unconfigured
            defer {
                state.connectionMode = previousMode
                state.profileAccentHex = previousAccent
            }
            let fixture = UsageGatewayFixture(cronJobCount: cronJobCount)
            do {
                try await operation(fixture)
                await fixture.close()
            } catch {
                await fixture.close()
                throw error
            }
        }
    }
}

@MainActor
private final class UsageGatewayFixture {
    struct Request: Sendable {
        let owner: String
        let method: String
    }

    let revision = LockIsolated<UInt64>(1)
    let requests = LockIsolated<[Request]>([])
    let coldUsage = LockIsolated(false)
    let cronProofEvents = LockIsolated<[[String: String]]>([])
    let recordCronProof: @Sendable ([String: String]) -> Void
    let session: GatewayTestWebSocketSession
    let gateway: GatewayConnection
    let control: ControlChannel
    let cron: CronJobsStore
    let summaries: StatusMenuSummaries

    init(cronJobCount: Int) {
        let revision = self.revision
        let requests = self.requests
        let coldUsage = self.coldUsage
        let cronProofEvents = self.cronProofEvents
        self.recordCronProof = { fields in
            guard cronJobCount > 0 else { return }
            let recorded = cronProofEvents.withValue { events -> [String: String]? in
                guard events.count < 32 else { return nil }
                let event = events.count == 31 ? ["stage": "truncated", "limit": "32"] :
                    fields.mapValues { String($0.prefix(256)) }
                events.append(event)
                return event
            }
            if let recorded {
                let fields = recorded.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }
                print("CRON_SUMMARY_PROOF " + fields.joined(separator: " "))
            }
        }
        let recordCronProof = self.recordCronProof
        self.session = GatewayTestWebSocketSession(taskFactory: {
            let owner = revision.value == 1 ? "A" : "B"
            return GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                let data: Data
                switch message {
                case let .data(value): data = value
                case let .string(value): data = Data(value.utf8)
                @unknown default: return
                }
                guard let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let method = frame["method"] as? String else { return }
                requests.withValue { $0.append(Request(owner: owner, method: method)) }
                let isCronProofRequest = method == "health" || method == "cron.list"
                if isCronProofRequest {
                    let params = frame["params"] as? [String: Any]
                    recordCronProof([
                        "stage": "request", "owner": owner, "method": method,
                        "includeDisabled": (params?["includeDisabled"] as? Bool).map(String.init) ?? "absent",
                        "limit": (params?["limit"] as? Int).map(String.init) ?? "absent",
                    ])
                }
                var responseFacts = ["stage": "response-emitted", "owner": owner, "method": method]
                let payload: String
                switch method {
                case "usage.status":
                    if coldUsage.value,
                       requests.value.filter({ $0.owner == owner && $0.method == method }).count == 1
                    {
                        payload = #"{"updatedAt":1800000000000,"providers":[],"refreshing":true}"#
                    } else {
                        payload = #"""
                        {"updatedAt":1800000000000,
                        "providers":[{"provider":"synthetic","displayName":"Gateway \#(owner)",
                        "windows":[{"label":"daily","usedPercent":25}]}],"refreshing":false}
                        """#
                    }
                case "usage.cost":
                    let totals = #"""
                    "input":1,"output":2,"cacheRead":0,"cacheWrite":0,
                    "totalTokens":3,"totalCost":0.25,"missingCostEntries":0
                    """#
                    let daily = owner == "A" ? #"[{"date":"2026-09-03",\#(totals)}]"# : "[]"
                    payload = #"{"updatedAt":1800000000000,"days":30,"daily":\#(daily),"totals":{\#(totals)}}"#
                case "node.list":
                    payload = #"{"nodes":[]}"#
                case "cron.list":
                    let params = frame["params"] as? [String: Any]
                    let limit = min(params?["limit"] as? Int ?? 200, 200)
                    let count = min(cronJobCount, limit)
                    responseFacts["total"] = String(cronJobCount)
                    responseFacts["returnedJobs"] = String(count)
                    let jobs = (0..<count).map { index in
                        let id = String(format: "job-%03d", index)
                        return #"""
                        {"id":"\#(id)","name":"Automation \#(index)","enabled":true,
                        "createdAtMs":0,"updatedAtMs":0,"schedule":{"kind":"every","everyMs":1000},
                        "sessionTarget":"main","wakeMode":"now",
                        "payload":{"kind":"systemEvent","text":"fixture"},"state":{}}
                        """#
                    }.joined(separator: ",")
                    let nextOffset = count < cronJobCount ? String(count) : "null"
                    payload = #"""
                    {"jobs":[\#(jobs)],"total":\#(cronJobCount),"offset":0,"limit":\#(limit),
                    "snapshotRevision":"fixture","hasMore":\#(count < cronJobCount),"nextOffset":\#(nextOffset)}
                    """#
                default:
                    payload = #"{"ok":true}"#
                }
                let response = #"{"type":"res","id":"\#(id)","ok":true,"payload":\#(payload)}"#
                socket.emitReceiveSuccess(.data(Data(response.utf8)))
                if isCronProofRequest { recordCronProof(responseFacts) }
            })
        })
        self.gateway = GatewayConnection(
            testEndpointProvider: {
                let current = revision.value
                return GatewayConnection.EndpointSnapshot(
                    config: (URL(string: "ws://127.0.0.1:\(49700 + current)")!, nil, nil),
                    routeAuthority: nil,
                    revision: current)
            },
            currentEndpointRevision: { revision.value },
            sessionBox: WebSocketSessionBox(session: self.session))
        self.control = ControlChannel(gateway: self.gateway, endpointRevision: { revision.value })
        self.cron = CronJobsStore(gateway: self.gateway, isPreview: true)
        self.summaries = StatusMenuSummaries(
            control: self.control,
            nodes: NodesStore(control: self.control, localNodeIDLoader: { _ in "synthetic-local-node" }),
            cron: self.cron)
    }

    var hasCostChart: Bool {
        let item = NSMenuItem()
        self.summaries.configureUsage(item)
        return item.submenu?.items.contains { ($0.representedObject as? String) == "usage.cost.chart" } == true
    }

    func populate() async throws {
        _ = try await self.control.request(method: "health")
        #expect(self.control.state == .connected)
        self.summaries.refresh {}
        try await self.waitUntil {
            self.summaries.usageSummary?.contains("Gateway A") == true && self.hasCostChart
        }
        #expect(self.summaries.usageSummary?.contains("Gateway A") == true)
        #expect(self.hasCostChart)
    }

    func close() async {
        self.summaries.menuDidClose()
        await self.control.disconnect()
    }

    func waitUntil(timeout: Duration = .seconds(2), _ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + timeout
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(2))
        }
        try #require(condition())
    }
}
