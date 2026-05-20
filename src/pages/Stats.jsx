import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { format, parseISO, isValid } from 'date-fns';
import { useSeasonAccuracy, usePerformanceMetrics, useBettingSim, useTrackerHistory } from '../hooks/useHistory';
import ClubBadge from '../components/ClubBadge';
import { getLeague } from '../utils/leagues.jsx';
import { TopScorers, LeagueStats, FormTable } from './FdStats';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, ScatterChart, Scatter, ReferenceLine,
} from 'recharts';

function AccuracyCard({ leagueId }) {
  const { data, loading } = useSeasonAccuracy(leagueId);
  if (loading) return <div className="loading-card" style={{ padding: 20 }}><div className="spinner" /></div>;
  if (!data || data.total === 0) return (
    <div className="card">
      <div className="card-title">Season accuracy</div>
      <div className="text-muted fs-13">No tracked predictions yet. Predictions are auto-tracked before each game.</div>
    </div>
  );

  const { total, correct, accuracy, logLoss, brier, byGW } = data;

  return (
    <div className="card">
      <div className="card-title">Season accuracy</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 }}>
        <div style={{ background: 'var(--surface2)', borderRadius: 8, padding: '10px 8px', textAlign: 'center' }}>
          <div style={{ fontSize: 24, fontWeight: 700, fontFamily: 'Bebas Neue, sans-serif', color: 'var(--gold)' }}>
            {(accuracy * 100).toFixed(1)}%
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600 }}>ACCURACY</div>
        </div>
        <div style={{ background: 'var(--surface2)', borderRadius: 8, padding: '10px 8px', textAlign: 'center' }}>
          <div style={{ fontSize: 24, fontWeight: 700, fontFamily: 'Bebas Neue, sans-serif', color: 'var(--text)' }}>
            {correct}/{total}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600 }}>CORRECT</div>
        </div>
        <div style={{ background: 'var(--surface2)', borderRadius: 8, padding: '10px 8px', textAlign: 'center' }}>
          <div style={{ fontSize: 24, fontWeight: 700, fontFamily: 'Bebas Neue, sans-serif', color: 'var(--blue-light)' }}>
            {brier != null ? brier.toFixed(3) : '—'}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600 }}>BRIER</div>
        </div>
      </div>

      {byGW?.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>
            {leagueId === 'premier-league' ? 'Accuracy by gameweek' : 'Accuracy by matchday'}
          </div>
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={byGW} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis
                dataKey="gw"
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                label={{
                  value: leagueId === 'premier-league' ? 'GW' : 'MD',
                  position: 'insideBottomRight',
                  offset: -4,
                  fontSize: 9,
                  fill: 'var(--text-muted)',
                }}
              />
              <YAxis domain={[0,1]} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={v => `${(v*100).toFixed(0)}%`} />
              <Tooltip formatter={v => `${(v*100).toFixed(0)}%`} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 12 }} />
              <Bar dataKey="accuracy" fill="var(--blue)" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </>
      )}

      {logLoss != null && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
          Log loss: <strong style={{ color: 'var(--text)' }}>{logLoss.toFixed(4)}</strong>
          <span style={{ marginLeft: 12 }}>
            Lower is better (random baseline ≈ 1.099)
          </span>
        </div>
      )}
    </div>
  );
}

function CalibrationCard({ leagueId }) {
  const { data } = usePerformanceMetrics(leagueId);
  if (!data?.calibration?.length) return null;

  const calibData = data.calibration.map(b => ({
    predicted: (b.meanPredicted * 100).toFixed(0),
    actual:    b.meanActual,
    n:         b.count,
  }));

  return (
    <div className="card">
      <div className="card-title">Calibration curve</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
        Perfect calibration = diagonal line. Points above = overconfident; below = underconfident.
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <ScatterChart margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis dataKey="predicted" type="number" domain={[0,100]} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} label={{ value: 'Predicted %', position: 'insideBottom', dy: 14, fontSize: 10, fill: 'var(--text-muted)' }} />
          <YAxis dataKey="actual" type="number" domain={[0,1]} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={v => `${(v*100).toFixed(0)}%`} />
          <Tooltip formatter={(v) => typeof v === 'number' ? (v < 2 ? `${(v*100).toFixed(1)}%` : `${v}%`) : v} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 12 }} />
          <ReferenceLine segment={[{x:0,y:0},{x:100,y:1}]} stroke="rgba(255,255,255,0.2)" strokeDasharray="4 4" />
          <Scatter data={calibData} fill="var(--gold)" />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

