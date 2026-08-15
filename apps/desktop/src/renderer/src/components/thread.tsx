import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ToolCard } from '../stores/chat.js';

/** Thread rendering shared by the live Chat screen and the transcript viewer. */

export function Md({ text }: { text: string }) {
  return (
    <div className="msg-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // target=_blank routes every model-emitted link through main's
          // window-open handler: https opens in the system browser, all other
          // schemes are denied. Without it, a localhost/file link would
          // navigate the app window itself (will-navigate lets those pass).
          a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function ToolCardView({ card }: { card: ToolCard }) {
  const [open, setOpen] = useState(false);
  const role = card.envRole ?? 'other';
  const inputPreview = useMemo(() => {
    if (typeof card.input === 'string') {
      // Transcript replay carries the input as a (possibly truncated) JSON
      // string — pretty-print when it parses, show raw otherwise.
      try {
        return JSON.stringify(JSON.parse(card.input), null, 2);
      } catch {
        return card.input;
      }
    }
    try {
      return JSON.stringify(card.input, null, 2);
    } catch {
      return String(card.input);
    }
  }, [card.input]);
  return (
    <div className={`tool-card env-${card.connection ? role : 'none'}`}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-status">{card.ok === null ? '…' : card.ok ? '✓' : '✗'}</span>
        <span className="tool-name">{card.name}</span>
        {card.connection && (
          <span className={`env-chip ${role}`}>
            {card.connection} · {role}
          </span>
        )}
      </button>
      {open && <pre className="tool-input">{inputPreview}</pre>}
    </div>
  );
}
