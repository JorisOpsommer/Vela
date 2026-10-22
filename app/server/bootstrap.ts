// Wires configuration into services: database, auth, bridges, catalog, live hub.
import crypto from 'node:crypto';
import path from 'node:path';
import type { AppConfig } from './config';
import { openDb, type Db } from './db';
import { AuthService } from './auth/service';
import { SecretBox } from './auth/secret-box';
import { Catalog, loadTickerConfig } from './market/catalog';
import { MarketService } from './market/service';
import { LiveHub } from './market/live';
import { AlpacaBridge } from './market/bridges/alpaca';
import { FinnhubBridge } from './market/bridges/finnhub';
import { YahooBridge } from './market/bridges/yahoo';
import { EnergyChartsBridge } from './market/bridges/energycharts';
import { CoinbaseBridge } from './market/bridges/coinbase';
import { RelatedMap } from './analytics/related';
import { CacheStore } from './market/cache-store';
import { CachedMarket } from './market/cached-market';
import { CacheWarmer } from './market/warmer';

export interface Services {
    db: Db;
    auth: AuthService;
    market: MarketService;
    hub: LiveHub;
    cached: CachedMarket;
    warmer: CacheWarmer;
    related: RelatedMap;
    close(): void;
}

export interface Log {
    info(msg: string): void;
    warn(msg: string): void;
}

export function createServices(config: AppConfig, log: Log): Services {
    const db = openDb(config.dataDir);
    const auth = new AuthService(db, new SecretBox(config.sessionSecret), config.sessionTtlMs);

    const alpaca = config.alpaca ? new AlpacaBridge(config.alpaca) : undefined;
    const finnhub = config.finnhubKey ? new FinnhubBridge(config.finnhubKey) : undefined;
    if (!alpaca) log.warn('ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY not set — US stocks fall back to the keyless source.');
    if (!finnhub) log.warn('FINNHUB_API_KEY not set — no real-time trade stream.');

    const catalog = new Catalog(loadTickerConfig(config.configDir), { alpaca: !!alpaca, finnhub: !!finnhub });
    const market = new MarketService(catalog, {
        alpaca,
        finnhub,
        yahoo: new YahooBridge(),
        energycharts: new EnergyChartsBridge(path.join(config.dataDir, 'cache', 'energy')),
        coinbase: new CoinbaseBridge(),
    });

    // The trade stream carries the watchlist plus whatever charts are open (plan cap: 50).
    const watchLive = catalog
        .defaultGroups()
        .flatMap((g) => g.symbols)
        .map((s) => catalog.resolve(s)?.live?.ticker)
        .filter((t): t is string => !!t);
    let hub: LiveHub;
    const refreshStreams = () => finnhub?.setStreams([...new Set([...hub.activeLiveTickers(), ...watchLive])]);
    hub = new LiveHub(market, refreshStreams);
    refreshStreams();

    if (alpaca) {
        const loadAssets = () =>
            alpaca
                .assets()
                .then((a) => {
                    catalog.setAssets(a);
                    log.info(`symbol catalog: ${a.length} US equities`);
                })
                .catch((err: Error) => {
                    log.warn(`asset list failed (${err.message}); retrying in 5 min`);
                    setTimeout(loadAssets, 5 * 60_000).unref();
                });
        loadAssets();
        setInterval(loadAssets, 24 * 3_600_000).unref();
    }

    const cached = new CachedMarket(market, new CacheStore(path.join(config.dataDir, 'cache', 'cache.sqlite')));
    const warmer = new CacheWarmer(cached, db, hub);
    warmer.start();

    const related = RelatedMap.load(config.configDir);
    log.info(`related-symbol map: ${related.symbols.size} symbols`);

    return {
        db,
        auth,
        market,
        hub,
        cached,
        warmer,
        related,
        close() {
            warmer.stop();
            finnhub?.close();
            cached.store.close();
            db.close();
        },
    };
}

/** First start: create the admin from the environment, or print a one-time password. */
export async function ensureAdmin(auth: AuthService, config: AppConfig, log: Log): Promise<void> {
    if (auth.userCount() > 0) return;
    if (config.admin) {
        await auth.createUser(config.admin.username, config.admin.password, 'admin');
        log.info(`created admin account "${config.admin.username}" from ADMIN_USERNAME / ADMIN_PASSWORD`);
        return;
    }
    const password = crypto.randomBytes(15).toString('base64url');
    await auth.createUser('admin', password, 'admin', { mustChangePassword: true });
    log.warn(`no users yet — created "admin" with one-time password: ${password}  (you must change it at first sign-in)`);
}
