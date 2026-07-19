import Foundation
import Observation
import SwiftUI
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

enum ChatSessionBatchAction: Sendable, Equatable {
    case pin
    case unpin
    case archive
    case delete
}

struct ChatSessionBatchResult: Sendable, Equatable {
    let succeededKeys: [String]
    let errorsByKey: [String: String]
}

enum ChatSessionBatchValidationError: LocalizedError {
    case cannotArchive
    case cannotDelete
    case attachmentOwnerPinned

    var errorDescription: String? {
        switch self {
        case .cannotArchive:
            String(localized: "This session cannot be archived while it is active or running.")
        case .cannotDelete:
            String(localized: "The main session cannot be deleted.")
        case .attachmentOwnerPinned:
            String(localized: "Remove attachments or wait for delivery before archiving or deleting this session.")
        }
    }
}

enum ChatSessionBatchMutationRunner {
    static func run(
        keys: [String],
        maxConcurrent: Int = 4,
        operation: @escaping @Sendable (String) async throws -> Void) async -> ChatSessionBatchResult
    {
        guard !keys.isEmpty else {
            return ChatSessionBatchResult(succeededKeys: [], errorsByKey: [:])
        }
        let limit = max(1, min(maxConcurrent, keys.count))
        var succeeded: [(Int, String)] = []
        var failures: [String: String] = [:]
        await withTaskGroup(of: (Int, String, String?).self) { group in
            var nextIndex = 0
            while nextIndex < limit {
                let index = nextIndex
                let key = keys[index]
                group.addTask {
                    do {
                        try await operation(key)
                        return (index, key, nil)
                    } catch {
                        return (index, key, error.localizedDescription)
                    }
                }
                nextIndex += 1
            }
            while let (index, key, error) = await group.next() {
                if let error {
                    failures[key] = error
                } else {
                    succeeded.append((index, key))
                }
                if nextIndex < keys.count {
                    let pendingIndex = nextIndex
                    let pendingKey = keys[pendingIndex]
                    group.addTask {
                        do {
                            try await operation(pendingKey)
                            return (pendingIndex, pendingKey, nil)
                        } catch {
                            return (pendingIndex, pendingKey, error.localizedDescription)
                        }
                    }
                    nextIndex += 1
                }
            }
        }
        return ChatSessionBatchResult(
            succeededKeys: succeeded.sorted { $0.0 < $1.0 }.map(\.1),
            errorsByKey: failures)
    }
}

struct ChatSessionInspectorDetails: Equatable {
    let title: String
    let key: String
    let kind: String?
    let agentID: String?
    let group: String?
    let runState: String?
    let model: String?
    let provider: String?
    let runtime: String?
    let runDurationMs: Double?
    let worktreeID: String?
    let worktreeBranch: String?
    let worktreeRoot: String?
    let updatedAt: Double?
    let lastActivityAt: Double?
    let lastInteractionAt: Double?
    let startedAt: Double?
    let endedAt: Double?

    init(session: OpenClawChatSessionEntry) {
        self.title = ChatSessionSidebarModel.displayName(for: session)
        self.key = session.key
        self.kind = Self.normalized(session.kind)
        self.agentID = Self.normalized(OpenClawChatSessionKey.agentID(from: session.key))
        self.group = Self.normalized(session.category)
        self.runState = Self.runState(for: session)
        self.model = Self.normalized(session.model)
        self.provider = Self.normalized(session.modelProvider)
        self.runtime = Self.normalized(session.agentRuntime?.id)
        self.runDurationMs = session.runtimeMs
        self.worktreeID = Self.normalized(session.worktree?.id)
        self.worktreeBranch = Self.normalized(session.worktree?.branch)
        self.worktreeRoot = Self.normalized(session.worktree?.repoRoot)
        self.updatedAt = session.updatedAt
        self.lastActivityAt = session.lastActivityAt
        self.lastInteractionAt = session.lastInteractionAt
        self.startedAt = session.startedAt
        self.endedAt = session.endedAt
    }

