# Self-hosted charts

This fork adds a complete, self-hosted charting app on top of the Vela library. It is a
single Docker container: sign-in with local accounts, a multi-chart workspace, a watchlist,
per-account saved layouts, and server-side "bridges" that fetch market data from several
providers while keeping your API keys on the server.

```
browser ──HTTPS──► your reverse proxy / tunnel ──HTTP──► app (Node, port 8080)
                                                         ├─ SQLite: accounts, sessions, layouts, activity
                                                         └─ bridges: Alpaca · Finnhub · Yahoo · Coinbase · Energy-Charts
```

Besides the charts, the app has two extra pages: **Insights** (your most-opened symbols,
timeframes, indicators, activity patterns, and suggested tickers from a local relationship
map) and **Data providers** (speed, errors, cache use and rate-limit headroom per source).

The app code lives in [`app/`](app/). The library in `src/` is unchanged, so upstream
updates merge cleanly.

## Data sources

| Source | Key | What it serves | Limits |
| --- | --- | --- | --- |
| Alpaca (Basic) | yes | US stocks and ETFs (history from the consolidated tape, newest 15 min from IEX), US crypto fallback, exchange calendar, the list of ~13,000 US equities for search with their margin and borrow terms, option chains for the **Options** page (open interest, and quotes, greeks and implied volatility from the indicative feed) | 200 requests/min |
| Finnhub (free) | yes | Real-time trade stream for the watchlist and open charts (US stocks, EUR/USD), company logos, fallback quotes | 60 requests/min, 50 streamed symbols. The free plan has no historical bars. |
| Yahoo Finance chart endpoint | no | Indices (Dow, Nasdaq 100, DAX, Nikkei, VIX, DXY), futures (Brent, WTI, TTF gas), EUR/USD, fallback for stocks | Unofficial: it can change without notice. Answers are cached. |
| Coinbase | no | BTC/USD, ETH/USD, ETH/BTC history and live stream | Public market data |
| Energy-Charts (Fraunhofer ISE) | no | Belgian day-ahead power price (Belpex), 15-minute slots, including tomorrow once published | CC BY 4.0. The app shows the credit. |

Each symbol lists its sources in order. When one fails, the next takes over, and a source
that keeps failing is skipped for a minute. Every source has its own request budget, and
identical requests from many browsers share one upstream call.

Things to know:

- US stock bars are close to real time, but the volume of the newest ~15 minutes counts only
  IEX trades (a small share of the market). Older bars carry full-market volume.
- Belpex is a price, not a traded instrument: each delivery slot is one flat bar, and larger
  timeframes fold slots into real open/high/low/close. Its smallest timeframe is 15 minutes.
- Option prices on the Basic plan come from Alpaca's indicative feed: derived from the
  exchange quotes, with trades delayed 15 minutes. Open interest is Alpaca's daily figure.
  Each watched stock costs about three requests a day, read once after the close.
- The **Trends** page reads only the cached 4h and daily bars, so it costs no provider
  requests.
- The default watchlist and the symbol mapping live in [`app/config/tickers.json`](app/config/tickers.json).
  Add any instrument the sources carry, then restart the container.

## Deploy on a Proxmox LXC

### 1. Prepare the container

Create a Debian 12 (or Ubuntu 24.04) LXC with 2 vCPU, 2 GB RAM and 8 GB disk. Docker inside
an LXC needs nesting. For an unprivileged container also enable keyctl. In the Proxmox UI:
**Options → Features → nesting ✓, keyctl ✓**, or on the host:

```bash
pct set <vmid> --features nesting=1,keyctl=1
```

Then, inside the LXC, install Docker:

```bash
apt update && apt install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sh
```

### 2. Configure and start

```bash
git clone https://github.com/JorisOpsommer/Vela.git && cd Vela
cp .env.example .env
nano .env
```

Fill in the API keys and a fresh `SESSION_SECRET` (`openssl rand -hex 32`). Then start:

```bash
docker compose up -d --build
```

```bash
docker compose logs -f app
```

The app now listens on port 8080 of the LXC (plain HTTP). On the very first start, it creates
the admin account. If you set `ADMIN_USERNAME` and `ADMIN_PASSWORD`, it uses those. Otherwise
it prints a one-time password in the log, and you must choose a new password at first sign-in.
After the first start you can clear `ADMIN_PASSWORD` from `.env`.

### 3. Put it behind HTTPS

The app does not terminate TLS itself. Point your reverse proxy or tunnel (Nginx Proxy
Manager, Traefik, Caddy, a Cloudflare Tunnel, …) at `http://<lxc-ip>:8080`. The proxy must:

