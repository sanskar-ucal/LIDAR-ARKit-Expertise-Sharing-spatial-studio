import Foundation
import RoomBridgeCore

/// JSON control socket with authentication, heartbeat and reconnect-with-resume.
/// After every (re)connect the server sends a full snapshot before any incremental
/// message, so callers simply replace their state on `.snapshot`.
@MainActor
final class ControlChannel {
    enum State: Equatable {
        case idle, connecting, connected
        case reconnecting(String)
        case failed(String)
        case ended
    }

    private(set) var state: State = .idle {
        didSet { if state != oldValue { onState?(state) } }
    }
    var onState: ((State) -> Void)?
    var onEvent: ((Header, ServerEvent) -> Void)?

    private(set) var clientId: String?
    private(set) var roomId: String?
    private let url: URL
    private let roomCode: String
    private let token: String
    private let displayName: String
    private let session = URLSession(configuration: .default)
    private var task: URLSessionWebSocketTask?
    private var generation = 0
    private var stopped = true
    private var backoff = Backoff()

    init(webSocketBase: URL, roomCode: String, token: String, displayName: String) {
        url = webSocketBase.appendingPathComponent("ws/control")
        self.roomCode = roomCode
        self.token = token
        self.displayName = displayName
    }

    func start() {
        guard stopped else { return }
        stopped = false
        connect()
    }

    func stop() {
        stopped = true
        generation += 1
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        if state != .ended { state = .idle }
    }

    /// Drop the current socket and reconnect immediately (e.g. after returning to foreground).
    func reconnectNow() {
        guard !stopped else { return }
        task?.cancel(with: .goingAway, reason: nil)
        backoff.succeed()
        connect()
    }

    private func connect() {
        generation += 1
        let gen = generation
        state = clientId == nil ? .connecting : .reconnecting("Reconnecting…")
        let t = session.webSocketTask(with: url)
        t.maximumMessageSize = 1 << 20
        task = t
        t.resume()
        Task { await self.run(t, gen) }
    }

    private func run(_ t: URLSessionWebSocketTask, _ gen: Int) async {
        let heartbeat = Task { [weak t] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                t?.sendPing { _ in }
            }
        }
        defer { heartbeat.cancel() }
        do {
            let auth = AuthPayload(roomCode: roomCode, token: token, displayName: displayName, resumeClientId: clientId)
            let (_, data) = try MessageEncoder.encode(type: "auth", payload: auth, roomId: "", clientId: "", originEpoch: nil)
            try await t.send(.string(String(decoding: data, as: UTF8.self)))
            while gen == generation {
                let message = try await t.receive()
                let bytes: Data
                switch message {
                case .string(let s): bytes = Data(s.utf8)
                case .data(let d): bytes = d
                @unknown default: continue
                }
                guard gen == generation else { return }
                do {
                    let (header, event) = try ServerMessageDecoder.decode(bytes)
                    handle(header, event)
                } catch {
                    print("RoomBridge: ignored undecodable message: \(error)")
                }
                if stopped { return }
            }
        } catch {
            guard gen == generation, !stopped else { return }
            // Keep retrying even if the very first attempt failed: the Mac server may still be starting.
            state = .reconnecting(error.localizedDescription)
            let delay = backoff.fail()
            try? await Task.sleep(for: .seconds(delay))
            guard gen == generation, !stopped else { return }
            connect()
        }
    }

    private func handle(_ header: Header, _ event: ServerEvent) {
        switch event {
        case .authOK(let ok):
            clientId = ok.clientId
            roomId = ok.roomId
            backoff.succeed()
            state = .connected
        case .authError(let e):
            stopped = true
            state = .failed(e.message)
            task?.cancel(with: .normalClosure, reason: nil)
        case .roomEnded:
            stopped = true
            state = .ended
        default:
            break
        }
        onEvent?(header, event)
    }

    /// Sends a message if connected. Returns its messageId, or nil when offline (callers
    /// do not queue edits while disconnected; the reconnect snapshot is authoritative).
    @discardableResult
    func send<P: Encodable>(_ type: String, _ payload: P, originEpoch: Int? = nil) -> String? {
        guard state == .connected, let t = task, let rid = roomId, let cid = clientId else { return nil }
        guard let (mid, data) = try? MessageEncoder.encode(type: type, payload: payload, roomId: rid, clientId: cid, originEpoch: originEpoch) else { return nil }
        t.send(.string(String(decoding: data, as: UTF8.self))) { error in
            if let error { print("RoomBridge: send \(type) failed: \(error.localizedDescription)") }
        }
        return mid
    }
}
