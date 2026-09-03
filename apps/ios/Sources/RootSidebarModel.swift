import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

struct ChatSessionRosterSnapshot: Sendable {
    private static let maximumPageCount = 50
    private static let maximumSessionCount = 10000

    let sessions: [OpenClawChatSessionEntry]
    let isCached: Bool
    let totalCount: Int?
    let isComplete: Bool

    init(
        sessions: [OpenClawChatSessionEntry],
        isCached: Bool,
        totalCount: Int? = nil,
        isComplete: Bool = true)
    {
        self.sessions = sessions
        self.isCached = isCached
        self.totalCount = totalCount
        self.isComplete = isComplete
    }

    @MainActor
    static func collect(
        fetchPage: @MainActor (Int) async throws -> OpenClawChatSessionsListResponse) async throws -> Self
    {
        var sessions: [OpenClawChatSessionEntry] = []
        var rowIndices: [String: Int] = [:]
        var totalCount: Int?
        var offset = 0
        var pageCount = 0

        while true {
            try Task.checkCancellation()
            // Match sessions.list's bounded scan so a changing Gateway snapshot
            // cannot keep a sidebar refresh alive forever.
            guard pageCount < Self.maximumPageCount, sessions.count < Self.maximumSessionCount else {
                return Self(sessions: sessions, isCached: false, totalCount: totalCount, isComplete: false)
            }
            pageCount += 1
            let response: OpenClawChatSessionsListResponse
            do {
                response = try await fetchPage(offset)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                guard !sessions.isEmpty else { throw error }
                return Self(sessions: sessions, isCached: false, totalCount: totalCount, isComplete: false)
            }
            try Task.checkCancellation()

            if let count = response.totalCount {
                totalCount = count
            }
            for session in response.sessions {
                if let index = rowIndices[session.key] {
                    sessions[index] = session
                } else {
                    guard sessions.count < Self.maximumSessionCount else {
                        return Self(sessions: sessions, isCached: false, totalCount: totalCount, isComplete: false)
                    }
                    rowIndices[session.key] = sessions.count
                    sessions.append(session)
                }
            }

            let advancedOffset = offset + response.sessions.count
            let hasMore = response.hasMore ?? totalCount.map { advancedOffset < $0 } ?? false
            guard hasMore else {
                let isComplete = totalCount.map { sessions.count >= $0 } ?? true
                return Self(sessions: sessions, isCached: false, totalCount: totalCount, isComplete: isComplete)
            }

            let nextOffset = response.nextOffset ?? advancedOffset
            guard !response.sessions.isEmpty,
                  nextOffset > offset,
                  totalCount.map({ nextOffset < $0 }) ?? true
            else {
                return Self(sessions: sessions, isCached: false, totalCount: totalCount, isComplete: false)
            }
            offset = nextOffset
        }
    }
}

