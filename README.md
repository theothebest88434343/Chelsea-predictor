# MatchIQ

![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white)
![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?logo=supabase&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

**MatchIQ** is a full-stack football analytics and prediction platform. Pick any team across six of Europe's top leagues, get statistically-grounded match predictions before every game, track how accurate those predictions were, and run a simulated betting portfolio — all in a clean mobile-first UI.

> 🔗 **Live demo:** [matchiq.up.railway.app](https://matchiq.up.railway.app)

---

## Table of Contents

- [Features](#features)
- [How the Prediction Model Works](#how-the-prediction-model-works)
- [Model Performance](#model-performance)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)

---

## Features

### 🌍 Six Leagues
Premier League, La Liga, Bundesliga, Serie A, Ligue 1, and a World Cup / tournament mode. Each league has its own home dashboard, fixtures list, standings table, and team stats page.

### 📊 Match Predictions
Every upcoming fixture gets a full prediction breakdown:
- **Predicted scoreline** — the single most probable score from the joint PMF
- **Win / draw / loss probabilities** — blended model + live market odds
- **Expected goals** (λ) for each team
- **Confidence badge** — calibrated signal strength (Low / Medium / High)
- **Why this prediction** — plain-English explanation of the key factors driving the model output (xG edge, attack vs defence matchup, total goals projection)

### 🧠 Score Matrix
A 6×6 heatmap of every scoreline from 0–0 to 5–5, with each cell shaded by probability. The modal cell (top score) is highlighted. Makes it easy to see whether a 1–0 or 2–1 is genuinely more likely, and how fat the tail risk is.

### 📈 Season Stats
Rolling form, season totals (W/D/L, GF/GA, points), and historical prediction accuracy for your team — stored persistently in Supabase.

### 💰 Betting Simulator
A paper-trading portfolio that places virtual bets on model predictions and tracks P&L over the season. Lets you stress-test a staking strategy without real money.

### 🏆 World Cup / Tournament Mode
Round-by-round predictions for international tournaments, with group stage standings and knockout bracket simulations via Monte Carlo.

### 📴 Off-Season Mode
When a league season ends, the team home page automatically switches to an off-season summary card: champion, top scorer, the user's team final position, season stats, and last 5 results — so the app always has something useful to show.

### 🔔 Push Notifications
Web-push alerts (VAPID) for upcoming fixtures and prediction results.

### ⚡ Live Countdown
Seconds-accurate countdown to every kickoff, live on the hero card.

---

## How the Prediction Model Works

The prediction engine (`models/predictionEngine.js`) is a layered statistical model. Here's how it works from input data to final probabilities.

### 1. Attack & Defence Ratings

Each team gets a rolling **attack strength** and **defence weakness** rating, updated after every match. The ratings use exponentially weighted moving averages (EWMA) so recent form counts more than results from three months ago. The weights decay geometrically — last week matters roughly 3× more than six weeks ago.

```
attackRating  = EWMA(goals scored   / league average goals scored)
defenceRating = EWMA(goals conceded / league average goals conceded)
```

A rating of 1.0 means exactly average. Arsenal with a 1.4 attack score are expected to score 40% more than a typical team against average opposition.

### 2. Expected Goals (λ)

The model computes an expected goal rate (λ) for each side — the Poisson rate parameter that drives everything downstream.

```
λ_home = leagueAvgHomeGoals × homeAttack × awayDefence × homeAdvantage
λ_away = leagueAvgAwayGoals × awayAttack × homeDefence
```

Where `homeAdvantage` is a league-specific constant (typically ~1.15 for the Premier League). When Understat xG data is available, the model blends in shot-quality-adjusted xG values alongside goals-based ratings to make the estimates more stable early in a season.

### 3. ELO Rating Blend

The raw lambda estimates can be noisy for teams with few matches. To smooth this out, the model maintains an **ELO rating** for every team, updated after each result using the standard ELO K-factor formula. Before computing λ, the model blends the form-based ratings with ELO-implied win probabilities using a weighted average. ELO acts as a regulariser — it pulls outlier ratings toward the long-run mean.

### 4. Bivariate Poisson Score Matrix

Given λ_home and λ_away, the model builds a **6×6 joint probability matrix** — every scoreline from 0–0 to 5–5 — using the bivariate Poisson distribution.

Under the independent Poisson model, `P(home=i, away=j) = Poisson(i; λH) × Poisson(j; λA)`. The problem is this underestimates draws (real football has a structural correlation at low scores). The bivariate extension introduces a covariance term that inflates joint probabilities at 0–0, 1–0, 0–1, and 1–1.

### 5. Dixon-Coles τ Correction

The **Dixon-Coles correction** (Dixon & Coles, 1997) applies a multiplicative adjustment factor τ to the four low-score cells:

| Score | τ adjustment |
|---|---|
| 0–0 | `τ(0,0) = 1 - λH·λA·ρ` |
| 1–0 | `τ(1,0) = 1 + λA·ρ` |
| 0–1 | `τ(0,1) = 1 + λH·ρ` |
| 1–1 | `τ(1,1) = 1 - ρ` |

The correlation parameter ρ is **dynamic** — it's computed as a function of the geometric mean of both lambdas, so high-scoring matches (where draws are rarer) get a smaller correction than tight matches. Additionally, when the two teams' expected goal rates are very close (|λH − λA| < 0.30), the model applies a further RHO boost toward −0.20, inflating 0–0 and 1–1 probabilities to better capture the draw tendency in evenly matched fixtures.

### 6. Home / Draw / Away Probabilities

The score matrix is summed along its diagonals:
```
P(home win) = Σ P(i,j) where i > j
P(draw)     = Σ P(i,j) where i = j
P(away win) = Σ P(i,j) where i < j
```

The **predicted scoreline** is the argmax cell of the matrix — the single most probable score. This is labelled "top score" in the UI rather than "predicted score" to set the right expectation: even the most likely individual scoreline rarely exceeds 20% probability.

### 7. Market Odds Blending

Raw model probabilities are blended with live bookmaker odds (sourced from The Odds API) to produce the final output. Bookmakers aggregate enormous amounts of information including team news, weather, referee history, and sharp-money positioning — signals the model cannot see. The blend uses:

```
finalProb = modelWeight × modelProb + (1 − modelWeight) × impliedOddsProb
```

The model weight is **adaptive**:
- Standard matches: 75% model / 25% market
- Close-match fixtures (|λH − λA| < 0.25): 65% model / **35% market**

The higher market weight on close games is intentional — bookmaker draw prices are the strongest available draw-detection signal, and the Poisson model structurally underpredicts draws (home win is almost always the modal outcome even for equal-strength teams).

### 8. Isotonic Calibration

The final step is **isotonic regression calibration** — a monotone non-parametric transform that maps raw model probabilities to empirical hit rates. Probabilities from statistical football models tend to be overconfident (a model saying 70% might actually be right only 58% of the time). Calibration fixes this without needing a parametric assumption, preserving the ranking of predictions while correcting the scale.

### 9. Monte Carlo Simulation (Tournaments)

For World Cup and tournament mode, the model runs **10,000 Monte Carlo simulations** of the remaining rounds. In each simulation, every match outcome is sampled from the model's probability distribution. The results are aggregated to produce "probability of reaching the quarter-final", "probability of winning the group", etc. — distributions rather than single point estimates.

---

## Model Performance

Backtested via walk-forward validation across the full 2025–26 season (predicting match N using only matches 0…N-1 as training data — no look-ahead). The backtest runs with **no market odds** to isolate the pure statistical signal.

| League | Matches | Accuracy | Log-loss | Brier |
|---|---|---|---|---|
| Bundesliga | 301 | **50.8%** | 1.0244 | 0.6137 |
| Premier League | 365 | 48.8% | 1.0446 | 0.6300 |
| Ligue 1 | 300 | 48.3% | 1.0304 | 0.6190 |
| La Liga | 365 | 47.1% | 1.0223 | 0.6129 |
| Serie A | 365 | 46.6% | 1.0510 | 0.6314 |
| **All leagues** | **1,696** | **48.2%** | **1.0345** | **0.6214** |

**Reference baselines:**

| Method | Accuracy | Log-loss | Brier |
|---|---|---|---|
| Random guess | ~33% | 1.099 | 0.667 |
| Always pick home win | ~45% | ~1.05 | ~0.640 |
| **MatchIQ (no market odds)** | **48.2%** | **1.035** | **0.621** |
| Betting markets | ~55% | ~0.93 | ~0.580 |
| Top academic models | ~57% | ~0.90 | ~0.560 |

The pure statistical model beats both the random baseline (+15pp) and the naive always-home strategy (+3pp) across nearly 1,700 matches. In production, live market odds blending adds an estimated +3–5pp, putting the live model in the 51–53% range — competitive with published academic models given the real-time data constraints.

Draw recall is structurally limited (~3–12% across leagues). This is a known limitation of Poisson-family models: home win is almost always the modal outcome in the joint PMF, even for perfectly matched teams. The adaptive market weight and dynamic RHO boost are the principled mitigations in production.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, React Router 6, Recharts, Lucide React |
| Build tool | Vite 5 |
| Backend | Node.js 20, Express 4 |
| Database | Supabase (PostgreSQL) |
| AI reports | Groq (Llama 3) |
| Scheduling | node-cron |
| Push notifications | web-push (VAPID) |
| Football data (PL) | FPL API (unofficial, free) |
| Football data (FD leagues) | football-data.org (free tier) |
| xG data | Understat (scraped) |
| Live odds | The Odds API |
| Deployment | Railway |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT (React)                       │
│  Home · Fixtures · League · Stats · WorldCup · Betting Sim  │
└────────────────────────┬────────────────────────────────────┘
                         │ REST API calls
┌────────────────────────▼────────────────────────────────────┐
│                    EXPRESS SERVER                            │
│                                                             │
│  Routes:                    Cron jobs:                      │
│  /api/fixtures              • Refresh FPL data (hourly)     │
│  /api/predictions/:id       • Refresh FD data (hourly)      │
│  /api/fd/matches            • Fetch live odds (pre-match)   │
│  /api/fd/league             • Save predictions (pre-KO)     │
│  /api/fd/scorers            • Score predictions (post-KO)   │
│  /api/stats                                                 │
│  /api/report/:id  (Groq)                                    │
└──────┬──────────────────────────────┬───────────────────────┘
       │                              │
┌──────▼──────┐            ┌──────────▼──────────────────────┐
│  Supabase   │            │       PREDICTION ENGINE          │
│  PostgreSQL │            │                                  │
│             │            │  1. Build rolling EWMA ratings   │
│  Tables:    │            │  2. Blend ELO regularisation     │
│  predictions│            │  3. Compute λH, λA               │
│  results    │            │  4. Build 6×6 Poisson matrix     │
│  team_stats │            │  5. Dixon-Coles τ correction      │
│  history    │            │  6. Dynamic RHO (close matches)  │
└─────────────┘            │  7. Sum → H/D/A probabilities    │
                           │  8. Adaptive market odds blend   │
                           │  9. Isotonic calibration         │
                           └──────────────────────────────────┘

Data sources:
  FPL API ──────────────► PL fixtures, results, team data
  football-data.org ────► La Liga, Bundesliga, Serie A, Ligue 1
  Understat ────────────► xG data (shot quality)
  The Odds API ─────────► Live pre-match bookmaker odds
```

### Caching Strategy

The server maintains in-memory caches for all external API responses with per-source TTLs:
- FPL fixtures / results: 60 minutes
- FD league data: 60 minutes  
- Understat xG: 24 hours (changes rarely mid-season)
- Odds: 30 minutes (refreshed closer to kickoff)

Supabase stores prediction snapshots and scored results persistently, so the app can show historical accuracy without re-fetching old data.

---

## Getting Started

### Prerequisites
- Node.js 20+
- A free [Supabase](https://supabase.com) project
- API keys listed below

### Install & run

```bash
git clone https://github.com/theothebest88434343/Chelsea-predictor.git
cd Chelsea-predictor
npm install
```

Create a `.env` file in the project root (see [Environment Variables](#environment-variables) below), then:

```bash
npm run dev
```

This starts the Express server on `:3001` and the Vite dev server on `:5173` concurrently.

### Production build

```bash
npm run build
npm start
```

The Express server serves the compiled React app as static files on the port defined by `PORT`.

---

## Environment Variables

| Variable | Description | Where to get it |
|---|---|---|
| `GROQ_API_KEY` | LLM API key for pre-match reports | [console.groq.com](https://console.groq.com) — free |
| `ODDS_API_KEY` | Live bookmaker odds | [the-odds-api.com](https://the-odds-api.com) — free tier |
| `SUPABASE_URL` | Supabase project URL | Supabase dashboard → Settings → API |
| `SUPABASE_ANON_KEY` | Supabase anon key | Supabase dashboard → Settings → API |
| `VAPID_PUBLIC_KEY` | Web push public key | `npx web-push generate-vapid-keys` |
| `VAPID_SECRET_KEY` | Web push private key | same as above |
| `FD_API_KEY` | football-data.org API key | [football-data.org](https://www.football-data.org) — free tier |
| `WC_API_KEY` | Tournament / World Cup data | [api-football.com](https://api-football.com) |
| `WC_LEAGUE_ID` | Tournament league ID | `1` = FIFA World Cup |
| `PORT` | Server port | `3001` (local), set by host in production |

```env
GROQ_API_KEY=
ODDS_API_KEY=
SUPABASE_URL=
SUPABASE_ANON_KEY=
VAPID_PUBLIC_KEY=
VAPID_SECRET_KEY=
FD_API_KEY=
WC_API_KEY=
WC_LEAGUE_ID=1
PORT=3001
```

---

## License

MIT — do what you want, attribution appreciated.

---

<p align="center">Built with ⚽ and too much Dixon-Coles literature</p>
