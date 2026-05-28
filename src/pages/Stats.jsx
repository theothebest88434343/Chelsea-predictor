import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { format, parseISO, isValid } from 'date-fns';
import { useSeasonAccuracy, useBettingSim, useTrackerHistory } from '../hooks/useHistory';
import { useFetch } from '../hooks/useFetch';
import ClubBadge from '../components/ClubBadge';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, ScatterChart, Scatter, ReferenceLine,
} from 'recharts';

// ─── Stat row — secondary / supporting metric ──────────────────────────────────
function StatRow({ label, sublabel, value, subvalue }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{label}</div>
        {sublabel && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{sublabel}</div>}
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'Bebas Neue, sans-serif', color: 'var(--text)' }}>
          {value}
        </div>
        {subvalue && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{subvalue}</div>}
      </div>
    </div>
  );
}

// ─── Accuracy card — unified season performance view ───────────────────────────
// Reads from the v2 /api/season-accuracy contract.
// predictionAccuracy (score_based)  = primary user-facing metric
// modelAccuracy (probability_argmax) = secondary model health metric
// calibration (probability_based)    = advanced / collapsed by default
function AccuracyCard({ leagueId }) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const { data, loading } = useSeasonAccuracy(leagueId);

  if (loading) return <div className="loading-card" style={{ padding: 20 }}><div className="spinner" /></div>;
  if (!data || data.meta?.total === 0) return (
    <div className="card">
      <div className="card-title">Season performance</div>
      <div className="text-muted fs-13">No tracked predictions yet. Predictions are saved automatically before each game.</div>
    </div>
  );

  const { meta, predictionAccuracy, modelAccuracy, calibration, byGameweek } = data;
  const total   = meta?.total ?? 0;
  const gwLabel = leagueId === 'premier-league' ? 'GW' : 'MD';

  // Plain-English confidence quality label from Brier score.
  // Brier = 0 (perfect) … 0.67 (random baseline for 3-outcome events).
  const brierLabel = calibration?.brier == null ? null
    : calibration.brier < 0.52 ? 'Well calibrated'
    : calibration.brier < 0.60 ? 'Reasonably calibrated'
    : 'Needs improvement';

  const chartData = (byGameweek ?? []).map(d => ({
    gw:    d.gameweek,
    rate:  d.predictionAccuracy.rate,
    model: d.modelAccuracy.rate,
  }));

  // Calibration curve data — already in the v2 response, no extra fetch needed.
  const calibCurve = (calibration?.curve ?? []).map(b => ({
    predicted: +(b.meanPredicted * 100).toFixed(0),
    actual:    b.meanActual,
    n:         b.count,
  }));

  return (
    <div className="card">
      <div className="card-title">Season performance</div>

      {/* ── PRIMARY: hero prediction accuracy ─────────────────────────────────── */}
      <div style={{ textAlign: 'center', padding: '4px 0 20px' }}>
        <div style={{
          fontSize: 64, fontWeight: 700, fontFamily: 'Bebas Neue, sans-serif',
          color: 'var(--gold)', lineHeight: 1,
        }}>
          {(predictionAccuracy.rate * 100).toFixed(1)}%
        </div>
        <div style={{ fontSize: 14, color: 'var(--text)', marginTop: 6, fontWeight: 500 }}>
          Correct outcome predicted
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
          {predictionAccuracy.correct} of {total} games
          {predictionAccuracy.exact > 0 && ` · ${predictionAccuracy.exact} exact scores`}
        </div>
      </div>

      {/* ── DIVIDER ────────────────────────────────────────────────────────────── */}
      <div style={{ borderTop: '1px solid var(--border)', margin: '0 0 16px' }} />

      {/* ── SECONDARY: model + confidence ─────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
        <StatRow
          label="Probability model"
          sublabel="Most likely winner based on match odds and form"
          value={`${(modelAccuracy.rate * 100).toFixed(1)}%`}
          subvalue={`${modelAccuracy.correct} / ${total}`}
        />
        {brierLabel && (
          <StatRow
            label="Confidence quality"
            sublabel={`${brierLabel} · 0 = perfect, lower is better`}
            value={calibration.brier.toFixed(3)}
          />
        )}
      </div>

      {/* ── COLLAPSIBLE: breakdown by gameweek + calibration chart ────────────── */}
      <button
        onClick={() => setShowBreakdown(v => !v)}
        style={{
          width: '100%', padding: '8px 12px', borderRadius: 8,
          border: '1px solid var(--border)', background: 'var(--surface2)',
          color: 'var(--text-muted)', fontSize: 12, fontWeight: 600,
          cursor: 'pointer', fontFamily: 'inherit',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}
      >
        <span>{showBreakdown ? 'Hide breakdown' : 'Show breakdown by ' + (leagueId === 'premier-league' ? 'gameweek' : 'matchday')}</span>
        <span style={{ fontSize: 10, opacity: 0.6 }}>{showBreakdown ? '▲' : '▼'}</span>
      </button>

      {showBreakdown && chartData.length > 0 && (
        <div style={{ marginTop: 16 }}>

          {/* Per-GW bars */}
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>
            Accuracy by {leagueId === 'premier-league' ? 'gameweek' : 'matchday'}
          </div>
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={chartData} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis
                dataKey="gw"
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                label={{ value: gwLabel, position: 'insideBottomRight', offset: -4, fontSize: 9, fill: 'var(--text-muted)' }}
              />
              <YAxis domain={[0,1]} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={v => `${(v*100).toFixed(0)}%`} />
              <Tooltip
                formatter={(v, name) => [`${(v * 100).toFixed(0)}%`, name === 'rate' ? 'Prediction' : 'Model']}
                contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 12 }}
              />
              <Bar dataKey="rate"  fill="var(--blue)"              radius={[3,3,0,0]} name="Prediction" />
              <Bar dataKey="model" fill="rgba(255,255,255,0.10)"   radius={[3,3,0,0]} name="Model" />
            </BarChart>
          </ResponsiveContainer>

          {/* Calibration scatter — only if enough data points */}
          {calibCurve.length >= 3 && (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 20, marginBottom: 4, fontWeight: 600 }}>
                Confidence calibration
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                When we say 60% chance — does it happen 60% of the time? Points on the line = perfect.
              </div>
              <ResponsiveContainer width="100%" height={160}>
                <ScatterChart margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="predicted" type="number" domain={[0,100]}
                    tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                    label={{ value: 'We said…', position: 'insideBottom', dy: 14, fontSize: 10, fill: 'var(--text-muted)' }} />
                  <YAxis dataKey="actual" type="number" domain={[0,1]}
                    tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                    tickFormatter={v => `${(v*100).toFixed(0)}%`} />
                  <Tooltip
                    formatter={(v) => typeof v === 'number' ? (v < 2 ? `${(v*100).toFixed(1)}%` : `${v}%`) : v}
                    contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 12 }}
                  />
                  <ReferenceLine segment={[{x:0,y:0},{x:100,y:1}]} stroke="rgba(255,255,255,0.2)" strokeDasharray="4 4" />
                  <Scatter data={calibCurve} fill="var(--gold)" />
                </ScatterChart>
              </ResponsiveContainer>
            </>
          )}

          {/* Log loss footnote */}
          {calibration?.logLoss != null && (
            <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-muted)' }}>
              Log loss <strong style={{ color: 'var(--text)' }}>{calibration.logLoss.toFixed(4)}</strong>
              <span style={{ marginLeft: 8 }}>· random baseline ≈ 1.099 · lower is better</span>
            </div>
          )}
        </div>
      )}
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

  const normalised = predScore.replace(/–/g, '-');

  // ★ Exact: displayed predicted score matches actual score exactly
  if (normalised === `${homeGoals}-${awayGoals}`) return 'exact';

  // ✓/✗: use outcome implied by the DISPLAYED predicted score, not model probabilities.
  // e.g. "Predicted 1-1, actual 2-0" → score says D, actual is H → Wrong
  //      "Predicted 2-1, actual 1-0" → score says H, actual is H → Correct
  const predictedOutcome = outcomeFromScore(normalised);
  if (predictedOutcome === null) return 'wrong';
  return predictedOutcome === actual ? 'correct' : 'wrong';
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

