import { BillingCycleWorkerPort } from '@eduerp/contracts';
import { loadWorkerEnv, redactWorkerConfig, WorkerEnvConfig } from './config/env';
import { sanitizeWorkerErrorMessage, WorkerDatabase } from './database';
import {
  ExternalNotificationTransportAdapter,
  OutboxWorker,
} from './outbox.worker';
import { RemindersWorker } from './reminders.worker';
import { SchedulesWorker } from './schedules.worker';
import { TeacherPingWorker } from './teacher-ping.worker';

export * from './database';
export * from './outbox.worker';
export * from './reminders.worker';
export * from './teacher-ping.worker';
export * from './schedules.worker';

export type WorkerLifecycleState = 'IDLE' | 'RUNNING' | 'STOPPING' | 'STOPPED';

export interface WorkerLogEvent {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly worker_id: string;
  readonly center_slug: string;
  readonly details?: Record<string, unknown>;
  readonly timestamp_utc: string;
}

export interface WorkerStopOutcome {
  readonly signal: string;
  readonly drainedCleanly: boolean;
  readonly timedOut: boolean;
}

export class WorkerRuntimeSkeleton {
  private readonly config: WorkerEnvConfig;
  private readonly logger: (entry: WorkerLogEvent) => void;
  private readonly db: WorkerDatabase;
  public readonly outboxWorker: OutboxWorker;
  public readonly remindersWorker: RemindersWorker;
  public readonly teacherPingWorker: TeacherPingWorker;
  public readonly schedulesWorker: SchedulesWorker;
  private state: WorkerLifecycleState = 'IDLE';
  private pollTimer: NodeJS.Timeout | null = null;
  private inFlightTick: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private lastStopOutcome: WorkerStopOutcome | null = null;
  private pollCycleCount = 0;
  private readonly suppressedPolicyWarnKeys = new Set<string>();

  constructor(
    config: WorkerEnvConfig,
    logger: (entry: WorkerLogEvent) => void = (entry) =>
      process.stdout.write(`${JSON.stringify(entry)}\n`),
    customDb?: WorkerDatabase,
    customTransportAdapter?: ExternalNotificationTransportAdapter,
    customBillingCyclePort?: BillingCycleWorkerPort,
  ) {
    this.config = config;
    this.logger = logger;
    this.db = customDb ?? new WorkerDatabase(config);
    this.outboxWorker = new OutboxWorker(config, this.db, customTransportAdapter);
    this.remindersWorker = new RemindersWorker(config, this.db);
    this.teacherPingWorker = new TeacherPingWorker(config, this.db);
    this.schedulesWorker = new SchedulesWorker(config, this.db, customBillingCyclePort);
  }

  public getState(): WorkerLifecycleState {
    return this.state;
  }

  public getPollCycleCount(): number {
    return this.pollCycleCount;
  }

  public getLastStopOutcome(): WorkerStopOutcome | null {
    return this.lastStopOutcome;
  }

  public start(): void {
    if (this.state !== 'IDLE') {
      return;
    }
    this.state = 'RUNNING';
    this.logger({
      level: 'info',
      event: 'worker_started',
      worker_id: this.config.workerId,
      center_slug: this.config.centerSlug,
      details: {
        stage_boundary: 'S13_OUTBOX_REMINDERS_PINGS_SCHEDULER_ACTIVE',
        config: redactWorkerConfig(this.config),
      },
      timestamp_utc: new Date().toISOString(),
    });

    // S01: Schedule non-overlapping automatic poll cycles on pollIntervalMs
    this.pollTimer = setInterval(() => {
      if (this.state === 'RUNNING' && this.inFlightTick === null) {
        void this.executePollCycle();
      }
    }, this.config.pollIntervalMs);
  }