extension NodeAppModel {
    func loadChatSessionRoster(
        limit: Int,
        archived: Bool = false,
        allowCachedFallback: Bool = true) async throws -> ChatSessionRosterSnapshot
    {
        let sourceGatewayID = self.chatTranscriptCacheGatewayID
        let sourceAgentID = self.chatDeliveryAgentId
        guard self.isLocalChatFixtureEnabled || self.isOperatorGatewayConnected else {
            guard allowCachedFallback else { throw URLError(.notConnectedToInternet) }
            return await ChatSessionRosterSnapshot(
                sessions: archived ? [] : self.loadCachedChatSessions(
                    gatewayID: sourceGatewayID,
                    agentID: sourceAgentID),
                isCached: true,
                isComplete: false)
        }

        do {
            let snapshot: ChatSessionRosterSnapshot
            if self.isLocalChatFixtureEnabled {
                let response = try await self.makeChatTransport().listSessions(limit: limit, archived: archived)
                snapshot = ChatSessionRosterSnapshot(
                    sessions: response.sessions,
                    isCached: false,
                    totalCount: response.totalCount,
                    isComplete: response.hasMore != true)
            } else {
                guard let sourceGatewayID,
                      let route = await self.operatorSession.currentRoute(ifGatewayID: sourceGatewayID)
                else { throw URLError(.notConnectedToInternet) }

                // Every page belongs to one physical authenticated Gateway route;
                // reconnects and gateway switches must never splice two rosters.
                snapshot = try await ChatSessionRosterSnapshot.collect { offset in
                    let request = OpenClawChatGatewayRequests.sessionsList(
                        limit: limit,
                        search: nil,
                        archived: archived,
                        agentID: sourceAgentID,
                        offset: offset)
                    let data = try await self.operatorSession.request(request, ifCurrentRoute: route)
                    return try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: data)
                }
                guard GatewayStableIdentifier.matches(self.chatTranscriptCacheGatewayID, sourceGatewayID),
                      self.chatDeliveryAgentId == sourceAgentID
                else {
                    throw CancellationError()
                }
            }

            if !archived {
                // An interrupted page must not replace a more complete offline roster.
                if snapshot.isComplete {
                    await self.storeCachedChatSessions(
                        snapshot.sessions,
                        gatewayID: sourceGatewayID,
                        agentID: sourceAgentID)
                    if let sourceGatewayID,
                       !GatewayStableIdentifier.matches(self.chatTranscriptCacheGatewayID, sourceGatewayID) ||
                       self.chatDeliveryAgentId != sourceAgentID
                    {
                        throw CancellationError()
                    }
                }
            }
            return snapshot
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            guard allowCachedFallback, !archived else { throw error }
            let cached = await self.loadCachedChatSessions(
                gatewayID: sourceGatewayID,
                agentID: sourceAgentID)
            guard !cached.isEmpty else { throw error }
            return ChatSessionRosterSnapshot(sessions: cached, isCached: true, isComplete: false)
        }
    }
}

@MainActor
@Observable
final class RootSidebarModel {
    static let sessionLimit = 200

    struct TokenUsageSummary: Equatable {
        let total: Int?
        let isPartial: Bool
    }

    struct SessionObserverDeclaration<Route: Equatable>: Equatable {
        let route: Route
        let visible: Bool
        let generation: UInt64
    }

    private(set) var sessions: [OpenClawChatSessionEntry] = []
    private(set) var usage: CostUsageSummaryLite?
    private(set) var cronJobs: [CronJob] = []
    private(set) var isRefreshing = false
    private(set) var sessionErrorText: String?
    private(set) var isSessionRosterComplete = true
    private var rosterGeneration = 0
    private var dashboardGeneration = 0
    private var sessionObserverVisibility = false
    private var sessionObserverGeneration: UInt64 = 0
    private var sessionObserverDeclaration: SessionObserverDeclaration<GatewayNodeSessionRoute>?
    private var sessionObserverSync: (id: UUID, task: Task<Void, Never>)?

    var failedCronJobCount: Int {
        self.cronJobs.count { Self.isFailedCronJob($0) }
    }

    var overdueCronJobCount: Int {
        let threshold = Int(Date().timeIntervalSince1970 * 1000) - 300_000
        return self.cronJobs.count { job in
            job.enabled && (job.nextrunatms.map { $0 < threshold } ?? false)
        }
    }

    func sections(
        query: String,
        currentSessionKey: String,
        mainSessionKey: String,
        activeAgentID: String?,
        groups: [OpenClawChatSessionGroup]) -> [ChatSessionSidebarModel.Section]
    {
        ChatSessionSidebarModel.sections(
            sessions: self.sessions,
            currentSessionKey: currentSessionKey,
            mainSessionKey: mainSessionKey,
            activeAgentID: activeAgentID,
            groups: groups,
            excludesMainSession: true,
            query: query)
    }

    func refresh(appModel: NodeAppModel) async {
        self.rosterGeneration &+= 1
        let rosterGeneration = self.rosterGeneration
        self.dashboardGeneration &+= 1
        let dashboardGeneration = self.dashboardGeneration
        self.isRefreshing = true
        defer {
            if rosterGeneration == self.rosterGeneration {
                self.isRefreshing = false
            }
        }

        async let roster = self.loadRoster(appModel: appModel)
        async let dashboard = self.loadDashboard(appModel: appModel)
        let loadedRoster = await roster
        guard !Task.isCancelled else { return }
        if rosterGeneration == self.rosterGeneration {
            switch loadedRoster {
            case let .success(loadedRoster):
                self.applyRoster(loadedRoster)
            case let .failure(message):
                self.sessionErrorText = message
            case .cancelled:
                return
            }
            self.isRefreshing = false
        }

        let loadedDashboard = await dashboard
        guard !Task.isCancelled, dashboardGeneration == self.dashboardGeneration else { return }
        if let usage = loadedDashboard.usage {
            self.usage = usage
        }
        if let cronJobs = loadedDashboard.cronJobs {
            self.cronJobs = cronJobs
        }
    }

