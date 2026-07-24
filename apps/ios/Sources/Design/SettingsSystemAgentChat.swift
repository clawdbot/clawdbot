import Foundation
import Observation
import OpenClawKit
import SwiftUI

struct IOSSystemAgentChatRouteLease: Sendable {
    let route: GatewayNodeSessionRoute?
    let request: @Sendable (_ method: String, _ params: [String: AnyCodable], _ timeoutMs: Double) async throws -> Data
    let isCurrent: @Sendable () async -> Bool

    static func live(session: GatewayNodeSession, gatewayID: String?) async -> Self? {
        guard let route = await session.currentRoute(ifGatewayID: gatewayID) else { return nil }
        return Self(
            route: route,
            request: { method, params, timeoutMs in
                try await session.request(
                    method: method,
                    params: params,
                    timeoutMs: timeoutMs,
                    ifCurrentRoute: route,
                    distinguishPreDispatchRouteChange: true)
            },
            isCurrent: {
                await session.currentRoute(ifGatewayID: gatewayID) == route
            })
    }
}

@MainActor
@Observable
final class IOSSystemAgentChatModel {
    enum AccessState: Equatable {
        case disconnected
        case missingAdminScope
        case checkingSystemAgentMethod
        case missingSystemAgentMethod
        case ready
    }

    struct Message: Identifiable, Equatable {
        enum Role: Equatable {
            case assistant
            case user
        }

        let id: UUID
        let role: Role
        let text: String
        let question: SystemAgentChatQuestion?

        init(
            id: UUID = UUID(),
            role: Role,
            text: String,
            question: SystemAgentChatQuestion? = nil)
        {
            self.id = id
            self.role = role
            self.text = text
            self.question = question
        }
    }

    struct Handoff: Equatable {
        let agentID: String?
    }

    typealias CaptureRoute = @Sendable (_ gatewayID: String?) async -> IOSSystemAgentChatRouteLease?

    private struct ChatResult: Decodable {
        let reply: String
        let action: String
        let sensitive: Bool?
        let agentId: String?
        let question: AnyCodable?
    }

    private(set) var messages: [Message] = []
    private(set) var isSending = false
    private(set) var errorMessage: String?
    private(set) var expectsSensitiveReply = false
    private(set) var dismissedQuestionMessageIDs: Set<UUID> = []
    private(set) var retiredQuestionMessageIDs: Set<UUID> = []
    private(set) var accessState: AccessState
    private(set) var pendingHandoff: Handoff?
    private(set) var sessionID: String
    var input = ""
    var onOpenAgent: ((String?) -> Void)?

    private let sessionPrefix: String
    private let captureRoute: CaptureRoute
    private var routeLease: IOSSystemAgentChatRouteLease?
    private var routeIdentity: String?
    private var started = false
    private var requestGeneration: UInt64? = 0
    private var requestTask: Task<Void, Never>?
    private var systemAgentMethodSupport: (gatewayID: String?, route: GatewayNodeSessionRoute, value: Bool)?

    init(
        accessState: AccessState,
        routeIdentity: String?,
        sessionPrefix: String = "ios-settings-openclaw",
        captureRoute: @escaping CaptureRoute)
    {
        self.accessState = accessState
        self.routeIdentity = routeIdentity
        self.sessionPrefix = sessionPrefix
        self.sessionID = "\(sessionPrefix)-\(UUID().uuidString)"
        self.captureRoute = captureRoute
    }

    convenience init(appModel: NodeAppModel) {
        let session = appModel.operatorSession
        let captureRoute: CaptureRoute = if appModel.isScreenshotFixtureModeEnabled {
            { _ in
                IOSSystemAgentChatRouteLease(
                    route: nil,
                    request: { _, params, _ in try Self.screenshotFixtureReply(params: params) },
                    isCurrent: { true })
            }
        } else {
            { gatewayID in
                await IOSSystemAgentChatRouteLease.live(session: session, gatewayID: gatewayID)
            }
        }
        self.init(
            accessState: Self.accessState(
                connected: appModel.isOperatorGatewayConnected,
                hasAdminScope: appModel.hasOperatorAdminScope,
                supportsSystemAgent: appModel.isScreenshotFixtureModeEnabled ? true : nil),
            routeIdentity: appModel.connectedGatewayID,
            captureRoute: captureRoute)
        self.onOpenAgent = { [weak appModel] agentID in
            guard let appModel else { return }
            let trimmedAgentID = agentID?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let trimmedAgentID, !trimmedAgentID.isEmpty {
                appModel.setSelectedAgentId(trimmedAgentID)
            }
            appModel.openChat(sessionKey: nil)
        }
    }

