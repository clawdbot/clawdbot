# Proposal: Integration des Iroh Frameworks für direkte P2P Gateway-Verbindungen (iOS/App)

## 📝 Beschreibung
Dieser Vorschlag (Proposal) skizziert die Integration des [Iroh Frameworks](https://github.com/n0-computer/iroh) (`iroh-net`), um eine direkte, sichere und dezentrale Peer-to-Peer (P2P) Verbindung zwischen der OpenClaw Mobile App (iOS/Android) und dem OpenClaw Gateway herzustellen. 

Bisher war die externe Verbindung primär auf lokale Netzwerke (mDNS/LAN) oder externe VPN-Lösungen wie Tailscale angewiesen. Mit Iroh ermöglichen wir nahtloses NAT-Traversal (Hole-Punching) und verschlüsselte Tunnel-Verbindungen direkt "Out-of-the-Box", ohne dass der Nutzer ein zusätzliches VPN-Setup benötigt.

## 💡 Hintergrund & Motivation
* **Bessere UX (Kein Tailscale-Zwang):** Nutzer müssen sich nicht mehr um die Konfiguration von Tailnets oder Port-Freigaben (Port Forwarding) kümmern, wenn sie von unterwegs auf ihr heimisches OpenClaw-Gateway zugreifen möchten.
* **Performantes NAT-Traversal:** Iroh nutzt moderne Techniken (ähnlich wie WireGuard, kombiniert mit STUN/DERP-Servern), um direkte Verbindungen zwischen zwei Geräten herzustellen, selbst hinter strikten Firewalls.
* **Rust Core & Swift Bindings:** Da Iroh in Rust geschrieben ist, können wir es dank [UniFFI](https://github.com/mozilla/uniffi-rs) effizient und speichersicher in Swift (iOS) und Kotlin (Android) einbinden.

## 🏗️ Architektur & Technische Änderungen

### 1. OpenClaw Gateway (Backend)
* **`iroh-net` Integration:** Das Gateway startet nun parallel zum Standard-HTTP-Server einen Iroh-Node.
* **Ticket-Generierung:** Ein neuer Befehl (`openclaw gateway iroh-ticket`) generiert ein Iroh-Ticket (Node-ID, Relay-URLs, ALPN).
* **ALPN-Routing:** Eingehende P2P-Verbindungen über Iroh werden sicher terminiert und intern an die API-Handler des Gateways weitergeleitet (z.B. `/api/v1/...`).

### 2. OpenClaw Mobile App (iOS / Swift)
* **Rust-Bindings:** Hinzufügen der vorkompilierten Iroh-Bibliotheken (`libiroh.a` oder via Swift Package Manager) unter Nutzung von uniffi-bindgen für die Swift-Header.
* **Connection Manager:** Eine neue Klasse `IrohConnectionManager`, die parallel zur bisherigen `NetworkManager`-Logik existiert.
* **Ticket-Scanner / Setup-Flow:** Die Kamera oder ein Eingabefeld in der App kann ein Iroh-Ticket als QR-Code scannen, um den Node zu authentifizieren.
* **Transport Layer:** HTTP-Requests der App werden so umgeschrieben, dass sie über die Iroh-Sockets getunnelt werden.

## 💻 Code Deep Dive / Implementation Details

### Gateway (Backend - Node.js / TypeScript)
Das Gateway startet einen Iroh-Knoten parallel zum HTTP-Server, lauscht auf ein spezifisches ALPN und generiert das Ticket für die App.

```typescript
// gateway/src/network/IrohServer.ts
import { Iroh } from '@number0/iroh';

export class IrohGatewayServer {
  private node: Iroh;
  private readonly ALPN = Buffer.from('openclaw/api/v1');

  async start(storagePath: string) {
    console.log('[Iroh] Initialisiere P2P Node...');

    // Starte Iroh Node (persistent für gleichbleibende Node ID)
    this.node = await Iroh.persistent(storagePath);
    
    // Ticket generieren (beinhaltet Node ID, Relay Info etc.)
    const ticket = await this.node.net.ticket();
    console.log(`[Iroh] Gateway Ticket generiert:\n${ticket}\n`);

    // Auf eingehende Verbindungen für unser Custom ALPN warten
    this.node.net.subscribe(async (req) => {
      if (req.alpn.equals(this.ALPN)) {
        console.log(`[Iroh] Eingehende Verbindung von Node: ${req.nodeId}`);
        const connection = await req.accept();
        
        // Tunnel die Iroh-Verbindung an den internen Express/HTTP Router
        this.handleTunnelConnection(connection);
      } else {
        req.reject(); // Unbekanntes Protokoll abweisen
      }
    });
  }

  private async handleTunnelConnection(connection: any) {
    // Hier wird der P2P Byte-Stream ausgelesen und an die lokale 
    // OpenClaw API weitergeleitet
  }
}
```

### iOS App (Swift)
In der iOS App binden wir Iroh über den Swift Package Manager ein. Der `IrohConnectionManager` nimmt das Ticket entgegen und stellt die P2P-Verbindung her.

```swift
// app/ios/OpenClaw/Network/IrohConnectionManager.swift
import Foundation
import Iroh // via Swift Package Manager

class IrohConnectionManager: ObservableObject {
    @Published var isConnected: Bool = false
    private var node: IrohNode?
    
    let alpn = "openclaw/api/v1".data(using: .utf8)!

    func connectToGateway(ticketString: String) async throws {
        let documentDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        let irohDir = documentDir.appendingPathComponent("iroh_data").path
        
        let node = try await IrohNode(path: irohDir)
        self.node = node
        
        let ticket = try NodeTicket(ticketString)
        
        // P2P Verbindung herstellen
        let endpoint = try await node.net.join(ticket: ticket)
        let connection = try await endpoint.connect(alpn: self.alpn)
        
        DispatchQueue.main.async {
            self.isConnected = true
            print("✅ Erfolgreich mit OpenClaw Gateway via Iroh verbunden!")
        }
        
        NetworkSession.shared.setIrohConnection(connection)
    }
}
```

### UI: Ticket-Eingabe (SwiftUI)

```swift
// app/ios/OpenClaw/Views/Settings/IrohPairingView.swift
import SwiftUI

struct IrohPairingView: View {
    @StateObject private var irohManager = IrohConnectionManager()
    @State private var ticketInput: String = ""
    @State private var isLoading: Bool = false
    
    var body: some View {
        Form {
            Section(header: Text("Direktverbindung (Iroh P2P)")) {
                TextField("Iroh Ticket einfügen...", text: $ticketInput)
                    .textFieldStyle(RoundedBorderTextFieldStyle())
                
                Button(action: {
                    Task {
                        isLoading = true
                        do {
                            try await irohManager.connectToGateway(ticketString: ticketInput)
                        } catch {
                            print("❌ Fehler bei der Verbindung: \(error)")
                        }
                        isLoading = false
                    }
                }) {
                    if isLoading {
                        ProgressView()
                    } else {
                        Text("Verbinden")
                    }
                }
                .disabled(ticketInput.isEmpty)
            }
            
            if irohManager.isConnected {
                Section {
                    Text("✅ Gateway sicher verbunden (P2P)")
                        .foregroundColor(.green)
                }
            }
        }
        .navigationTitle("Iroh Setup")
    }
}
```

## ⚠️ Bekannte Limitierungen & Todos
- **Android Support:** Dieser Entwurf legt das Fundament, aber die JNI/Kotlin Bindings müssen parallel evaluiert werden.
- **DERP-Server Konfiguration:** Aktuell werden die n0-Default-Relays (USA/EU) genutzt. In Zukunft sollten wir die Option bieten, eigene DERP-Relay-Server im Gateway zu konfigurieren.
- **Battery Drain Analyse (iOS):** Da Iroh UDP-Keepalives nutzt, müssen wir die Auswirkungen auf den Akku im Background-State weiter monitoren.