    private static func normalized(_ value: String?) -> String? {
        let value = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return value?.isEmpty == false ? value : nil
    }

    private static func runState(for session: OpenClawChatSessionEntry) -> String? {
        if session.hasActiveRun == true || session.hasActiveSubagentRun == true {
            return String(localized: "Running")
        }
        return self.normalized(session.status)
    }
}

@MainActor
struct ChatSessionInspectorSheet: View {
    @Bindable var viewModel: OpenClawChatViewModel
    let session: OpenClawChatSessionEntry

    @Environment(\.dismiss) private var dismiss
    @State private var displayedSession: OpenClawChatSessionEntry
    @State private var groups: [OpenClawChatSessionGroup] = []
    @State private var isMutatingGroup = false
    @State private var errorText: String?

    init(viewModel: OpenClawChatViewModel, session: OpenClawChatSessionEntry) {
        self.viewModel = viewModel
        self.session = session
        _displayedSession = State(initialValue: session)
    }

    private var details: ChatSessionInspectorDetails {
        ChatSessionInspectorDetails(session: self.displayedSession)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Identity") {
                    LabeledContent("Name", value: self.details.title)
                    HStack(alignment: .firstTextBaseline) {
                        LabeledContent("Key", value: self.details.key)
                        Button {
                            Self.copy(self.details.key)
                        } label: {
                            Image(systemName: "doc.on.doc")
                        }
                        .buttonStyle(.borderless)
                        .help("Copy session key")
                    }
                    self.optionalRow("Kind", self.details.kind)
                    self.optionalRow("Agent", self.details.agentID)
                }

                Section("Organization") {
                    Picker("Group", selection: self.groupSelection) {
                        Text("None")
                            .font(OpenClawChatTypography.body)
                            .tag("")
                        ForEach(self.groups) { group in
                            Text(verbatim: group.name)
                                .font(OpenClawChatTypography.body)
                                .tag(group.name)
                        }
                    }
                    .disabled(self.isMutatingGroup)
                    Toggle("Pinned", isOn: self.pinnedBinding)
                        .font(OpenClawChatTypography.body)
                    Toggle("Archived", isOn: self.archivedBinding)
                        .font(OpenClawChatTypography.body)
                        .disabled(!self.displayedSession.isArchived && !ChatSessionSidebarModel.canArchiveSession(
                            self.displayedSession,
                            mainSessionKey: self.viewModel.resolvedMainSessionKey))
                }

                Section("Run") {
                    self.optionalRow("Status", self.details.runState)
                    self.optionalRow("Model", self.details.model)
                    self.optionalRow("Provider", self.details.provider)
                    self.optionalRow("Runtime", self.details.runtime)
                    if let duration = self.details.runDurationMs {
                        LabeledContent("Run duration", value: Self.duration(duration))
                    }
                }

                if self.details.worktreeID != nil || self.details.worktreeBranch != nil ||
                    self.details.worktreeRoot != nil
                {
                    Section("Worktree") {
                        self.optionalRow("ID", self.details.worktreeID)
                        self.optionalRow("Branch", self.details.worktreeBranch)
                        self.optionalRow("Repository root", self.details.worktreeRoot)
                    }
                }

                Section("Activity") {
                    self.timestampRow("Updated", self.details.updatedAt)
                    self.timestampRow("Last activity", self.details.lastActivityAt)
                    self.timestampRow("Last interaction", self.details.lastInteractionAt)
                    self.timestampRow("Run started", self.details.startedAt)
                    self.timestampRow("Run ended", self.details.endedAt)
                }