    func refreshSessions(appModel: NodeAppModel) async {
        self.rosterGeneration &+= 1
        let rosterGeneration = self.rosterGeneration
        self.isRefreshing = true
        defer {
            if rosterGeneration == self.rosterGeneration {
                self.isRefreshing = false
            }
        }

        let loadedRoster = await self.loadRoster(appModel: appModel, allowCachedFallback: false)
        guard !Task.isCancelled, rosterGeneration == self.rosterGeneration else { return }
        switch loadedRoster {
        case let .success(roster):
            self.applyRoster(roster)
        case let .failure(message):
            self.sessionErrorText = message
        case .cancelled:
            return
        }
    }

    func setSessionObserverVisibility(appModel: NodeAppModel, visible: Bool) async {
        self.sessionObserverVisibility = visible
        let observerGeneration = self.sessionObserverGeneration
        let previous = self.sessionObserverSync?.task
        let syncID = UUID()
        let task = Task { @MainActor [weak self, weak appModel] in
            await previous?.value
            guard let self,
                  let appModel,
                  self.sessionObserverGeneration == observerGeneration,
                  self.sessionObserverVisibility == visible,
                  let route = await appModel.operatorSession.currentRoute(),
                  self.sessionObserverGeneration == observerGeneration,
                  self.sessionObserverVisibility == visible
            else {
                self?.finishSessionObserverSync(id: syncID)
                return
            }

            if let declaration = self.sessionObserverDeclaration,
               declaration.route == route,
               declaration.visible == visible,
               declaration.generation == observerGeneration
            {
                self.finishSessionObserverSync(id: syncID)
                return
            }

            // The Gateway may apply a change before its reply times out. An old
            // confirmation must never suppress the next recovery declaration.
            self.sessionObserverDeclaration = nil
            let request = OpenClawChatGatewayRequests.setSessionObserverVisibility(
                visible,
                timeoutMs: 12000)
            do {
                _ = try await appModel.operatorSession.request(
                    method: request.method,
                    params: request.params,
                    timeoutMs: request.timeoutMs,
                    ifCurrentRoute: route)
                if let declaration = Self.confirmedSessionObserverDeclaration(
                    route: route,
                    visible: visible,
                    generation: observerGeneration,
                    currentGeneration: self.sessionObserverGeneration,
                    currentVisibility: self.sessionObserverVisibility)
                {
                    self.sessionObserverDeclaration = declaration
                }
            } catch {
                // Reconnect replays visibility on its own physical operator route.
            }
            self.finishSessionObserverSync(id: syncID)
        }
        self.sessionObserverSync = (id: syncID, task: task)
        await task.value
    }

    static func confirmedSessionObserverDeclaration<Route: Equatable>(
        route: Route,
        visible: Bool,
        generation: UInt64,
        currentGeneration: UInt64,
        currentVisibility: Bool) -> SessionObserverDeclaration<Route>?
    {
        guard generation == currentGeneration, visible == currentVisibility else { return nil }
        return SessionObserverDeclaration(route: route, visible: visible, generation: generation)
    }

    private func finishSessionObserverSync(id: UUID) {
        guard self.sessionObserverSync?.id == id else { return }
        self.sessionObserverSync = nil
    }

    func observeSessionEvents(appModel: NodeAppModel) async {
        await Self.consumeSubscribedSessionEvents(
            makeStream: {
                await appModel.operatorSession.subscribeServerEvents(bufferingNewest: 200)
            },
            subscribe: {
                let request = OpenClawChatGatewayRequests.subscribeSessions(timeoutMs: 12000)
                _ = try await appModel.operatorSession.request(
                    method: request.method,
                    params: request.params,
                    timeoutMs: request.timeoutMs)
            },
            onEvent: { [weak self] frame in
                await self?.handleSessionEvent(frame, appModel: appModel) ?? false
            },
            invalidateObserverDeclaration: { [weak self] in
                guard let self else { return }
                // Subscription generations prevent a delayed old-socket ACK from
                // satisfying the visibility replay queued for the new socket.
                self.sessionObserverGeneration &+= 1
                self.sessionObserverDeclaration = nil
            },
            observerVisibility: { [weak self] in
                self?.sessionObserverVisibility ?? false
            },
            declareObserverVisibility: { [weak self] visible in
                await self?.setSessionObserverVisibility(appModel: appModel, visible: visible)
            })
    }

