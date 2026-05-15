import { useState } from 'react';
import { useFetch } from '../hooks/useFetch';
import { ChevronDown, ChevronUp } from 'lucide-react';

function renderMarkdown(text) {
  // Minimal markdown: **bold**, newlines
  return text
    .split('\n')
    .map((line, i) => {
      const withBold = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      return `<p key="${i}" style="margin-bottom:6px">${withBold}</p>`;
    })
    .join('');
}

export default function OpponentAnalysis({ teamId }) {
  const [open, setOpen] = useState(false);
  const { data, loading, error } = useFetch(teamId && open ? `/api/opponent-analysis?teamId=${teamId}` : null);

  if (!teamId) return null;

  return (
    <div className="card">
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', background: 'none', border: 'none', cursor: 'pointer',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          color: 'var(--text)', fontFamily: 'inherit', padding: 0,
        }}
      >
        <span className="card-title" style={{ margin: 0 }}>AI opponent analysis</span>
        {open ? <ChevronUp size={18} color="var(--text-muted)" /> : <ChevronDown size={18} color="var(--text-muted)" />}
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          {loading && <div className="loading-card" style={{ padding: 20 }}><div className="spinner" /></div>}
          {error   && <div className="error-card">Could not load analysis</div>}
          {data?.analysis && (
            <>
              {data.formStr && (
                <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                  {data.formStr.split('').map((ch, i) => (
                    <div key={i} className={`form-dot ${ch}`}>{ch}</div>
                  ))}
                </div>
              )}
              {data.topScorer && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
                  Top scorer: <strong style={{ color: 'var(--text)' }}>{data.topScorer}</strong>
                </div>
              )}
              <div
                style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text)' }}
                dangerouslySetInnerHTML={{ __html: data.analysis.replace(/\n/g, '<br/>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') }}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
