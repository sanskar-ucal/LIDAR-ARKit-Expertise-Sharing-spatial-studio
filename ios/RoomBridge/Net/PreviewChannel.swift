import Foundation

/// Binary preview socket, separate from the control socket so video can never delay
/// scene/guidance messages. At most one frame is in flight; the broadcaster skips
/// capturing while a send is pending.
@MainActor
final class PreviewChannel {
    enum State: Equatable { case idle, connecting, ready, closed }

    private(set) var state: State = .idle
    private(set) var viewers = 0
    private(set) var serverDropped = 0
    private(set) var inFlight = false
    private var task: URLSessionWebSocketTask?
    private var generation = 0
    private var lastTicket: (URL, String)?
    private let session = URLSession(configuration: .default)

    var isReady: Bool { state == .ready && !inFlight }

    func connect(webSocketBase: URL, ticket: String) {
        lastTicket = (webSocketBase, ticket)
        close()
        generation += 1
        let gen = generation
        state = .connecting
        let t = session.webSocketTask(with: webSocketBase.appendingPathComponent("ws/preview"))
        task = t
        t.resume()
        Task {
            do {
                let auth = try JSONSerialization.data(withJSONObject: ["type": "preview.auth", "ticket": ticket])
                try await t.send(.string(String(decoding: auth, as: UTF8.self)))
                while gen == self.generation {
                    let msg = try await t.receive()
                    guard case .string(let s) = msg,
                          let obj = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any] else { continue }
                    switch obj["type"] as? String {
                    case "preview.ready": self.state = .ready
                    case "preview.stats":
                        self.viewers = obj["viewers"] as? Int ?? 0
                        self.serverDropped = obj["dropped"] as? Int ?? 0
                    default: break
                    }
                }
            } catch {
                guard gen == self.generation else { return }
                self.state = .closed
                self.inFlight = false
                // Retry with the same ticket; a control reconnect issues a fresh one.
                try? await Task.sleep(for: .seconds(2))
                if gen == self.generation, let (base, ticket) = self.lastTicket { self.connect(webSocketBase: base, ticket: ticket) }
            }
        }
    }

    func send(frame: Data, completion: @escaping @MainActor (Bool) -> Void) {
        guard state == .ready, !inFlight, let t = task else {
            completion(false)
            return
        }
        inFlight = true
        t.send(.data(frame)) { error in
            Task { @MainActor in
                self.inFlight = false
                completion(error == nil)
            }
        }
    }

    func close() {
        generation += 1
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        inFlight = false
        state = .idle
    }

    func shutdown() {
        lastTicket = nil
        close()
    }
}