function BettingSimCard({ leagueId }) {
  const [stake, setStake] = useState(10);
  const { data, loading } = useBettingSim(stake, leagueId);

  if (loading) return <div className="loading-card" style={{ padding: 20 }}><div className="spinner" /></div>;
  if (!data || (!data.flatSeries?.length && !data.kellySeries?.length)) {
    return (
      <div className="card">
        <div className="card-title">Betting simulator</div>
        <div className="text-muted fs-13">No completed predictions with odds data yet.</div>
      </div>
    );
  }

  const chartData = data.flatSeries.map((flat, i) => ({
    game:  i + 1,
    flat:  parseFloat(flat.toFixed(2)),
    kelly: parseFloat((data.kellySeries[i] - 1000).toFixed(2)),
  }));

  return (
    <div className="card">
      <div className="card-title">Betting simulator</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Stake</span>
        {[5,10,20,50].map(s => (
          <button key={s} onClick={() => setStake(s)}
            style={{ padding: '4px 10px', borderRadius: 16, border: '1px solid', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, transition: 'all 0.15s', borderColor: stake === s ? 'var(--gold)' : 'var(--border)', background: stake === s ? 'rgba(219,161,17,0.1)' : 'var(--surface)', color: stake === s ? 'var(--gold)' : 'var(--text-muted)' }}>
            £{s}
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
        <div style={{ background: 'var(--surface2)', borderRadius: 8, padding: '10px 8px', textAlign: 'center' }}>
          <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'Bebas Neue, sans-serif', color: data.flatBank >= 0 ? 'var(--green)' : 'var(--red)' }}>
            {data.flatBank >= 0 ? '+' : ''}£{data.flatBank.toFixed(2)}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600 }}>FLAT STAKE P&L</div>
        </div>
        <div style={{ background: 'var(--surface2)', borderRadius: 8, padding: '10px 8px', textAlign: 'center' }}>
          <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'Bebas Neue, sans-serif', color: data.kellyBank >= 1000 ? 'var(--green)' : 'var(--red)' }}>
            {data.kellyBank >= 1000 ? '+' : ''}£{(data.kellyBank - 1000).toFixed(2)}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600 }}>KELLY P&L</div>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={140}>
        <LineChart data={chartData} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis dataKey="game" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
          <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={v => `£${v}`} />
          <Tooltip formatter={v => `£${v}`} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 12 }} />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
          <Line type="monotone" dataKey="flat"  stroke="var(--blue-light)" strokeWidth={2} dot={false} name="Flat" />
          <Line type="monotone" dataKey="kelly" stroke="var(--gold)"       strokeWidth={2} dot={false} name="Kelly" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function outcomeFromScore(scoreStr) {
  // Handles both hyphen "2-1" and en-dash "2–1" variants
  const parts = scoreStr.split(/[-–]/).map(Number);
  if (parts.length !== 2 || parts.some(isNaN)) return null;
  const [h, a] = parts;
  return h > a ? 'H' : h < a ? 'A' : 'D';
}

function classifyPrediction(p) {
  if (!p.result) return 'pending';

  const { homeGoals, awayGoals } = p.result;
  const actual    = homeGoals > awayGoals ? 'H' : homeGoals < awayGoals ? 'A' : 'D';
  const predScore = p.prediction?.predictedScore;

  if (!predScore) return 'pending';

  if (predScore.replace('–', '-') === `${homeGoals}-${awayGoals}`) return 'exact';

  const predicted = outcomeFromScore(predScore);
  if (predicted === null) return 'wrong';

  return predicted === actual ? 'correct' : 'wrong';
}

const STATUS_META = {
  exact:   { label: '★ Exact',   color: 'var(--gold)',       bg: 'rgba(219,161,17,0.12)', border: 'rgba(219,161,17,0.35)' },
  correct: { label: '✓ Correct', color: 'var(--green)',      bg: 'rgba(34,197,94,0.10)',  border: 'rgba(34,197,94,0.30)'  },
  wrong:   { label: '✗ Wrong',   color: 'var(--red)',        bg: 'rgba(239,68,68,0.10)',  border: 'rgba(239,68,68,0.30)'  },
  pending: { label: 'Pending',   color: 'var(--text-muted)', bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.12)' },
};

