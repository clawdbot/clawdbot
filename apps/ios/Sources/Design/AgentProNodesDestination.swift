import OpenClawProtocol
import SwiftUI
import UIKit

struct AgentProNodesDestination: View {
    let headerLeadingAction: OpenClawSidebarHeaderAction?
    let overview: AgentOverviewSnapshot?
    let gatewayConnected: Bool
    let agentCount: Int
    let instancesValue: String
    let instancesDetail: String
    let instancesColor: Color
    let refresh: () async -> Void

    var body: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    self.header
                    self.summaryCard
                    self.totalsCard
                    self.nodesList
                }
                .padding(.vertical, 18)
                .font(OpenClawType.body)
            }
            .refreshable {
                await self.refresh()
            }
            .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
        }
        .navigationTitle("Instances")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private var header: some View {
        if let headerLeadingAction {
            OpenClawAdaptiveHeaderRow(
                title: "Instances",
                subtitle: .verbatim(self.instancesDetail),
                titleFont: OpenClawType.title3SemiBold,
                subtitleFont: OpenClawType.subheadMedium)
            {
                OpenClawSidebarHeaderLeadingSlot(action: headerLeadingAction)
            } accessory: {
                EmptyView()
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var summaryCard: some View {
        ProCard {
            HStack(spacing: 12) {
                ProIconBadge(systemName: "display", color: self.instancesColor)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Instances")
                        .font(OpenClawType.headline)
                    Text(verbatim: self.instancesDetail)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                ProValuePill(value: self.instancesValue, color: self.instancesColor)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var totalsCard: some View {
        ProCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Presence")
                        .font(OpenClawType.headline)
                    Spacer()
                    ProValuePill(value: self.instancesValue, color: self.instancesColor)
                }
                HStack(spacing: 10) {
                    self.detailMetric(
                        label: "Connected",
                        value: (self.overview?.presence.count ?? 0).formatted())
                    self.detailMetric(label: "Agents", value: self.agentCount.formatted())
                    self.detailMetric(
                        label: "Gateway",
                        value: self.gatewayConnected
                            ? String(localized: "online")
                            : String(localized: "offline"))
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var nodesList: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Connected Instances")
            ProCard(padding: 0) {
                let nodes = self.sortedPresenceEntries
                if nodes.isEmpty {
                    self.emptyRow(
                        icon: "display",
                        title: self.gatewayConnected ? "No instances connected" : "Instances unavailable",
                        detail: self.gatewayConnected
                            ? "The gateway did not report any system presence entries."
                            : "Connect a gateway to inspect connected instances.")
                        .padding(14)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(nodes.enumerated()), id: \.element.presenceKey) { index, entry in
                            NavigationLink {
                                self.nodeDetail(entry)
                            } label: {
                                self.nodePresenceRow(entry, showsChevron: true)
                            }
                            .buttonStyle(.plain)
                            if index < nodes.count - 1 {
                                Divider().padding(.leading, 60)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var sortedPresenceEntries: [PresenceEntry] {
        (self.overview?.presence ?? [])
            .sorted { lhs, rhs in
                if lhs.ts != rhs.ts { return lhs.ts > rhs.ts }
                return (Self.presenceLabel(lhs) ?? lhs.presenceKey)
                    .localizedCaseInsensitiveCompare(Self.presenceLabel(rhs) ?? rhs.presenceKey) == .orderedAscending
            }
    }

    private func nodePresenceRow(_ entry: PresenceEntry, showsChevron: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 12) {
            ProIconBadge(systemName: Self.presenceIcon(entry), color: Self.presenceColor(entry))
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: Self.presenceLabel(entry) ?? String(localized: "Instance"))
                    .font(OpenClawType.subheadSemiBold)
                    .lineLimit(1)
                Text(Self.presenceDetail(entry))
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                if let meta = Self.presenceMeta(entry) {
                    Text(meta)
                        .font(OpenClawType.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            Text(Self.presenceState(entry))
                .font(OpenClawType.caption2SemiBold)
                .foregroundStyle(Self.presenceColor(entry))
                .lineLimit(1)
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(OpenClawType.caption2Bold)
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
    }

    private func nodeDetail(_ entry: PresenceEntry) -> some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ProCard {
                        HStack(spacing: 12) {
                            ProIconBadge(systemName: Self.presenceIcon(entry), color: Self.presenceColor(entry))
                            VStack(alignment: .leading, spacing: 3) {
                                Text(verbatim: Self.presenceLabel(entry) ?? String(localized: "Instance"))
                                    .font(OpenClawType.headline)
                                Text(Self.presenceDetail(entry))
                                    .font(OpenClawType.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 8)
                            ProValuePill(value: Self.presenceState(entry), color: Self.presenceColor(entry))
                        }
                    }
                    .padding(.horizontal, OpenClawProMetric.pagePadding)

                    ProCard {
                        VStack(spacing: 0) {
                            self.nodeDetailRow("Instance", copyLabel: "Copy instance", value: entry.instanceid)
                            Divider()
                            self.nodeDetailRow("Device", copyLabel: "Copy device", value: entry.deviceid)
                            Divider()
                            self.nodeDetailRow("Host", copyLabel: "Copy host", value: entry.host)
                            Divider()
                            self.nodeDetailRow("IP", copyLabel: "Copy IP", value: entry.ip)
                            Divider()
                            self.nodeDetailRow("Platform", copyLabel: "Copy platform", value: entry.platform)
                            Divider()
                            self.nodeDetailRow("Version", copyLabel: "Copy version", value: entry.version)
                            Divider()
                            self.nodeDetailRow("Mode", copyLabel: "Copy mode", value: entry.mode)
                        }
                    }
                    .padding(.horizontal, OpenClawProMetric.pagePadding)

                    self.nodeListCard(title: "Scopes", values: entry.scopes ?? [])
                    self.nodeListCard(title: "Roles", values: entry.roles ?? [])
                    self.nodeListCard(title: "Tags", values: entry.tags ?? [])
                }
                .padding(.vertical, 18)
                .font(OpenClawType.body)
            }
            .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
        }
        .navigationTitle(Self.presenceLabel(entry) ?? String(localized: "Instance"))
        .navigationBarTitleDisplayMode(.inline)
    }

    private func nodeDetailRow(
        _ title: OpenClawTextValue,
        copyLabel: LocalizedStringKey,
        value: String?) -> some View
    {
        let normalized = Self.normalized(value) ?? "n/a"
        return HStack(spacing: 10) {
            title.text
                .font(OpenClawType.subhead)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Text(verbatim: normalized)
                .font(OpenClawType.subhead)
                .lineLimit(1)
                .truncationMode(.middle)
            Button {
                UIPasteboard.general.string = normalized
            } label: {
                Image(systemName: "doc.on.doc")
            }
            .buttonStyle(.plain)
            .disabled(normalized == "n/a")
            .accessibilityLabel(copyLabel)
        }
        .font(OpenClawType.subhead)
        .padding(.vertical, 10)
    }

    private func nodeListCard(title: OpenClawTextValue, values: [String]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: title)
            ProCard {
                if values.isEmpty {
                    Text("None reported.")
                        .font(OpenClawType.subhead)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(values, id: \.self) { value in
                            Text(verbatim: value)
                                .font(OpenClawType.monoSmall)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private func detailMetric(label: OpenClawTextValue, value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            label.text
                .font(OpenClawType.caption2Medium)
                .foregroundStyle(.secondary)
            Text(verbatim: value)
                .font(OpenClawType.subheadSemiBold)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(
            Color.primary.opacity(0.055),
            in: RoundedRectangle(cornerRadius: OpenClawRadius.sm, style: .continuous))
    }

    private func emptyRow(
        icon: String,
        title: OpenClawTextValue,
        detail: OpenClawTextValue) -> some View
    {
        HStack(spacing: 12) {
            ProIconBadge(systemName: icon, color: .secondary)
            VStack(alignment: .leading, spacing: 3) {
                title.text
                    .font(OpenClawType.subheadSemiBold)
                detail.text
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
        }
    }

    private static func presenceLabel(_ entry: PresenceEntry) -> String? {
        self.normalized(entry.host)
            ?? self.normalized(entry.devicefamily)
            ?? self.normalized(entry.platform)
            ?? self.normalized(entry.mode)
    }

    private static func presenceDetail(_ entry: PresenceEntry) -> String {
        let parts = [
            Self.normalized(entry.ip),
            Self.normalized(entry.platform),
            Self.normalized(entry.version),
        ].compactMap(\.self)
        if !parts.isEmpty {
            return parts.joined(separator: " • ")
        }
        return Self.normalized(entry.text) ?? String(localized: "Presence beacon received.")
    }

    private static func presenceMeta(_ entry: PresenceEntry) -> String? {
        let tags = (entry.tags ?? []).prefix(2).joined(separator: ", ")
        let scopesCount = entry.scopes?.count ?? 0
        let rolesCount = entry.roles?.count ?? 0
        let scopesText = String(
            AttributedString(localized: "^[\(scopesCount) scope](inflect: true)").characters)
        let rolesText = String(
            AttributedString(localized: "^[\(rolesCount) role](inflect: true)").characters)
        let labels = [
            Self.normalized(entry.instanceid).map {
                String(format: String(localized: "instance %@"), $0)
            },
            tags.isEmpty ? nil : tags,
            scopesCount > 0 ? scopesText : nil,
            rolesCount > 0 ? rolesText : nil,
        ].compactMap(\.self)
        return labels.isEmpty ? nil : labels.joined(separator: " • ")
    }

    private static func presenceState(_ entry: PresenceEntry) -> String {
        if let reason = normalized(entry.reason) {
            return reason
        }
        if let mode = Self.normalized(entry.mode) {
            return mode
        }
        return Self.relativeTime(fromMilliseconds: entry.ts)
    }

    private static func presenceIcon(_ entry: PresenceEntry) -> String {
        let family = Self.normalized(entry.devicefamily)?.lowercased()
        if family?.contains("phone") == true { return "iphone" }
        if family?.contains("tablet") == true || family?.contains("pad") == true { return "ipad" }
        if family?.contains("desktop") == true || family?.contains("mac") == true { return "desktopcomputer" }
        return "display"
    }

    private static func presenceColor(_ entry: PresenceEntry) -> Color {
        self.normalized(entry.reason) == nil ? OpenClawBrand.accent : OpenClawBrand.warn
    }

    private static func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func relativeTime(fromMilliseconds milliseconds: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(milliseconds) / 1000)
        return date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }
}

extension PresenceEntry {
    fileprivate var presenceKey: String {
        self.instanceid
            ?? self.deviceid
            ?? self.host
            ?? self.ip
            ?? "\(self.ts)"
    }
}
