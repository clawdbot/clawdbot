import Foundation
import OpenClawKit
import OpenClawProtocol

/// Shared RPC application layer. Platform adapters retain route acquisition,
/// dispatch fencing, event subscriptions, and their session-target policy.
public protocol OpenClawChatGatewayTransport: OpenClawChatTransport {
    var chatGatewayAgentID: String? { get }
    func sessionTarget(for sessionKey: String, overrideAgentID: String?) -> OpenClawChatSessionTarget
    func requestChatGateway(_ request: OpenClawChatGatewayRequest) async throws -> Data
    func requestChatSessionAction(_ request: OpenClawChatGatewayRequest) async throws -> Data
}

extension OpenClawChatGatewayTransport {
    public func requestChatSessionAction(_ request: OpenClawChatGatewayRequest) async throws -> Data {
        try await self.requestChatGateway(request)
    }

    public func abortRun(sessionKey: String, runId: String) async throws {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: nil)
        let request = OpenClawChatGatewayRequests.abortRun(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            runID: runId)
        _ = try await self.requestChatGateway(request)
    }

    public func deleteSession(key: String) async throws {
        let target = self.sessionTarget(for: key, overrideAgentID: nil)
        let request = OpenClawChatGatewayRequests.deleteSession(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        _ = try await self.requestChatGateway(request)
    }

    public func setActiveSessionKey(_ sessionKey: String) async throws {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: nil)
        let request = OpenClawChatGatewayRequests.subscribeSessionMessages(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        _ = try await self.requestChatGateway(request)
    }

    public func resetSession(sessionKey: String) async throws {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: nil)
        let request = OpenClawChatGatewayRequests.resetSession(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        _ = try await self.requestChatGateway(request)
    }

    public func listCommands(sessionKey: String) async throws -> [OpenClawChatCommandChoice] {
        let request = OpenClawChatGatewayRequests.commandsList(
            sessionKey: sessionKey,
            fallbackAgentID: self.chatGatewayAgentID)
        let data = try await self.requestChatGateway(request)
        let decoded = try JSONDecoder().decode(CommandsListResult.self, from: data)
        return decoded.commands.map(OpenClawChatGatewayPayloadCodec.commandChoice)
    }

    public func listQuestions() async throws -> [QuestionRecord] {
        let data = try await self.requestChatGateway(OpenClawChatGatewayRequests.questionList())
        return try JSONDecoder().decode(QuestionListResult.self, from: data).questions
    }

    public func listTasks(sessionKey: String, agentID: String?) async throws -> [TaskSummary] {
        let data = try await self.requestChatGateway(OpenClawChatGatewayRequests.tasksList(
            sessionKey: sessionKey,
            agentID: agentID))
        return try JSONDecoder().decode(TasksListResult.self, from: data).tasks
    }

    public func getQuestion(id: String) async throws -> QuestionRecord {
        let data = try await self.requestChatGateway(OpenClawChatGatewayRequests.questionGet(id: id))
        return try JSONDecoder().decode(QuestionGetResult.self, from: data).question
    }

    public func resolveQuestion(
        id: String,
        answers: [String: [String]],
        secretStoreAllowedHosts: [String]?) async throws -> QuestionAnswers
    {
        let data = try await self.requestChatGateway(OpenClawChatGatewayRequests.resolveQuestion(
            id: id,
            answers: answers,
            secretStoreAllowedHosts: secretStoreAllowedHosts))
        return try OpenClawChatGatewayPayloadCodec.decodeQuestionAnswer(data)
    }

    public func cancelQuestion(id: String) async throws {
        _ = try await self.requestChatGateway(
            OpenClawChatGatewayRequests.cancelQuestion(id: id))
    }

    public func setSessionThinking(sessionKey: String, thinkingLevel: String) async throws {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: nil)
        _ = try await self.patchSessionSettings(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            patch: OpenClawChatSessionSettingsPatch(thinkingLevel: .some(thinkingLevel)))
    }

    public func patchSessionModel(
        sessionKey: String,
        agentID: String?,
        model: String?) async throws -> OpenClawChatModelPatchResult?
    {
        try await self.patchSessionSettings(
            sessionKey: sessionKey,
            agentID: agentID,
            patch: OpenClawChatSessionSettingsPatch(model: .some(model)))
    }

    public func createSession(
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

    public func rewindSession(
        sessionKey: String,
        entryId: String) async throws -> OpenClawChatRewindResponse
    {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: nil)
        let request = OpenClawChatGatewayRequests.rewindSession(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            entryId: entryId)
        let data = try await self.requestChatSessionAction(request)
        return try JSONDecoder().decode(OpenClawChatRewindResponse.self, from: data)
    }

    public func forkSessionAtMessage(
        sessionKey: String,
        entryId: String) async throws -> OpenClawChatForkAtMessageResponse
    {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: nil)
        let request = OpenClawChatGatewayRequests.forkAtMessage(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            entryId: entryId)
        let data = try await self.requestChatSessionAction(request)
        return try JSONDecoder().decode(OpenClawChatForkAtMessageResponse.self, from: data)
    }

    public func listSessionBranches(
        sessionKey: String,
        agentID: String?) async throws -> OpenClawChatSessionBranchesResponse
    {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: agentID)
        let request = OpenClawChatGatewayRequests.listSessionBranches(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        let data = try await self.requestChatSessionAction(request)
        return try JSONDecoder().decode(OpenClawChatSessionBranchesResponse.self, from: data)
    }

    public func switchSessionBranch(sessionKey: String, agentID: String?, leafEntryId: String) async throws {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: nil)
        let request = OpenClawChatGatewayRequests.switchSessionBranch(
            sessionKey: target.sessionKey,
            agentID: agentID ?? target.agentID,
            leafEntryId: leafEntryId)
        _ = try await self.requestChatSessionAction(request)
    }
}
