import SwiftUI

struct StatusPill: View {
    let text: String
    let tint: Color

    /// Protocol identifiers and runtime values are operator data, not localized UI copy.
    static func verbatim(_ text: String, tint: Color) -> Self {
        Self(text: text, tint: tint)
    }

    var body: some View {
        Text(self.text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .foregroundStyle(self.tint == .secondary ? .secondary : self.tint)
            .background((self.tint == .secondary ? Color.secondary : self.tint).opacity(0.12))
            .clipShape(Capsule())
    }
}