                if let errorText {
                    Section {
                        Text(errorText)
                            .font(OpenClawChatTypography.caption)
                            .foregroundStyle(OpenClawChatTheme.danger)
                    }
                }
            }
            .navigationTitle("Session Info")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { self.dismiss() }
                        .font(OpenClawChatTypography.body)
                }
            }
            // Keyed to the catalog revision so group create/rename/delete while
            // the inspector is open refreshes the picker instead of going stale.
            .task(id: self.viewModel.sessionGroupsRevision) {
                do {
                    self.groups = try await self.viewModel.fetchSessionGroups()
                } catch {
                    self.errorText = error.localizedDescription
                }
            }
            .onChange(of: self.viewModel.sessions) {
                if let refreshed = self.viewModel.sessions.first(where: { $0.key == self.displayedSession.key }) {
                    self.displayedSession = refreshed
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 620)
        #endif
    }

    private var groupSelection: Binding<String> {
        Binding(
            get: { self.displayedSession.category ?? "" },
            set: { next in
                let previous = self.displayedSession.category
                let nextGroup = next.isEmpty ? nil : next
                self.displayedSession.category = nextGroup
                self.isMutatingGroup = true
                Task {
                    defer { self.isMutatingGroup = false }
                    do {
                        try await self.viewModel.setSessionGroup(
                            key: self.displayedSession.key,
                            group: nextGroup)
                        self.errorText = nil
                    } catch {
                        self.displayedSession.category = previous
                        self.errorText = error.localizedDescription
                    }
                }
            })
    }

    private var pinnedBinding: Binding<Bool> {
        Binding(
            get: { self.displayedSession.isPinned },
            set: { pinned in
                self.displayedSession.pinned = pinned
                self.viewModel.setSessionPinned(key: self.displayedSession.key, pinned: pinned)
            })
    }

    private var archivedBinding: Binding<Bool> {
        Binding(
            get: { self.displayedSession.isArchived },
            set: { archived in
                self.displayedSession.archived = archived
                self.viewModel.setSessionArchived(key: self.displayedSession.key, archived: archived)
            })
    }

    @ViewBuilder
    private func optionalRow(_ title: LocalizedStringKey, _ value: String?) -> some View {
        if let value {
            LabeledContent(title, value: value)
        }
    }

    @ViewBuilder
    private func timestampRow(_ title: LocalizedStringKey, _ timestamp: Double?) -> some View {
        if let timestamp, timestamp > 0 {
            LabeledContent(title, value: Date(timeIntervalSince1970: timestamp / 1000).formatted(
                date: .abbreviated,
                time: .standard))
        }
    }

    private static func duration(_ milliseconds: Double) -> String {
        Duration.seconds(milliseconds / 1000).formatted(.units(allowed: [.hours, .minutes, .seconds]))
    }

    private static func copy(_ value: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
        #elseif os(iOS)
        UIPasteboard.general.string = value
        #endif
    }
}

