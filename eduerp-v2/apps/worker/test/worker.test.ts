import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadWorkerEnv, redactWorkerConfig, WorkerConfigValidationError } from '../src/config/env';
import { WorkerLogEvent, WorkerRuntimeSkeleton } from '../src/main';

const VALID_WORKER_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  WORKER_ID: 'worker-guliston-ilm-01',
  CENTER_ID: '11111111-2222-4333-8444-555555555555',
  CENTER_SLUG: 'guliston-ilm',
  CENTER_TIMEZONE: 'Asia/Tashkent',
  LICENSE_MODE: 'ACTIVE',
  DATABASE_URL: 'postgresql://eduerp_app_dev:WorkerSecretPass_DoNotLeak_55@postgres:5432/eduerp_guliston_ilm_dev',
  WORKER_POLL_INTERVAL_MS: '250',
  WORKER_SHUTDOWN_TIMEOUT_MS: '2000',
  BOT_OUTBOUND_ENABLED: 'false',
};

describe('Worker Config Validation & Graceful Signal Shutdown (03.02 / 03.05)', () => {
  it('validates worker config and redacts DATABASE_URL credentials', () => {
    const config = loadWorkerEnv(VALID_WORKER_ENV);
    assert.equal(config.workerId, 'worker-guliston-ilm-01');
    assert.equal(config.botOutboundEnabled, false);
    assert.equal(config.pollIntervalMs, 250);

    const redacted = JSON.stringify(redactWorkerConfig(config));
    assert.equal(redacted.includes('WorkerSecretPass_DoNotLeak_55'), false);
    assert.equal(redacted.includes('[REDACTED_DATABASE_URL]'), true);
  });

  it('fails fast with WorkerConfigValidationError on invalid poll interval or missing DATABASE_URL', () => {
    assert.throws(
      () =>
        loadWorkerEnv({
          ...VALID_WORKER_ENV,
          WORKER_ID: '!',
          WORKER_POLL_INTERVAL_MS: '10',
          DATABASE_URL: '',
        }),
      (err: unknown) => {
        assert.ok(err instanceof WorkerConfigValidationError);
        assert.ok(err.invalidFields.includes('WORKER_ID'));
        assert.ok(err.invalidFields.includes('WORKER_POLL_INTERVAL_MS'));
        assert.ok(err.invalidFields.includes('DATABASE_URL'));
        return true;
      },
    );
  });

  it('transitions IDLE -> RUNNING -> STOPPED cleanly on SIGTERM without leaking secrets in logs', async () => {
    const config = loadWorkerEnv(VALID_WORKER_ENV);
    const events: WorkerLogEvent[] = [];
    const worker = new WorkerRuntimeSkeleton(config, (entry) => events.push(entry));

    assert.equal(worker.getState(), 'IDLE');
    worker.start();
    assert.equal(worker.getState(), 'RUNNING');

    await worker.stop('SIGTERM');
    assert.equal(worker.getState(), 'STOPPED');

    assert.equal(events.length, 2);
    assert.equal(events[0].event, 'worker_started');
    assert.equal(events[1].event, 'worker_stopped_gracefully');
    assert.deepEqual(events[1].details, { signal: 'SIGTERM' });
    assert.equal(JSON.stringify(events).includes('WorkerSecretPass_DoNotLeak_55'), false);
  });
});
