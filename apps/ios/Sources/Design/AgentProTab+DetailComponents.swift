import OpenClawKit
import SwiftUI

extension AgentProTab {
    func detailMetric(label: OpenClawTextValue, value: String) -> some View {
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

    func emptyDetailRow(
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
}