  /**
   * S01 & T03/T05: Executes one full non-overlapping worker poll cycle across all Stage 13 jobs
   * (`remindersWorker`, `teacherPingWorker`, `schedulesWorker`, `outboxWorker`) with
   * per-job failure isolation, stopping immediately if `state !== 'RUNNING'`, and preventing
   * repetitive 500ms warning log floods on unconfigured center policies.
   */
  public async executePollCycle(nowUtc: Date = new Date()): Promise<void> {
    if (this.state !== 'RUNNING' || this.inFlightTick !== null) {
      return;
    }
    const tickPromise = (async () => {
      this.pollCycleCount += 1;
      const isolatedTasks: Array<{
        readonly jobName: string;
        readonly run: () => Promise<unknown>;
      }> = [
        {
          jobName: 'PromiseReminderJob',
          run: () =>
            this.remindersWorker.runPromiseReminderTick({
              nowUtc,
              allowUnconfiguredDefer: true,
            }),
        },
        {
          jobName: 'TeacherPingAndEscalationJob',
          run: () => this.teacherPingWorker.runTeacherPingAndEscalationTick({ nowUtc }),
        },
        {
          jobName: 'BillingCycleCutoffAndCatchUpJob',
          run: () => this.schedulesWorker.runBillingCycleCutoffAndCatchUpJob({ nowUtc }),
        },
        {
          jobName: 'UnclosedCashShiftReminderJob',
          run: () => this.schedulesWorker.runUnclosedCashShiftReminderJob({ nowUtc }),
        },
        {
          jobName: 'TrialNoShowFollowUpJob',
          run: () => this.schedulesWorker.runTrialNoShowFollowUpJob({ nowUtc }),
        },
        {
          jobName: 'OutboxTickJob',
          run: () => this.outboxWorker.runOutboxTick({ nowUtc }),
        },
      ];

      for (const task of isolatedTasks) {
        if (this.state !== 'RUNNING') {
          break;
        }
        try {
          await task.run();
        } catch (err: unknown) {
          if (this.state !== 'RUNNING') {
            break;
          }
          const sanitizedReason = sanitizeWorkerErrorMessage(err);
          const isUnconfiguredPolicyGate = sanitizedReason.includes(
            'POLICY_DECISION_NOT_CONFIRMED',
          );
          const dedupKey = `${task.jobName}:${sanitizedReason}`;
          if (isUnconfiguredPolicyGate && this.suppressedPolicyWarnKeys.has(dedupKey)) {
            continue;
          }
          if (isUnconfiguredPolicyGate) {
            this.suppressedPolicyWarnKeys.add(dedupKey);
          }
          this.logger({
            level: 'warn',
            event: 'worker_job_isolated_error',
            worker_id: this.config.workerId,
            center_slug: this.config.centerSlug,
            details: {
              job_name: task.jobName,
              reason: sanitizedReason,
            },
            timestamp_utc: new Date().toISOString(),
          });
        }
      }
    })();

    this.inFlightTick = tickPromise;
    try {
      await tickPromise;
    } finally {
      if (this.inFlightTick === tickPromise) {
        this.inFlightTick = null;
      }
    }
  }

  /**
   * T05 Bounded Graceful Shutdown:
   * - Shares a single `stopPromise` across concurrent/repeated `stop()` calls so every caller
   *   observes the exact same completion state.
   * - Stops timer and prevents any subsequent job or outbox claim.
   * - Waits up to `shutdownTimeoutMs` for `inFlightTick` to drain; if a slow/hung DB query exceeds
   *   `shutdownTimeoutMs`, aborts active DB clients and bounds `db.close()` so `stop()` NEVER hangs.
   * - Emits `worker_stopped_gracefully` ONLY when `inFlightTick` drained within budget; emits
   *   `worker_shutdown_bounded_timeout` when shutdown timed out.
   */
  public async stop(signal: string): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = (async () => {
      this.state = 'STOPPING';
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }

      let timedOut = false;
      const activeTick = this.inFlightTick;
      if (activeTick) {
        activeTick.catch(() => undefined);
        const totalBudgetMs = Math.max(50, this.config.shutdownTimeoutMs);
        const tickWaitBudgetMs = Math.max(40, totalBudgetMs - Math.min(150, Math.floor(totalBudgetMs / 4)));
        let timer: NodeJS.Timeout | null = null;
        const outcome = await Promise.race([
          activeTick.then(
            () => 'DRAINED' as const,
            () => 'DRAINED' as const,
          ),
          new Promise<'TIMED_OUT'>((resolve) => {
            timer = setTimeout(() => resolve('TIMED_OUT'), tickWaitBudgetMs);
          }),
        ]);
        if (timer) {
          clearTimeout(timer);
        }
        timedOut = outcome === 'TIMED_OUT';
      }

      const closeTimeoutMs = timedOut
        ? 100
        : Math.max(50, Math.min(500, this.config.shutdownTimeoutMs));
      await this.db.close(closeTimeoutMs, timedOut);

      this.inFlightTick = null;
      this.state = 'STOPPED';
      this.lastStopOutcome = {
        signal,
        drainedCleanly: !timedOut,
        timedOut,
      };

      if (!timedOut) {
        this.logger({
          level: 'info',
          event: 'worker_stopped_gracefully',
          worker_id: this.config.workerId,
          center_slug: this.config.centerSlug,
          details: { signal },
          timestamp_utc: new Date().toISOString(),
        });
      } else {
        this.logger({
          level: 'warn',
          event: 'worker_shutdown_bounded_timeout',
          worker_id: this.config.workerId,
          center_slug: this.config.centerSlug,
          details: {
            signal,
            shutdown_timeout_ms: this.config.shutdownTimeoutMs,
            drained_cleanly: false,
          },
          timestamp_utc: new Date().toISOString(),
        });
      }
    })();

    return this.stopPromise;
  }
}

export function bootstrapWorker(rawEnv: NodeJS.ProcessEnv = process.env): WorkerRuntimeSkeleton {
  const config = loadWorkerEnv(rawEnv);
  const worker = new WorkerRuntimeSkeleton(config);
  worker.start();

  const onSignal = (sig: NodeJS.Signals): void => {
    void worker.stop(sig).finally(() => {
      const outcome = worker.getLastStopOutcome();
      process.exit(outcome && !outcome.drainedCleanly ? 1 : 0);
    });
  };

  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));
  return worker;
}

if (require.main === module) {
  try {
    bootstrapWorker(process.env);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown worker startup error';
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        event: 'worker_startup_failed',
        message,
        timestamp_utc: new Date().toISOString(),
      })}\n`,
    );
    process.exit(1);
  }
}
