import Foundation
import SwiftUI

struct MobileBackgroundTask: Decodable, Identifiable, Equatable {
    struct Timestamp: Decodable, Equatable {
        let milliseconds: Double

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let number = try? container.decode(Double.self) {
                self.milliseconds = number
                return
            }
            let value = try container.decode(String.self)
            let fractionalFormatter = ISO8601DateFormatter()
            fractionalFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            guard let date = fractionalFormatter.date(from: value) ?? ISO8601DateFormatter().date(from: value) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Expected a millisecond timestamp or ISO-8601 date")
            }
            self.milliseconds = date.timeIntervalSince1970 * 1000
        }
    }

    let id: String
    let status: String
    let runtime: String?
    let title: String?
    let agentId: String?
    let sessionKey: String?
    let childSessionKey: String?
    let createdAt: Timestamp?
    let updatedAt: Timestamp?
    let startedAt: Timestamp?
    let endedAt: Timestamp?
    let progressSummary: String?
    let terminalSummary: String?
    let error: String?
    let prompt: String?

    var displayTitle: String {
        self.title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
            ?? self.id.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
            ?? String(localized: "Background task")
    }

    var isActive: Bool {
        self.status == "queued" || self.status == "running"
    }

    var statusLabel: String {
        switch self.status {
        case "queued": String(localized: "Queued")
        case "running": String(localized: "Running")
        case "completed": String(localized: "Completed")
        default: String(localized: "Failed")
        }
    }

    var runtimeLabel: String {
        switch self.runtime {
        case "subagent": String(localized: "Subagent")
        case "cron": String(localized: "Cron")
        case "acp": "ACP"
        case "cli": "CLI"
        default: String(localized: "Task")
        }
    }

    var output: String? {
        let candidates = if self.status == "failed" || self.status == "timed_out" {
            [self.error, self.terminalSummary, self.progressSummary]
        } else {
            [self.terminalSummary, self.error, self.progressSummary]
        }
        return candidates.compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty }.first
    }

    var activityMilliseconds: Double {
        self.updatedAt?.milliseconds ?? self.endedAt?.milliseconds
            ?? self.startedAt?.milliseconds ?? self.createdAt?.milliseconds ?? 0
    }
}

extension String {
    fileprivate var nilIfEmpty: String? {
        self.isEmpty ? nil : self
    }
}

private struct MobileBackgroundTasksEnvelope: Decodable {
    let tasks: [MobileBackgroundTask]
}

private struct MobileBackgroundTaskEnvelope: Decodable {
    let task: MobileBackgroundTask
}

private struct MobileBackgroundTasksListParams: Encodable {
    let agentId: String
    let status: [String]?
    let limit: Int
}

private struct MobileBackgroundTaskGetParams: Encodable {
    let taskId: String
}

enum MobileBackgroundTaskList {
    @MainActor
    static func load(
        request: (_ status: [String], _ limit: Int) async throws -> [MobileBackgroundTask]) async throws
        -> [MobileBackgroundTask]
    {
        // Active first, terminal second: a monotonic active-to-terminal transition
        // is then present in at least one snapshot instead of falling between calls.
        let active = try await request(["queued", "running"], 200)
        let finished = try await request(["completed", "failed", "cancelled", "timed_out"], 100)
        return self.merge(recent: finished, active: active)
    }

    static func merge(
        recent: [MobileBackgroundTask],
        active: [MobileBackgroundTask]) -> [MobileBackgroundTask]
    {
        var byId: [String: MobileBackgroundTask] = [:]
        for task in recent + active {
            guard let current = byId[task.id] else {
                byId[task.id] = task
                continue
            }
            if task.activityMilliseconds > current.activityMilliseconds ||
                (task.activityMilliseconds == current.activityMilliseconds && !task.isActive)
            {
                byId[task.id] = task
            }
        }
        return byId.values.sorted {
            if $0.activityMilliseconds != $1.activityMilliseconds {
                return $0.activityMilliseconds > $1.activityMilliseconds
            }
            return $0.id < $1.id
        }
    }
}

