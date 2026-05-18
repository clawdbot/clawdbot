import SwiftUI

struct SelectionStateIndicator: View {
    let selected: Bool

    var body: some View {
        Group {
            if self.selected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(Color.accentColor)
            } else {
                Image(systemName: "arrow.right.circle")
                    .foregroundStyle(.secondary)
            }
        }
    }
}

extension View {
    func openClawSelectableRowChrome(selected: Bool, hovered: Bool = false) -> some View {
        self
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(self.openClawRowBackground(selected: selected, hovered: hovered)))
            .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(
                        selected ? Color.accentColor.opacity(0.45) : Color.clear,
                        lineWidth: 1))
    }

    private func openClawRowBackground(selected: Bool, hovered: Bool) -> Color {
        if selected { return Color.accentColor.opacity(0.12) }
        if hovered { return Color.secondary.opacity(0.08) }
        return Color.clear
    }
}
