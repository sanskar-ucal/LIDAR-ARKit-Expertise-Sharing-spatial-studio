import { useEffect, useRef, useState } from "react";

interface Props {
  disabled: boolean;
  /** This room's invite on http://localhost, where browsers allow the microphone. */
  localLink: string | null;
  /** Uploads the clip and posts it with its caption; resolves when sent. */
  onSend(audio: Blob, durationMs: number, caption: string): Promise<void>;
}

const MAX_MS = 60_000;

/**
 * Push-to-talk for the expert's browser companion: hold to record, then check or type the
 * text everyone will read. No speech recognition runs in the browser, so audio stays local.
 */
export function PushToTalk({ disabled, localLink, onSend }: Props) {
  const [state, setState] = useState<"idle" | "recording" | "review" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);
  const clip = useRef<{ blob: Blob; ms: number } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
    rec.current?.stream.getTracks().forEach((t) => t.stop());
  }, []);

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    return (
      <div className="ptt muted small">
        🎤 Voice notes need the microphone, which browsers only allow on <span className="mono">localhost</span>.{" "}
        {localLink ? (
          <>
            <a href={localLink}>Open this room on localhost</a> on the Mac that runs the server.
          </>
        ) : (
          "Open the expert invite in a browser on the Mac that runs the server."
        )}
      </div>
    );
  }

  const start = async () => {
    if (state !== "idle" || disabled) return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t));
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const ms = Date.now() - started.current;
        if (ms < 400) {
          setState("idle");
          setError("Hold the button while you talk.");
          return;
        }
        clip.current = { blob: new Blob(chunks.current, { type: r.mimeType || "audio/webm" }), ms: Math.min(ms, MAX_MS) };
        setState("review");
      };
      rec.current = r;
      started.current = Date.now();
      r.start();
      setState("recording");
      setElapsed(0);
      timer.current = setInterval(() => {
        const ms = Date.now() - started.current;
        setElapsed(ms);
        if (ms >= MAX_MS) stop();
      }, 250);
    } catch {
      setError("Microphone permission was denied.");
    }
  };

  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    if (rec.current?.state === "recording") rec.current.stop();
  };

  const send = async () => {
    if (!clip.current) return;
    setState("sending");
    try {
      await onSend(clip.current.blob, clip.current.ms, caption.trim() || "(voice note)");
      clip.current = null;
      setCaption("");
      setState("idle");
    } catch (e) {
      setError(`Not sent: ${(e as Error).message}`);
      setState("review");
    }
  };

  return (
    <div className="ptt">
      {state === "review" || state === "sending" ? (
        <div className="ptt-review">
          <input
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            maxLength={500}
            placeholder="What did you say? Everyone reads this text"
            autoFocus
          />
          <button className="primary" onClick={send} disabled={state === "sending"}>
            {state === "sending" ? "Sending…" : "Send voice note"}
          </button>
          <button className="ghost" onClick={() => { clip.current = null; setState("idle"); }} disabled={state === "sending"}>
            Discard
          </button>
        </div>
      ) : (
        <button
          className={`ptt-button ${state === "recording" ? "on" : ""}`}
          disabled={disabled}
          onPointerDown={start}
          onPointerUp={stop}
          onPointerLeave={stop}
          aria-label="Hold to record a voice note"
        >
          {state === "recording" ? `● Recording ${Math.floor(elapsed / 1000)}s — release to stop` : "🎤 Hold to talk"}
        </button>
      )}
      {error && <div className="small warn-text">{error}</div>}
    </div>
  );
}
