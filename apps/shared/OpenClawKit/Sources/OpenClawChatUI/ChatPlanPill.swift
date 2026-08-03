import SwiftUI

private struct ChatPlanPillSurface: ViewModifier {
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        #if os(macOS)
        content
            .background(
                RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                    .fill(OpenClawChatTheme.subtleCard))
            .overlay(
                RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                    .strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
        #else
        if #available(iOS 26.0, *) {
            content
                .glassEffect(.regular, in: .rect(cornerRadius: self.cornerRadius))
        } else {
            content
                .background(
                    .regularMaterial,
                    in: RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                        .strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
        }
        #endif
    }
}

struct ChatPlanPill: View {
    let steps: [OpenClawChatPlanStep]
    let explanation: String?

    @State private var isExpanded = false

    private var completedCount: Int {
        self.steps.count { $0.status == .completed }
    }

    private var currentStep: OpenClawChatPlanStep? {
        self.steps.first { $0.status == .inProgress }
            ?? self.steps.last { $0.status == .completed }
            ?? self.steps.first
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    self.isExpanded.toggle()
                }
            } label: {
                self.summary
                    .padding(.horizontal, 12)
                    .padding(.vertical, self.isExpanded ? 11 : 9)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(self.summaryAccessibilityLabel)
            .accessibilityHint(self.isExpanded ? "Collapse plan" : "Expand plan")

            if self.isExpanded {
                Divider()
                    .overlay(OpenClawChatTheme.divider)
                    .padding(.horizontal, 12)
                VStack(alignment: .leading, spacing: 9) {
                    if let explanation {
                        Text(explanation)
                            .font(OpenClawChatTypography.caption)
                            .foregroundStyle(OpenClawChatTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(Array(self.steps.enumerated()), id: \.offset) { _, step in
                            self.stepRow(step)
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 9)
                .padding(.bottom, 11)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(ChatPlanPillSurface(cornerRadius: self.isExpanded ? 16 : 18))
        .foregroundStyle(OpenClawChatTheme.assistantText)
    }

    private var summaryAccessibilityLabel: String {
        guard let currentStep else {
            return "Plan, \(self.completedCount) of \(self.steps.count) steps done"
        }
        return "Plan, \(self.completedCount) of \(self.steps.count) steps done, "
            + "\(Self.accessibilityLabel(for: currentStep.status)): \(currentStep.step)"
    }

    private var summary: some View {
        HStack(spacing: 8) {
            if let currentStep {
                Text(Self.marker(for: currentStep.status))
                    .font(OpenClawChatTypography.captionSemiBold)
                    .foregroundStyle(Self.markerColor(for: currentStep.status))
                Text(currentStep.step)
                    .font(OpenClawChatTypography.footnoteSemiBold)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 8)
            Text(verbatim: "\(self.completedCount)/\(self.steps.count)")
                .font(OpenClawChatTypography.captionSemiBold)
                .foregroundStyle(OpenClawChatTheme.muted)
            Image(systemName: "chevron.down")
                .font(OpenClawChatTypography.caption2)
                .foregroundStyle(OpenClawChatTheme.muted)
                .rotationEffect(.degrees(self.isExpanded ? 180 : 0))
        }
    }

    private func stepRow(_ step: OpenClawChatPlanStep) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(Self.marker(for: step.status))
                .font(OpenClawChatTypography.captionSemiBold)
                .foregroundStyle(Self.markerColor(for: step.status))
                .frame(width: 12, alignment: .center)
            Text(step.step)
                .font(OpenClawChatTypography.footnote)
                .foregroundStyle(
                    step.status == .pending
                        ? OpenClawChatTheme.muted
                        : OpenClawChatTheme.assistantText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.stepAccessibilityLabel(step))
    }

    private static func marker(for status: OpenClawChatPlanStep.Status) -> String {
        switch status {
        case .completed: "✓"
        case .inProgress: "▸"
        case .pending: "▢"
        }
    }

    private static func markerColor(for status: OpenClawChatPlanStep.Status) -> Color {
        switch status {
        case .completed, .inProgress: OpenClawChatTheme.accent
        case .pending: OpenClawChatTheme.muted
        }
    }

    private static func stepAccessibilityLabel(_ step: OpenClawChatPlanStep) -> String {
        "\(self.accessibilityLabel(for: step.status)), \(step.step)"
    }

    private static func accessibilityLabel(for status: OpenClawChatPlanStep.Status) -> String {
        switch status {
        case .completed: "Completed"
        case .inProgress: "In progress"
        case .pending: "Pending"
        }
    }
}
