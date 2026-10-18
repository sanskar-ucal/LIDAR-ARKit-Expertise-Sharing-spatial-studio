import type { Step } from "../narrator";
import type { FeedItem } from "../state";

function Keys({ shortcut }: { shortcut: string }) {
  const groups = shortcut.split(" · ");
  return (
    <span className="keys">
      {groups.map((g, i) => (
        <span key={i}>
          {i > 0 && <span className="muted small"> then </span>}
          {g.split(" ").map((t, j) =>
            (t.length === 1 && /[A-Za-z]/.test(t)) || (t.includes("+") && !t.startsWith("+")) ? (
              <kbd key={j}>{t}</kbd>
            ) : (
              <span key={j} className="mono"> {t} </span>
            ),
          )}
        </span>
      ))}
    </span>
  );
}

function StepLine({ step, lead }: { step: Step; lead?: string }) {
  return (
    <div className="step">
      {lead && <span>{lead} </span>}
      <span>{step.text}</span>
      {step.shortcut && (
        <div className="shortcut">
          <span className="muted small">In Blender: </span>
          {step.concept === "add" ? <span className="mono small">{step.shortcut}</span> : <Keys shortcut={step.shortcut} />}
        </div>
      )}
    </div>
  );
}

/** Every change in the room, explained in Blender terms (a CAD lesson for the novice and observers). */
export function LearningFeed({ feed }: { feed: FeedItem[] }) {
  return (
    <section className="card">
      <h2>CAD lesson: what just happened</h2>
      {feed.length === 0 && <p className="muted">When the expert or the novice changes something, it is explained here with the Blender keys that do it.</p>}
      <ul className="feed">
        {feed.slice(0, 12).map((f) => (
          <li key={f.id} className={`feed-item ${f.tone}`}>
            {f.title ? <div className="step">{f.title}</div> : f.steps[0] && <StepLine step={f.steps[0]} lead={f.actor} />}
            {(f.title ? f.steps : f.steps.slice(1)).map((s, i) => (
              <StepLine key={i} step={s} lead={f.title ? undefined : "then"} />
            ))}
            {f.note && <div className="muted small note">“{f.note}”</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}
