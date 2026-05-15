function Bar({ value, max, color }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div style={{ background: 'var(--surface2)', borderRadius: 4, height: 8, overflow: 'hidden', flex: 1 }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4, transition: 'width 0.4s ease' }} />
    </div>
  );
}

function StatRow({ label, homeVal, awayVal, color = 'var(--blue-light)', higherIsBetter = true }) {
  const max = Math.max(homeVal, awayVal, 0.01);
  const homeWins = higherIsBetter ? homeVal >= awayVal : homeVal <= awayVal;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
        <span style={{ fontWeight: 700, color: homeWins ? 'var(--text)' : 'var(--text-muted)' }}>
          {homeVal.toFixed(2)}
        </span>
        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{label}</span>
        <span style={{ fontWeight: 700, color: !homeWins ? 'var(--text)' : 'var(--text-muted)' }}>
          {awayVal.toFixed(2)}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <Bar value={homeVal} max={max} color={color} />
        <Bar value={awayVal} max={max} color="rgba(150,50,50,0.7)" />
      </div>
    </div>
  );
}

export default function XGPanel({ lambdas, strengths, homeTeam, awayTeam }) {
  if (!lambdas) return null;

  return (
    <div>
      <div className="card-title" style={{ marginBottom: 4 }}>Model inputs</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
        <span>{homeTeam?.shortName}</span>
        <span>{awayTeam?.shortName}</span>
      </div>

      <StatRow
        label="Expected goals (λ)"
        homeVal={lambdas.home}
        awayVal={lambdas.away}
        color="var(--blue-light)"
      />
      {strengths && (
        <>
          <StatRow
            label="Attack strength"
            homeVal={strengths.hAtk ?? 1}
            awayVal={strengths.aAtk ?? 1}
          />
          <StatRow
            label="Defence strength"
            homeVal={strengths.hDef ?? 1}
            awayVal={strengths.aDef ?? 1}
            higherIsBetter={false}
            color="var(--gold)"
          />
        </>
      )}
    </div>
  );
}