    static func accessState(
        connected: Bool,
        hasAdminScope: Bool,
        supportsSystemAgent: Bool?) -> AccessState
    {
        guard connected else { return .disconnected }
        guard hasAdminScope else { return .missingAdminScope }
        guard let supportsSystemAgent else { return .checkingSystemAgentMethod }
        return supportsSystemAgent ? .ready : .missingSystemAgentMethod
    }

    nonisolated static func screenshotFixtureReply(params: [String: AnyCodable]) throws -> Data {
        let hasMessage = params["message"]?.value is String
        let reply = hasMessage
            ? String(localized: "I’ll keep this conversation separate from ordinary agent chat.")
            : String(localized: "I can check Gateway status, repair configuration, change models, or connect channels.")
        var result: [String: Any] = [
            "sessionId": "ios-screenshot-openclaw",
            "reply": reply,
            "action": "none",
        ]
        if !hasMessage {
            result["question"] = [
                "id": "help",
                "header": "OpenClaw",
                "question": String(localized: "What should we look at first?"),
                "options": [
                    [
                        "label": String(localized: "Check status"),
                        "description": String(localized: "Review the Gateway and active services."),
                        "recommended": true,
                        "reply": "Check Gateway status",
                    ],
                    [
                        "label": String(localized: "Review setup"),
                        "description": String(localized: "Inspect models, channels, and configuration."),
                        "reply": "Review setup",
                    ],
                ],
            ]
        }
        return try JSONSerialization.data(withJSONObject: result)
    }

    func updateAccess(
        connected: Bool,
        hasAdminScope: Bool,
        supportsSystemAgent: Bool? = true,
        routeIdentity: String?)
    {
        let nextAccess = Self.accessState(
            connected: connected,
            hasAdminScope: hasAdminScope,
            supportsSystemAgent: supportsSystemAgent)
        let routeChanged = self.routeIdentity != routeIdentity
        self.routeIdentity = routeIdentity
        self.accessState = nextAccess

        if routeChanged {
            self.invalidateCurrentRequest()
            self.clearSystemAgentMethodSupport()
            self.rotateConversation()
            return
        }
        if nextAccess == .checkingSystemAgentMethod {
            self.invalidateCurrentRequest()
            self.routeLease = nil
            self.input = ""
            return
        }
        guard nextAccess != .ready else { return }
        guard self.started || self.isSending || !self.messages.isEmpty else { return }
        self.invalidateCurrentRequest()
        self.routeLease = nil
        self.input = ""
        self.expectsSensitiveReply = false
        self.pendingHandoff = nil
        self.errorMessage = String(localized: "The Gateway connection changed. Restart OpenClaw to reconnect.")
    }

    @discardableResult
    func matchesGatewayIdentity(_ gatewayID: String?) -> Bool {
        self.routeIdentity == gatewayID
    }

    func cachedSystemAgentMethodSupport(
        gatewayID: String?,
        route: GatewayNodeSessionRoute) -> Bool?
    {
        guard let systemAgentMethodSupport,
              systemAgentMethodSupport.gatewayID == gatewayID,
              systemAgentMethodSupport.route == route
        else { return nil }
        return systemAgentMethodSupport.value
    }

    func cacheSystemAgentMethodSupport(
        gatewayID: String?,
        route: GatewayNodeSessionRoute,
        value: Bool)
    {
        self.systemAgentMethodSupport = (gatewayID, route, value)
    }

    func clearSystemAgentMethodSupport() {
        self.systemAgentMethodSupport = nil
    }

