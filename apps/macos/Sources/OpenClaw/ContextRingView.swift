import SwiftUI

struct ContextRingStyle: Equatable {
    struct RGB: Equatable {
        let red: Int
        let green: Int
        let blue: Int
    }

    static let warningThreshold = 0.85
    static let dangerThreshold = 0.95

    let ratio: Double

    var percent: Int {
        Int((min(max(self.ratio, 0), 1) * 100).rounded())
    }

    var showsLabel: Bool {
        self.ratio >= Self.warningThreshold
    }

    var noticeColor: RGB? {
        guard self.showsLabel else { return nil }
        let warning = RGB(red: 245, green: 158, blue: 11)
        let danger = RGB(red: 239, green: 68, blue: 68)
        let band = Self.dangerThreshold - Self.warningThreshold
        let mix = min(max((self.ratio - Self.warningThreshold) / band, 0), 1)
        return RGB(
            red: Int((Double(warning.red) + Double(danger.red - warning.red) * mix).rounded()),
            green: Int((Double(warning.green) + Double(danger.green - warning.green) * mix).rounded()),
            blue: Int((Double(warning.blue) + Double(danger.blue - warning.blue) * mix).rounded()))
    }

    var fillColor: Color {
        guard let noticeColor else { return .secondary }
        return Color(
            .sRGB,
            red: Double(noticeColor.red) / 255,
            green: Double(noticeColor.green) / 255,
            blue: Double(noticeColor.blue) / 255,
            opacity: 1)
    }
}

struct ContextRingView: View {
    static let compactThreshold = 0.90

    let percentUsed: Double

    var body: some View {
        let style = ContextRingStyle(ratio: self.percentUsed / 100)

        HStack(spacing: 4) {
            ZStack {
                Circle()
                    .stroke(style.fillColor.opacity(0.22), lineWidth: 2.5)
                Circle()
                    .trim(from: 0, to: min(max(style.ratio, 0), 1))
                    .stroke(style.fillColor, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: 13, height: 13)
            .frame(width: 16, height: 16)

            if style.showsLabel {
                Text("\(style.percent)%")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(style.fillColor)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(String(localized: "Context usage"))
        .accessibilityValue(String(localized: "\(style.percent) percent used"))
    }
}