// Fetches live predictions for all unplayed fixtures in a given FD matchday.
// Used as a fallback in TrackerHistory when the current matchday has no settled results.
function useFdMatchdayPredictions(leagueId, matchday, enabled) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !leagueId || !matchday) { setData(null); return; }
    let cancelled = false;
    setLoading(true);

    fetch(`/api/fd/fixtures?league=${leagueId}`)
      .then(r => r.json())
      .then(j => {
        if (cancelled) return;
        const fixtures = (Array.isArray(j) ? j : j.fixtures ?? [])
          .filter(f => f.matchday === matchday && !f.finished);
        return Promise.all(
          fixtures.map(f =>
            fetch(`/api/fd/predictions?league=${leagueId}&fixtureId=${f.id}`)
              .then(r => r.ok ? r.json() : null)
              .catch(() => null)
              .then(pred => pred?.prediction ? {
                fixtureId:  f.id,
                gameweek:   f.matchday,
                kickoff:    f.kickoffTime,
                homeTeam:   f.homeTeam,
                awayTeam:   f.awayTeam,
                prediction: pred.prediction,
                result:     null,
              } : null)
          )
        );
      })
      .then(rows => {
        if (!cancelled) { setData((rows ?? []).filter(Boolean)); setLoading(false); }
      })
      .catch(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [leagueId, matchday, enabled]);

  return { data, loading };
}

