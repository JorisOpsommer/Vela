// Trend detection rides the warmer's passes right after the bars are fresh: every watched
// symbol (crypto on the crypto passes, the rest on the US-session ones). It reads only the
// cache, so it costs no provider request.
import type { BackgroundJob } from '../market/warmer';
import type { MarketService } from '../market/service';
import type { TrendsService } from './service';

export function trendsJob(trends: TrendsService, market: MarketService): BackgroundJob {
    return {
        id: 'trends',
        steps(kind, plan) {
            if (kind === 'premarket') return [];
            return [...plan.watched.keys()]
                .filter((symbol) => (kind === 'crypto') === (market.resolve(symbol)?.class === 'crypto') || kind === 'manual')
                .map((symbol) => ({ label: `trends ${symbol}`, run: async () => void trends.refresh(symbol) }));
        },
    };
}
