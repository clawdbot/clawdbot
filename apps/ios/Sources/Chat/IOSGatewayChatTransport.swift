import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog

struct IOSGatewayChatTransport: OpenClawChatTransport {
    static let logger = Logger(subsystem: "ai.openclawfoundation.app", category: "ios.chat.transport")
    let gateway: GatewayNodeSession
    private let widgetGateway: GatewayNodeSession?
    let globalAgentId: String?
    let outboxGatewayID: String?
    private let mediaArtifactLoader: IOSMediaArtifactLoader?

    var outboxRequiresSessionRoutingContract: Bool {
        true
    }

    init(
        gateway: GatewayNodeSession,
        widgetGateway: GatewayNodeSession? = nil,
        globalAgentId: String? = nil,
        outboxGatewayID: String? = nil,
        mediaArtifactLoader: IOSMediaArtifactLoader? = nil)
    {
        self.gateway = gateway
        self.widgetGateway = widgetGateway
        let normalized = globalAgentId?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        self.globalAgentId = normalized?.isEmpty == false ? normalized : nil
        self.outboxGatewayID = GatewayStableIdentifier.exact(outboxGatewayID)
        self.mediaArtifactLoader = mediaArtifactLoader
    }

    func acquireOutboxRouteLease() async -> OpenClawChatTransportRouteLeaseResult {
        guard let outboxGatewayID,
              let route = await gateway.currentRoute(ifGatewayID: outboxGatewayID)
        else { return .unavailable(reason: nil) }
        guard let supportsRoutingContract = await gateway.supportsServerCapability(
            .chatSendRoutingContract,
            ifCurrentRoute: route)
        else { return .unavailable(reason: nil) }
        guard supportsRoutingContract else {
            return .unavailable(
                reason: OpenClawChatTransportUpgradeMessage.routingContract,
                allowsLiveSend: true)
        }
        let supportsSettingsCAS = await gateway.supportsServerCapability(
            .sessionSettingsCAS,
            ifCurrentRoute: route) == true
        let transport = self
        guard let routingContract = try? await transport.sessionRoutingContract(ifCurrentRoute: route)
        else { return .unavailable(reason: nil) }
        return .available(OpenClawChatTransportRouteLease(
            sendTargetedMessageWithSettings: { key, agent, settings, text, thinking, id, attachments in
                try await transport.sendMessage(
                    sessionKey: key,
                    agentID: agent,
                    expectedSessionRoutingContract: routingContract,
                    expectedSessionSettings: settings,
                    message: text,
                    thinking: thinking,
                    idempotencyKey: id,
                    attachments: attachments,
                    ifCurrentRoute: route,
                    distinguishPreDispatchRouteChange: true)
            },
            requestTargetedHistory: { sessionKey, agentID in
                try await transport.requestHistory(
                    sessionKey: sessionKey,
                    agentID: agentID,
                    ifCurrentRoute: route)
            },
            sessionRoutingContract: routingContract,
            supportsSessionSettingsCAS: supportsSettingsCAS))
    }

    func acquireSwarmRouteLease() async -> OpenClawChatSwarmRouteLease? {
        guard let route = await currentSessionMutationRoute() else { return nil }
        let transport = self
        return OpenClawChatSwarmRouteLease(
            isEnabled: { sessionKey in
                try await transport.isSwarmEnabled(sessionKey: sessionKey, ifCurrentRoute: route)
            },
            listChildSessions: { parentKey in
                try await transport.listChildSessions(parentKey: parentKey, ifCurrentRoute: route)
            })
    }

    func acquireSessionSettingsRouteLease() async -> OpenClawChatSessionSettingsRouteLease? {
        let route = await currentSessionMutationRoute()
        guard let route else { return nil }
        let transport = self
        return OpenClawChatSessionSettingsRouteLease { sessionKey, agentID, patch in
            try await transport.patchSessionSettings(
                sessionKey: sessionKey,
                agentID: agentID,
                patch: patch,
                ifCurrentRoute: route)
        }
    }

