import { RefreshCw } from 'lucide-react';

// ─── ErrorCard ────────────────────────────────────────────────────────────────
// Reusable graceful error state — never shows raw HTTP status strings.
// `onRetry` is optional; omit it for errors with no logical retry path.
export function ErrorCard({ message, onRetry, style }) {
  const friendly = message?.startsWith?.('Server')
    ? message
    : message?.startsWith?.('Resource')
      ? message
      : "Couldn't load data";

  return (
    <div
      className="card"
      style={{ textAlign: 'center', padding: '28px 20px', ...style }}
    >
      <div style={{ fontSize: 28, marginBottom: 10 }}>⚠️</div>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>
        {friendly}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: onRetry ? 14 : 0 }}>
        The server may be waking up or temporarily unavailable.
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '7px 16px', borderRadius: 8,
            background: 'rgba(255,255,255,0.07)',
            border: '1px solid rgba(255,255,255,0.15)',
            color: 'var(--text)', fontSize: 12, fontWeight: 600,
            cursor: 'pointer', fontFamily: 'inherit',
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.12)'}
          onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.07)'}
        >
          <RefreshCw size={13} />
          Try again
        </button>
      )}
    </div>
  );
}
