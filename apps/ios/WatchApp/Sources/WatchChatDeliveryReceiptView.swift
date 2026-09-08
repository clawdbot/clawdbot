import OpenClawKit
import SwiftUI

struct WatchChatDeliveryReceiptView: View {
    let receipt: OpenClawWatchChatDeliveryReceipt

    var body: some View {
        if let outcome = self.receipt.outcome {
            VStack(alignment: .leading, spacing: 4) {
                Text("Saved Watch result")
                    .font(WatchClawType.body(size: 10, weight: .medium))
                    .foregroundStyle(.secondary)
                switch outcome {
                case let .reply(text):
                    Text(text)
                        .font(WatchClawType.body(size: 12))
                case .forwarded:
                    Text("Forwarded to Chat on iPhone.")
                        .font(WatchClawType.body(size: 12))
                case let .failed(_, message), let .uncertain(message):
                    Text(message)
                        .font(WatchClawType.body(size: 12))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
        }
    }
}