    func acquireSessionMutationRouteLease() async -> OpenClawChatSessionMutationRouteLease? {
        guard let route = await currentSessionMutationRoute() else { return nil }
        let unreadAckContract = await gateway.supportsServerCapability(
            .sessionUnreadAckContract,
            ifCurrentRoute: route)
        let transport = self
        return OpenClawChatSessionMutationRouteLease(
            sessionTarget: { transport.sessionTarget(for: $0) },
            unreadAckContract: unreadAckContract,
            request: { request in
                try await transport.requestSessionMutation(request, ifCurrentRoute: route)
            })
    }

    func acquireNewSessionRouteLease() async -> OpenClawChatNewSessionRouteLease? {
        guard let route = await currentSessionMutationRoute() else { return nil }
        let transport = self
        let request: @Sendable (OpenClawChatGatewayRequest) async throws -> Data = { request in
            try await transport.requestSessionMutation(request, ifCurrentRoute: route)
        }
        return OpenClawChatNewSessionRouteLease(
            listAgents: {
                let data = try await request(OpenClawChatGatewayRequests.agentsList())
                let result = try JSONDecoder().decode(AgentsListResult.self, from: data)
                return OpenClawChatAgentsListResponse(
                    defaultId: result.defaultid,
                    agents: result.agents.filter(\.isSelectableAgent).map {
                        OpenClawChatAgentChoice(
                            id: $0.id,
                            name: $0.name,
                            workspaceGit: $0.workspacegit)
                    })
            },
            createSession: { key, label, agentID, parentSessionKey, worktree, worktreeBaseRef in
                let createRequest = transport.createSessionRequest(
                    key: key,
                    label: label,
                    agentID: agentID,
                    parentSessionKey: parentSessionKey,
                    worktree: worktree,
                    worktreeBaseRef: worktreeBaseRef)
                let data = try await request(createRequest)
                return try JSONDecoder().decode(OpenClawChatCreateSessionResponse.self, from: data)
            })
    }

    func currentSessionMutationRoute() async -> GatewayNodeSessionRoute? {
        if let outboxGatewayID {
            return await self.gateway.currentRoute(ifGatewayID: outboxGatewayID)
        }
        return await self.gateway.currentRoute()
    }

    private func sessionRoutingContract(
        ifCurrentRoute route: GatewayNodeSessionRoute) async throws -> String
    {
        let data = try await gateway.request(
            OpenClawChatGatewayRequests.agentsList(),
            ifCurrentRoute: route)
        return try OpenClawChatGatewayPayloadCodec.decodeSessionRoutingIdentity(data).contract
    }

    typealias SessionTarget = OpenClawChatSessionTarget

    static func sessionTarget(
        for rawSessionKey: String,
        selectedAgentID: String?,
        overrideAgentID: String? = nil) -> SessionTarget
    {
        OpenClawChatSessionTarget.resolve(
            rawSessionKey,
            selectedAgentID: selectedAgentID,
            overrideAgentID: overrideAgentID,
            policy: .scopeBareKeysToSelectedAgent)
    }

    func sessionTarget(
        for sessionKey: String,
        overrideAgentID: String? = nil) -> SessionTarget
    {
        Self.sessionTarget(
            for: sessionKey,
            selectedAgentID: self.globalAgentId,
            overrideAgentID: overrideAgentID)
    }

    private func requestSessionMutation(
        _ request: OpenClawChatGatewayRequest,
        ifCurrentRoute route: GatewayNodeSessionRoute) async throws -> Data
    {
        try await self.gateway.request(
            request,
            ifCurrentRoute: route,
            distinguishPreDispatchRouteChange: true)
    }

    func createSession(
        key: String,
        label: String?,
        parentSessionKey: String?,
        worktree: Bool?) async throws -> OpenClawChatCreateSessionResponse
    {
        try await self.createSession(
            key: key,
            label: label,
            agentID: nil,
            parentSessionKey: parentSessionKey,
            worktree: worktree,
            worktreeBaseRef: nil)
    }

