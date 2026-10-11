import { useEffect, useRef, useState, type FormEvent } from "react";
import { ROLE_LABEL, type Comment, type SceneObject } from "../protocol";

interface Props {
  comments: Comment[];
  selected: SceneObject | null;
  canSend: boolean;
  onSend(text: string): boolean;
  onClearSelection(): void;
}

export function Comments({ comments, selected, canSend, onSend, onClearSelection }: Props) {
  const [draft, setDraft] = useState("");
  const list = selected ? comments.filter((c) => c.objectId === selected.id) : comments;
  const end = useRef<HTMLLIElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [list.length]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = draft.trim();
    if (!t) return;
    if (onSend(t.slice(0, 500))) setDraft("");
  };

  return (
    <section className="card comments">
      <h2>
        {selected ? <>Comments on “{selected.name}”</> : "Discussion"}
        {selected && (
          <button className="link" onClick={onClearSelection}>
            show all
          </button>
        )}
      </h2>
      <ul>
        {list.length === 0 && <li className="muted">No comments yet.</li>}
        {list.map((c) => (
          <li key={c.id}>
            <div className="comment-head">
              <strong>{c.authorName}</strong>
              <span className="muted small">{ROLE_LABEL[c.authorRole]}</span>
              {!selected && c.objectName && (
                <span className={`tag ${c.objectDeleted ? "" : "accent"}`}>
                  on {c.objectName}
                  {c.objectDeleted ? " (deleted)" : ""}
                </span>
              )}
            </div>
            <p>{c.text}</p>
          </li>
        ))}
        <li ref={end} aria-hidden />
      </ul>
      <form onSubmit={submit} className="composer">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={500}
          placeholder={selected ? `Comment on ${selected.name}…` : "Say something to everyone…"}
          disabled={!canSend}
        />
        <button type="submit" className="primary" disabled={!canSend || !draft.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
