import OpenClawKit
import OpenClawProtocol
import SwiftUI

extension AgentProTab {
    var usageTotalsCard: some View {
        ProCard(radius: AgentLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Totals")
                        .font(OpenClawType.headline)
                    Spacer()
                    ProValuePill(
                        value: "\(self.overview?.usage?.days ?? 31)d",
                        color: OpenClawBrand.accentForeground)
                }
                HStack(spacing: 10) {
                    self.detailMetric(label: "Cost", value: self.usageValue)
                    self.detailMetric(label: "Tokens", value: self.usageTokenValue)
                    self.detailMetric(label: "Cache", value: self.usageCacheValue)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    var usageTokenValue: String {
        guard let tokens = self.overview?.usage?.totalTokens else { return "0" }
        return Self.compactNumber(tokens)
    }

    var usageCacheValue: String {
        guard let cacheStatus = self.normalized(self.overview?.usage?.cacheStatus?["status"]?.value as? String) else {
            return "n/a"
        }
        return cacheStatus
    }

    var usageDailyList: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Daily")
            ProCard(padding: 0, radius: AgentLayout.cardRadius) {
                let days = self.overview?.usage?.daily ?? []
                if days.isEmpty {
                    self.emptyDetailRow(
                        icon: "chart.bar",
                        title: "No daily usage yet",
                        detail: "The gateway returned totals without daily session cost rows.")
                        .padding(14)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(days.prefix(14).enumerated()), id: \.element.date) { index, day in
                            self.usageDayRow(day)
                            if index < min(days.count, 14) - 1 {
                                Divider().padding(.leading, 60)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    func usageDayRow(_ day: CostUsageDailyEntryLite) -> some View {
        HStack(spacing: 12) {
            ProIconBadge(systemName: "calendar", color: OpenClawBrand.accent)
            VStack(alignment: .leading, spacing: 3) {
                Text(day.date)
                    .font(OpenClawType.subheadSemiBold)
                Text(verbatim: Self.tokenCountText(day.totalTokens ?? 0))
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Text(Self.currency(day.totalCost ?? 0))
                .font(OpenClawType.caption2SemiBold)
                .foregroundStyle(OpenClawBrand.accent)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
    }

    private static func tokenCountText(_ count: Int) -> String {
        String(
            format: String(localized: "%@ tokens"),
            self.compactNumber(count))
    }
}