- **Keep the `Host` header.** Sign-in and the live stream accept requests only from the
  address the request was sent to.
- **Pass WebSocket upgrades** on `/api/stream` (live candles).
- **Run on a private network address** (LAN, Docker network or the same host). The app then
  reads each visitor's real IP from `CF-Connecting-IP` or `X-Forwarded-For`, so a failed
  sign-in only locks out that visitor.

- **Send `X-Forwarded-Proto: https`.** Cloudflare Tunnel and most proxies do this by
  default. The app then uses a `Secure`, `__Host-` sign-in cookie and sends HSTS.

You can also open `http://<lxc-ip>:8080` directly on your LAN without any setting: the app
sees plain HTTP and uses a cookie without `Secure` for that address. Do not expose the
plain-HTTP port to the internet. Set the published host port with `APP_PORT` (default
`8080`).

### 4. Add users

Sign in, open the account page (person icon, top right) and add users there. New users
choose their own password at first sign-in. Everyone can turn on two-factor sign-in with
an authenticator app on the same page.

## Security

- **TLS at your proxy.** The app speaks plain HTTP; keep the port reachable only by your
  proxy (a firewall rule on the LXC, or no port forward on your router).
- **Accounts.** Passwords are hashed with Argon2id. Sessions are random 256-bit tokens, stored
  only as hashes, in `HttpOnly`, `SameSite=Lax` cookies that are also `Secure` whenever the request came over HTTPS. A session ends after 60 days
  without use (`SESSION_TTL_DAYS`); activity keeps extending it.
  Optional TOTP two-factor; its secrets are encrypted at rest. There is no public sign-up.
- **Brute force.** Failed sign-ins are limited per client IP and per username, with growing
  lockouts. Forwarded client-IP headers are honoured only from private-network peers (your
  proxy); a client connecting from the internet cannot fake its IP.
- **Requests.** Every state-changing call needs a per-session CSRF token and a same-origin
  `Origin`. A strict Content-Security-Policy allows scripts from the app itself only.
- **Keys.** The browser never sees an API key: all data flows through the server, and only
  signed-in users can use it.
- **Container.** Read-only filesystem, non-root user, all Linux capabilities dropped.
- **Analytics stay home.** The Insights page is built from each user's own activity, stored
  in this app's database. Users can erase their history from that page.

## Operations

```bash
docker compose exec app node dist/server/cli.js list-users
docker compose exec app node dist/server/cli.js reset-password <username>
docker compose exec app node dist/server/cli.js reset-2fa <username>
```

`reset-password` prints a one-time password and re-enables the account. Use it if you lock
yourself out.

**Backups.** Everything lives in the `vela-data` volume (`vela.sqlite` plus a cache). Back it up
with the stack stopped, or copy it live with SQLite's backup command:

```bash
docker compose exec app node -e "require('node:sqlite').backup(new (require('node:sqlite').DatabaseSync)('/data/vela.sqlite'), '/data/backup.sqlite')"
```

```bash
docker compose cp app:/data/backup.sqlite ./vela-backup.sqlite
```

`vela.sqlite` also keeps the daily options history (open interest by strike, implied
volatility): Alpaca serves only the current day, so it can't be fetched again.

The `cache/` folder (`cache/cache.sqlite` holds the market-data cache behind the **Cache** page)
only copies provider data. Leave it out of backups, or delete it at any time with the stack
stopped: charts then load from the providers until the cache warms up again.

**Updates.**

```bash
git pull && docker compose up -d --build
```

## Develop

```bash
npm ci && cd app && npm ci
npm run dev
```

`npm run dev` rebuilds the web app and the server on save and serves both at
`http://localhost:8080` (it reads `../.env`; plain HTTP is detected, so no cookie setting is needed). Checks:

```bash
cd app && npm run typecheck && npm test && npm run build
```

## Attribution

The chart keeps Vela's attribution mark on, as the Apache-2.0 [NOTICE](NOTICE) requires.
Belgian power prices are © Bundesnetzagentur | SMARD.de via Energy-Charts.info (Fraunhofer
ISE), CC BY 4.0. The chart credits the source in the top bar whenever a power price is open,
and the data providers page lists it too.

Some symbols come from a feed that runs behind the market (for example 10 minutes for
NYMEX futures, 15 for the VIX). Their chart shows an amber **Delayed Nm** tag next to the
symbol name. Set
`delayMinutes` per instrument in `app/config/tickers.json`; US stocks and crypto are real
time and need none.
