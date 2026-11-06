import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeCanonicalNextRollingRenewalDate,
  computeOutboxBackoffDelaySeconds,
  daysInCanonicalGregorianMonth,
  OUTBOX_MAX_ATTEMPTS,
} from '@eduerp/contracts';
import { loadWorkerEnv, redactWorkerConfig, WorkerConfigValidationError } from '../src/config/env';
import {
  buildGuardianScopedPayloadProjection,
  extractEventTargetStudentIds,
  formatCenterLocalDateParts,
  sanitizeWorkerErrorMessage,
  WorkerDatabase,
  WorkerLogEvent,
  WorkerRuntimeSkeleton,
} from '../src/main';

const VALID_WORKER_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  WORKER_ID: 'worker-guliston-ilm-01',
  CENTER_ID: '11111111-2222-4333-8444-555555555555',
  CENTER_SLUG: 'guliston-ilm',
  CENTER_TIMEZONE: 'Asia/Tashkent',
  LICENSE_MODE: 'ACTIVE',
  DATABASE_URL:
    'postgresql://eduerp_app_dev:WorkerSecretPass_DoNotLeak_55@postgres:5432/eduerp_guliston_ilm_dev',
  WORKER_POLL_INTERVAL_MS: '250',
  WORKER_SHUTDOWN_TIMEOUT_MS: '2000',
  BOT_OUTBOUND_ENABLED: 'false',
};

