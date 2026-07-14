import http from 'node:http';
import { config } from './config';
import { getTrackerStats } from './tracker';
import { getExecutionStats } from './executor';
import { getMonitorState } from './monitor';
import { getLiquidatorAddress } from './blockchain';

/**
 * Railway has no other way to tell a wedged bot from a healthy one - the process
 * stays up either way. Serving readiness plus the last cycle time makes a stall
 * visible instead of silent.
 */
export function startHealthServer(): void {
  const port = Number.parseInt(process.env.PORT || '3000', 10);

  http
    .createServer((_req, res) => {
      const monitor = getMonitorState();
      const tracker = getTrackerStats();

      // Stale if we have not completed a cycle in three intervals.
      const staleAfterMs = config.pollingIntervalMs * 3;
      const healthy =
        monitor.ready && (!monitor.lastCycleAt || Date.now() - monitor.lastCycleAt < staleAfterMs);

      res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          {
            healthy,
            ready: monitor.ready,
            mode: config.executeMode ? (config.dryRun ? 'dry-run' : 'execute') : 'monitor',
            liquidator: getLiquidatorAddress(),
            lastCycleAt: monitor.lastCycleAt ? new Date(monitor.lastCycleAt).toISOString() : null,
            lastSyncedBlock: monitor.lastSyncedBlock?.toString() ?? null,
            lastError: monitor.lastError,
            positions: tracker,
            execution: config.executeMode ? getExecutionStats() : undefined,
          },
          null,
          2
        )
      );
    })
    .listen(port, () => {
      console.log(`Health server listening on :${port}`);
    });
}
