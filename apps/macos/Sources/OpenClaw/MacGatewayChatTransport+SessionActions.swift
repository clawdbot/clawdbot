import Foundation
import OpenClawChatUI
import OpenClawProtocol

extension MacGatewayChatTransport {
    func acquireNewSessionRouteLease() async -> OpenClawChatNewSessionRouteLease? {
        guard let serverLease = await self.connection.captureServerLease() else { return nil }
        guard await self.currentOutboxGatewayMatchesConnection() else { return nil }
        let request: @Sendable (OpenClawChatGatewayRequest) async throws -> Data = { request in
            try await self.connection.request(
                method: request.method,
                params: request.params,
                timeoutMs: request.timeoutMs,
                ifCurrentServerLease: serverLease)
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
            createSession: { key, label, explicitAgentID, parentSessionKey, worktree, worktreeBaseRef in
                let agentID = explicitAgentID
                    ?? OpenClawChatSessionKey.agentID(from: key)
                    ?? parentSessionKey.flatMap { OpenClawChatSessionKey.agentID(from: $0) }
                let createRequest = OpenClawChatGatewayRequests.createSession(
                    key: key,
                    agentID: agentID,
                    label: label,
                    parentSessionKey: parentSessionKey,
                    worktree: worktree,
                    worktreeBaseRef: worktreeBaseRef)
                let data = try await request(createRequest)
                return try JSONDecoder().decode(OpenClawChatCreateSessionResponse.self, from: data)
            })
    }

    func acquireSessionGroupsRouteLease() async -> OpenClawChatSessionGroupsRouteLease? {
        guard let serverLease = await self.connection.captureServerLease() else { return nil }
        guard await self.currentOutboxGatewayMatchesConnection() else { return nil }
        let request: @Sendable (OpenClawChatGatewayRequest) async throws -> Data = { request in
            try await self.connection.request(
                method: request.method,
                params: request.params,
                timeoutMs: request.timeoutMs,
                ifCurrentServerLease: serverLease)
        }
        return OpenClawChatSessionGroupsRouteLease(
            listGroups: {
                let data = try await request(OpenClawChatGatewayRequests.sessionGroupsList())
                return try JSONDecoder().decode(OpenClawChatSessionGroupsResponse.self, from: data)
            },
            putGroups: { names in
                let data = try await request(OpenClawChatGatewayRequests.sessionGroupsPut(names: names))
                return try JSONDecoder().decode(OpenClawChatSessionGroupsMutationResponse.self, from: data)
            },
            renameGroup: { name, to in
                let data = try await request(OpenClawChatGatewayRequests.sessionGroupsRename(name: name, to: to))
                return try JSONDecoder().decode(OpenClawChatSessionGroupsMutationResponse.self, from: data)
            },
            deleteGroup: { name in
                let data = try await request(OpenClawChatGatewayRequests.sessionGroupsDelete(name: name))
                return try JSONDecoder().decode(OpenClawChatSessionGroupsMutationResponse.self, from: data)
            })
    }

    func acquireSessionMutationRouteLease() async -> OpenClawChatSessionMutationRouteLease? {
        guard let serverLease = await self.connection.captureServerLease() else { return nil }
        guard await self.currentOutboxGatewayMatchesConnection() else { return nil }
        let transport = self
        return OpenClawChatSessionMutationRouteLease(
            patchSession: { key, label, category, pinned, archived, unread in
                let target = transport.sessionTarget(for: key)
                let request = OpenClawChatGatewayRequests.patchSession(
                    sessionKey: target.sessionKey,
                    agentID: target.agentID,
                    label: label,
                    category: category,
                    pinned: pinned,
                    archived: archived,
                    unread: unread)
                _ = try await self.connection.request(
                    method: request.method,
                    params: request.params,
                    timeoutMs: request.timeoutMs,
                    ifCurrentServerLease: serverLease)
            },
            deleteSession: { key in
                let target = transport.sessionTarget(for: key)
                let request = OpenClawChatGatewayRequests.deleteSession(
                    sessionKey: target.sessionKey,
                    agentID: target.agentID)
                _ = try await self.connection.request(
                    method: request.method,
                    params: request.params,
                    timeoutMs: request.timeoutMs,
                    ifCurrentServerLease: serverLease)
            })
    }

    private func requestSessionAction(_ request: OpenClawChatGatewayRequest) async throws -> Data {
        guard let serverLease = await self.connection.captureServerLease() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        try await self.requireCurrentOutboxGateway()
        return try await self.connection.request(
            method: request.method,
            params: request.params,
            timeoutMs: request.timeoutMs,
            ifCurrentServerLease: serverLease)
    }

    func forkSession(parentKey: String) async throws -> String {
        let target = self.sessionTarget(for: parentKey)
        let request = OpenClawChatGatewayRequests.forkSession(
            parentSessionKey: target.sessionKey,
            agentID: target.agentID)
        let data = try await self.requestSessionAction(request)
        return try JSONDecoder().decode(OpenClawChatCreateSessionResponse.self, from: data).key
    }

    func rewindSession(
        sessionKey: String,
        entryId: String) async throws -> OpenClawChatRewindResponse
    {
        let target = self.sessionTarget(for: sessionKey)
        let request = Self.rewindSessionRequest(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            entryId: entryId)
        let data = try await self.requestSessionAction(request)
        return try JSONDecoder().decode(OpenClawChatRewindResponse.self, from: data)
    }

    func forkSessionAtMessage(
        sessionKey: String,
        entryId: String) async throws -> OpenClawChatForkAtMessageResponse
    {
        let target = self.sessionTarget(for: sessionKey)
        let request = Self.forkSessionAtMessageRequest(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            entryId: entryId)
        let data = try await self.requestSessionAction(request)
        return try JSONDecoder().decode(OpenClawChatForkAtMessageResponse.self, from: data)
    }

    func listSessionBranches(
        sessionKey: String,
        agentID: String?) async throws -> OpenClawChatSessionBranchesResponse
    {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: agentID)
        let request = OpenClawChatGatewayRequests.listSessionBranches(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        let data = try await self.requestSessionAction(request)
        return try JSONDecoder().decode(OpenClawChatSessionBranchesResponse.self, from: data)
    }

    func switchSessionBranch(sessionKey: String, agentID: String?, leafEntryId: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        let request = OpenClawChatGatewayRequests.switchSessionBranch(
            sessionKey: target.sessionKey,
            agentID: agentID ?? target.agentID,
            leafEntryId: leafEntryId)
        _ = try await self.requestSessionAction(request)
    }

    static func rewindSessionRequest(
        sessionKey: String,
        agentID: String?,
        entryId: String) -> OpenClawChatGatewayRequest
    {
        OpenClawChatGatewayRequests.rewindSession(
            sessionKey: sessionKey,
            agentID: agentID,
            entryId: entryId)
    }

    static func forkSessionAtMessageRequest(
        sessionKey: String,
        agentID: String?,
        entryId: String) -> OpenClawChatGatewayRequest
    {
        OpenClawChatGatewayRequests.forkAtMessage(
            sessionKey: sessionKey,
            agentID: agentID,
            entryId: entryId)
    }
}
