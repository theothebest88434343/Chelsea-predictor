// Accepts pre-fetched data from parent (to avoid double-fetch when wrapper already has it)
export default function WeatherPanel({ data }) {
  if (!data?.available) return null;

  const windHigh  = data.windKph > 40;

  return (
    <div>
      <div className="card-title" style={{ marginBottom: 8 }}>Weather forecast</div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 32 }}>{data.icon}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{data.condition}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{data.stadium}</div>
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 20, color: 'var(--text)', lineHeight: 1 }}>
              {data.temperature}°C
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>TEMP</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{
              fontFamily: 'Bebas Neue, sans-serif', fontSize: 20, lineHeight: 1,
              color: data.precipChance > 60 ? 'var(--blue-light)' : 'var(--text)',
            }}>
              {data.precipChance}%
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>RAIN</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{
              fontFamily: 'Bebas Neue, sans-serif', fontSize: 20, lineHeight: 1,
              color: windHigh ? 'var(--gold)' : 'var(--text)',
            }}>
              {data.windKph}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>KPH WIND</div>
          </div>
        </div>
      </div>
      {data.notes?.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {data.notes.map((note, i) => (
            <div key={i} style={{
              fontSize: 11, color: 'var(--text-muted)', background: 'var(--surface2)',
              borderRadius: 4, padding: '4px 8px', borderLeft: '2px solid var(--gold)',
            }}>
              ⚠ {note}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
