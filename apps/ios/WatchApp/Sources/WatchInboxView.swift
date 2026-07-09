import SwiftUI
import WatchKit

struct WatchInboxView: View {
    var store: WatchInboxStore
    var directNode: WatchDirectNode
    var onAction: ((WatchPromptAction) -> Void)?
    var onExecApprovalDecision: ((String, String?, WatchExecApprovalDecision) -> Void)?
    var onRefreshExecApprovalReview: (() -> Void)?
    var onRefreshAppSnapshot: (() -> Void)?
    var onAppCommand: ((WatchAppCommand) -> Void)?
    var onSendChatMessage: ((String) -> String?)?

    var body: some View {
        NavigationStack {
            WatchControlSurfaceView(
                store: self.store,
                directNode: self.directNode,
                onAction: self.onAction,
                onExecApprovalDecision: self.onExecApprovalDecision,
                onRefreshExecApprovalReview: self.onRefreshExecApprovalReview,
                onRefreshAppSnapshot: self.onRefreshAppSnapshot,
                onAppCommand: self.onAppCommand,
                onSendChatMessage: self.onSendChatMessage)
                .toolbar(.hidden, for: .navigationBar)
        }
    }
}

private struct WatchControlSurfaceView: View {
    var store: WatchInboxStore
    var directNode: WatchDirectNode
    var onAction: ((WatchPromptAction) -> Void)?
    var onExecApprovalDecision: ((String, String?, WatchExecApprovalDecision) -> Void)?
    var onRefreshExecApprovalReview: (() -> Void)?
    var onRefreshAppSnapshot: (() -> Void)?
    var onAppCommand: ((WatchAppCommand) -> Void)?
    var onSendChatMessage: ((String) -> String?)?
    @State private var selectedFace = 0

    var body: some View {
        TabView(selection: self.$selectedFace) {
            self.nowFace
                .tag(0)
            self.stackFace
                .tag(1)
            self.approvalsFace
                .tag(2)
            self.connectionFace
                .tag(3)
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .background(WatchClawStyle.background.ignoresSafeArea())
        .navigationTitle("")
    }

    private var faceCount: Int {
        4
    }

    private var pageRail: some View {
        WatchPageRail(selectedIndex: self.selectedFace, pageCount: self.faceCount)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.bottom, -5)
            .allowsHitTesting(false)
    }

    private var avatarImageSource: String? {
        WatchAvatarSource.normalized(self.store.appSnapshot?.agentAvatarURL)
    }

    private var avatarText: String? {
        WatchAvatarSource.normalized(self.store.appSnapshot?.agentAvatarText)
    }

    private var nowFace: some View {
        WatchFaceScroll {
            self.pageRail
            WatchFaceHeader(
                section: "Now",
                title: self.greetingText,
                subtitle: self.connectionLine,
                isOnline: self.store.appSnapshot?.gatewayConnected == true,
                avatarImageSource: self.avatarImageSource,
                avatarText: self.avatarText)

            NavigationLink {
                self.primaryDestination
            } label: {
                WatchHeroCard(
                    label: self.primaryLabel,
                    title: self.primaryTitle,
                    subtitle: self.primarySubtitle,
                    accessory: self.store.talkSummaryText)
            }
            .buttonStyle(.plain)

            NavigationLink {
                self.chatTimelineDestination
            } label: {
                WatchPrimaryLabel(title: "Talk to Claw")
            }
            .buttonStyle(.plain)

            if self.chatCount > 0 || self.approvalCount > 0 {
                WatchCompactStatusStrip(
                    inboxCount: self.chatCountText,
                    approvalCount: self.approvalCountText,
                    status: self.statusLine)
            }
        }
    }

