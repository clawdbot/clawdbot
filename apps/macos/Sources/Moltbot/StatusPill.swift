import SwiftUI

struct StatusPill: View {
    let text: String
    let tint: Color

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