    private func rotateConversation() {
        self.started = false
        self.routeLease = nil
        self.sessionID = "\(self.sessionPrefix)-\(UUID().uuidString)"
        self.messages.removeAll()
        self.dismissedQuestionMessageIDs.removeAll()
        self.retiredQuestionMessageIDs.removeAll()
        self.input = ""
        self.errorMessage = nil
        self.expectsSensitiveReply = false
        self.pendingHandoff = nil
    }

    func startIfNeeded() -> Task<Void, Never>? {
        guard self.accessState == .ready,
              !self.started,
              self.errorMessage == nil,
              let generation = self.requestGeneration
        else { return nil }
        self.started = true
        let task = Task { [weak self] in
            guard let self else { return }
            await self.requestReply(message: nil, generation: generation)
        }
        self.requestTask = task
        return task
    }

    @discardableResult
    func send() -> Task<Void, Never>? {
        let trimmed = self.input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return self.send(message: self.expectsSensitiveReply ? self.input : trimmed)
    }

    @discardableResult
    func answerQuestion(messageID: UUID, optionLabel: String) -> Task<Void, Never>? {
        guard let message = self.messages.first(where: { $0.id == messageID }),
              let question = message.question,
              let option = question.options.first(where: { $0.label == optionLabel }),
              self.canAnswerQuestion(message)
        else { return nil }
        return self.send(message: option.reply ?? option.label, displayText: option.label)
    }

    @discardableResult
    func skipQuestion(messageID: UUID) -> Task<Void, Never>? {
        guard let message = self.messages.first(where: { $0.id == messageID }),
              self.canAnswerQuestion(message),
              let task = self.send(
                  message: "Skip for now",
                  displayText: String(localized: "Skip for now"))
        else { return nil }
        self.dismissedQuestionMessageIDs.insert(messageID)
        return task
    }

    func isQuestionVisible(_ message: Message) -> Bool {
        message.question != nil && !self.dismissedQuestionMessageIDs.contains(message.id)
    }

    func canAnswerQuestion(_ message: Message) -> Bool {
        self.accessState == .ready &&
            self.isQuestionVisible(message) &&
            !self.retiredQuestionMessageIDs.contains(message.id) &&
            !self.isSending &&
            self.errorMessage == nil
    }

    func openAgent() {
        guard let handoff = self.pendingHandoff else { return }
        self.pendingHandoff = nil
        self.onOpenAgent?(handoff.agentID)
    }

    @discardableResult
    func restartAfterError() -> Task<Void, Never>? {
        guard self.accessState == .ready,
              let previousGeneration = self.requestGeneration
        else { return nil }
        let generation = previousGeneration &+ 1
        self.requestGeneration = generation
        self.requestTask?.cancel()
        self.routeLease = nil
        self.sessionID = "\(self.sessionPrefix)-\(UUID().uuidString)"
        self.started = true
        self.messages.removeAll()
        self.dismissedQuestionMessageIDs.removeAll()
        self.retiredQuestionMessageIDs.removeAll()
        self.input = ""
        self.errorMessage = nil
        self.expectsSensitiveReply = false
        self.pendingHandoff = nil
        let task = Task { [weak self] in
            guard let self else { return }
            await self.requestReply(message: nil, generation: generation)
        }
        self.requestTask = task
        return task
    }

    /// A secret-bearing draft must not survive while another surface is active.
    /// In-flight work stays bound to its captured route and can finish in the retained model.
    func clearInputForBackground() {
        self.input = ""
    }

    private func invalidateCurrentRequest() {
        guard let generation = self.requestGeneration else { return }
        self.requestGeneration = generation &+ 1
        self.requestTask?.cancel()
        self.requestTask = nil
        self.isSending = false
    }

    private func isCurrentRequest(_ generation: UInt64) -> Bool {
        self.requestGeneration == generation && !Task.isCancelled
    }

