# Chelsea Pred

Predicts scorelines and outcomes for Chelsea fixtures using a Poisson + Dixon-Coles model blended with xG data, form, H2H, ELO ratings, and live market odds. Tracks predictions across the season and scores itself.

Built with React + Vite on the frontend, Express on the backend. Data from the FPL API and Understat. AI pre-match reports via Groq.

## Running locally

```bash
npm install
npm run dev
```

Needs a `.env` with:

```
GROQ_API_KEY=
ODDS_API_KEY=
VAPID_PUBLIC_KEY=
VAPID_SECRET_KEY=
PORT=3001
```

- Groq: [console.groq.com](https://console.groq.com) (free)
- Odds API: [the-odds-api.com](https://the-odds-api.com) (free tier)
- VAPID keys: `npx web-push generate-vapid-keys`

## Production

```bash
npm run build && npm start
```

Deployed on Railway.
