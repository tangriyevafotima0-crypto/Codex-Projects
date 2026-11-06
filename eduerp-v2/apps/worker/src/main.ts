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
  private pollCycleCount = 0;

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
   * S01: Executes one full non-overlapping worker poll cycle across all Stage 13 jobs
   * (`remindersWorker`, `teacherPingWorker`, `schedulesWorker`, `outboxWorker`) with
   * per-job failure isolation so a policy/transient error in one job never aborts the
   * remaining jobs in the same cycle.
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
          run: () => this.remindersWorker.runPromiseReminderTick({ nowUtc }),
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
          this.logger({
            level: 'warn',
            event: 'worker_job_isolated_error',
            worker_id: this.config.workerId,
            center_slug: this.config.centerSlug,
            details: {
              job_name: task.jobName,
              reason: sanitizeWorkerErrorMessage(err),
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
      this.inFlightTick = null;
    }
  }

  public async stop(signal: string): Promise<void> {
    if (this.state === 'STOPPING' || this.state === 'STOPPED') {
      return;
    }
    this.state = 'STOPPING';
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.inFlightTick) {
      await Promise.race([
        this.inFlightTick,
        new Promise<void>((resolve) => setTimeout(resolve, this.config.shutdownTimeoutMs)),
      ]);
    }
    await this.db.close();
    this.state = 'STOPPED';
    this.logger({
      level: 'info',
      event: 'worker_stopped_gracefully',
      worker_id: this.config.workerId,
      center_slug: this.config.centerSlug,
      details: { signal },
      timestamp_utc: new Date().toISOString(),
    });
  }
}

export function bootstrapWorker(rawEnv: NodeJS.ProcessEnv = process.env): WorkerRuntimeSkeleton {
  const config = loadWorkerEnv(rawEnv);
  const worker = new WorkerRuntimeSkeleton(config);
  worker.start();

  const onSignal = (sig: NodeJS.Signals): void => {
    void worker.stop(sig).finally(() => {
      process.exit(0);
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