    private var stackFace: some View {
        WatchFaceScroll {
            self.pageRail
            WatchFaceHeader(
                section: "Inbox",
                title: "What needs you",
                subtitle: self.inboxSubtitle,
                isOnline: self.chatCount > 0 || self.approvalCount > 0,
                avatarImageSource: self.avatarImageSource,
                avatarText: self.avatarText)

            if self.inboxHasItems {
                if self.approvalCount > 0 {
                    self.inboxApprovalsLink
                    self.inboxChatLink
                } else {
                    self.inboxChatLink
                    self.inboxApprovalsLink
                }
                self.inboxPromptBlock
            } else {
                WatchHeroCard(
                    label: "Clear",
                    title: "Caught up",
                    subtitle: self.store.hasAppSnapshot ? "No chats or approvals need you" : "Waiting for iPhone sync",
                    accessory: "Ready")
            }

            Button {
                self.onAppCommand?(.openChat)
            } label: {
                WatchSecondaryLabel(title: "Continue on iPhone")
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder private var inboxChatLink: some View {
        if self.chatCount > 0 {
            NavigationLink {
                self.chatTimelineDestination
            } label: {
                WatchStackCard(
                    label: "Chat",
                    title: self.chatPreviewTitle,
                    subtitle: self.chatPreviewSubtitle,
                    badge: "\(self.chatCount)",
                    isProminent: self.approvalCount == 0)
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder private var inboxApprovalsLink: some View {
        if self.approvalCount > 0 {
            NavigationLink {
                WatchExecApprovalListView(store: self.store, onDecision: self.onExecApprovalDecision)
            } label: {
                WatchStackCard(
                    label: "Approvals",
                    title: self.approvalHeadline,
                    subtitle: self.approvalSubtitle,
                    badge: "\(self.approvalCount)",
                    isProminent: true)
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder private var inboxPromptBlock: some View {
        if self.store.hasMessagePrompt {
            WatchHeroCard(
                label: self.store.kind ?? "Latest",
                title: self.store.title,
                subtitle: self.store.body,
                accessory: self.updatedText)

            if let details = promptDetails {
                WatchDetailText(text: details)
            }

            ForEach(self.store.actions) { action in
                WatchActionCard(
                    title: action.label,
                    subtitle: self.actionSubtitle(action))
                {
                    self.onAction?(action)
                }
                .disabled(self.store.isReplySending)
            }

            if let replyStatusText = store.replyStatusText, !replyStatusText.isEmpty {
                WatchTinyStatus(text: replyStatusText)
            }
        }
    }

    private var promptDetails: String? {
        let details = self.store.details?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return details.isEmpty ? nil : details
    }

    private var inboxHasItems: Bool {
        self.chatCount > 0 || self.approvalCount > 0 || self.store.hasMessagePrompt
    }

    private var inboxSubtitle: String {
        if self.approvalCount > 0 {
            return "Approval waiting"
        }
        if self.chatCount > 0 {
            return self.chatStatusText
        }
        if self.store.hasMessagePrompt {
            return self.store.kind ?? "Latest update"
        }
        return self.store.hasAppSnapshot ? "Nothing waiting" : "Waiting for iPhone"
    }

    private var approvalsFace: some View {
        WatchFaceScroll {
            self.pageRail
            WatchFaceHeader(
                section: "Approvals",
                title: self.approvalHeadline,
                subtitle: self.approvalHeaderSubtitle,
                isOnline: self.approvalCount > 0,
                avatarImageSource: self.avatarImageSource,
                avatarText: self.avatarText)

            if let record = self.store.activeExecApproval {
                WatchHeroCard(
                    label: "Approval needed",
                    title: record.approval.commandPreview ?? record.approval.commandText,
                    subtitle: self.approvalDecisionSubtitle(record),
                    accessory: self.approvalAccessory(record))

                if record.isResolving {
                    WatchTinyStatus(text: record.statusText ?? "Sending decision...")
                } else {
                    HStack(spacing: 8) {
                        if record.approval.allowedDecisions.contains(.allowOnce) {
                            WatchDecisionButton(title: "Approve", color: .green) {
                                self.onExecApprovalDecision?(
                                    record.id,
                                    record.approval.gatewayStableID,
                                    .allowOnce)
                            }
                        }

                        if record.approval.allowedDecisions.contains(.deny) {
                            WatchDecisionButton(title: "Deny", color: WatchClawStyle.accent) {
                                self.onExecApprovalDecision?(
                                    record.id,
                                    record.approval.gatewayStableID,
                                    .deny)
                            }
                        }
                    }
                }

                if let statusText = record.statusText, !statusText.isEmpty, !record.isResolving {
                    WatchTinyStatus(text: statusText)
                }
            } else {
                WatchHeroCard(
                    label: "Clear",
                    title: "No approvals waiting",
                    subtitle: self.store.lastExecApprovalOutcomeText ?? "You are caught up",
                    accessory: "Ready")

                if self.store.shouldShowExecApprovalReviewStatus {
                    WatchSecondaryButton(title: "Review again") {
                        self.onRefreshExecApprovalReview?()
                    }
                }
            }

            if self.approvalCount > 1 {
                NavigationLink {
                    WatchExecApprovalListView(store: self.store, onDecision: self.onExecApprovalDecision)
                } label: {
                    WatchSecondaryLabel(title: "Open all approvals")
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var connectionFace: some View {
        WatchFaceScroll {
            self.pageRail
            WatchFaceHeader(
                section: "Connection",
                title: self.directNode.isConnected ? "Watch node online" : "Direct Gateway",
                subtitle: self.directNode.statusText,
                isOnline: self.directNode.isConnected,
                avatarImageSource: self.avatarImageSource,
                avatarText: self.avatarText)

            WatchHeroCard(
                label: self.directNode.isConnected ? "Direct" : "Setup",
                title: self.directNode.endpointText ?? "Enable from iPhone",
                subtitle: self.directNode.isConfigured
                    ? "Uses Wi-Fi or cellular while OpenClaw is active"
                    : "Open iPhone Settings → Apple Watch",
                accessory: self.directNode.isConnected ? "Online" : "Offline")

            WatchDetailText(
                text: "Direct mode supports device info, status, and notifications. Chat, Talk, and approvals still use the iPhone.")

            if self.directNode.isConfigured {
                Toggle(isOn: Binding(
                    get: { self.directNode.isEnabled },
                    set: { self.directNode.setEnabled($0) }))
                {
                    Text("Direct connection")
                        .font(WatchClawType.body(size: 13))
                }
                .tint(WatchClawStyle.accent)
                .padding(.horizontal, 8)

                WatchSecondaryButton(title: "Forget direct setup") {
                    self.directNode.forget()
                }
            } else {
                WatchDetailText(
                    text: "The iPhone securely sends a one-time setup code. Existing relay features stay available.")
            }
        }
    }

    private var chatItems: [WatchChatItem] {
        self.store.appSnapshot?.chatItems ?? []
    }

    private var chatTimelineDestination: some View {
        WatchChatTimelineView(
            items: self.chatItems,
            statusText: self.chatStatusText,
            sendStatusText: self.chatSendStatusText,
            avatarImageSource: self.avatarImageSource,
            avatarText: self.avatarText,
            completedChatCommandId: self.store.chatCompletion?.commandId,
            completedChatReplyText: self.store.chatCompletion?.replyText,
            onRefresh: self.onRefreshAppSnapshot,
            onSendMessage: self.onSendChatMessage)
    }

    @ViewBuilder private var primaryDestination: some View {
        if let record = store.activeExecApproval {
            WatchExecApprovalDetailView(
                store: self.store,
                record: record,
                onDecision: self.onExecApprovalDecision)
        } else {
            self.chatTimelineDestination
        }
    }

    private var chatCount: Int {
        self.chatItems.count
    }

    private var approvalCount: Int {
        max(self.store.sortedExecApprovals.count, self.store.appSnapshot?.pendingApprovalCount ?? 0)
    }

    private var chatCountText: String {
        self.chatCount == 0 ? "0" : "\(self.chatCount)"
    }

    private var approvalCountText: String {
        self.approvalCount == 0 ? "0" : "\(self.approvalCount)"
    }

    private var connectionLine: String {
        if let snapshot = store.appSnapshot {
            return snapshot.gatewayConnected ? "AI agent online" : "Reconnect on iPhone"
        }
        return "Pair iPhone"
    }

    private var primaryLabel: String {
        if self.store.activeExecApproval != nil { return "Next up" }
        return self.store.appSnapshot?.gatewayConnected == true ? "Running" : "Pairing"
    }

    private var primaryTitle: String {
        if let record = store.activeExecApproval {
            return record.approval.commandPreview ?? record.approval.commandText
        }
        if self.chatCount > 0 {
            return self.chatItems.last?.text ?? self.store.gatewaySummaryText
        }
        return self.store.gatewaySummaryText
    }

    private var primarySubtitle: String {
        if self.store.activeExecApproval != nil {
            return "Approval waiting on your wrist"
        }
        if self.chatCount > 0 {
            return self.chatStatusText
        }
        return self.store.hasAppSnapshot ? "Ready for quick actions" : "Waiting for iPhone sync"
    }

    private var approvalHeadline: String {
        self.approvalCount == 1 ? "1 approval waiting" : "\(self.approvalCount) approvals"
    }

    private var approvalSubtitle: String {
        guard let record = store.activeExecApproval else { return "No approvals waiting" }
        return record.approval.commandPreview ?? record.approval.commandText
    }

    private var approvalHeaderSubtitle: String {
        self.approvalCount > 0 ? "Decide from watch" : "No approvals"
    }

    private func approvalDecisionSubtitle(_ record: WatchExecApprovalRecord) -> String {
        var parts: [String] = []
        if let expiresText = expiryText(record.approval.expiresAtMs) {
            parts.append("Expires in \(expiresText)")
        }
        if let host = record.approval.host, !host.isEmpty {
            parts.append(host)
        }
        if parts.isEmpty {
            parts.append("Review before it runs")
        }
        return parts.joined(separator: " · ")
    }

    private func approvalAccessory(_ record: WatchExecApprovalRecord) -> String {
        if record.isResolving {
            return "Sending"
        }
        if let risk = approvalRiskText(record.approval.risk) {
            return risk
        }
        return "Review"
    }

    private func approvalRiskText(_ risk: WatchRiskLevel?) -> String? {
        switch risk {
        case .high:
            "High risk"
        case .medium:
            "Medium risk"
        case .low:
            "Low risk"
        case nil:
            nil
        }
    }

    private var chatPreviewTitle: String {
        guard let item = chatItems.last else { return "No chat synced" }
        return self.roleTitle(item.role)
    }

    private var chatPreviewSubtitle: String {
        self.chatItems.last?.text ?? self.chatStatusText
    }

    private var chatStatusText: String {
        if let status = store.appSnapshot?.chatStatusText, !status.isEmpty {
            return status
        }
        if self.chatCount > 0 {
            return self.chatCount == 1 ? "1 recent message" : "\(self.chatCount) recent messages"
        }
        return self.store.hasAppSnapshot ? "No messages synced" : "Waiting for iPhone"
    }

    private var chatSendStatusText: String? {
        guard let status = store.appCommandStatusText, status.hasPrefix("Chat:") else {
            return nil
        }
        return status
    }

    private var greetingText: String {
        if let greetingTextOverride = store.greetingTextOverride {
            return greetingTextOverride
        }
        let hour = Calendar.current.component(.hour, from: Date())
        if hour < 12 { return "Good morning" }
        if hour < 18 { return "Good afternoon" }
        return "Good evening"
    }

    private var statusLine: String {
        if let status = store.appSnapshotStatusText, !status.isEmpty {
            return status
        }
        if let commandStatus = store.appCommandStatusText, !commandStatus.isEmpty {
            return commandStatus
        }
        if let replyStatus = store.replyStatusText, !replyStatus.isEmpty {
            return replyStatus
        }
        return self.store.hasAppSnapshot ? "Synced" : "Waiting for iPhone"
    }

    private var updatedText: String {
        guard let updatedAt = store.updatedAt else { return "Just now" }
        return updatedAt.formatted(date: .omitted, time: .shortened)
    }

    private func roleTitle(_ role: String) -> String {
        switch role.lowercased() {
        case "user":
            "You"
        case "system":
            "System"
        default:
            "OpenClaw"
        }
    }

    private func actionSubtitle(_ action: WatchPromptAction) -> String {
        switch action.style?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "destructive":
            "Requires confirmation"
        case "cancel":
            "Dismiss this update"
        default:
            "Send from watch"
        }
    }

    private func expiryText(_ expiresAtMs: Int64?) -> String? {
        guard let expiresAtMs else { return nil }
        let deltaSeconds = max(0, (expiresAtMs - Int64(Date().timeIntervalSince1970 * 1000)) / 1000)
        if deltaSeconds < 60 {
            return "<1m"
        }
        return "\(deltaSeconds / 60)m"
    }
}

private enum WatchClawStyle {
    static let accent = Color(red: 1.0, green: 0.2, blue: 0.22)
    static let background = Color(red: 0.015, green: 0.015, blue: 0.02)
    static let surface = Color.white.opacity(0.075)
    static let raised = Color.white.opacity(0.115)
    static let border = Color.white.opacity(0.10)
    static let hotGradient = LinearGradient(
        colors: [Self.accent, Color(red: 0.78, green: 0.05, blue: 0.08)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing)
}

private struct WatchFaceScroll<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                self.content
            }
            .padding(.horizontal, 8)
            .padding(.top, 0)
            .padding(.bottom, 40)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .background(WatchClawStyle.background.ignoresSafeArea())
        .scrollIndicators(.hidden)
    }
}

private enum WatchAvatarSource {
    static func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    static func dataImage(from source: String?) -> UIImage? {
        guard let source = normalized(source),
              source.lowercased().hasPrefix("data:image/"),
              let commaIndex = source.firstIndex(of: ",")
        else {
            return nil
        }
        let header = source[..<commaIndex].lowercased()
        guard header.contains(";base64") else { return nil }
        let base64 = String(source[source.index(after: commaIndex)...])
        guard let data = Data(base64Encoded: base64) else { return nil }
        return UIImage(data: data)
    }

    static func remoteURL(from source: String?) -> URL? {
        guard let source = normalized(source),
              let url = URL(string: source),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http"
        else {
            return nil
        }
        return url
    }
}

private struct WatchClawAvatar: View {
    var size: CGFloat
    var imageSource: String?
    var text: String?
    @State private var dataImage: UIImage?

    var body: some View {
        ZStack {
            Circle()
                .fill(Color.black.opacity(0.30))
            self.avatarContent
                .padding(self.contentPadding)
        }
        .frame(width: self.size, height: self.size)
        .clipShape(Circle())
        .overlay {
            Circle()
                .strokeBorder(WatchClawStyle.accent.opacity(0.32), lineWidth: 1)
        }
        .shadow(color: WatchClawStyle.accent.opacity(0.30), radius: 5, y: 2)
        .task(id: WatchAvatarSource.normalized(self.imageSource)) {
            self.dataImage = WatchAvatarSource.dataImage(from: self.imageSource)
        }
    }

    @ViewBuilder private var avatarContent: some View {
        if let image = dataImage {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
        } else if let url = WatchAvatarSource.remoteURL(from: imageSource) {
            AsyncImage(url: url) { phase in
                switch phase {
                case let .success(image):
                    image
                        .resizable()
                        .scaledToFill()
                default:
                    self.fallbackContent
                }
            }
        } else {
            self.fallbackContent
        }
    }

    @ViewBuilder private var fallbackContent: some View {
        if let text = WatchAvatarSource.normalized(text) {
            Text(String(text.prefix(3)))
                .font(WatchClawType.avatar(size: self.size * 0.42))
                .foregroundStyle(.white)
                .minimumScaleFactor(0.6)
                .lineLimit(1)
        } else {
            Image("OpenClawIcon")
                .resizable()
                .scaledToFit()
        }
    }

    private var contentPadding: CGFloat {
        WatchAvatarSource.normalized(self.imageSource) == nil ? self.size * 0.04 : 0
    }
}

private struct WatchFaceHeader: View {
    let section: String
    let title: String
    let subtitle: String
    let isOnline: Bool
    var avatarImageSource: String?
    var avatarText: String?

    var body: some View {
        HStack(alignment: .center, spacing: 7) {
            WatchClawAvatar(
                size: 23,
                imageSource: self.avatarImageSource,
                text: self.avatarText)
            VStack(alignment: .leading, spacing: 1) {
                Text(self.section)
                    .font(WatchClawType.label(size: 10, weight: .bold))
                    .foregroundStyle(WatchClawStyle.accent)
                    .lineLimit(1)
                Text(self.title)
                    .font(WatchClawType.title(size: 18))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Text(self.subtitle)
                    .font(WatchClawType.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }
}

private struct WatchHeroCard: View {
    let label: String
    let title: String
    let subtitle: String
    let accessory: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center) {
                Text(self.label)
                    .font(WatchClawType.label(size: 10, weight: .bold))
                    .foregroundStyle(WatchClawStyle.accent)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(self.accessory)
                    .font(WatchClawType.label(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Text(self.title)
                .font(WatchClawType.title(size: 19))
                .lineLimit(3)
                .minimumScaleFactor(0.75)
            Text(self.subtitle)
                .font(WatchClawType.body(size: 13))
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 17, style: .continuous)
                .fill(WatchClawStyle.raised)
                .overlay {
                    RoundedRectangle(cornerRadius: 17, style: .continuous)
                        .strokeBorder(WatchClawStyle.border, lineWidth: 1)
                }
        }
    }
}

private struct WatchDetailText: View {
    let text: String

    var body: some View {
        Text(self.text)
            .font(WatchClawType.body(size: 12))
            .foregroundStyle(.secondary)
            .lineLimit(5)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.white.opacity(0.055))
            }
    }
}

private struct WatchCompactStatusStrip: View {
    let inboxCount: String
    let approvalCount: String
    let status: String

    var body: some View {
        HStack(spacing: 5) {
            WatchCompactMetric(label: "Inbox", value: self.inboxCount)
            WatchCompactMetric(label: "Approvals", value: self.approvalCount)
            Text(self.status)
                .font(WatchClawType.label(size: 10, weight: .medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background {
            Capsule(style: .continuous)
                .fill(Color.white.opacity(0.06))
        }
    }
}

private struct WatchCompactMetric: View {
    let label: String
    let value: String

    var body: some View {
        HStack(spacing: 3) {
            Text(self.label)
                .font(WatchClawType.label(size: 9, weight: .semibold))
                .foregroundStyle(.secondary)
            Text(self.value)
                .font(WatchClawType.label(size: 10, weight: .bold))
        }
        .lineLimit(1)
    }
}

private struct WatchPrimaryLabel: View {
    let title: LocalizedStringKey

    var body: some View {
        HStack(spacing: 7) {
            WatchVoiceGlyph()
            Text(self.title)
                .font(WatchClawType.captionBold)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 7)
        .background {
            Capsule(style: .continuous)
                .fill(WatchClawStyle.hotGradient)
        }
    }
}

private struct WatchVoiceGlyph: View {
    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach([7.0, 13.0, 18.0, 12.0, 8.0], id: \.self) { height in
                Capsule(style: .continuous)
                    .fill(.white.opacity(0.82))
                    .frame(width: 2, height: height)
            }
        }
        .frame(width: 20, height: 20)
    }
}

private struct WatchPageRail: View {
    let selectedIndex: Int
    let pageCount: Int

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<max(self.pageCount, 1), id: \.self) { index in
                Capsule(style: .continuous)
                    .fill(index == self.selectedIndex ? WatchClawStyle.accent : Color.white.opacity(0.20))
                    .frame(width: index == self.selectedIndex ? 13 : 4, height: 4)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 1)
    }
}

private struct WatchSecondaryLabel: View {
    let title: LocalizedStringKey

    var body: some View {
        Text(self.title)
            .font(WatchClawType.captionSemiBold)
            .lineLimit(1)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background {
                Capsule(style: .continuous)
                    .fill(Color.white.opacity(0.08))
                    .overlay {
                        Capsule(style: .continuous)
                            .strokeBorder(WatchClawStyle.border, lineWidth: 1)
                    }
            }
    }
}

private struct WatchSecondaryButton: View {
    let title: LocalizedStringKey
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            WatchSecondaryLabel(title: self.title)
        }
        .buttonStyle(.plain)
    }
}

private struct WatchStackCard: View {
    let label: String
    let title: String
    let subtitle: String
    let badge: String?
    var isProminent = false

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(self.label)
                    .font(WatchClawType.label(size: 10, weight: .bold))
                    .foregroundStyle(WatchClawStyle.accent)
                    .lineLimit(1)
                Text(self.title)
                    .font(WatchClawType.title(size: 17))
                    .lineLimit(1)
                Text(self.subtitle)
                    .font(WatchClawType.body(size: 13))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 2)
            HStack(spacing: 5) {
                if let badge {
                    Text(badge)
                        .font(WatchClawType.label(size: 10, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(minWidth: 18, minHeight: 18)
                        .background {
                            Circle()
                                .fill(WatchClawStyle.accent)
                        }
                }
                Image(systemName: "chevron.right")
                    .font(WatchClawType.symbol(size: 10, weight: .bold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 17, style: .continuous)
                .fill(self.isProminent ? WatchClawStyle.raised : WatchClawStyle.surface)
                .overlay {
                    RoundedRectangle(cornerRadius: 17, style: .continuous)
                        .strokeBorder(WatchClawStyle.border, lineWidth: 1)
                }
        }
    }
}

private struct WatchActionCard: View {
    let title: String
    let subtitle: String
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            WatchStackCard(
                label: "OpenClaw",
                title: self.title,
                subtitle: self.subtitle,
                badge: nil)
        }
        .buttonStyle(.plain)
    }
}

private struct WatchDecisionButton: View {
    let title: LocalizedStringKey
    let color: Color
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            Text(self.title)
                .font(WatchClawType.captionBold)
                .lineLimit(1)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 9)
                .background {
                    Capsule(style: .continuous)
                        .fill(self.color)
                }
        }
        .buttonStyle(.plain)
    }
}

private struct WatchTinyStatus: View {
    let text: String

    var body: some View {
        Text(self.text)
            .font(WatchClawType.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(2)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct WatchChatBubble: View {
    let item: WatchChatItem
    var avatarImageSource: String?
    var avatarText: String?

    var body: some View {
        HStack(alignment: .bottom, spacing: 6) {
            if !self.isUser {
                WatchClawAvatar(
                    size: 18,
                    imageSource: self.avatarImageSource,
                    text: self.avatarText)
            } else {
                Spacer(minLength: 20)
            }

            VStack(alignment: self.isUser ? .trailing : .leading, spacing: 3) {
                Text(self.roleTitle)
                    .font(WatchClawType.label(size: 9, weight: .bold))
                    .foregroundStyle(self.isUser ? .secondary : WatchClawStyle.accent)
                Text(self.item.text)
                    .font(WatchClawType.body(size: 13))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .frame(maxWidth: 132, alignment: self.isUser ? .trailing : .leading)
            .background {
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .fill(self.isUser ? WatchClawStyle.accent.opacity(0.88) : WatchClawStyle.surface)
            }

            if self.isUser {
                WatchMiniUserDot()
            } else {
                Spacer(minLength: 20)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var isUser: Bool {
        self.item.role.lowercased() == "user"
    }

    private var roleTitle: String {
        switch self.item.role.lowercased() {
        case "user":
            "You"
        case "system":
            "System"
        default:
            "OpenClaw"
        }
    }
}

private struct WatchChatTimelineView: View {
    let items: [WatchChatItem]
    let statusText: String
    let sendStatusText: String?
    var avatarImageSource: String?
    var avatarText: String?
    var completedChatCommandId: String?
    var completedChatReplyText: String?
    var onRefresh: (() -> Void)?
    var onSendMessage: ((String) -> String?)?
    @State private var voiceTurnTracker = WatchVoiceTurnTracker()
    @State private var speechPlayback = WatchSpeechPlayback()
    @State private var voiceReplyTimeout: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 7) {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if self.items.isEmpty {
                        WatchChatEmptyState(statusText: self.statusText)
                    } else {
                        ForEach(self.items) { item in
                            WatchChatBubble(
                                item: item,
                                avatarImageSource: self.avatarImageSource,
                                avatarText: self.avatarText)
                        }
                    }

                    if let sendStatusText, !sendStatusText.isEmpty {
                        WatchTinyStatus(text: sendStatusText)
                    }

                    if let voiceStatusText = self.voiceStatusText {
                        VStack(alignment: .leading, spacing: 3) {
                            // Watch TTS runs through AVSpeechSynthesizer, which has no
                            // metering API, so speaking uses the wave's synthetic pulse.
                            TalkWaveformView(
                                phase: self.speechPlayback.isSpeaking ? .speaking(level: nil) : .thinking)
                                .frame(height: 24)
                                .accessibilityHidden(true)
                            WatchTinyStatus(text: voiceStatusText)
                        }
                    }

                    WatchSecondaryButton(title: "Refresh") {
                        self.onRefresh?()
                    }
                }
                .padding(.horizontal, 8)
                .padding(.top, 8)
                .padding(.bottom, 4)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
            .scrollIndicators(.hidden)

            WatchChatComposer(
                onSendMessage: { text in
                    _ = self.sendMessage(text)
                },
                onStartVoiceTurn: {
                    self.startVoiceTurn()
                },
                isAwaitingVoiceReply: self.voiceTurnTracker.isAwaitingReply,
                onCancelVoiceTurn: {
                    self.cancelVoiceTurn()
                },
                isSpeaking: self.speechPlayback.isSpeaking,
                onStopSpeaking: {
                    self.speechPlayback.stop()
                })
                .padding(.horizontal, 7)
                .padding(.bottom, 5)
        }
        .background(WatchClawStyle.background.ignoresSafeArea())
        .navigationTitle("Chat")
        .onChange(of: self.completedChatCommandId) { _, commandId in
            self.handleCompletedVoiceTurn(commandId: commandId)
        }
        .onDisappear {
            self.cancelVoiceTurn()
            self.speechPlayback.stop()
        }
    }

    private func sendMessage(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return self.onSendMessage?(trimmed)
    }

    private var voiceStatusText: String? {
        if self.speechPlayback.isSpeaking {
            return "Speaking reply…"
        }
        if self.voiceTurnTracker.isAwaitingReply {
            return "Waiting for spoken reply…"
        }
        return nil
    }

    private func startVoiceTurn() {
        WatchNativeTextInput.present(suggestions: []) { text in
            guard let commandId = self.sendMessage(text) else { return }
            self.voiceTurnTracker.begin(commandId: commandId)
            self.scheduleVoiceReplyTimeout()
        }
    }

    private func handleCompletedVoiceTurn(commandId: String?) {
        guard let reply = voiceTurnTracker.takeReply(
            completedCommandId: commandId,
            text: completedChatReplyText)
        else {
            return
        }
        self.voiceReplyTimeout?.cancel()
        self.speechPlayback.speak(reply)
    }

    private func cancelVoiceTurn() {
        self.voiceReplyTimeout?.cancel()
        self.voiceTurnTracker.cancel()
    }

    private func scheduleVoiceReplyTimeout() {
        self.voiceReplyTimeout?.cancel()
        self.voiceReplyTimeout = Task { @MainActor in
            try? await Task.sleep(for: .seconds(90))
            guard !Task.isCancelled else { return }
            self.voiceTurnTracker.cancel()
        }
    }
}

private struct WatchChatEmptyState: View {
    let statusText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("No chat synced")
                .font(WatchClawType.title(size: 16))
                .lineLimit(2)
            Text(self.statusText)
                .font(WatchClawType.body(size: 12))
                .foregroundStyle(.secondary)
                .lineLimit(3)
            Text("Tap the message pill below to start from your watch.")
                .font(WatchClawType.body(size: 11, weight: .medium))
                .foregroundStyle(WatchClawStyle.accent)
                .lineLimit(2)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 17, style: .continuous)
                .fill(WatchClawStyle.surface)
                .overlay {
                    RoundedRectangle(cornerRadius: 17, style: .continuous)
                        .strokeBorder(WatchClawStyle.border, lineWidth: 1)
                }
        }
    }
}

private struct WatchMiniUserDot: View {
    var body: some View {
        Text("You")
            .font(WatchClawType.label(size: 8, weight: .bold))
            .foregroundStyle(.white.opacity(0.86))
            .frame(width: 22, height: 18)
            .background {
                Capsule(style: .continuous)
                    .fill(Color.white.opacity(0.10))
            }
    }
}

private struct WatchChatComposer: View {
    let onSendMessage: (String) -> Void
    let onStartVoiceTurn: () -> Void
    let isAwaitingVoiceReply: Bool
    let onCancelVoiceTurn: () -> Void
    let isSpeaking: Bool
    let onStopSpeaking: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Button {
                WatchNativeTextInput.present(
                    suggestions: [],
                    onSubmit: self.onSendMessage)
            } label: {
                HStack(spacing: 5) {
                    Text("Message OpenClaw")
                        .font(WatchClawType.body(size: 12, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Image(systemName: "text.bubble")
                        .font(WatchClawType.symbol(size: 12, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 11)
                .padding(.vertical, 10)
                .background {
                    Capsule(style: .continuous)
                        .fill(Color.white.opacity(0.09))
                        .overlay {
                            Capsule(style: .continuous)
                                .strokeBorder(Color.white.opacity(0.16), lineWidth: 1)
                        }
                }
            }
            .buttonStyle(.plain)
            .disabled(self.isAwaitingVoiceReply)

            Button {
                if self.isSpeaking {
                    self.onStopSpeaking()
                } else if self.isAwaitingVoiceReply {
                    self.onCancelVoiceTurn()
                } else {
                    self.onStartVoiceTurn()
                }
            } label: {
                Group {
                    if self.isSpeaking {
                        Image(systemName: "speaker.slash.fill")
                            .font(WatchClawType.symbol(size: 13, weight: .bold))
                    } else if self.isAwaitingVoiceReply {
                        Image(systemName: "xmark")
                            .font(WatchClawType.symbol(size: 13, weight: .bold))
                    } else {
                        WatchVoiceGlyph()
                    }
                }
                .foregroundStyle(.white)
                .frame(width: 20, height: 20)
                .padding(8)
                .background {
                    Circle()
                        .fill(WatchClawStyle.hotGradient)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(self.voiceButtonAccessibilityLabel)
        }
    }

    private var voiceButtonAccessibilityLabel: String {
        if self.isSpeaking {
            return "Stop speaking"
        }
        if self.isAwaitingVoiceReply {
            return "Cancel voice turn"
        }
        return "Start voice turn"
    }
}

private enum WatchNativeTextInput {
    @MainActor
    static func present(
        suggestions: [String],
        onSubmit: @escaping (String) -> Void)
    {
        WKApplication.shared().visibleInterfaceController?.presentTextInputController(
            withSuggestions: suggestions,
            allowedInputMode: .allowEmoji)
        { results in
            guard let text = results?.compactMap(stringValue).first?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                !text.isEmpty
            else {
                return
            }
            onSubmit(text)
        }
    }

    private static func stringValue(_ result: Any) -> String? {
        if let string = result as? String {
            return string
        }
        if let attributed = result as? NSAttributedString {
            return attributed.string
        }
        return nil
    }
}

private struct WatchExecApprovalListView: View {
    var store: WatchInboxStore
    var onDecision: ((String, String?, WatchExecApprovalDecision) -> Void)?

    var body: some View {
        WatchDetailScroll(title: "Approvals") {
            if self.store.sortedExecApprovals.isEmpty {
                WatchHeroCard(
                    label: "Clear",
                    title: "No approvals waiting",
                    subtitle: self.store.lastExecApprovalOutcomeText ?? "You are caught up",
                    accessory: "Ready")
            } else {
                ForEach(self.store.sortedExecApprovals) { record in
                    NavigationLink {
                        WatchExecApprovalDetailView(
                            store: self.store,
                            record: record,
                            onDecision: self.onDecision)
                    } label: {
                        WatchStackCard(
                            label: "Approval",
                            title: record.approval.commandPreview ?? record.approval.commandText,
                            subtitle: self.metadataLine(for: record),
                            badge: nil)
                    }
                    .buttonStyle(.plain)
                }
            }

            if let outcome = self.store.lastExecApprovalOutcomeText, !outcome.isEmpty {
                WatchTinyStatus(text: outcome)
            }
        }
    }

    private func metadataLine(for record: WatchExecApprovalRecord) -> String {
        var parts: [String] = []
        if let host = record.approval.host, !host.isEmpty {
            parts.append(host)
        }
        if let nodeId = record.approval.nodeId, !nodeId.isEmpty {
            parts.append(nodeId)
        }
        if let expiresText = Self.expiresText(record.approval.expiresAtMs) {
            parts.append(expiresText)
        }
        if let statusText = record.statusText, !statusText.isEmpty {
            parts.append(statusText)
        }
        return parts.isEmpty ? "Pending review" : parts.joined(separator: " · ")
    }

    private static func expiresText(_ expiresAtMs: Int64?) -> String? {
        guard let expiresAtMs else { return nil }
        let deltaSeconds = max(0, (expiresAtMs - Int64(Date().timeIntervalSince1970 * 1000)) / 1000)
        if deltaSeconds < 60 {
            return "Expires in <1m"
        }
        return "Expires in \(deltaSeconds / 60)m"
    }
}

private struct WatchExecApprovalDetailView: View {
    var store: WatchInboxStore
    let record: WatchExecApprovalRecord
    var onDecision: ((String, String?, WatchExecApprovalDecision) -> Void)?

    var body: some View {
        WatchDetailScroll(title: "Approval") {
            WatchHeroCard(
                label: self.riskText(self.currentRecord?.approval.risk ?? self.record.approval.risk) ?? "Review",
                title: self.currentRecord?.approval.commandText ?? self.record.approval.commandText,
                subtitle: self.metadataSummary,
                accessory: Self
                    .expiresText(self.currentRecord?.approval.expiresAtMs ?? self.record.approval.expiresAtMs) ?? "Now")

            if let statusText = self.currentRecord?.statusText, !statusText.isEmpty {
                WatchTinyStatus(text: statusText)
            }

            if let currentRecord {
                if currentRecord.isResolving {
                    WatchTinyStatus(text: "Sending decision...")
                } else {
                    HStack(spacing: 8) {
                        if currentRecord.approval.allowedDecisions.contains(.allowOnce) {
                            WatchDecisionButton(title: "Approve", color: .green) {
                                self.onDecision?(
                                    currentRecord.id,
                                    currentRecord.approval.gatewayStableID,
                                    .allowOnce)
                            }
                        }

                        if currentRecord.approval.allowedDecisions.contains(.deny) {
                            WatchDecisionButton(title: "Deny", color: WatchClawStyle.accent) {
                                self.onDecision?(
                                    currentRecord.id,
                                    currentRecord.approval.gatewayStableID,
                                    .deny)
                            }
                        }
                    }
                }
            }
        }
        .onAppear {
            self.store.selectExecApproval(id: self.record.id)
        }
    }

    private var currentRecord: WatchExecApprovalRecord? {
        self.store.execApprovals.first(where: { $0.id == self.record.id })
    }

    private var metadataSummary: String {
        let approval = self.currentRecord?.approval ?? self.record.approval
        var parts: [String] = []
        if let host = approval.host, !host.isEmpty {
            parts.append(host)
        }
        if let nodeId = approval.nodeId, !nodeId.isEmpty {
            parts.append(nodeId)
        }
        if let agentId = approval.agentId, !agentId.isEmpty {
            parts.append(agentId)
        }
        return parts.isEmpty ? "Tap to decide" : parts.joined(separator: " · ")
    }

    private func riskText(_ risk: WatchRiskLevel?) -> String? {
        switch risk {
        case .high:
            "High risk"
        case .medium:
            "Medium risk"
        case .low:
            "Low risk"
        case nil:
            nil
        }
    }

    private static func expiresText(_ expiresAtMs: Int64?) -> String? {
        guard let expiresAtMs else { return nil }
        let deltaSeconds = max(0, (expiresAtMs - Int64(Date().timeIntervalSince1970 * 1000)) / 1000)
        if deltaSeconds < 60 {
            return "<1 minute"
        }
        return "\(deltaSeconds / 60) minutes"
    }
}

private struct WatchDetailScroll<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 9) {
                self.content
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 9)
            .padding(.bottom, 18)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .background(WatchClawStyle.background.ignoresSafeArea())
        .navigationTitle(self.title)
    }
}
