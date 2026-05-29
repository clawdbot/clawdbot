import SwiftUI

struct OnboardingIntroStep: View {
    let onContinue: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            Image(systemName: "iphone.gen3")
                .font(.system(size: 60, weight: .semibold))
                .foregroundStyle(.tint)
                .padding(.bottom, 18)

            Text("Welcome to OpenClaw")
                .font(.largeTitle.weight(.bold))
                .multilineTextAlignment(.center)
                .padding(.bottom, 10)

            Text("Turn this iPhone into a secure OpenClaw node for chat, voice, camera, and device tools.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
                .padding(.bottom, 24)

            VStack(alignment: .leading, spacing: 14) {
                Label("Connect to your gateway", systemImage: "link")
                Label("Choose device permissions", systemImage: "hand.raised")
                Label("Use OpenClaw from your phone", systemImage: "message.fill")
            }
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .background {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Color(uiColor: .secondarySystemBackground))
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 16)

            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.orange)
                    .frame(width: 24)
                    .padding(.top, 2)

                VStack(alignment: .leading, spacing: 6) {
                    Text("Security notice")
                        .font(.headline)
                    Text(
                        "The connected OpenClaw agent can use device capabilities you enable, "
                            + "such as camera, microphone, photos, contacts, calendar, and location. "
                            + "Continue only if you trust the gateway and agent you connect to.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .background {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Color(uiColor: .secondarySystemBackground))
            }
            .padding(.horizontal, 24)

            Spacer()

            Button {
                self.onContinue()
            } label: {
                Text("Continue")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .padding(.horizontal, 24)
            .padding(.bottom, 48)
        }
    }
}

struct OnboardingWelcomeStep: View {
    let statusLine: String
    let onScanQRCode: () -> Void
    let onManualSetup: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            Image(systemName: "qrcode.viewfinder")
                .font(.system(size: 64))
                .foregroundStyle(.tint)
                .padding(.bottom, 20)

            Text("Connect Gateway")
                .font(.largeTitle.weight(.bold))
                .padding(.bottom, 8)

            Text("Scan a QR code from your OpenClaw gateway or continue with manual setup.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            VStack(alignment: .leading, spacing: 8) {
                Text("How to pair")
                    .font(.headline)
                Text("In your OpenClaw chat, run")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text("/pair qr")
                    .font(.system(.footnote, design: .monospaced).weight(.semibold))
                Text("Then scan the QR code here to connect this iPhone.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color(uiColor: .secondarySystemBackground))
            }
            .padding(.horizontal, 24)
            .padding(.top, 20)

            Spacer()

            VStack(spacing: 12) {
                Button {
                    self.onScanQRCode()
                } label: {
                    Label("Scan QR Code", systemImage: "qrcode")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

                Button {
                    self.onManualSetup()
                } label: {
                    Text("Set Up Manually")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
            }
            .padding(.bottom, 12)

            Text(self.statusLine)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
                .padding(.bottom, 48)
        }
    }
}

struct OnboardingModeRow: View {
    let title: String
    let subtitle: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(self.title)
                        .font(.body.weight(.semibold))
                    Text(self.subtitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: self.selected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(self.selected ? Color.accentColor : Color.secondary)
            }
        }
        .buttonStyle(.plain)
    }
}
