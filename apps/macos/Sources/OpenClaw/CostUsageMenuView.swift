import Charts
import SwiftUI

struct CostUsageHistoryMenuView: View {
    let summary: GatewayCostUsageSummary
    let dates: CostUsageMenuDateParser

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            self.header
            self.chart
            self.footer
        }
        .environment(\.timeZone, self.dates.timeZone)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var header: some View {
        let todayKey = self.dates.format(Date())
        let todayEntry = self.summary.daily.first { $0.date == todayKey }
        let todayCost = CostUsageFormatting.formatUsd(todayEntry?.totalCost) ?? "n/a"
        let totalCost = CostUsageFormatting.formatUsd(self.summary.totals.totalCost) ?? "n/a"

        return HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Today")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(todayCost)
                    .font(.system(size: 14, weight: .semibold))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(String(format: String(localized: "Last %lldd"), self.summary.days))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(totalCost)
                    .font(.system(size: 14, weight: .semibold))
            }
            Spacer()
        }
    }

    private var chart: some View {
        let entries = self.summary.daily.compactMap { entry -> (Date, Double)? in
            guard let date = self.dates.parse(entry.date) else { return nil }
            return (date, entry.totalCost)
        }

        return Chart(entries, id: \.0) { entry in
            BarMark(
                x: .value("Day", entry.0),
                y: .value("Cost", entry.1))
                .foregroundStyle(Color.accentColor)
                .cornerRadius(3)
        }
        .chartXAxis {
            AxisMarks(values: .stride(by: .day, count: 7)) {
                AxisGridLine().foregroundStyle(.clear)
                AxisValueLabel(format: .dateTime.month().day())
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading) {
                AxisGridLine()
                AxisValueLabel()
            }
        }
        .frame(height: 110)
    }

    private var footer: some View {
        if self.summary.totals.missingCostEntries == 0 {
            return AnyView(EmptyView())
        }
        return AnyView(
            Text(String(
                format: String(localized: "Partial: %lld entries missing cost"),
                self.summary.totals.missingCostEntries))
                .font(.caption2)
                .foregroundStyle(.secondary))
    }
}