    static func consumeSubscribedSessionEvents(
        makeStream: @MainActor () async -> AsyncStream<EventFrame>,
        subscribe: @MainActor () async throws -> Void,
        onEvent: @MainActor (EventFrame) async -> Bool,
        invalidateObserverDeclaration: @MainActor () -> Void = {},
        observerVisibility: @MainActor () -> Bool = { false },
        declareObserverVisibility: @MainActor (Bool) async -> Void = { _ in },
        retryDelays: [Duration] = [
            .seconds(1),
            .seconds(2),
            .seconds(4),
            .seconds(8),
            .seconds(16),
            .seconds(30),
        ],
        sleep: @MainActor (Duration) async throws -> Void = { delay in
            try await Task.sleep(for: delay)
        }) async
    {
        var failureCount = 0
        while !Task.isCancelled {
            // Register the local continuation before the RPC. The gateway may
            // synchronously emit a one-off final digest while handling subscribe.
            let stream = await makeStream()
            do {
                try await subscribe()
                // Subscriptions are socket-owned; a successful replay invalidates
                // an old visibility ACK even when the logical route is unchanged.
                invalidateObserverDeclaration()
                await declareObserverVisibility(observerVisibility())
                failureCount = 0
            } catch is CancellationError {
                return
            } catch {
                failureCount += 1
                guard await self.waitForSessionEventRetry(
                    failureCount: failureCount,
                    retryDelays: retryDelays,
                    sleep: sleep)
                else { return }
                continue
            }

            for await frame in stream {
                guard !Task.isCancelled else { return }
                if await onEvent(frame) {
                    break
                }
            }
            guard !Task.isCancelled else { return }
            failureCount += 1
            guard await self.waitForSessionEventRetry(
                failureCount: failureCount,
                retryDelays: retryDelays,
                sleep: sleep)
            else { return }
        }
    }

    private static func waitForSessionEventRetry(
        failureCount: Int,
        retryDelays: [Duration],
        sleep: @MainActor (Duration) async throws -> Void) async -> Bool
    {
        let delay = retryDelays.isEmpty
            ? .zero
            : retryDelays[min(max(0, failureCount - 1), retryDelays.count - 1)]
        do {
            try await sleep(delay)
            return !Task.isCancelled
        } catch {
            return false
        }
    }

    private func handleSessionEvent(_ frame: EventFrame, appModel: NodeAppModel) async -> Bool {
        guard let event = OpenClawChatGatewayPayloadCodec.event(from: frame) else { return false }
        switch event {
        case .sessionsChanged:
            await self.refreshSessions(appModel: appModel)
        case let .sessionObserver(digest):
            self.sessions = ChatSessionSidebarModel.applying(
                observerDigest: digest,
                to: self.sessions,
                activeAgentId: appModel.chatDeliveryAgentId)
        case .seqGap:
            await self.refreshSessions(appModel: appModel)
            return true
        default:
            return false
        }
        return false
    }

    func reportSessionError(_ error: any Error) {
        self.sessionErrorText = error.localizedDescription
    }

    static func tokenUsageSummary(
        for sessions: [OpenClawChatSessionEntry],
        rosterIsComplete: Bool = true) -> TokenUsageSummary
    {
        let knownTotals = sessions.compactMap(\.totalTokens)
        return TokenUsageSummary(
            total: knownTotals.isEmpty ? nil : knownTotals.reduce(0, +),
            isPartial: !rosterIsComplete || knownTotals.count < sessions.count ||
                sessions.contains { $0.totalTokensFresh == false })
    }

