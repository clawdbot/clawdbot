import OpenClawChatUI
import OpenClawKit
import SwiftUI

struct WatchMessageJournalView: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var journal: OpenClawWatchMessageJournal?
    @State private var entries: [OpenClawWatchMessageEntry] = []
    @State private var pendingDiscard: OpenClawWatchMessageEntry?
    @State private var isUpdating = false
    @State private var didLoad = false
    @State private var notice: String?
    @State private var refreshID = 0

    var body: some View {
        Form {
            if let warning = self.appModel.watchChatDeliveryWarning {
                Section {
                    Text(warning)
                        .font(OpenClawType.body)
                        .foregroundStyle(OpenClawBrand.warn)
                }
            }
            if let notice = self.notice {
                Section {
                    Text(notice)
                        .font(OpenClawType.body)
                    Button {
                        self.refreshID &+= 1
                    } label: {
                        Text("Try again")
                            .font(OpenClawType.subheadSemiBold)
                    }
                }
            }
            if !self.didLoad {
                ProgressView()
            } else if self.entries.isEmpty, self.notice == nil {
                Text("No saved Watch messages")
                    .font(OpenClawType.body)
                    .foregroundStyle(.secondary)
            }
            ForEach(self.entries) { entry in
                Section {
                    self.message(entry)
                }
            }
            Section {
                Text(
                    "Dismiss hides cards; receipts still expire after 48 hours. Needs review stays until discarded.")
                    .font(OpenClawType.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Message Delivery")
        .task(id: self.refreshID) { await self.observeMessages() }
        .confirmationDialog(
            "Discard this saved message?",
            isPresented: Binding(
                get: { self.pendingDiscard != nil },
                set: { if !$0 { self.pendingDiscard = nil } }),
            presenting: self.pendingDiscard)
        { entry in
            Button(role: .destructive) {
                Task { await self.remove(entry) }
            } label: {
                Text("Discard")
                    .font(OpenClawType.body)
            }
        } message: { _ in
            Text("This deletes the saved Needs review message from iPhone.")
                .font(OpenClawType.body)
        }
    }

    private func message(_ entry: OpenClawWatchMessageEntry) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(Self.statusTitle(entry))
                .font(OpenClawType.subheadSemiBold)
            if let text = entry.displayText, !text.isEmpty {
                Text(verbatim: text)
                    .font(OpenClawType.body)
                    .lineLimit(8)
                    .textSelection(.enabled)
            }
            if let context = entry.command?.context {
                Text(verbatim: "\(context.agentId) · \(context.sessionKey)")
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
            }
            if let gatewayID = entry.owner?.gatewayStableID {
                Text(verbatim: gatewayID)
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if let explanation = Self.explanation(entry) {
                Text(explanation)
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
            }
            if case let .reply(text) = entry.receipt?.terminal?.outcome {
                DisclosureGroup {
                    Text(verbatim: text)
                        .font(OpenClawType.body)
                        .textSelection(.enabled)
                } label: {
                    Text("Reply")
                        .font(OpenClawType.captionSemiBold)
                }
            }
            HStack {
                if let text = entry.displayText, !text.isEmpty {
                    Button {
                        UIPasteboard.general.string = text
                    } label: {
                        Label("Copy message", systemImage: "doc.on.doc")
                            .font(OpenClawType.captionSemiBold)
                    }
                }
                Spacer()
                if entry.phase == .needsReview {
                    Button(role: .destructive) {
                        self.pendingDiscard = entry
                    } label: {
                        Label("Discard…", systemImage: "trash")
                            .font(OpenClawType.captionSemiBold)
                    }
                    .disabled(self.isUpdating)
                } else if entry.receipt?.terminal != nil {
                    Button {
                        Task { await self.remove(entry) }
                    } label: {
                        Label("Dismiss", systemImage: "xmark")
                            .font(OpenClawType.captionSemiBold)
                    }
                    .disabled(self.isUpdating)
                }
            }
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 4)
    }

    static func statusTitle(_ entry: OpenClawWatchMessageEntry) -> String {
        if let terminal = entry.receipt?.terminal {
            switch terminal.outcome {
            case .reply: return String(localized: "Reply saved")
            case .forwarded: return String(localized: "Forwarded")
            case let .failed(code, _):
                if code == "expired" { return String(localized: "Expired") }
                return entry.acceptedRunID == nil ? String(localized: "Not sent") :
                    String(localized: "Gateway run failed")
            case .uncertain: return String(localized: "Delivery uncertain")
            }
        }
        switch entry.phase {
        case .queued: return String(localized: "Queued on iPhone")
        case .sending: return String(localized: "Sending")
        case .accepted: return String(localized: "Accepted by Gateway")
        case .receiptReady, .received: return String(localized: "Result saved")
        case .needsReview: return String(localized: "Needs review")
        case .tombstone: return String(localized: "Discarded")
        }
    }

    private static func explanation(_ entry: OpenClawWatchMessageEntry) -> String? {
        if entry.phase == .needsReview {
            return String(
                localized: "Saved by an older app; not sent again. Copy it to Chat to send it.")
        }
        switch entry.receipt?.terminal?.outcome {
        case let .failed(_, message), let .uncertain(message): return message
        default: return nil
        }
    }

    private func observeMessages() async {
        self.notice = nil
        self.entries = []
        self.didLoad = false
        do {
            let journal = try await self.appModel.watchMessageJournal()
            try Task.checkCancellation()
            self.journal = journal
            let changes = try await journal.changes()
            for try await entries in changes {
                try Task.checkCancellation()
                self.entries = entries.filter { $0.displayText != nil }
                self.didLoad = true
                self.appModel.clearWatchChatStorageWarning(for: journal)
            }
        } catch let error as OpenClawWatchChatDeliveryError {
            guard !Task.isCancelled else { return }
            self.notice = error.message
        } catch {
            guard !Task.isCancelled else { return }
        }
        guard !Task.isCancelled else { return }
        self.journal = nil
        self.entries = []
        self.didLoad = true
        if self.notice == nil {
            self.notice = String(localized: "Could not load saved Watch messages. Try again after unlocking iPhone.")
        }
    }

    private func remove(_ entry: OpenClawWatchMessageEntry) async {
        guard let journal = self.journal, !self.isUpdating else { return }
        self.isUpdating = true
        defer { self.isUpdating = false }
        do {
            let result = if entry.phase == .needsReview {
                try await journal.discard(id: entry.commandId, exactOwner: entry.owner)
            } else {
                try await journal.dismiss(id: entry.commandId, exactOwner: entry.owner)
            }
            if result == .superseded {
                self.notice = String(localized: "The message changed. Refresh its delivery status before trying again.")
            }
        } catch {
            self
                .notice =
                String(localized: "The message could not be updated. Refresh the delivery status and try again.")
        }
    }
}
