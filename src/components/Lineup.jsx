// Displays a predicted formation grid (data from SofaScore if available, else placeholder)

const FORMATIONS = {
  '4-3-3': [
    { row: 'GK',  players: ['GK'] },
    { row: 'DEF', players: ['RB', 'CB', 'CB', 'LB'] },
    { row: 'MID', players: ['CM', 'CM', 'CM'] },
    { row: 'FWD', players: ['RW', 'ST', 'LW'] },
  ],
  '4-2-3-1': [
    { row: 'GK',  players: ['GK'] },
    { row: 'DEF', players: ['RB', 'CB', 'CB', 'LB'] },
    { row: 'DM',  players: ['DM', 'DM'] },
    { row: 'AM',  players: ['RAM', 'CAM', 'LAM'] },
    { row: 'FWD', players: ['ST'] },
  ],
  '3-4-3': [
    { row: 'GK',  players: ['GK'] },
    { row: 'DEF', players: ['CB', 'CB', 'CB'] },
    { row: 'MID', players: ['RM', 'CM', 'CM', 'LM'] },
    { row: 'FWD', players: ['RW', 'ST', 'LW'] },
  ],
};

function PlayerDot({ label, name }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
      <div style={{
        width: 36, height: 36, borderRadius: '50%',
        background: 'var(--blue)', border: '2px solid rgba(255,255,255,0.15)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 10, fontWeight: 700, color: '#fff', letterSpacing: 0.3,
      }}>
        {label}
      </div>
      {name && (
        <div style={{ fontSize: 9, color: 'var(--text-muted)', textAlign: 'center', maxWidth: 40, lineHeight: 1.2 }}>
          {name}
        </div>
      )}
    </div>
  );
}

export default function Lineup({ formation = '4-3-3', players = {}, teamName = '' }) {
  const rows = FORMATIONS[formation] ?? FORMATIONS['4-3-3'];

  return (
    <div>
      <div className="card-title" style={{ marginBottom: 4 }}>
        {teamName ? `${teamName} lineup` : 'Predicted lineup'}
      </div>
      <div style={{ fontSize: 11, color: 'var(--gold)', marginBottom: 12, letterSpacing: 0.5 }}>
        {formation}
      </div>
      <div
        style={{
          background: 'linear-gradient(180deg, #1a3a1a 0%, #0d2010 100%)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 'var(--radius)',
          padding: '16px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {rows.map(({ row, players: positions }) => (
          <div key={row} style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'center' }}>
            {positions.map((pos, i) => (
              <PlayerDot key={i} label={pos} name={players[pos]} />
            ))}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
        Formation from SofaScore when available, else predicted
      </div>
    </div>
  );
}