    func createSession(
        key: String,
        label: String?,
        agentID: String?,
        parentSessionKey: String?,
        worktree: Bool?,
        worktreeBaseRef: String?) async throws -> OpenClawChatCreateSessionResponse
    {
        let request = self.createSessionRequest(
            key: key,
            label: label,
            agentID: agentID,
            parentSessionKey: parentSessionKey,
            worktree: worktree,
            worktreeBaseRef: worktreeBaseRef)
        let res = try await gateway.request(request)
        return try JSONDecoder().decode(OpenClawChatCreateSessionResponse.self, from: res)
    }

    private func createSessionRequest(
        key: String,
        label: String?,
        agentID: String?,
        parentSessionKey: String?,
        worktree: Bool?,
        worktreeBaseRef: String?) -> OpenClawChatGatewayRequest
    {
        let target = self.sessionTarget(for: key, overrideAgentID: agentID)
        let parentTarget = parentSessionKey.map { self.sessionTarget(for: $0) }
        let explicitAgentID = agentID?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return OpenClawChatGatewayRequests.createSession(
            key: target.sessionKey,
            agentID: explicitAgentID?.isEmpty == false
                ? explicitAgentID
                : target.agentID ?? parentTarget?.agentID,
            label: label,
            parentSessionKey: parentTarget?.sessionKey,
            worktree: worktree,
            worktreeBaseRef: worktreeBaseRef)
    }

    func abortRun(sessionKey: String, runId: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        let request = OpenClawChatGatewayRequests.abortRun(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            runID: runId)
        _ = try await self.gateway.request(request)
    }

