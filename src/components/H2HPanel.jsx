import { format, parseISO } from 'date-fns';

function MatchRow({ match }) {
  const { homeTeam, awayTeam, homeGoals, awayGoals, date, season } = match;
  const isChelseaHome = homeTeam === 'Chelsea FC';
  const chelseaGoals  = isChelseaHome ? homeGoals : awayGoals;
  const oppGoals      = isChelseaHome ? awayGoals : homeGoals;
  const result        = chelseaGoals > oppGoals ? 'W' : chelseaGoals < oppGoals ? 'L' : 'D';

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ flex: 1, fontSize: 12 }}>
        <div style={{ color: 'var(--text-muted)', fontSize: 10, marginBottom: 2 }}>
          {date ? format(parseISO(date), 'd MMM yyyy') : season}
        </div>
        <div style={{ fontWeight: 600 }}>{homeTeam} vs {awayTeam}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 16, fontWeight: 700, fontFamily: 'Bebas Neue, sans-serif', letterSpacing: 1 }}>
          {homeGoals} – {awayGoals}
        </span>
        <div className={`form-dot ${result}`} style={{ width: 24, height: 24, fontSize: 10 }}>
          {result}
        </div>
      </div>
    </div>
  );
}

export default function H2HPanel({ h2h = [], loading = false }) {
  if (loading) return <div className="loading-card" style={{ padding: 20 }}><div className="spinner" /></div>;

  if (!h2h.length) {
    return (
      <div>
        <div className="card-title">Head to head</div>
        <span className="text-muted fs-13">No H2H data found</span>
      </div>
    );
  }

  const last6 = h2h.slice(0, 6);
  const chelsea = last6.filter(m => {
    const isChelseaHome = m.homeTeam === 'Chelsea FC';
    const cg = isChelseaHome ? m.homeGoals : m.awayGoals;
    const og = isChelseaHome ? m.awayGoals : m.homeGoals;
    return cg > og;
  }).length;
  const drawn = last6.filter(m => m.homeGoals === m.awayGoals).length;
  const opp   = last6.length - chelsea - drawn;

  return (
    <div>
      <div className="card-title" style={{ marginBottom: 4 }}>Head to head</div>
      <div style={{ display: 'flex', gap: 12, fontSize: 12, marginBottom: 12 }}>
        <span className="text-green fw-700">CHE {chelsea}</span>
        <span className="text-muted">{drawn} D</span>
        <span className="text-red">{opp} OPP</span>
        <span className="text-muted">last {last6.length}</span>
      </div>
      {last6.map((m, i) => <MatchRow key={i} match={m} />)}
    </div>
  );
}
