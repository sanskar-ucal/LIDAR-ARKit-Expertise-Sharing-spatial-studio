import AVFoundation
import Foundation
import Speech

/// Push-to-talk recording: AAC in an MP4 container, mono, at most 60 s. Nothing is kept on
/// the phone after the clip is sent.
@MainActor
final class VoiceRecorder {
    static let mime = "audio/mp4"
    private var recorder: AVAudioRecorder?
    private var url: URL?

    var isRecording: Bool { recorder?.isRecording ?? false }

    func start() async -> Bool {
        guard await AVAudioApplication.requestRecordPermission() else { return false }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
            try session.setActive(true)
        } catch {
            return false
        }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("rb-voice-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 22_050,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 48_000,
        ]
        guard let r = try? AVAudioRecorder(url: file, settings: settings), r.record(forDuration: 60) else { return false }
        recorder = r
        url = file
        return true
    }

    /// Stops and returns the clip and its length, or nil if nothing was recorded.
    func stop() -> (url: URL, durationMs: Int)? {
        guard let r = recorder, let url else { return nil }
        let ms = Int((r.currentTime * 1000).rounded())
        r.stop()
        recorder = nil
        self.url = nil
        return ms > 0 ? (url, ms) : nil
    }
}

/// Speech to text that never leaves the phone: if on-device recognition is unavailable for the
/// current language, the note is sent without a transcript instead of using Apple's servers.
enum Transcriber {
    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false
        func claim() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            if done { return false }
            done = true
            return true
        }
    }

    static func transcribe(_ url: URL) async -> String? {
        let status: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { cont.resume(returning: $0) }
        }
        guard status == .authorized, let recognizer = SFSpeechRecognizer(), recognizer.isAvailable,
              recognizer.supportsOnDeviceRecognition else { return nil }
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        let once = Once()
        return await withCheckedContinuation { (cont: CheckedContinuation<String?, Never>) in
            recognizer.recognitionTask(with: request) { result, error in
                if let result, result.isFinal {
                    if once.claim() { cont.resume(returning: result.bestTranscription.formattedString) }
                } else if error != nil {
                    if once.claim() { cont.resume(returning: nil) }
                }
            }
        }
    }
}