function TrackerHistory({ leagueId }) {
  const { data, loading } = useTrackerHistory(leagueId);
  const [selectedGW, setSelectedGW] = useState(null);
  const isPL    = leagueId === 'premier-league';
  const gwLabel = isPL ? 'Gameweek' : 'Matchday';

  // Server is the sole authority on which rounds are complete.
  // completedRounds is ordered by completed_at DESC (real completion order — safe
  // for Brazil where matchday N can complete before matchday N-1).
  // completedGWs is the legacy numeric alias kept for backward compat.
  const serverGW       = data?.currentGW ?? null;
  const completedRounds = data?.completedRounds ?? [];
  const completedSet   = new Set(data?.completedGWs ?? []);
  // roundCompletionOrder: maps GW number → completion rank (0 = most recent)
  // Used to sort the History dropdown by real completion time, not by GW number.
  const roundCompletionRank = new Map(
    completedRounds.map((r, i) => [Number(r.external_round_id), i])
  );

  // liveGW: the GW the live-predictions fallback should target.
  // PL: take max(serverGW, all stored GWs) — FPL is_current can lag.
  // FD: use serverGW directly — preFill stores future MDs that would inflate max.
  const liveGW = data
    ? (isPL
        ? (Math.max(serverGW ?? 0, ...(data.predictions ?? []).map(p => p.gameweek ?? 0)) || null)
        : serverGW)
    : null;

  // showLiveFallback: current GW is not yet in the server's completedGWs list.
  // The server is the single source of truth — no re-derivation on the client.
  const showLiveFallback = liveGW !== null && !completedSet.has(liveGW);

  // PL live-fallback data (bulk endpoint, only fetched when needed)
  const { data: livePredData, loading: liveLoadingPL } = useFetch(
    isPL && showLiveFallback && liveGW ? `/api/predict-gameweek?gw=${liveGW}` : null
  );

  // FD live-fallback data (per-fixture fetch, only fetched when needed)
  const { data: fdLiveData, loading: liveLoadingFD } = useFdMatchdayPredictions(
    !isPL && showLiveFallback ? leagueId : null,
    liveGW,
    !isPL && showLiveFallback && !!liveGW
  );

  const liveLoading = isPL ? liveLoadingPL : liveLoadingFD;

  if (loading) return <div className="loading-card" style={{ padding: 20 }}><div className="spinner" /></div>;

  const all = data?.predictions ?? [];

  // Build GW map — only include GWs the server says are complete.
  // Dedup by fixtureId within each GW: keep the entry with a result; if multiple
  // settled entries exist, keep the one with the latest trackedAt.
  const byGW  = [];
  const gwMap = new Map();

  for (const p of all) {
    const gw = p.gameweek ?? 0;
    // Exclude: no GW, PL GW1 (warm-up round), and any GW the server hasn't marked complete.
    if (!gw || (isPL && gw === 1) || !completedSet.has(gw)) continue;
    if (!gwMap.has(gw)) { gwMap.set(gw, new Map()); byGW.push(gw); }
    const gwFixtures = gwMap.get(gw);
    const existing   = gwFixtures.get(p.fixtureId);
    // Prefer settled over unsettled; among settled, prefer newest trackedAt.
    if (!existing) {
      gwFixtures.set(p.fixtureId, p);
    } else if (p.result && !existing.result) {
      gwFixtures.set(p.fixtureId, p); // settled wins over unsettled
    } else if (p.result && existing.result) {
      const tNew = safeDate(p.trackedAt)?.getTime() ?? 0;
      const tOld = safeDate(existing.trackedAt)?.getTime() ?? 0;
      if (tNew > tOld) gwFixtures.set(p.fixtureId, p); // newer settled wins
    }
  }
  // Sort by real completion order from server (completed_at DESC), not by GW
  // number. This fixes non-linear leagues (Brazil) where matchday N+1 can
  // complete before matchday N due to postponements.
  byGW.sort((a, b) => {
    const ra = roundCompletionRank.get(a) ?? 999;
    const rb = roundCompletionRank.get(b) ?? 999;
    return ra - rb; // lower rank = more recently completed = shown first
  });

  // Flatten fixture maps back to arrays and drop GWs with no settled entries.
  for (const gw of [...byGW]) {
    const rows = [...gwMap.get(gw).values()].filter(p => p.result);
    if (rows.length === 0) byGW.splice(byGW.indexOf(gw), 1);
    else gwMap.set(gw, rows);
  }

  // ── Live-fallback view: current GW not yet complete ───────────────────────────
  if (showLiveFallback) {
    if (liveLoading) return <div className="loading-card" style={{ padding: 20 }}><div className="spinner" /></div>;

    const rawLive = isPL
      ? (livePredData ?? []).map(f => ({
          fixtureId:  f.fixtureId,
          gameweek:   f.gameweek,
          kickoff:    f.kickoff,
          homeTeam:   f.homeTeam,
          awayTeam:   f.awayTeam,
          prediction: f.prediction,
          result:     null,
        }))
      : (fdLiveData ?? []);

    const liveRows = [...rawLive].sort((a, b) => {
      const da = safeDate(a.kickoff), db = safeDate(b.kickoff);
      return da && db ? da - db : 0;
    });

    // Build gwMap for completed rounds so the dropdown works alongside live view
    const liveByGW  = [];
    const liveGwMap = new Map();
    for (const p of all) {
      const gw = p.gameweek ?? 0;
      if (!gw || (isPL && gw === 1) || !completedSet.has(gw)) continue;
      if (!liveGwMap.has(gw)) { liveGwMap.set(gw, []); liveByGW.push(gw); }
      liveGwMap.get(gw).push(p);
    }
    liveByGW.sort((a, b) => {
      const ra = roundCompletionRank.get(a) ?? 999;
      const rb = roundCompletionRank.get(b) ?? 999;
      return ra - rb;
    });

    const activeLiveGW = selectedGW && completedSet.has(selectedGW) ? selectedGW : null;
    const historyRows  = activeLiveGW ? (liveGwMap.get(activeLiveGW) ?? []) : null;

    return (
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div className="card-title" style={{ margin: 0 }}>History</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {activeLiveGW ? null : `${gwLabel} ${liveGW} · live predictions`}
          </div>
        </div>

        {liveByGW.length > 0 && (
          <select
            value={activeLiveGW ?? ''}
            onChange={e => setSelectedGW(e.target.value ? Number(e.target.value) : null)}
            style={{
              width: '100%', marginBottom: 16, padding: '8px 12px',
              borderRadius: 8, border: '1px solid var(--border)',
              background: 'var(--surface2)', color: 'var(--text)',
              fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
              cursor: 'pointer', appearance: 'none',
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`,
              backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center', paddingRight: 32,
            }}
          >
            <option value="">{gwLabel} {liveGW} · live predictions</option>
            {liveByGW.map(gw => (
              <option key={gw} value={gw}>
                {gwLabel} {gw} — {liveGwMap.get(gw).length} games
              </option>
            ))}
          </select>
        )}

        {historyRows ? (
          historyRows.length === 0
            ? <div className="text-muted fs-13" style={{ padding: '8px 0' }}>No results found.</div>
            : historyRows.map((p, i) => <PredictionRow key={p.fixtureId ?? `${activeLiveGW}-${i}`} p={p} />)
        ) : (
          liveRows.length === 0
            ? <div className="text-muted fs-13" style={{ padding: '8px 0' }}>No predictions available yet.</div>
            : liveRows.map((p, i) => <PredictionRow key={p.fixtureId ?? i} p={p} />)
        )}
      </div>
    );
  }

  // ── No completed GWs yet ───────────────────────────────────────────────────────
  if (!byGW.length) return (
    <div className="card">
      <div className="card-title">History</div>
      <div className="text-muted fs-13" style={{ padding: '8px 0' }}>
        No completed gameweeks yet — results appear here once a full round is settled.
      </div>
    </div>
  );

  // Sort each GW's rows by kickoff ascending
  for (const gw of byGW) {
    gwMap.get(gw).sort((a, b) => {
      const da = safeDate(a.kickoff), db = safeDate(b.kickoff);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da - db;
    });
  }

  // Default to the most-recently-completed GW (byGW[0] is the highest, since sorted desc).
  // Prefer the server's currentGW if it is in the completed list.
  const defaultGW = serverGW && completedSet.has(serverGW) ? serverGW : byGW[0];
  const activeGW  = (selectedGW && completedSet.has(selectedGW)) ? selectedGW : defaultGW;
  const rows      = gwMap.get(activeGW) ?? [];

  // All rows are settled (gwMap only holds completed GWs) — classify directly.
  const gwExact   = rows.filter(p => classifyPrediction(p) === 'exact').length;
  const gwCorrect = rows.filter(p => classifyPrediction(p) === 'correct').length;
  const gwWrong   = rows.filter(p => classifyPrediction(p) === 'wrong').length;
  const gwAccuracy = rows.length ? Math.round((gwExact + gwCorrect) / rows.length * 100) : null;

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
          width: '100%', marginBottom: 16, padding: '8px 12px',
          borderRadius: 8, border: '1px solid var(--border)',
          background: 'var(--surface2)', color: 'var(--text)',
          fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
          cursor: 'pointer', appearance: 'none',
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`,
          backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center', paddingRight: 32,
        }}
      >
        {byGW.map(gw => {
          const gwRows = gwMap.get(gw);
          return (
            <option key={gw} value={gw}>
              {gwLabel} {gw} — {gwRows.length} games
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
  const [tab, setTab] = useState('accuracy');

  return (
    <div>
      <div className="section-title">Analytics</div>

      <div className="tab-row">
        {/* Analytics tabs — all leagues */}
        <button className={`tab-btn${tab === 'accuracy' ? ' active' : ''}`} onClick={() => setTab('accuracy')}>
          Accuracy
        </button>
        <button className={`tab-btn${tab === 'tracker' ? ' active' : ''}`} onClick={() => setTab('tracker')}>
          History
        </button>
      </div>

      {tab === 'accuracy' && <AccuracyCard leagueId={leagueId} />}
      {tab === 'tracker' && <TrackerHistory leagueId={leagueId} />}
    </div>
  );
}