@MainActor
struct ChatSessionGroupsSheet: View {
    @Bindable var viewModel: OpenClawChatViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var groups: [OpenClawChatSessionGroup] = []
    @State private var newGroupName = ""
    @State private var renameTarget: OpenClawChatSessionGroup?
    @State private var renameText = ""
    @State private var deleteTarget: OpenClawChatSessionGroup?
    @State private var routeLease: OpenClawChatSessionGroupsRouteLease?
    @State private var isLoading = true
    @State private var isMutating = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            List {
                Section("Groups") {
                    ForEach(self.groups) { group in
                        HStack {
                            Text(verbatim: group.name)
                                .font(OpenClawChatTypography.body)
                            Spacer()
                            Menu {
                                Button("Rename…") {
                                    self.renameText = group.name
                                    self.renameTarget = group
                                }
                                Button("Delete…", role: .destructive) {
                                    self.deleteTarget = group
                                }
                            } label: {
                                Image(systemName: "ellipsis.circle")
                            }
                            #if os(macOS)
                            .menuStyle(.borderlessButton)
                            #endif
                            .disabled(self.isMutating)
                        }
                    }
                    if self.groups.isEmpty, !self.isLoading {
                        Text("No groups")
                            .font(OpenClawChatTypography.body)
                            .foregroundStyle(.secondary)
                    }
                }
                Section("Create Group") {
                    TextField("Group name", text: self.$newGroupName)
                        .font(OpenClawChatTypography.body)
                        .disabled(self.isMutating)
                    Button("Add Group") {
                        guard !self.isMutating else { return }
                        let name = self.newGroupName
                        self.isMutating = true
                        Task { await self.createGroup(named: name) }
                    }
                    .font(OpenClawChatTypography.body)
                    .disabled(
                        self.isMutating ||
                            self.newGroupName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if let errorText {
                    Section {
                        Text(errorText)
                            .font(OpenClawChatTypography.caption)
                            .foregroundStyle(OpenClawChatTheme.danger)
                    }
                }
            }
            .overlay { if self.isLoading { ProgressView() } }
            .navigationTitle("Session Groups")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { self.dismiss() }
                        .font(OpenClawChatTypography.body)
                }
            }
            // Keyed to the catalog revision so remote group mutations (reason
            // "groups" events) refresh an open manager instead of going stale.
            .task(id: self.viewModel.sessionGroupsRevision) { await self.loadGroups() }
            .alert(
                "Rename Group",
                isPresented: Binding(
                    get: { self.renameTarget != nil },
                    set: { if !$0 { self.renameTarget = nil } }))
            {
                TextField("Group name", text: self.$renameText)
                    .font(OpenClawChatTypography.body)
                Button("Rename") {
                    guard !self.isMutating, let target = self.renameTarget else { return }
                    let name = self.renameText
                    self.isMutating = true
                    Task { await self.renameGroup(target, to: name) }
                }
                .disabled(self.isMutating)
                Button("Cancel", role: .cancel) { self.renameTarget = nil }
            }
            .confirmationDialog(
                    self.deleteTarget.map { String(format: String(localized: "Delete “%@”?"), $0.name) }
                        ?? String(localized: "Delete group?"),
                    isPresented: Binding(
                        get: { self.deleteTarget != nil },
                        set: { if !$0 { self.deleteTarget = nil } }))
            {
                Button("Delete Group", role: .destructive) {
                    guard !self.isMutating, let target = self.deleteTarget else { return }
                    self.isMutating = true
                    Task { await self.deleteGroup(target) }
                }
                .disabled(self.isMutating)
                } message: {
                    Text("Sessions in this group become ungrouped.")
                        .font(OpenClawChatTypography.body)
                }
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 420)
        #endif
    }

    private func loadGroups() async {
        self.isLoading = true
        defer { self.isLoading = false }
        do {
            let routeLease = try await self.viewModel.sessionGroupsRouteLease()
            self.routeLease = routeLease
            self.groups = try await self.viewModel.fetchSessionGroups(using: routeLease)
            self.errorText = nil
        } catch {
            self.routeLease = nil
            self.errorText = error.localizedDescription
        }
    }

    private func createGroup(named name: String) async {
        defer { self.isMutating = false }
        guard let routeLease = self.routeLease else {
            self.errorText = String(localized: "Gateway changed. Close and reopen Groups to continue.")
            return
        }
        do {
            self.groups = try await self.viewModel.createSessionGroup(
                named: name,
                using: routeLease)
            self.newGroupName = ""
            self.errorText = nil
        } catch {
            self.errorText = error.localizedDescription
        }
    }

    private func renameGroup(_ target: OpenClawChatSessionGroup, to name: String) async {
        defer { self.isMutating = false }
        defer { self.renameTarget = nil }
        guard let routeLease = self.routeLease else {
            self.errorText = String(localized: "Gateway changed. Close and reopen Groups to continue.")
            return
        }
        do {
            self.groups = try await self.viewModel.renameSessionGroup(
                target.name,
                to: name,
                using: routeLease)
            self.errorText = nil
        } catch {
            self.errorText = error.localizedDescription
        }
    }

    private func deleteGroup(_ target: OpenClawChatSessionGroup) async {
        defer { self.isMutating = false }
        defer { self.deleteTarget = nil }
        guard let routeLease = self.routeLease else {
            self.errorText = String(localized: "Gateway changed. Close and reopen Groups to continue.")
            return
        }
        do {
            self.groups = try await self.viewModel.deleteSessionGroup(target.name, using: routeLease)
            self.errorText = nil
        } catch {
            self.errorText = error.localizedDescription
        }
    }
}

