import { ChevronDown, ChevronUp } from 'lucide-react';

const BORDER = '1px solid rgba(255,255,255,0.10)';

// ─── ExpandableSection ────────────────────────────────────────────────────────
// Canonical accordion toggle — single source of truth for all leagues.
// Props:
//   title      — section label (rendered uppercase via CSS)
//   open       — controlled boolean
//   onToggle   — () => void
//   borderTop  — add top border to the button (use for 2nd+ sections)
//   isLast     — omits bottom border when closed (avoids double-border at card edge)
//   children   — content shown when open
export function ExpandableSection({ title, open, onToggle, borderTop = false, isLast = false, children }) {
  return (
    <>
      <button
        onClick={onToggle}
        aria-expanded={open}
        style={{
          width: '100%', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', padding: '10px 16px',
          background: 'var(--surface2)', border: 'none',
          ...(borderTop ? { borderTop: BORDER } : {}),
          borderBottom: (isLast && !open) ? 'none' : BORDER,
          color: open ? 'var(--text)' : 'var(--text-muted)',
          cursor: 'pointer', fontFamily: 'inherit',
          fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
          textTransform: 'uppercase', transition: 'color 0.15s',
        }}
      >
        <span>{title}</span>
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {open && children}
    </>
  );
}
