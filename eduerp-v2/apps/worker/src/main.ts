import { loadWorkerEnv, redactWorkerConfig, WorkerEnvConfig } from './config/env';
import { sanitizeWorkerErrorMessage, WorkerDatabase } from './database';
import { OutboxWorker } from './outbox.worker';
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
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private inFlightTick: Promise<void> | null = null;

  constructor(
    config: WorkerEnvConfig,
    logger: (entry: WorkerLogEvent) => void = (entry) =>
      process.stdout.write(`${JSON.stringify(entry)}\n`),
    customDb?: WorkerDatabase,
  ) {
    this.config = config;
    this.logger = logger;
    this.db = customDb ?? new WorkerDatabase(config);
    this.outboxWorker = new OutboxWorker(config, this.db);
    this.remindersWorker = new RemindersWorker(config, this.db);
    this.teacherPingWorker = new TeacherPingWorker(config, this.db);
    this.schedulesWorker = new SchedulesWorker(config, this.db);
  }

  public getState(): WorkerLifecycleState {
    return this.state;
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

    this.heartbeatTimer = setInterval(() => {
      if (this.state === 'RUNNING') {
        this.logger({
          level: 'info',
          event: 'worker_idle_heartbeat',
          worker_id: this.config.workerId,
          center_slug: this.config.centerSlug,
          details: { bot_outbound_enabled: this.config.botOutboundEnabled },
          timestamp_utc: new Date().toISOString(),
        });
      }
    }, this.config.pollIntervalMs);
  }

  public async executePollCycle(nowUtc: Date = new Date()): Promise<void> {
    if (this.state !== 'RUNNING' || this.inFlightTick !== null) {
      return;
    }
    const tickPromise = (async () => {
      try {
        await this.remindersWorker.runPromiseReminderTick({ nowUtc });
        await this.teacherPingWorker.runTeacherPingAndEscalationTick({ nowUtc });
        await this.schedulesWorker.runUnclosedCashShiftReminderJob({ nowUtc });
        await this.outboxWorker.runOutboxTick({ nowUtc });
      } catch (err: unknown) {
        this.logger({
          level: 'warn',
          event: 'worker_poll_cycle_error',
          worker_id: this.config.workerId,
          center_slug: this.config.centerSlug,
          details: { reason: sanitizeWorkerErrorMessage(err) },
          timestamp_utc: new Date().toISOString(),
        });
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
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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