    private func sessionRoute(for generation: UInt64) async throws -> IOSSystemAgentChatRouteLease {
        if let routeLease = self.routeLease {
            return routeLease
        }
        guard let routeLease = await self.captureRoute(self.routeIdentity) else {
            guard self.isCurrentRequest(generation) else { throw CancellationError() }
            throw NSError(
                domain: "Gateway",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: String(localized: "Gateway is not connected")])
        }
        guard self.isCurrentRequest(generation) else { throw CancellationError() }
        self.routeLease = routeLease
        return routeLease
    }

    private func send(message: String, displayText: String? = nil) -> Task<Void, Never>? {
        guard self.accessState == .ready,
              let generation = self.requestGeneration,
              !message.isEmpty,
              !self.isSending,
              self.errorMessage == nil,
              self.pendingHandoff == nil
        else { return nil }
        self.retireQuestions()
        self.input = ""
        self.messages.append(Message(
            role: .user,
            text: displayText ?? (self.expectsSensitiveReply ? String(localized: "<redacted secret>") : message)))
        let task = Task { [weak self] in
            guard let self else { return }
            await self.requestReply(message: message, generation: generation)
        }
        self.requestTask = task
        return task
    }

    private func retireQuestions() {
        for message in self.messages where message.question != nil {
            self.retiredQuestionMessageIDs.insert(message.id)
        }
    }

    private func requestReply(message: String?, generation: UInt64) async {
        guard self.accessState == .ready, self.isCurrentRequest(generation) else { return }
        self.isSending = true
        self.errorMessage = nil
        defer {
            if self.requestGeneration == generation {
                self.isSending = false
            }
        }

        do {
            var params: [String: AnyCodable] = [
                "sessionId": AnyCodable(self.sessionID),
            ]
            if let message {
                params["message"] = AnyCodable(message)
            }
            let routeLease = try await self.sessionRoute(for: generation)
            guard self.isCurrentRequest(generation) else { return }
            let data = try await routeLease.request("openclaw.chat", params, 190_000)
            guard self.isCurrentRequest(generation) else { return }
            guard await routeLease.isCurrent() else { throw CancellationError() }
            let result = try JSONDecoder().decode(ChatResult.self, from: data)
            guard self.isCurrentRequest(generation) else { return }
            self.expectsSensitiveReply = result.sensitive == true
            self.messages.append(Message(
                role: .assistant,
                text: result.reply,
                question: SystemAgentChatQuestion.parse(result.question?.dictionaryValue)))
            if result.action == "open-agent" {
                self.pendingHandoff = Handoff(agentID: result.agentId)
            }
        } catch {
            guard self.requestGeneration == generation else { return }
            let routeChangedBeforeDispatch = if let requestError = error as? GatewayNodeSessionRequestError {
                switch requestError {
                case .routeChangedBeforeDispatch: true
                }
            } else {
                false
            }
            if error is CancellationError || routeChangedBeforeDispatch {
                self.started = false
                self.routeLease = nil
                self.errorMessage = String(localized: "The Gateway connection changed. Restart OpenClaw to reconnect.")
                return
            }
            self.errorMessage = error.localizedDescription
        }
    }
}

@MainActor
@Observable
final class IOSSystemAgentChatStore {
    private var model: IOSSystemAgentChatModel?

    func model(for appModel: NodeAppModel) -> IOSSystemAgentChatModel {
        if let model {
            return model
        }
        let model = IOSSystemAgentChatModel(appModel: appModel)
        self.model = model
        return model
    }
}

struct SettingsSystemAgentChatScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: IOSSystemAgentChatModel
    @State private var systemAgentSupportCheckID = UUID()
    @State private var systemAgentSupportRetryTask: Task<Void, Never>?
    @State private var isScreenActive = false

    init(model: IOSSystemAgentChatModel) {
        _model = State(initialValue: model)
    }

    var body: some View {
        VStack(spacing: 0) {
            if self.model.accessState == .ready {
                self.chatContent
            } else {
                self.accessGate
            }
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("OpenClaw")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            self.isScreenActive = true
            await self.refreshSystemAgentSupportAndStart()
        }
        .onChange(of: self.appModel.isOperatorGatewayConnected) { _, _ in
            Task { await self.refreshSystemAgentSupportAndStart(forceRefresh: true) }
        }
        .onChange(of: self.appModel.hasOperatorAdminScope) { _, _ in
            Task { await self.refreshSystemAgentSupportAndStart(forceRefresh: true) }
        }
        .onChange(of: self.appModel.connectedGatewayID) { _, _ in
            Task { await self.refreshSystemAgentSupportAndStart(forceRefresh: true) }
        }
        .onChange(of: self.scenePhase) { _, phase in
            guard phase == .active else {
                self.cancelSystemAgentSupportRetry()
                self.model.clearInputForBackground()
                return
            }
            Task { await self.refreshSystemAgentSupportAndStart() }
        }
        .onDisappear {
            self.isScreenActive = false
            self.cancelSystemAgentSupportRetry()
            self.model.clearInputForBackground()
        }
    }

    private var chatContent: some View {
        VStack(spacing: 10) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(self.model.messages) { message in
                            VStack(alignment: .leading, spacing: 10) {
                                IOSSystemAgentChatBubble(message: message)
                                if let question = message.question,
                                   self.model.isQuestionVisible(message)
                                {
                                    IOSSystemAgentQuestionCard(
                                        question: question,
                                        isEnabled: self.model.canAnswerQuestion(message),
                                        onSelect: { option in
                                            self.model.answerQuestion(
                                                messageID: message.id,
                                                optionLabel: option.label)
                                        },
                                        onSkip: {
                                            self.model.skipQuestion(messageID: message.id)
                                        })
                                }
                            }
                            .id(message.id)
                        }

                        if self.model.isSending {
                            HStack(spacing: 8) {
                                ProgressView()
                                    .controlSize(.small)
                                Text("OpenClaw is working…")
                                    .font(OpenClawType.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.horizontal, 4)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                }
                .onChange(of: self.model.messages) { _, messages in
                    guard let last = messages.last else { return }
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }

            if let error = self.model.errorMessage {
                self.errorRow(error)
            }
            if self.model.pendingHandoff != nil {
                self.handoffRow
            } else {
                self.composer
            }
        }
    }

    private var accessGate: some View {
        VStack(spacing: 14) {
            Image(systemName: self.accessGateIcon)
                .font(.system(size: 42, weight: .semibold))
                .foregroundStyle(OpenClawBrand.warn)
            Text(self.accessGateTitle)
                .font(OpenClawType.title3SemiBold)
            Text(self.accessGateDetail)
                .font(OpenClawType.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: 420)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(28)
        .accessibilityIdentifier("settings-system-agent-access-gate")
    }

    private var accessGateIcon: String {
        switch self.model.accessState {
        case .disconnected: "wifi.slash"
        case .missingAdminScope: "lock.shield"
        case .checkingSystemAgentMethod: "arrow.triangle.2.circlepath"
        case .missingSystemAgentMethod: "arrow.down.circle"
        case .ready: ""
        }
    }

    private var accessGateTitle: String {
        switch self.model.accessState {
        case .disconnected: String(localized: "Gateway Required")
        case .missingAdminScope: String(localized: "Full Access Required")
        case .checkingSystemAgentMethod: String(localized: "Checking Gateway")
        case .missingSystemAgentMethod: String(localized: "Gateway Update Required")
        case .ready: ""
        }
    }

    private var accessGateDetail: String {
        switch self.model.accessState {
        case .disconnected:
            String(localized: "Connect this iPhone to a Gateway before opening the OpenClaw settings assistant.")
        case .missingAdminScope:
            String(localized: "Reconnect with operator.admin access to review and change Gateway settings.")
        case .checkingSystemAgentMethod:
            String(localized: "Checking whether this Gateway supports the OpenClaw settings assistant.")
        case .missingSystemAgentMethod:
            String(localized: "Update this Gateway to use the OpenClaw settings assistant.")
        case .ready:
            ""
        }
    }

    private func errorRow(_ error: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(OpenClawBrand.warn)
            Text(error)
                .font(OpenClawType.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button {
                self.model.restartAfterError()
            } label: {
                Text("Restart")
                    .font(OpenClawType.captionSemiBold)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.horizontal, 14)
    }

    private var handoffRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("OpenClaw is ready to continue in your ordinary chat.")
                .font(OpenClawType.subhead)
                .foregroundStyle(.secondary)
            Button {
                self.model.openAgent()
            } label: {
                Label {
                    Text("Open Chat")
                        .font(OpenClawType.subheadSemiBold)
                } icon: {
                    Image(systemName: "bubble.left.and.bubble.right.fill")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("settings-system-agent-open-chat")
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 12)
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            Group {
                if self.model.expectsSensitiveReply {
                    ZStack(alignment: .leading) {
                        SecureField("", text: self.$model.input)
                            .font(OpenClawType.body)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityLabel("Enter secret")
                        if self.model.input.isEmpty {
                            Text("Enter secret…")
                                .font(OpenClawType.body)
                                .foregroundStyle(.tertiary)
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                        }
                    }
                } else {
                    TextField(text: self.$model.input, axis: .vertical) {
                        Text("Reply to OpenClaw…")
                            .font(OpenClawType.body)
                    }
                    .font(OpenClawType.body)
                    .lineLimit(1...5)
                }
            }
            .textFieldStyle(.roundedBorder)
            .onSubmit { self.model.send() }
            .disabled(self.model.errorMessage != nil || self.model.isSending)

            Button {
                self.model.send()
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 28, weight: .semibold))
            }
            .buttonStyle(.plain)
            .disabled(
                self.model.isSending ||
                    self.model.errorMessage != nil ||
                    self.model.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Send reply")
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 12)
    }

    private func isCurrentSystemAgentSupportCheck(_ checkID: UUID, gatewayID: String?) -> Bool {
        self.isScreenActive &&
            self.scenePhase == .active &&
            self.systemAgentSupportCheckID == checkID &&
            self.appModel.connectedGatewayID == gatewayID
    }

    private func cancelSystemAgentSupportRetry() {
        self.systemAgentSupportRetryTask?.cancel()
        self.systemAgentSupportRetryTask = nil
    }

    private func enterCheckingSystemAgentSupport(gatewayID: String?) {
        self.model.clearSystemAgentMethodSupport()
        self.model.updateAccess(
            connected: self.appModel.isOperatorGatewayConnected,
            hasAdminScope: self.appModel.hasOperatorAdminScope,
            supportsSystemAgent: nil,
            routeIdentity: gatewayID)
    }

    private func retrySystemAgentSupportCheck(_ checkID: UUID, gatewayID: String?) {
        self.cancelSystemAgentSupportRetry()
        self.systemAgentSupportRetryTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled,
                  self.isScreenActive,
                  self.scenePhase == .active,
                  self.isCurrentSystemAgentSupportCheck(checkID, gatewayID: gatewayID)
            else { return }
            self.systemAgentSupportRetryTask = nil
            await self.refreshSystemAgentSupportAndStart()
        }
    }

    private func refreshSystemAgentSupportAndStart(forceRefresh: Bool = false) async {
        guard self.isScreenActive, self.scenePhase == .active else { return }
        let checkID = UUID()
        self.systemAgentSupportCheckID = checkID
        let gatewayID = self.appModel.connectedGatewayID
        let connected = self.appModel.isOperatorGatewayConnected
        let hasAdminScope = self.appModel.hasOperatorAdminScope
        let isFixture = self.appModel.isScreenshotFixtureModeEnabled

        if forceRefresh || !connected || !hasAdminScope || !self.model.matchesGatewayIdentity(gatewayID) {
            self.enterCheckingSystemAgentSupport(gatewayID: gatewayID)
        }

        guard connected, hasAdminScope else { return }
        if isFixture {
            self.model.updateAccess(
                connected: connected,
                hasAdminScope: hasAdminScope,
                supportsSystemAgent: true,
                routeIdentity: gatewayID)
            self.model.startIfNeeded()
            return
        }

        guard let route = await self.appModel.operatorSession.currentRoute(ifGatewayID: gatewayID) else {
            guard self.isCurrentSystemAgentSupportCheck(checkID, gatewayID: gatewayID) else { return }
            self.enterCheckingSystemAgentSupport(gatewayID: gatewayID)
            self.retrySystemAgentSupportCheck(checkID, gatewayID: gatewayID)
            return
        }
        guard self.isCurrentSystemAgentSupportCheck(checkID, gatewayID: gatewayID) else { return }

        if !forceRefresh,
           let support = self.model.cachedSystemAgentMethodSupport(gatewayID: gatewayID, route: route)
        {
            self.model.updateAccess(
                connected: connected,
                hasAdminScope: hasAdminScope,
                supportsSystemAgent: support,
                routeIdentity: gatewayID)
            self.model.startIfNeeded()
            return
        }

        self.enterCheckingSystemAgentSupport(gatewayID: gatewayID)
        let support = await self.appModel.operatorSession.supportsServerMethod(
            "openclaw.chat",
            ifCurrentRoute: route)
        guard self.isCurrentSystemAgentSupportCheck(checkID, gatewayID: gatewayID) else { return }
        guard let currentRoute = await self.appModel.operatorSession.currentRoute(ifGatewayID: gatewayID) else {
            guard self.isCurrentSystemAgentSupportCheck(checkID, gatewayID: gatewayID) else { return }
            self.enterCheckingSystemAgentSupport(gatewayID: gatewayID)
            self.retrySystemAgentSupportCheck(checkID, gatewayID: gatewayID)
            return
        }
        guard self.isCurrentSystemAgentSupportCheck(checkID, gatewayID: gatewayID) else { return }
        guard currentRoute == route else {
            self.enterCheckingSystemAgentSupport(gatewayID: gatewayID)
            self.retrySystemAgentSupportCheck(checkID, gatewayID: gatewayID)
            return
        }
        guard let support else {
            self.retrySystemAgentSupportCheck(checkID, gatewayID: gatewayID)
            return
        }
        self.model.cacheSystemAgentMethodSupport(gatewayID: gatewayID, route: route, value: support)
        self.model.updateAccess(
            connected: self.appModel.isOperatorGatewayConnected,
            hasAdminScope: self.appModel.hasOperatorAdminScope,
            supportsSystemAgent: support,
            routeIdentity: gatewayID)
        self.model.startIfNeeded()
    }
}