describe('Worker Config Validation, Backoff, Timezone, Guardian Scope Projection & Bounded Shutdown (03.02 / 03.05 / 13.01..13.05 / S13FIX-T)', () => {
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

  it('transitions IDLE -> RUNNING -> STOPPED cleanly on SIGTERM without leaking secrets in logs, and shares a single stopPromise across repeated stop() calls', async () => {
    const config = loadWorkerEnv(VALID_WORKER_ENV);
    const events: WorkerLogEvent[] = [];
    const worker = new WorkerRuntimeSkeleton(config, (entry) => events.push(entry));

    assert.equal(worker.getState(), 'IDLE');
    worker.start();
    assert.equal(worker.getState(), 'RUNNING');

    const [s1, s2] = await Promise.all([worker.stop('SIGTERM'), worker.stop('SIGINT')]);
    assert.equal(s1, undefined);
    assert.equal(s2, undefined);
    assert.equal(worker.getState(), 'STOPPED');
    assert.equal(worker.getLastStopOutcome()?.drainedCleanly, true);

    assert.equal(events.length, 2);
    assert.equal(events[0].event, 'worker_started');
    assert.equal(events[1].event, 'worker_stopped_gracefully');
    assert.deepEqual(events[1].details, { signal: 'SIGTERM' });
    assert.equal(JSON.stringify(events).includes('WorkerSecretPass_DoNotLeak_55'), false);
  });

  it('enforces bounded shutdown timeout when an in-flight tick hangs and emits worker_shutdown_bounded_timeout instead of hanging or falsely logging graceful stop', async () => {
    const config = loadWorkerEnv({
      ...VALID_WORKER_ENV,
      WORKER_POLL_INTERVAL_MS: '500',
      WORKER_SHUTDOWN_TIMEOUT_MS: '120',
    });
    const events: WorkerLogEvent[] = [];
    const fakeHungDb = new WorkerDatabase(config);
    const worker = new WorkerRuntimeSkeleton(config, (entry) => events.push(entry), fakeHungDb);

    // Inject a slow/hung job into remindersWorker to simulate a hung PG query during executePollCycle
    (
      worker.remindersWorker as unknown as {
        runPromiseReminderTick: () => Promise<unknown>;
      }
    ).runPromiseReminderTick = () =>
      new Promise((resolve) => {
        setTimeout(resolve, 5000);
      });

    worker.start();
    const cyclePromise = worker.executePollCycle();
    await new Promise((r) => setTimeout(r, 20));

    const t0 = Date.now();
    await Promise.all([worker.stop('SIGTERM'), worker.stop('SIGINT')]);
    const elapsedMs = Date.now() - t0;

    assert.ok(elapsedMs < 800, `Expected bounded stop within 800ms, got ${elapsedMs}ms`);
    assert.equal(worker.getState(), 'STOPPED');
    assert.equal(worker.getLastStopOutcome()?.timedOut, true);
    assert.equal(worker.getLastStopOutcome()?.drainedCleanly, false);
    assert.equal(
      events.some((e) => e.event === 'worker_stopped_gracefully'),
      false,
      'Must not emit worker_stopped_gracefully when in-flight tick timed out',
    );
    assert.equal(
      events.some((e) => e.event === 'worker_shutdown_bounded_timeout'),
      true,
      'Must emit worker_shutdown_bounded_timeout when in-flight tick timed out',
    );
    void cyclePromise;
  });

  it('projects recipient-scoped guardian payloads for batch AttendanceSubmitted without leaking unrelated students (T04) and computes leap-year / rolling boundaries (T02)', () => {
    const childA = '11111111-2222-4333-8444-aaaaaaaaaaaa';
    const childB = '11111111-2222-4333-8444-bbbbbbbbbbbb';
    const batchPayload = {
      lesson_id: '11111111-2222-4333-8444-cccccccccccc',
      group_id: '11111111-2222-4333-8444-dddddddddddd',
      absent_student_ids: [childA],
      late_student_ids: [childB],
      records: [
        { student_id: childA, status: 'ABSENT' },
        { student_id: childB, status: 'LATE' },
      ],
    };

    const allIds = extractEventTargetStudentIds(batchPayload);
    assert.deepEqual(allIds, [childA, childB]);

    const projA = buildGuardianScopedPayloadProjection(batchPayload, [childA]);
    assert.deepEqual(projA.student_ids, [childA]);
    assert.equal(projA.student_id, childA);
    assert.deepEqual(projA.absent_student_ids, [childA]);
    assert.deepEqual(projA.late_student_ids, []);
    assert.equal(JSON.stringify(projA).includes(childB), false);

    const projB = buildGuardianScopedPayloadProjection(batchPayload, [childB]);
    assert.deepEqual(projB.student_ids, [childB]);
    assert.equal(projB.student_id, childB);
    assert.deepEqual(projB.absent_student_ids, []);
    assert.deepEqual(projB.late_student_ids, [childB]);
    assert.equal(JSON.stringify(projB).includes(childA), false);

    assert.equal(daysInCanonicalGregorianMonth(2026, 2), 28);
    assert.equal(daysInCanonicalGregorianMonth(2028, 2), 29);

    const rol1 = computeCanonicalNextRollingRenewalDate('2026-01-31', 'CONTINUE_FROM_CLAMPED_DAY');
    assert.equal(rol1.inclusivePeriodEndDate, '2026-02-27');
    assert.equal(rol1.nextRenewalDate, '2026-02-28');
    const rol2 = computeCanonicalNextRollingRenewalDate(
      rol1.nextRenewalDate,
      'CONTINUE_FROM_CLAMPED_DAY',
    );
    assert.equal(rol2.inclusivePeriodEndDate, '2026-03-27');
    assert.equal(rol2.nextRenewalDate, '2026-03-28');
  });

  it('computes bounded exponential backoff (13.01), formats Asia/Tashkent 09:00 boundary (13.02), and redacts PII/secrets from worker errors', () => {
    assert.equal(OUTBOX_MAX_ATTEMPTS, 8);
    assert.equal(computeOutboxBackoffDelaySeconds(1), 10);
    assert.equal(computeOutboxBackoffDelaySeconds(2), 20);
    assert.equal(computeOutboxBackoffDelaySeconds(3), 40);
    assert.equal(computeOutboxBackoffDelaySeconds(8), 1280);
    assert.equal(computeOutboxBackoffDelaySeconds(12), 3600);

    // 03:59 UTC == 08:59 Asia/Tashkent (before 09:00); 04:00 UTC == 09:00 Asia/Tashkent
    const before9 = formatCenterLocalDateParts(
      new Date('2026-11-10T03:59:00.000Z'),
      'Asia/Tashkent',
    );
    assert.equal(before9.localDate, '2026-11-10');
    assert.equal(before9.localHour, 8);

    const at9 = formatCenterLocalDateParts(
      new Date('2026-11-10T04:00:00.000Z'),
      'Asia/Tashkent',
    );
    assert.equal(at9.localDate, '2026-11-10');
    assert.equal(at9.localHour, 9);

    const sanitized = sanitizeWorkerErrorMessage(
      new Error(
        'Failed connecting to postgresql://user:SuperSecret123@127.0.0.1:5432/db for phone +998901234567 token ' +
          '123456789:' +
          'AA' +
          'H' +
          'abcdefghijklmnopqrstuvwx12345678',
      ),
    );
    assert.equal(sanitized.includes('SuperSecret123'), false);
    assert.equal(sanitized.includes('+998901234567'), false);
    assert.equal(sanitized.includes('[REDACTED_DATABASE_URL]'), true);
    assert.equal(sanitized.includes('[REDACTED_PHONE]'), true);
    assert.equal(sanitized.includes('[REDACTED_BOT_TOKEN]'), true);
  });
});
