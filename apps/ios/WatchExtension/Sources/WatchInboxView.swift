import SwiftUI

struct WatchInboxView: View {
    var store: WatchInboxStore
    var onAction: ((WatchPromptAction) -> Void)?
    var onExecApprovalDecision: ((String, WatchExecApprovalDecision) -> Void)?
    var onRefreshExecApprovalReview: (() -> Void)?

    var body: some View {
        NavigationStack {
            if self.store.sortedExecApprovals.count == 1,
               let record = self.store.activeExecApproval
            {
                WatchExecApprovalDetailView(
                    store: self.store,
                    record: record,
                    onDecision: self.onExecApprovalDecision)
            } else if !self.store.sortedExecApprovals.isEmpty {
                WatchExecApprovalListView(
                    store: self.store,
                    onDecision: self.onExecApprovalDecision)
            } else if self.store.shouldShowExecApprovalReviewStatus {
                WatchExecApprovalLoadingView(
                    store: self.store,
                    onRetry: self.onRefreshExecApprovalReview)
            } else {
                WatchGenericInboxView(store: self.store, onAction: self.onAction)
            }
        }
    }
}

private struct WatchExecApprovalLoadingView: View {
    var store: WatchInboxStore
    var onRetry: (() -> Void)?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text("Exec approval")
                    .font(.headline)

                if self.store.isExecApprovalReviewLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                if let statusText = self.store.execApprovalReviewStatusText, !statusText.isEmpty {
                    Text(statusText)
                        .font(.body)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if !self.store.isExecApprovalReviewLoading {
                    Button("Retry") {
                        self.onRetry?()
                    }
                }

                Text("Keep your iPhone nearby and unlocked if review details take a moment to appear.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .navigationTitle("Exec approval")
    }
}

private struct WatchExecApprovalListView: View {
    var store: WatchInboxStore
    var onDecision: ((String, WatchExecApprovalDecision) -> Void)?

    var body: some View {
        List {
            Section("Exec approvals") {
                ForEach(self.store.sortedExecApprovals) { record in
                    NavigationLink {
                        WatchExecApprovalDetailView(
                            store: self.store,
                            record: record,
                            onDecision: self.onDecision)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(record.approval.commandPreview ?? record.approval.commandText)
                                .font(.headline)
                                .lineLimit(2)
                            Text(self.metadataLine(for: record))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                            if let statusText = record.statusText, !statusText.isEmpty {
                                Text(statusText)
                                    .font(.footnote)
                                    .foregroundStyle(record.isResolving ? Color.secondary : Color.red)
                                    .lineLimit(2)
                            }
                        }
                    }
                }
            }

            if let outcome = self.store.lastExecApprovalOutcomeText, !outcome.isEmpty {
                Section("Last result") {
                    Text(outcome)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Approvals")
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
        return parts.isEmpty ? "Pending review" : parts.joined(separator: " · ")
    }

    private static func expiresText(_ expiresAtMs: Int?) -> String? {
        guard let expiresAtMs else { return nil }
        let deltaSeconds = max(0, (expiresAtMs - Int(Date().timeIntervalSince1970 * 1000)) / 1000)
        if deltaSeconds < 60 {
            return "Expires in <1m"
        }
        return "Expires in \(deltaSeconds / 60)m"
    }
}

private struct WatchExecApprovalDetailView: View {
    var store: WatchInboxStore
    let record: WatchExecApprovalRecord
    var onDecision: ((String, WatchExecApprovalDecision) -> Void)?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text(self.record.approval.commandText)
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)

                if let host = self.record.approval.host, !host.isEmpty {
                    self.metadataRow(label: "Host", value: host)
                }
                if let nodeId = self.record.approval.nodeId, !nodeId.isEmpty {
                    self.metadataRow(label: "Node", value: nodeId)
                }
                if let agentId = self.record.approval.agentId, !agentId.isEmpty {
                    self.metadataRow(label: "Agent", value: agentId)
                }
                if let expiresText = Self.expiresText(self.record.approval.expiresAtMs) {
                    self.metadataRow(label: "Expires", value: expiresText)
                }
                if let riskText = self.riskText(self.record.approval.risk) {
                    self.metadataRow(label: "Risk", value: riskText)
                }

                if let statusText = self.currentRecord?.statusText, !statusText.isEmpty {
                    Text(statusText)
                        .font(.footnote)
                        .foregroundStyle((self.currentRecord?.isResolving ?? false) ? Color.secondary : Color.red)
                }

                if let currentRecord,
                   currentRecord.approval.allowedDecisions.contains(.allowOnce)
                {
                    Button("Allow Once") {
                        self.onDecision?(currentRecord.id, .allowOnce)
                    }
                    .disabled(currentRecord.isResolving)
                }

                if let currentRecord,
                   currentRecord.approval.allowedDecisions.contains(.deny)
                {
                    Button(role: .destructive) {
                        self.onDecision?(currentRecord.id, .deny)
                    } label: {
                        Text("Deny")
                            .frame(maxWidth: .infinity)
                    }
                    .disabled(currentRecord.isResolving)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .navigationTitle("Exec approval")
        .onAppear {
            self.store.selectExecApproval(id: self.record.id)
        }
    }

    private var currentRecord: WatchExecApprovalRecord? {
        self.store.execApprovals.first(where: { $0.id == self.record.id })
    }

    private func metadataRow(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func riskText(_ risk: WatchRiskLevel?) -> String? {
        switch risk {
        case .high:
            "High"
        case .medium:
            "Medium"
        case .low:
            "Low"
        case nil:
            nil
        }
    }

    private static func expiresText(_ expiresAtMs: Int?) -> String? {
        guard let expiresAtMs else { return nil }
        let deltaSeconds = max(0, (expiresAtMs - Int(Date().timeIntervalSince1970 * 1000)) / 1000)
        if deltaSeconds < 60 {
            return "<1 minute"
        }
        return "\(deltaSeconds / 60) minutes"
    }
}

private struct WatchGenericInboxView: View {
    var store: WatchInboxStore
    var onAction: ((WatchPromptAction) -> Void)?

    private func role(for action: WatchPromptAction) -> ButtonRole? {
        switch action.style?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "destructive":
            .destructive
        case "cancel":
            .cancel
        default:
            nil
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(self.store.title)
                    .font(.headline)
                    .lineLimit(2)

                Text(self.store.body)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)

                if let details = self.store.details, !details.isEmpty {
                    Text(details)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let outcome = self.store.lastExecApprovalOutcomeText, !outcome.isEmpty {
                    Text(outcome)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if !self.store.actions.isEmpty {
                    ForEach(self.store.actions) { action in
                        Button(role: self.role(for: action)) {
                            self.onAction?(action)
                        } label: {
                            Text(action.label)
                                .frame(maxWidth: .infinity)
                        }
                        .disabled(self.store.isReplySending)
                    }
                }

                if let replyStatusText = self.store.replyStatusText, !replyStatusText.isEmpty {
                    Text(replyStatusText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if let updatedAt = self.store.updatedAt {
                    Text("Updated \(updatedAt.formatted(date: .omitted, time: .shortened))")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .navigationTitle("OpenClaw")
    }
}