struct BackgroundTasksScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    let agentID: String

    @State private var tasks: [MobileBackgroundTask] = []
    @State private var loading = true
    @State private var errorMessage: String?

    private var activeTasks: [MobileBackgroundTask] {
        self.tasks.filter(\.isActive)
    }

    private var finishedTasks: [MobileBackgroundTask] {
        self.tasks.filter { !$0.isActive }.prefix(50).map(\.self)
    }

    var body: some View {
        NavigationStack {
            Group {
                if self.loading, self.tasks.isEmpty {
                    ProgressView {
                        Text("Loading background tasks…")
                            .font(OpenClawType.body)
                    }
                } else if let errorMessage, self.tasks.isEmpty {
                    ContentUnavailableView(
                        "Couldn’t Load Tasks",
                        systemImage: "exclamationmark.triangle",
                        description: Text(errorMessage).font(OpenClawType.body))
                } else if self.tasks.isEmpty {
                    ContentUnavailableView(
                        "No Background Tasks",
                        systemImage: "clock.arrow.circlepath",
                        description: Text("Tasks for this agent will appear here.")
                            .font(OpenClawType.body))
                } else {
                    List {
                        if let errorMessage {
                            Text(errorMessage)
                                .font(OpenClawType.footnote)
                                .foregroundStyle(OpenClawBrand.warn)
                        }
                        Section {
                            if self.activeTasks.isEmpty {
                                Text("No running tasks")
                                    .font(OpenClawType.body)
                                    .foregroundStyle(.secondary)
                            } else {
                                ForEach(self.activeTasks) { task in
                                    self.taskLink(task)
                                }
                            }
                        } header: {
                            Text("Running").font(OpenClawType.captionMedium)
                        }
                        Section {
                            if self.finishedTasks.isEmpty {
                                Text("No finished tasks")
                                    .font(OpenClawType.body)
                                    .foregroundStyle(.secondary)
                            } else {
                                ForEach(self.finishedTasks) { task in
                                    self.taskLink(task)
                                }
                            }
                        } header: {
                            Text("Finished").font(OpenClawType.captionMedium)
                        }
                    }
                    .listStyle(.insetGrouped)
                    .refreshable { await self.loadTasks() }
                }
            }
            .navigationTitle("Background Tasks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await self.loadTasks() }
                    } label: {
                        Label {
                            Text("Refresh").font(OpenClawType.body)
                        } icon: {
                            Image(systemName: "arrow.clockwise")
                        }
                    }
                    .disabled(self.loading)
                }
            }
        }
        .task { await self.loadTasks() }
    }

    private func taskLink(_ task: MobileBackgroundTask) -> some View {
        NavigationLink {
            BackgroundTaskDetailScreen(task: task)
        } label: {
            VStack(alignment: .leading, spacing: 7) {
                Text(task.displayTitle)
                    .font(OpenClawType.subheadMedium)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                HStack(spacing: 7) {
                    Text(task.statusLabel)
                        .font(OpenClawType.captionMedium)
                        .foregroundStyle(self.statusColor(task))
                    Text(task.runtimeLabel)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                if let output = task.output {
                    Text(output)
                        .font(OpenClawType.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            .padding(.vertical, 3)
        }
        .accessibilityIdentifier("background-task-\(task.id)")
    }

    private func statusColor(_ task: MobileBackgroundTask) -> Color {
        switch task.status {
        case "completed": OpenClawBrand.ok
        case "failed", "timed_out": OpenClawBrand.warn
        case "queued", "running": OpenClawBrand.accent
        default: .secondary
        }
    }

    @MainActor
    private func loadTasks() async {
        self.loading = true
        self.errorMessage = nil
        do {
            self.tasks = try await MobileBackgroundTaskList.load { status, limit in
                try await self.requestTasks(status: status, limit: limit)
            }
        } catch {
            self.errorMessage = error.localizedDescription
        }
        self.loading = false
    }

    private func requestTasks(status: [String]?, limit: Int) async throws -> [MobileBackgroundTask] {
        let params = MobileBackgroundTasksListParams(agentId: self.agentID, status: status, limit: limit)
        let data = try await self.request(method: "tasks.list", params: params)
        return try JSONDecoder().decode(MobileBackgroundTasksEnvelope.self, from: data).tasks
    }

    private func request(method: String, params: some Encodable) async throws -> Data {
        let payload = try JSONEncoder().encode(params)
        guard let paramsJSON = String(data: payload, encoding: .utf8) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return try await self.appModel.operatorSession.request(
            method: method,
            paramsJSON: paramsJSON,
            timeoutSeconds: 12)
    }
}

private struct BackgroundTaskDetailScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var task: MobileBackgroundTask
    @State private var loading = true
    @State private var errorMessage: String?

    init(task: MobileBackgroundTask) {
        self._task = State(initialValue: task)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(self.task.displayTitle)
                        .font(OpenClawType.title3)
                    HStack(spacing: 8) {
                        Text(self.task.statusLabel).font(OpenClawType.captionMedium)
                        Text(self.task.runtimeLabel)
                            .font(OpenClawType.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                self.detailBlock(
                    title: String(localized: "Prompt"),
                    body: self.task.prompt ?? (self.loading
                        ? String(localized: "Loading…")
                        : String(localized: "Prompt unavailable.")))
                self.detailBlock(
                    title: String(localized: "Output"),
                    body: self.task.output ?? String(localized: "No output yet."))
                if let errorMessage {
                    Text(errorMessage)
                        .font(OpenClawType.footnote)
                        .foregroundStyle(OpenClawBrand.warn)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
        }
        .navigationTitle("Task Details")
        .navigationBarTitleDisplayMode(.inline)
        .task { await self.loadDetail() }
    }

    private func detailBlock(title: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title)
                .font(OpenClawType.captionMedium)
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            Text(body)
                .font(OpenClawType.monoFootnote)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    @MainActor
    private func loadDetail() async {
        self.loading = true
        do {
            let params = MobileBackgroundTaskGetParams(taskId: self.task.id)
            let payload = try JSONEncoder().encode(params)
            guard let paramsJSON = String(data: payload, encoding: .utf8) else {
                throw CocoaError(.fileReadCorruptFile)
            }
            let data = try await self.appModel.operatorSession.request(
                method: "tasks.get",
                paramsJSON: paramsJSON,
                timeoutSeconds: 12)
            self.task = try JSONDecoder().decode(MobileBackgroundTaskEnvelope.self, from: data).task
        } catch {
            self.errorMessage = error.localizedDescription
        }
        self.loading = false
    }
}