function safeDate(raw) {
  try {
    const d = raw ? (typeof raw === 'string' ? parseISO(raw) : new Date(raw)) : null;
    return d && isValid(d) ? d : null;
  } catch { return null; }
}

const STATUS_ACCENT = {
  exact:   'var(--gold)',
  correct: 'var(--green)',
  wrong:   'var(--red)',
  pending: 'rgba(255,255,255,0.12)',
};

// Renders a crest img for non-PL teams (which have a crest URL), falls back to
// ClubBadge SVG for PL teams (which have a FPL team code).
function TeamBadge({ team, size }) {
  if (team?.crest) {
    return (
      <img
        src={team.crest}
        alt={team.shortName ?? team.short ?? ''}
        style={{ width: size, height: size, objectFit: 'contain', flexShrink: 0 }}
      />
    );
  }
  return <ClubBadge code={team?.code} short={team?.shortName ?? team?.short} size={size} />;
}

function PredictionRow({ p }) {
  const status = classifyPrediction(p);
  const { label, color, bg, border } = STATUS_META[status];
  const accent = STATUS_ACCENT[status];

  const predScore   = p.prediction?.predictedScore?.replace('-', '–') ?? '?–?';
  const actualScore = p.result ? `${p.result.homeGoals}–${p.result.awayGoals}` : null;

  return (
    <div style={{
      background: 'var(--surface2)',
      borderRadius: 10,
      padding: '12px 14px',
      marginBottom: 8,
      border: '1px solid var(--border)',
      borderLeft: `3px solid ${accent}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
          <TeamBadge team={p.homeTeam} size={18} />
          <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {p.homeTeam?.name ?? p.homeTeam?.short ?? '?'}
          </span>
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>vs</span>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'right' }}>
            {p.awayTeam?.name ?? p.awayTeam?.short ?? '?'}
          </span>
          <TeamBadge team={p.awayTeam} size={18} />
        </div>
      </div>

      <div style={{
        borderTop: '1px solid var(--border)',
        borderBottom: '1px solid var(--border)',
        padding: '8px 0',
        marginBottom: 10,
        display: 'flex',
        alignItems: 'center',
        justifyContent: actualScore ? 'space-between' : 'center',
        gap: 8,
      }}>
        {actualScore ? (
          <>
            <div style={{ textAlign: 'center', flex: 1 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 2 }}>Predicted</div>
              <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 20, letterSpacing: 1, color: 'var(--text-muted)' }}>{predScore}</div>
            </div>
            <span style={{ fontSize: 16, color: 'var(--text-muted)', opacity: 0.35, flexShrink: 0 }}>→</span>
            <div style={{ textAlign: 'center', flex: 1 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 2 }}>Actual</div>
              <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 24, letterSpacing: 1, color: 'var(--text)' }}>{actualScore}</div>
            </div>
          </>
        ) : (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 2 }}>Predicted</div>
            <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 22, letterSpacing: 1, color: 'var(--text-muted)' }}>{predScore}</div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div style={{
          fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 10,
          color, background: bg, border: `1px solid ${border}`,
          whiteSpace: 'nowrap', letterSpacing: 0.3,
        }}>
          {label}
        </div>
      </div>
    </div>
  );
}

function TrackerHistory({ leagueId }) {
  const { data, loading } = useTrackerHistory(leagueId);
  const [selectedGW, setSelectedGW] = useState(null);
  const isPL = leagueId === 'premier-league';
  const gwLabel = isPL ? 'Gameweek' : 'Matchday';

  if (loading) return <div className="loading-card" style={{ padding: 20 }}><div className="spinner" /></div>;

  const all = data?.predictions ?? [];

  if (!all.length) return (
    <div className="card">
      <div className="card-title">History</div>
      <div className="text-muted fs-13" style={{ padding: '8px 0' }}>
        No predictions yet — auto-saved whenever a fixture is loaded.
      </div>
    </div>
  );

  const byGW = [];
  const gwMap = new Map();
  for (const p of all) {
    const gw = p.gameweek ?? 0;
    // Skip GW0/null; for PL also skip GW1 (pre-season anomaly)
    if (!gw || (isPL && gw === 1)) continue;
    if (!gwMap.has(gw)) { gwMap.set(gw, []); byGW.push(gw); }
    gwMap.get(gw).push(p);
  }
  byGW.sort((a, b) => b - a);
  for (const gw of byGW) {
    gwMap.get(gw).sort((a, b) => {
      const da = safeDate(a.kickoff), db = safeDate(b.kickoff);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da - db;
    });
  }

  const currentGW = data?.currentGW ?? null;
  const activeGW = selectedGW ?? (currentGW && gwMap.has(currentGW) ? currentGW : byGW[0]);
  const rows = gwMap.get(activeGW) ?? [];

  const gwCompleted = rows.filter(p => p.result);
  const gwExact     = gwCompleted.filter(p => classifyPrediction(p) === 'exact').length;
  const gwCorrect   = gwCompleted.filter(p => classifyPrediction(p) === 'correct').length;
  const gwWrong     = gwCompleted.filter(p => classifyPrediction(p) === 'wrong').length;
  const gwAccuracy  = gwCompleted.length ? Math.round((gwExact + gwCorrect) / gwCompleted.length * 100) : null;

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div className="card-title" style={{ margin: 0 }}>History</div>
        {gwAccuracy !== null && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'right' }}>
            <span style={{ color: 'var(--gold)', fontWeight: 700 }}>{gwAccuracy}%</span>
            {' · '}{gwExact}★ {gwCorrect}✓ {gwWrong}✗
          </div>
        )}
      </div>

      <select
        value={activeGW}
        onChange={e => setSelectedGW(Number(e.target.value))}
        style={{
          width: '100%',
          marginBottom: 16,
          padding: '8px 12px',
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: 'var(--surface2)',
          color: 'var(--text)',
          fontSize: 13,
          fontWeight: 600,
          fontFamily: 'inherit',
          cursor: 'pointer',
          appearance: 'none',
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 12px center',
          paddingRight: 32,
        }}
      >
        {byGW.map(gw => {
          const gwRows = gwMap.get(gw);
          const settled = gwRows.filter(p => p.result).length;
          return (
            <option key={gw} value={gw}>
              {gw === 0 ? `Unknown ${gwLabel}` : `${gwLabel} ${gw}`} — {settled}/{gwRows.length} settled
            </option>
          );
        })}
      </select>

      {rows.map((p, i) => (
        <PredictionRow key={p.fixtureId ?? `${activeGW}-${i}`} p={p} />
      ))}
    </div>
  );
}

export default function Stats() {
  const { leagueId } = useParams();
  const isPL  = leagueId === 'premier-league';
  const league = getLeague(leagueId);

  const [tab, setTab] = useState(isPL ? 'accuracy' : 'scorers');

  return (
    <div>
      <div className="section-title">{isPL ? 'Analytics' : `${league.name} stats`}</div>

      <div className="tab-row">
        {/* Non-PL league tabs */}
        {!isPL && (
          <>
            <button className={`tab-btn${tab === 'scorers' ? ' active' : ''}`} onClick={() => setTab('scorers')}>
              Scorers
            </button>
            <button className={`tab-btn${tab === 'league' ? ' active' : ''}`} onClick={() => setTab('league')}>
              League
            </button>
            <button className={`tab-btn${tab === 'form' ? ' active' : ''}`} onClick={() => setTab('form')}>
              Form
            </button>
          </>
        )}
        {/* Analytics tabs — all leagues */}
        <button className={`tab-btn${tab === 'accuracy' ? ' active' : ''}`} onClick={() => setTab('accuracy')}>
          Accuracy
        </button>
        <button className={`tab-btn${tab === 'tracker' ? ' active' : ''}`} onClick={() => setTab('tracker')}>
          History
        </button>
      </div>

      {/* Non-PL league content tabs */}
      {!isPL && tab === 'scorers' && <TopScorers leagueId={leagueId} />}
      {!isPL && tab === 'league'  && <LeagueStats leagueId={leagueId} />}
      {!isPL && tab === 'form'    && <FormTable   leagueId={leagueId} />}

      {/* Analytics tabs — shared by all leagues */}
      {tab === 'accuracy' && (
        <>
          <AccuracyCard    leagueId={leagueId} />
          <CalibrationCard leagueId={leagueId} />
        </>
      )}
      {tab === 'tracker' && <TrackerHistory leagueId={leagueId} />}
    </div>
  );
}
