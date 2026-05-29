import Foundation
import OpenClawKit
import SwiftUI

struct AgentProDreamingDestination: View {
    @Environment(NodeAppModel.self) private var appModel
    let overview: AgentOverviewSnapshot?
    let gatewayConnected: Bool
    let overviewLoading: Bool
    let dreamingValue: String
    let dreamingDetail: String
    let dreamingColor: Color
    let refresh: () async -> Void
    @State private var selectedDreamDiaryDayID: String?
    @State private var dreamActionBusy: DreamAction?
    @State private var dreamActionStatusText: String?

    var body: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    self.detailSummaryCard(
                        icon: "moon",
                        title: "Dreaming",
                        value: self.dreamingValue,
                        detail: self.dreamingDetail,
                        color: self.dreamingColor)
                    self.dreamingTotalsCard
                    self.dreamingActionsCard
                    self.dreamDiaryCard
                    self.dreamingEntriesList(
                        title: "Promoted Entries",
                        entries: self.overview?.dreaming?.promotedEntries ?? [],
                        emptyTitle: "No promoted entries",
                        emptyDetail: "Dreaming has not promoted durable memory entries yet.")
                    self.dreamingEntriesList(
                        title: "Signal Entries",
                        entries: self.overview?.dreaming?.signalEntries ?? [],
                        emptyTitle: "No signal entries",
                        emptyDetail: "No recent recall, daily, grounded, or phase signals were reported.")
                    self.dreamingEntriesList(
                        title: "Short-Term Recall",
                        entries: self.overview?.dreaming?.shortTermEntries ?? [],
                        emptyTitle: "No short-term entries",
                        emptyDetail: "The short-term dreaming store is empty.")
                    self.dreamingPhasesCard
                }
                .padding(.vertical, 18)
            }
            .refreshable {
                await self.refresh()
            }
            .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
        }
        .navigationTitle("Dreaming")
        .navigationBarTitleDisplayMode(.inline)
    }

    private enum DreamAction: String, CaseIterable, Identifiable {
        case backfill
        case repair
        case dedupe

        var id: Self {
            self
        }

        var title: String {
            switch self {
            case .backfill: "Backfill"
            case .repair: "Repair"
            case .dedupe: "Dedupe"
            }
        }

        var icon: String {
            switch self {
            case .backfill: "book.pages"
            case .repair: "wrench.and.screwdriver"
            case .dedupe: "square.stack.3d.down.right"
            }
        }

        var method: String {
            switch self {
            case .backfill: "doctor.memory.backfillDreamDiary"
            case .repair: "doctor.memory.repairDreamingArtifacts"
            case .dedupe: "doctor.memory.dedupeDreamDiary"
            }
        }
    }

    private func detailSummaryCard(
        icon: String,
        title: String,
        value: String,
        detail: String,
        color: Color) -> some View
    {
        ProCard {
            HStack(spacing: 12) {
                ProIconBadge(systemName: icon, color: color)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.headline)
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                ProValuePill(value: value, color: color)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var dreamingTotalsCard: some View {
        ProCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Memory State")
                        .font(.headline)
                    Spacer()
                    ProValuePill(value: self.dreamingValue, color: self.dreamingColor)
                }
                HStack(spacing: 10) {
                    self.detailMetric(
                        label: "Short-term",
                        value: Self.compactNumber(self.overview?.dreaming?.shortTermCount ?? 0))
                    self.detailMetric(
                        label: "Signals",
                        value: Self.compactNumber(self.overview?.dreaming?.totalSignalCount ?? 0))
                    self.detailMetric(
                        label: "Promoted",
                        value: Self.compactNumber(self.overview?.dreaming?.promotedToday ?? 0))
                }
                if let storeError = self.normalized(self.overview?.dreaming?.storeError) {
                    Text(storeError)
                        .font(.caption2)
                        .foregroundStyle(OpenClawBrand.warn)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var dreamingActionsCard: some View {
        ProCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Maintenance")
                            .font(.headline)
                        Text("Refresh reads live state. Maintenance actions update the gateway diary/artifacts.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    Spacer(minLength: 8)
                    Button {
                        Task { await self.refresh() }
                    } label: {
                        Image(systemName: self.overviewLoading ? "hourglass" : "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(self.overviewLoading)
                    .accessibilityLabel("Refresh dreaming")
                }

                HStack(spacing: 8) {
                    ForEach(DreamAction.allCases) { action in
                        Button {
                            Task { await self.runDreamAction(action) }
                        } label: {
                            Label(action.title, systemImage: self.dreamActionBusy == action ? "hourglass" : action.icon)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(!self.gatewayConnected || self.dreamActionBusy != nil)
                    }
                }

                if let dreamActionStatusText {
                    Text(dreamActionStatusText)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var dreamDiaryCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Dream Diary")
            ProCard(padding: 0) {
                if let diary = self.overview?.dreamDiary {
                    if diary.found, let content = self.normalizedMultiline(diary.content) {
                        let days = Self.dreamDiaryDays(from: content)
                        let selectedDay = self.selectedDreamDiaryDay(from: days)
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                ProIconBadge(systemName: "book.pages", color: OpenClawBrand.accent)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(diary.path)
                                        .font(.subheadline.weight(.semibold))
                                        .lineLimit(1)
                                    Text(self.dreamDiaryUpdatedLabel(diary))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 8)
                                if !days.isEmpty {
                                    self.dreamDiaryDayMenu(days: days, selectedDay: selectedDay)
                                }
                            }
                            if let selectedDay {
                                self.dreamDiaryDayView(selectedDay)
                            } else {
                                self.emptyDetailRow(
                                    icon: "calendar.badge.exclamationmark",
                                    title: "No day entries",
                                    detail: "The diary is present, but it does not contain dated Dream Diary blocks.")
                            }
                        }
                        .padding(14)
                    } else {
                        self.emptyDetailRow(
                            icon: "book.closed",
                            title: diary.found ? "Dream diary is empty" : "No dream diary yet",
                            detail: diary.found
                                ? "\(diary.path) exists but has no readable content."
                                : "The gateway did not find DREAMS.md or dreams.md in the active agent workspace.")
                            .padding(14)
                    }
                } else {
                    self.emptyDetailRow(
                        icon: "book.closed",
                        title: self.gatewayConnected ? "Diary unavailable" : "Dreaming unavailable",
                        detail: self.gatewayConnected
                            ? "The gateway did not return dream diary content."
                            : "Connect a gateway to read dream diary entries.")
                        .padding(14)
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private func dreamDiaryDayMenu(days: [DreamDiaryDay], selectedDay: DreamDiaryDay?) -> some View {
        Menu {
            ForEach(Array(days.reversed())) { day in
                Button {
                    self.selectedDreamDiaryDayID = day.id
                } label: {
                    Label(
                        day.title,
                        systemImage: day.id == selectedDay?.id ? "checkmark.circle.fill" : "calendar")
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "calendar")
                Text(selectedDay?.title ?? "Day")
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.primary)
            .padding(.horizontal, 10)
            .frame(height: 34)
            .background(Color.primary.opacity(0.055), in: Capsule())
        }
        .accessibilityLabel("Dream diary day")
    }

    private func dreamDiaryDayView(_ day: DreamDiaryDay) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(day.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text("\(day.entryCount) \(day.entryCount == 1 ? "entry" : "entries")")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(OpenClawBrand.accent)
            }
            Text(day.body)
                .font(.caption.monospaced())
                .foregroundStyle(.primary)
                .lineLimit(120)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(10)
        .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func selectedDreamDiaryDay(from days: [DreamDiaryDay]) -> DreamDiaryDay? {
        if let selectedDreamDiaryDayID,
           let match = days.first(where: { $0.id == selectedDreamDiaryDayID })
        {
            return match
        }
        return days.last
    }

    private func dreamingEntriesList(
        title: String,
        entries: [DreamingEntryLite],
        emptyTitle: String,
        emptyDetail: String) -> some View
    {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: title)
            ProCard(padding: 0) {
                if entries.isEmpty {
                    self.emptyDetailRow(
                        icon: "doc.text.magnifyingglass",
                        title: emptyTitle,
                        detail: self.gatewayConnected ? emptyDetail : "Connect a gateway to load dreaming entries.")
                        .padding(14)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                            self.dreamingEntryRow(entry)
                            if index < entries.count - 1 {
                                Divider().padding(.leading, 60)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private func dreamingEntryRow(_ entry: DreamingEntryLite) -> some View {
        HStack(alignment: .top, spacing: 12) {
            ProIconBadge(systemName: "text.page", color: OpenClawBrand.accent)
            VStack(alignment: .leading, spacing: 4) {
                Text(self.dreamingEntryTitle(entry))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(entry.snippet)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(4)
                    .textSelection(.enabled)
                Text(self.dreamingEntryDetail(entry))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text("\(entry.totalSignalCount)")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(OpenClawBrand.accent)
                .lineLimit(1)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
    }

    private var dreamingPhasesCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Phases")
            ProCard(padding: 0) {
                let phases = self.dreamingPhases
                if phases.isEmpty {
                    self.emptyDetailRow(
                        icon: "moon.zzz",
                        title: self.gatewayConnected ? "No phase status" : "Dreaming unavailable",
                        detail: self.gatewayConnected
                            ? "The gateway did not return dreaming phase details."
                            : "Connect a gateway to load dreaming phases.")
                        .padding(14)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(phases.enumerated()), id: \.element.id) { index, phase in
                            self.dreamingPhaseRow(phase)
                            if index < phases.count - 1 {
                                Divider().padding(.leading, 60)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var dreamingPhases: [DreamingPhaseRow] {
        let phaseOrder = ["light", "deep", "rem"]
        let phases = self.overview?.dreaming?.phases ?? [:]
        return phaseOrder.compactMap { id in
            guard let phase = phases[id] else { return nil }
            return DreamingPhaseRow(id: id, title: id.capitalized, status: phase)
        }
    }

    private func dreamingPhaseRow(_ phase: DreamingPhaseRow) -> some View {
        HStack(alignment: .top, spacing: 12) {
            ProIconBadge(
                systemName: phase.status.enabled == false ? "pause.circle" : "moon.stars",
                color: phase.status.enabled == false ? .secondary : OpenClawBrand.accent)
            VStack(alignment: .leading, spacing: 4) {
                Text(phase.title)
                    .font(.subheadline.weight(.semibold))
                Text(self.dreamingPhaseDetail(phase.status))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                if let cron = self.normalized(phase.status.cron) {
                    Text(cron)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            Text(self.dreamingPhaseState(phase.status))
                .font(.caption2.weight(.semibold))
                .foregroundStyle(phase.status.managedCronPresent == true ? OpenClawBrand.accent : .secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
    }

    private func emptyDetailRow(icon: String, title: String, detail: String) -> some View {
        HStack(spacing: 12) {
            ProIconBadge(systemName: icon, color: .secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
        }
    }

    private func detailMetric(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func dreamingEntryTitle(_ entry: DreamingEntryLite) -> String {
        let path = entry.path.split(separator: "/").last.map(String.init) ?? entry.path
        return "\(path):\(entry.startLine)"
    }

    private func dreamingEntryDetail(_ entry: DreamingEntryLite) -> String {
        let parts = [
            entry.promotedAt.map { "promoted \($0)" },
            entry.lastRecalledAt.map { "recalled \($0)" },
            "\(entry.recallCount) recalls",
            "\(entry.groundedCount) grounded",
        ].compactMap(\.self)
        return parts.joined(separator: " • ")
    }

    private func dreamingPhaseDetail(_ phase: DreamingPhaseStatusLite) -> String {
        if let nextRunAtMs = phase.nextRunAtMs {
            return "Next cycle \(Self.relativeTime(fromMilliseconds: nextRunAtMs))"
        }
        if phase.managedCronPresent == true {
            return "Managed cron is installed."
        }
        return "Managed cron is not installed."
    }

    private func dreamingPhaseState(_ phase: DreamingPhaseStatusLite) -> String {
        if phase.enabled == false { return "off" }
        return phase.managedCronPresent == true ? "scheduled" : "setup"
    }

    private func dreamDiaryUpdatedLabel(_ diary: DreamDiaryLite) -> String {
        guard let updatedAtMs = diary.updatedAtMs else { return "No update timestamp" }
        return "Updated \(Self.relativeTime(fromMilliseconds: updatedAtMs))"
    }

    @MainActor
    private func runDreamAction(_ action: DreamAction) async {
        guard self.gatewayConnected, self.dreamActionBusy == nil else { return }
        self.dreamActionBusy = action
        self.dreamActionStatusText = nil
        defer { self.dreamActionBusy = nil }

        do {
            let data = try await self.appModel.operatorSession.request(
                method: action.method,
                paramsJSON: "{}",
                timeoutSeconds: 30)
            self.dreamActionStatusText = Self.dreamActionSummary(action: action, data: data)
            await self.refresh()
        } catch {
            self.dreamActionStatusText = error.localizedDescription
        }
    }

    private static func dreamActionSummary(action: DreamAction, data: Data) -> String {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return "\(action.title) complete."
        }
        let written = json["written"] as? Int
        let replaced = json["replaced"] as? Int
        let removed = json["removedEntries"] as? Int
        let changed = json["changed"] as? Bool
        let parts = [
            written.map { "\($0) written" },
            replaced.map { "\($0) replaced" },
            removed.map { "\($0) removed" },
            changed.map { $0 ? "artifacts repaired" : "no repair needed" },
        ].compactMap(\.self)
        if parts.isEmpty {
            return "\(action.title) complete."
        }
        return "\(action.title): \(parts.joined(separator: ", "))."
    }

    private func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private func normalizedMultiline(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func compactNumber(_ value: Int) -> String {
        value.formatted(.number.notation(.compactName))
    }

    private static func relativeTime(fromMilliseconds milliseconds: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(milliseconds) / 1000)
        return date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }

    private static func dreamDiaryDays(from content: String) -> [DreamDiaryDay] {
        let inner = Self.dreamDiaryInnerContent(content)
        let separatorBlocks = inner
            .components(separatedBy: "\n---")
            .flatMap { $0.components(separatedBy: "\r\n---") }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let blocks = separatorBlocks.count > 1 ? separatorBlocks : Self.splitDiaryBlocksByDateLine(inner)
        let parsedBlocks = blocks.enumerated().map { index, block in
            Self.dreamDiaryBlock(from: block, index: index)
        }.filter(\.hasDatedEntry)
        return Self.mergeDiaryBlocksByDay(parsedBlocks)
    }

    private static func dreamDiaryInnerContent(_ content: String) -> String {
        let start = "<!-- openclaw:dreaming:diary:start -->"
        let end = "<!-- openclaw:dreaming:diary:end -->"
        guard let startRange = content.range(of: start),
              let endRange = content.range(of: end, range: startRange.upperBound..<content.endIndex)
        else {
            return content
        }
        return String(content[startRange.upperBound..<endRange.lowerBound])
    }

    private static func dreamDiaryBlock(from block: String, index: Int) -> DreamDiaryDay {
        let rawLines = block.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let dateLineIndex = rawLines.firstIndex { line in
            Self.isDiaryDateLine(line)
        }
        let markerDay = rawLines.compactMap(Self.backfillDay).first
        let rawTitle = dateLineIndex.flatMap { Self.unwrappedEmphasis(rawLines[$0]) } ?? markerDay
        let title = rawTitle.map(Self.dayTitle) ?? markerDay ?? "Diary"
        let id = markerDay ?? Self.dayID(title)
        let bodyLines = rawLines.enumerated().compactMap { offset, line -> String? in
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if offset == dateLineIndex { return nil }
            if trimmed.hasPrefix("<!--") && trimmed.hasSuffix("-->") { return nil }
            if trimmed == "#" || trimmed == "# Dream Diary" { return nil }
            return line
        }
        let body = bodyLines
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return DreamDiaryDay(
            id: id.isEmpty ? "\(index)" : id,
            title: title,
            body: body.isEmpty ? "No diary prose for this day." : body,
            entryCount: 1,
            hasDatedEntry: rawTitle != nil)
    }

    private static func mergeDiaryBlocksByDay(_ blocks: [DreamDiaryDay]) -> [DreamDiaryDay] {
        var ordered: [DreamDiaryDay] = []
        for block in blocks {
            if let existingIndex = ordered.firstIndex(where: { $0.title == block.title }) {
                let existing = ordered[existingIndex]
                ordered[existingIndex] = DreamDiaryDay(
                    id: existing.id,
                    title: existing.title,
                    body: [existing.body, block.body].joined(separator: "\n\n---\n\n"),
                    entryCount: existing.entryCount + block.entryCount,
                    hasDatedEntry: true)
            } else {
                ordered.append(block)
            }
        }
        return ordered
    }

    private static func splitDiaryBlocksByDateLine(_ content: String) -> [String] {
        var blocks: [String] = []
        var current: [String] = []
        for line in content.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            if Self.isDiaryDateLine(line), !current.isEmpty {
                blocks.append(current.joined(separator: "\n"))
                current = []
            }
            current.append(line)
        }
        if !current.isEmpty {
            blocks.append(current.joined(separator: "\n"))
        }
        return blocks
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private static func isDiaryDateLine(_ line: String) -> Bool {
        guard let value = unwrappedEmphasis(line) else { return false }
        let monthNames = "January|February|March|April|May|June|July|August|September|October|November|December"
        let monthDatePattern = #"\b("# + monthNames + #")\s+\d{1,2},\s+\d{4}\b"#
        let isoDatePattern = #"\b\d{4}-\d{2}-\d{2}\b"#
        return value.range(
            of: "\(monthDatePattern)|\(isoDatePattern)",
            options: .regularExpression) != nil
    }

    private static func dayTitle(_ rawTitle: String) -> String {
        let noTime = rawTitle.replacingOccurrences(
            of: #"\s+at\s+\d{1,2}:\d{2}.*$"#,
            with: "",
            options: .regularExpression)
        return noTime.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func dayID(_ title: String) -> String {
        title.lowercased()
            .replacingOccurrences(of: #"[^a-z0-9]+"#, with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    private static func unwrappedEmphasis(_ line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("*"), trimmed.hasSuffix("*"), trimmed.count > 2 else { return nil }
        return String(trimmed.dropFirst().dropLast())
    }

    private static func backfillDay(_ line: String) -> String? {
        guard let range = line.range(of: #"day=\d{4}-\d{2}-\d{2}"#, options: .regularExpression) else {
            return nil
        }
        return String(line[range].dropFirst(4))
    }
}

private struct DreamDiaryDay: Identifiable {
    let id: String
    let title: String
    let body: String
    let entryCount: Int
    let hasDatedEntry: Bool
}
