// The daily options read: after the close, every symbol an active account watches gets
// one read for the trading day (open interest, quotes, greeks), most-watched first. A
// symbol already read that day, or one without listed options, costs no request.
import type { BackgroundJob, JobStep } from '../market/warmer';
import type { OptionsService } from './service';

export function optionsJob(options: OptionsService): BackgroundJob {
    return {
        id: 'options',
        steps(kind, plan) {
            if ((kind !== 'close' && kind !== 'manual') || !options.available) return [];
            const symbols = [...plan.watched.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
            let date: Promise<string> | null = null;
            const steps: JobStep[] = symbols.map((symbol) => ({
                label: `options ${symbol}`,
                async run() {
                    if (!(await options.optionable(symbol))) return;
                    date ??= options.sessionDate();
                    if (options.has(symbol, await date)) return;
                    await options.read(symbol);
                },
            }));
            steps.push({ label: 'options history', run: async () => options.prune() });
            return steps;
        },
    };
}