@MainActor
struct ChatNewSessionOptionsPopover: View {
    @Bindable var viewModel: OpenClawChatViewModel
    let onComplete: () -> Void

    @State private var agents: [OpenClawChatAgentChoice] = []
    @State private var selectedAgentID = ""
    @State private var usesWorktree = false
    @State private var baseRef = ""
    @State private var isLoading = true
    @State private var isCreating = false
    @State private var routeLease: OpenClawChatNewSessionRouteLease?
    @State private var errorText: String?

    private var selectedAgent: OpenClawChatAgentChoice? {
        self.agents.first { $0.id == self.selectedAgentID }
    }

    private func loadOptions() async {
        self.isLoading = true
        self.errorText = nil
        defer { self.isLoading = false }
        do {
            let routeLease = try await self.viewModel.newSessionRouteLease()
            let response = try await routeLease.listAgents()
            // An empty catalog must not retain the lease: a stray defaultId would
            // enable Create for an agent the gateway never offered.
            guard let response, !response.agents.isEmpty else {
                self.errorText = String(localized: "No agents are available on this gateway.")
                return
            }
            self.routeLease = routeLease
            self.agents = response.agents
            self.selectedAgentID = response.agents.contains(where: { $0.id == response.defaultId })
                ? response.defaultId
                : response.agents[0].id
        } catch {
            self.errorText = error.localizedDescription
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("New Session Options")
                .font(OpenClawChatTypography.body(size: 15, weight: .semibold, relativeTo: .headline))
            Picker("Agent", selection: self.$selectedAgentID) {
                ForEach(self.agents) { agent in
                    Text(verbatim: agent.displayName)
                        .font(OpenClawChatTypography.body)
                        .tag(agent.id)
                }
            }
            .disabled(self.isLoading || self.agents.isEmpty)
            Toggle("Create in a worktree", isOn: self.$usesWorktree)
                .font(OpenClawChatTypography.body)
                .disabled(self.selectedAgent?.workspaceGit == false)
            if self.usesWorktree {
                TextField("Base ref (optional)", text: self.$baseRef)
                    .font(OpenClawChatTypography.body)
            }
            if let errorText {
                Text(errorText)
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(OpenClawChatTheme.danger)
            }
            HStack {
                if self.errorText != nil, self.routeLease == nil {
                    Button("Retry") {
                        Task { await self.loadOptions() }
                    }
                    .font(OpenClawChatTypography.body)
                }
                Spacer()
                Button("Create") {
                    guard !self.isCreating, let routeLease = self.routeLease else { return }
                    self.isCreating = true
                    self.errorText = nil
                    let baseRef = self.baseRef.trimmingCharacters(in: .whitespacesAndNewlines)
                    Task {
                        defer { self.isCreating = false }
                        let created = await self.viewModel.startNewSession(
                            agentID: self.selectedAgentID,
                            worktree: self.usesWorktree,
                            worktreeBaseRef: baseRef.isEmpty ? nil : baseRef,
                            using: routeLease)
                        // Keep inputs on failure; dismissing would discard the
                        // selected agent/worktree while no session exists.
                        if created {
                            self.onComplete()
                        } else {
                            self.errorText = self.viewModel.errorText
                                ?? String(localized: "The session could not be created.")
                        }
                    }
                }
                .font(OpenClawChatTypography.body)
                .keyboardShortcut(.defaultAction)
                .disabled(
                    self.isLoading || self.isCreating || self.selectedAgentID.isEmpty || self.routeLease == nil)
            }
        }
        .padding(16)
        .frame(width: 320)
        .task { await self.loadOptions() }
        .onChange(of: self.selectedAgentID) {
            if self.selectedAgent?.workspaceGit == false {
                self.usesWorktree = false
            }
        }
    }
}