    func listSessions(
        limit: Int?,
        search: String?,
        archived: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        let request = OpenClawChatGatewayRequests.sessionsList(
            limit: limit,
            search: search,
            archived: archived,
            agentID: self.globalAgentId)
        let res = try await gateway.request(request)
        return try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: res)
    }

    func listChildSessions(parentKey: String) async throws -> [OpenClawChatSessionEntry] {
        try await self.listChildSessions(parentKey: parentKey, ifCurrentRoute: nil)
    }

    private func listChildSessions(
        parentKey: String,
        ifCurrentRoute route: GatewayNodeSessionRoute?) async throws -> [OpenClawChatSessionEntry]
    {
        try await OpenClawChatChildSessionPager.collect { offset in
            let request = OpenClawChatGatewayRequests.sessionsList(
                limit: 10000,
                search: nil,
                archived: false,
                includeGlobal: false,
                spawnedBy: parentKey,
                offset: offset,
                configuredAgentsOnly: true)
            let data = try await gateway.request(request, ifCurrentRoute: route)
            return try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: data)
        }
    }

    func listModels(agentID: String?) async throws -> [OpenClawChatModelChoice] {
        let response = try await gateway.request(OpenClawChatGatewayRequests.modelsList(agentID: agentID))
        return try OpenClawChatGatewayPayloadCodec.decodeModelChoices(response)
    }

    func loadModelCatalog(
        sessionKey: String,
        agentID: String?) async throws -> OpenClawChatModelCatalogSnapshot
    {
        guard let route = await self.currentSessionMutationRoute() else {
            throw CancellationError()
        }
        let sessionScoped = await self.gateway.supportsServerCapability(
            .sessionScopedChatMetadata,
            ifCurrentRoute: route) == true
        let request = if sessionScoped {
            OpenClawChatGatewayRequests.chatMetadata(
                sessionKey: sessionKey,
                fallbackAgentID: agentID ?? self.globalAgentId,
                includeSessionKey: true)
        } else {
            OpenClawChatGatewayRequests.modelsList(agentID: agentID)
        }
        let response = try await self.gateway.request(request, ifCurrentRoute: route)
        let choices = try sessionScoped
            ? OpenClawChatGatewayPayloadCodec.decodeChatMetadataModelChoices(response)
            : OpenClawChatGatewayPayloadCodec.decodeModelChoices(response)
        return OpenClawChatModelCatalogSnapshot(
            choices: choices,
            availabilityIsSessionScoped: sessionScoped)
    }

    func isSwarmEnabled(sessionKey: String) async throws -> Bool {
        try await self.isSwarmEnabled(sessionKey: sessionKey, ifCurrentRoute: nil)
    }

    private func isSwarmEnabled(
        sessionKey: String,
        ifCurrentRoute route: GatewayNodeSessionRoute?) async throws -> Bool
    {
        let request = OpenClawChatGatewayRequests.chatMetadata(
            sessionKey: sessionKey,
            fallbackAgentID: self.globalAgentId)
        let response = try await gateway.request(request, ifCurrentRoute: route)
        return try JSONDecoder().decode(OpenClawChatMetadataCapabilities.self, from: response).swarmEnabled
    }

    func setSessionModel(sessionKey: String, model: String?) async throws {
        _ = try await self.patchSessionModel(sessionKey: sessionKey, agentID: nil, model: model)
    }

    func patchSessionModel(
        sessionKey: String,
        agentID: String?,
        model: String?) async throws -> OpenClawChatModelPatchResult?
    {
        try await self.patchSessionSettings(
            sessionKey: sessionKey,
            agentID: agentID,
            patch: OpenClawChatSessionSettingsPatch(model: .some(model)))
    }

    func patchSessionSettings(
        sessionKey: String,
        agentID: String?,
        patch: OpenClawChatSessionSettingsPatch) async throws -> OpenClawChatModelPatchResult?
    {
        try await self.patchSessionSettings(
            sessionKey: sessionKey,
            agentID: agentID,
            patch: patch,
            ifCurrentRoute: nil)
    }

    private func patchSessionSettings(
        sessionKey: String,
        agentID: String?,
        patch: OpenClawChatSessionSettingsPatch,
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute?) async throws -> OpenClawChatModelPatchResult?
    {
        let requiresSettingsContract = patch.expectedSessionID != nil ||
            patch.permissionMode != nil || patch.toolOverrides != nil
        let requiresSettingsCAS = patch.expectedPermissionMode != nil ||
            patch.expectedToolOverrides != nil || patch.permissionMode != nil || patch.toolOverrides != nil
        let fallbackRoute: GatewayNodeSessionRoute? = if requiresSettingsContract, expectedRoute == nil {
            await self.currentSessionMutationRoute()
        } else {
            nil
        }
        let settingsRoute = expectedRoute ?? fallbackRoute
        let settingsSupport = if let settingsRoute {
            await sessionSettingsSupport(ifCurrentRoute: settingsRoute)
        } else {
            (settingsContract: false, settingsCAS: false)
        }
        guard !requiresSettingsContract || settingsSupport.settingsContract else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        guard !requiresSettingsCAS || settingsSupport.settingsCAS else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: agentID)
        let request = OpenClawChatGatewayRequests.patchSessionSettings(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            expectedSessionID: patch.expectedSessionID,
            expectedPermissionMode: patch.expectedPermissionMode,
            expectedToolOverrides: patch.expectedToolOverrides,
            model: patch.model,
            thinkingLevel: patch.thinkingLevel,
            fastMode: patch.fastMode,
            verboseLevel: patch.verboseLevel,
            permissionMode: patch.permissionMode,
            toolOverrides: patch.toolOverrides,
            supportsSessionSettingsContract: settingsSupport.settingsContract,
            supportsSessionSettingsCAS: settingsSupport.settingsCAS)
        let response = if let settingsRoute {
            try await self.gateway.request(
                request,
                ifCurrentRoute: settingsRoute,
                distinguishPreDispatchRouteChange: true)
        } else {
            try await self.gateway.request(request)
        }
        return try Self.decodeModelPatchResult(response)
    }

    static func decodeModelPatchResult(_ data: Data) throws -> OpenClawChatModelPatchResult {
        try JSONDecoder().decode(OpenClawChatModelPatchResult.self, from: data)
    }

    func setSessionThinking(sessionKey: String, thinkingLevel: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        _ = try await self.patchSessionSettings(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            patch: OpenClawChatSessionSettingsPatch(thinkingLevel: .some(thinkingLevel)))
    }

    func patchSession(
        key: String,
        expectedSessionID: String? = nil,
        label: String?? = nil,
        category: String?? = nil,
        color: String?? = nil,
        pinned: Bool? = nil,
        archived: Bool? = nil,
        unread: Bool? = nil) async throws
    {
        guard let routeLease = await acquireSessionMutationRouteLease() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        try await routeLease.patchSession(
            key: key,
            expectedSessionID: expectedSessionID,
            label: label,
            category: category,
            color: color,
            pinned: pinned,
            archived: archived,
            unread: unread)
    }

    func deleteSession(key: String) async throws {
        let target = self.sessionTarget(for: key)
        let request = OpenClawChatGatewayRequests.deleteSession(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        _ = try await self.gateway.request(request)
    }

    func forkSession(parentKey: String) async throws -> String {
        try await self.forkSession(parentKey: parentKey, fromLastCompleted: false)
    }

    func forkSession(parentKey: String, fromLastCompleted: Bool) async throws -> String {
        let target = self.sessionTarget(for: parentKey)
        let childAgentID = target.agentID ?? OpenClawChatSessionKey.agentID(from: target.sessionKey)
        let request = OpenClawChatGatewayRequests.forkSession(
            parentSessionKey: target.sessionKey,
            agentID: childAgentID,
            fromLastCompleted: fromLastCompleted)
        let response = try await gateway.request(request)
        return try JSONDecoder().decode(OpenClawChatCreateSessionResponse.self, from: response).key
    }

    func rewindSession(
        sessionKey: String,
        entryId: String) async throws -> OpenClawChatRewindResponse
    {
        let target = self.sessionTarget(for: sessionKey)
        let request = OpenClawChatGatewayRequests.rewindSession(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            entryId: entryId)
        let response = try await gateway.request(request)
        return try JSONDecoder().decode(OpenClawChatRewindResponse.self, from: response)
    }

    func forkSessionAtMessage(
        sessionKey: String,
        entryId: String) async throws -> OpenClawChatForkAtMessageResponse
    {
        let target = self.sessionTarget(for: sessionKey)
        let request = OpenClawChatGatewayRequests.forkAtMessage(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            entryId: entryId)
        let response = try await gateway.request(request)
        return try JSONDecoder().decode(OpenClawChatForkAtMessageResponse.self, from: response)
    }

    func listSessionBranches(
        sessionKey: String,
        agentID: String?) async throws -> OpenClawChatSessionBranchesResponse
    {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: agentID)
        let request = OpenClawChatGatewayRequests.listSessionBranches(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        let response = try await gateway.request(request)
        return try JSONDecoder().decode(OpenClawChatSessionBranchesResponse.self, from: response)
    }

    func switchSessionBranch(sessionKey: String, agentID: String?, leafEntryId: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        let request = OpenClawChatGatewayRequests.switchSessionBranch(
            sessionKey: target.sessionKey,
            agentID: agentID ?? target.agentID,
            leafEntryId: leafEntryId)
        _ = try await self.gateway.request(request)
    }

    func setActiveSessionKey(_ sessionKey: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        let request = OpenClawChatGatewayRequests.subscribeSessionMessages(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        _ = try await self.gateway.request(request)
    }

    func resetSession(sessionKey: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        let request = OpenClawChatGatewayRequests.resetSession(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        _ = try await self.gateway.request(request)
    }

    func compactSession(sessionKey: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        let request = OpenClawChatGatewayRequests.compactSession(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        let response = try await gateway.request(request)
        try OpenClawSessionsCompactResponse.requireSuccess(from: response)
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        try await self.requestHistory(sessionKey: sessionKey, agentID: nil, ifCurrentRoute: nil)
    }

    func gatewayAdvertisesMethod(_ method: String) async -> Bool? {
        guard let route = await currentSessionMutationRoute() else { return nil }
        return await self.gateway.supportsServerMethod(method, ifCurrentRoute: route)
    }

    func fetchProgressCard(sessionKey: String, agentID: String?) async throws -> ProgressCard? {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: agentID)
        let request = OpenClawChatGatewayRequests.progressCardGet(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        guard let route = await self.currentSessionMutationRoute() else { throw CancellationError() }
        if request.params["agentId"] != nil {
            guard let supported = await self.gateway.supportsServerCapability(
                .progressCardAgentScope,
                ifCurrentRoute: route) else { throw CancellationError() }
            guard supported else {
                throw OpenClawChatProgressCardError.ownerScopeUnavailable
            }
        }
        let data = try await self.gateway.request(request, ifCurrentRoute: route)
        return try OpenClawChatGatewayPayloadCodec.decodeProgressCard(
            data,
            agentID: OpenClawChatSessionKey.agentID(from: target.sessionKey) ?? target.agentID)
    }

    func resolveInlineWidgetResource(
        path: String,
        replacing failedResource: OpenClawChatWidgetResource?) async -> OpenClawChatWidgetResource?
    {
        let gateway = self.gateway
        let widgetGateway = self.widgetGateway
        return await OpenClawChatWidgetURLResolver.resolveResource(
            target: path,
            replacing: failedResource,
            currentSurfaceRoutes: {
                let node = await widgetGateway?.currentCanvasHostRoute()
                let operatorSurface = await gateway.currentCanvasHostRoute()
                return (node: node, operatorSurface: operatorSurface)
            },
            // Prefer the device's node route; operator rotation covers clients
            // whose node role is unavailable or intentionally disabled.
            refreshNodeSurfaceRoute: { observed in
                await widgetGateway?.refreshCanvasHostRoute(replacing: observed?.url)
            },
            refreshOperatorSurfaceRoute: { observed in
                await gateway.refreshCanvasHostRoute(replacing: observed?.url)
            })
    }

    func loadMediaArtifact(
        sessionKey: String,
        artifactId: String,
        kind: OpenClawChatMediaKind,
        playback: OpenClawChatPlaybackMode?) async throws -> OpenClawChatLoadedMedia?
    {
        guard kind.acceptsManagedArtifactID(artifactId),
              let mediaArtifactLoader,
              let route = await gateway.currentRoute(),
              let gatewayID = await gateway.currentGatewayID(ifCurrentRoute: route)
        else { return nil }
        let target = self.sessionTarget(for: sessionKey)
        let request = OpenClawChatGatewayRequests.artifactDownload(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            artifactId: artifactId)
        let data = try await gateway.request(request, ifCurrentRoute: route)
        let response = try JSONDecoder().decode(ArtifactsDownloadResult.self, from: data)
        guard await self.gateway.currentRoute() == route else { throw CancellationError() }
        let loaded = try await mediaArtifactLoader.load(
            response: response,
            kind: kind,
            playback: playback,
            expectedGatewayID: gatewayID)
        guard await self.gateway.currentRoute() == route else { throw CancellationError() }
        return loaded
    }

    func resolveInlineWidgetURL(path: String, replacing failedURL: URL?) async -> URL? {
        await self.resolveInlineWidgetResource(
            path: path,
            replacing: failedURL.map { OpenClawChatWidgetResource(url: $0) })?.url
    }

    func requestHistory(
        sessionKey: String,
        agentID: String? = nil,
        inputRunIDs: [String]? = nil,
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute?) async throws -> OpenClawChatHistoryPayload
    {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: agentID)
        let request = OpenClawChatGatewayRequests.history(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            inputRunIDs: inputRunIDs)
        let res = try await gateway.request(
            request,
            ifCurrentRoute: expectedRoute)
        return try JSONDecoder().decode(OpenClawChatHistoryPayload.self, from: res)
    }

    static func isUnsupportedHistoryInputRunIDsError(_ error: any Error) -> Bool {
        // Gateways through v2026.8.1 reject this optional field without a capability bit.
        // Remove this wire-contract fallback once the minimum Gateway is v2026.8.2;
        // local doctor cannot upgrade a remote Gateway.
        guard let error = error as? GatewayResponseError,
              error.method == "chat.history",
              error.code == "INVALID_REQUEST"
        else { return false }
        return error.message == "invalid chat.history params: at root: unexpected property 'inputRunIds'"
    }

    var supportsSlashCommandCatalog: Bool {
        true
    }

    func listCommands(sessionKey: String) async throws -> [OpenClawChatCommandChoice] {
        let request = OpenClawChatGatewayRequests.commandsList(
            sessionKey: sessionKey,
            fallbackAgentID: self.globalAgentId)
        let res = try await gateway.request(request)
        let decoded = try JSONDecoder().decode(CommandsListResult.self, from: res)
        return decoded.commands.map(OpenClawChatGatewayPayloadCodec.commandChoice)
    }

    func waitForRunCompletion(
        runId rawRunId: String,
        timeoutMs: Int) async -> OpenClawChatRunObservation
    {
        let route = await gateway.currentRoute()
        return await self.waitForRunCompletion(
            runId: rawRunId,
            timeoutMs: timeoutMs,
            ifCurrentRoute: route)
    }

    func waitForRunCompletion(
        runId rawRunId: String,
        timeoutMs: Int,
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute?) async -> OpenClawChatRunObservation
    {
        let runId = rawRunId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !runId.isEmpty, let expectedRoute else { return .unavailable }

        do {
            let request = OpenClawChatGatewayRequests.agentWait(runID: runId, timeoutMs: timeoutMs)
            GatewayDiagnostics.log("agent.wait start runId=\(runId)")
            let res = try await gateway.request(
                request,
                ifCurrentRoute: expectedRoute)
            let observation = try OpenClawChatGatewayPayloadCodec.decodeAgentWaitObservation(res)
            GatewayDiagnostics.log("agent.wait completed runId=\(runId) observation=\(observation)")
            return observation
        } catch {
            Self.logger.warning("agent.wait failed \(error.localizedDescription, privacy: .public)")
            GatewayDiagnostics.log("agent.wait failed runId=\(runId) error=\(error.localizedDescription)")
            return .unavailable
        }
    }

    func requestHealth(timeoutMs: Int) async throws -> Bool {
        let res = try await gateway.request(OpenClawChatGatewayRequests.health(timeoutMs: timeoutMs))
        return (try? JSONDecoder().decode(OpenClawGatewayHealthOK.self, from: res))?.ok ?? true
    }

    func listQuestions() async throws -> [QuestionRecord] {
        let data = try await gateway.request(OpenClawChatGatewayRequests.questionList())
        return try JSONDecoder().decode(QuestionListResult.self, from: data).questions
    }

    func listTasks(sessionKey: String, agentID: String?) async throws -> [TaskSummary] {
        let data = try await gateway.request(OpenClawChatGatewayRequests.tasksList(
            sessionKey: sessionKey,
            agentID: agentID))
        return try JSONDecoder().decode(TasksListResult.self, from: data).tasks
    }

    func getQuestion(id: String) async throws -> QuestionRecord {
        let data = try await gateway.request(OpenClawChatGatewayRequests.questionGet(id: id))
        return try JSONDecoder().decode(QuestionGetResult.self, from: data).question
    }

    func resolveQuestion(
        id: String,
        answers: [String: [String]],
        secretStoreAllowedHosts: [String]?) async throws -> QuestionAnswers
    {
        let data = try await self.gateway.request(OpenClawChatGatewayRequests.resolveQuestion(
            id: id,
            answers: answers,
            secretStoreAllowedHosts: secretStoreAllowedHosts))
        return try OpenClawChatGatewayPayloadCodec.decodeQuestionAnswer(data)
    }

    func cancelQuestion(id: String) async throws {
        _ = try await self.gateway.request(OpenClawChatGatewayRequests.cancelQuestion(id: id))
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { continuation in
            let task = Task {
                let stream = await self.gateway.subscribeServerEvents()
                for await evt in stream {
                    if Task.isCancelled {
                        return
                    }
                    if let mapped = OpenClawChatGatewayPayloadCodec.event(from: evt) {
                        continuation.yield(mapped)
                    }
                }
            }

            continuation.onTermination = { @Sendable _ in
                task.cancel()
            }
        }
    }
}