private struct IOSSystemAgentQuestionCard: View {
    let question: SystemAgentChatQuestion
    let isEnabled: Bool
    let onSelect: (SystemAgentChatQuestion.Option) -> Void
    let onSkip: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(self.question.header.uppercased())
                .font(OpenClawType.caption2SemiBold)
                .foregroundStyle(OpenClawBrand.accent)
            Text(self.question.question)
                .font(OpenClawType.subheadSemiBold)
            ForEach(self.question.options, id: \.label) { option in
                self.optionButton(option)
            }
            Button(action: self.onSkip) {
                Text("Skip for now")
                    .font(OpenClawType.captionSemiBold)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .disabled(!self.isEnabled)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color(uiColor: .secondarySystemGroupedBackground)))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.secondary.opacity(0.16)))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(self.question.question)
    }

    private func optionButton(_ option: SystemAgentChatQuestion.Option) -> some View {
        Button {
            self.onSelect(option)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(option.label)
                        .font(OpenClawType.subheadSemiBold)
                        .foregroundStyle(.primary)
                    if let description = option.description {
                        Text(description)
                            .font(OpenClawType.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                if option.recommended {
                    Text("Recommended")
                        .font(OpenClawType.caption2SemiBold)
                        .foregroundStyle(OpenClawBrand.accent)
                }
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(option.recommended
                        ? OpenClawBrand.accent.opacity(0.12)
                        : Color(uiColor: .tertiarySystemGroupedBackground)))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(option.recommended
                        ? OpenClawBrand.accent.opacity(0.55)
                        : Color.secondary.opacity(0.12)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!self.isEnabled)
    }
}

private struct IOSSystemAgentChatBubble: View {
    let message: IOSSystemAgentChatModel.Message

    var body: some View {
        HStack {
            if self.message.role == .user {
                Spacer(minLength: 44)
            }
            Text(self.message.text)
                .font(OpenClawType.body)
                .textSelection(.enabled)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(
                    RoundedRectangle(cornerRadius: 13, style: .continuous)
                        .fill(self.message.role == .user
                            ? OpenClawBrand.accent.opacity(0.18)
                            : Color(uiColor: .secondarySystemGroupedBackground)))
            if self.message.role == .assistant {
                Spacer(minLength: 44)
            }
        }
    }
}