    private func applyRoster(_ roster: ChatSessionRosterSnapshot) {
        self.sessions = roster.sessions
        self.isSessionRosterComplete = roster.isComplete
        guard !roster.isComplete, !roster.isCached else {
            self.sessionErrorText = nil
            return
        }
        if let totalCount = roster.totalCount {
            self.sessionErrorText = String(
                format: String(localized: "Showing %lld of %lld sessions. Refresh to load the rest."),
                roster.sessions.count,
                totalCount)
        } else {
            self.sessionErrorText = String(localized: "Some sessions could not be loaded. Refresh to try again.")
        }
    }

    private func loadRoster(
        appModel: NodeAppModel,
        allowCachedFallback: Bool = true) async -> RosterLoadResult
    {
        do {
            return try await .success(appModel.loadChatSessionRoster(
                limit: Self.sessionLimit,
                allowCachedFallback: allowCachedFallback))
        } catch is CancellationError {
            return .cancelled
        } catch {
            return .failure(error.localizedDescription)
        }
    }

    private func loadDashboard(appModel: NodeAppModel) async -> DashboardSnapshot {
        guard appModel.isOperatorGatewayConnected else {
            return DashboardSnapshot(usage: nil, cronJobs: nil)
        }
        async let usage = self.request(
            CostUsageSummaryLite.self,
            appModel: appModel,
            method: "usage.cost",
            paramsJSON: CostUsageRequest.monthParamsJSON())
        async let cronJobs = self.loadCronJobs(appModel: appModel)
        let loadedUsage = await usage
        let loadedCronJobs = await cronJobs
        return DashboardSnapshot(usage: loadedUsage, cronJobs: loadedCronJobs)
    }

    private func loadCronJobs(appModel: NodeAppModel) async -> [CronJob]? {
        let pageLimit = 5
        let jobLimit = 1000
        var jobs: [CronJob] = []
        var seenJobIDs: Set<String> = []
        var expectedIdentity: CronJobsSnapshotIdentity?
        var offset = 0
        for _ in 0..<pageLimit {
            let paramsJSON = "{\"includeDisabled\":true,\"limit\":200,\"offset\":\(offset)," +
                "\"sortBy\":\"name\",\"sortDir\":\"asc\"}"
            let page = await self.request(
                CronJobsListLite.self,
                appModel: appModel,
                method: "cron.list",
                paramsJSON: paramsJSON)
            guard let page,
                  let identity = cronJobsSnapshotIdentity(page: page, maximumCount: jobLimit)
            else { return nil }
            if let expectedIdentity, identity != expectedIdentity {
                return nil
            }
            expectedIdentity = identity
            let pageJobIDs = Set(page.jobs.map(\.id))
            guard pageJobIDs.count == page.jobs.count,
                  seenJobIDs.isDisjoint(with: pageJobIDs)
            else { return nil }
            seenJobIDs.formUnion(pageJobIDs)
            jobs.append(contentsOf: page.jobs)
            guard jobs.count <= jobLimit else { return nil }
            if let total = identity.total {
                guard total >= jobs.count else { return nil }
                if jobs.count == total {
                    guard !page.hasMore else { return nil }
                    return jobs
                }
            }
            guard page.hasMore else { return jobs }
            guard let nextOffset = nextCronJobsListOffset(page: page, currentOffset: offset),
                  nextOffset <= jobLimit
            else { return nil }
            offset = nextOffset
        }
        return nil
    }

    private func request<T: Decodable>(
        _ type: T.Type,
        appModel: NodeAppModel,
        method: String,
        paramsJSON: String) async -> T?
    {
        do {
            let data = try await appModel.operatorSession.request(
                method: method,
                paramsJSON: paramsJSON,
                timeoutSeconds: 12)
            return try JSONDecoder().decode(type, from: data)
        } catch {
            return nil
        }
    }

    static func isFailedCronJob(_ job: CronJob) -> Bool {
        let status = (job.lastrunstatus?.value as? String)?.lowercased()
        // This failure vocabulary mirrors the web sidebar-attention contract in ui/src/components/sidebar-attention.ts.
        return job.enabled && ["error", "failed", "timeout", "timed_out"].contains(status)
    }

    private struct DashboardSnapshot {
        let usage: CostUsageSummaryLite?
        let cronJobs: [CronJob]?
    }

    private enum RosterLoadResult {
        case success(ChatSessionRosterSnapshot)
        case failure(String)
        case cancelled
    }
}
