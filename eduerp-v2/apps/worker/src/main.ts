import { loadWorkerEnv, redactWorkerConfig, WorkerEnvConfig } from './config/env';

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
  private state: WorkerLifecycleState = 'IDLE';
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    config: WorkerEnvConfig,
    logger: (entry: WorkerLogEvent) => void = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`),
  ) {
    this.config = config;
    this.logger = logger;
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
        stage_boundary: 'S03_FOUNDATION_SKELETON_ONLY_NO_OUTBOX_BUSINESS_JOBS_YET',
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
    // The daemon must stay alive while waiting for work; stop() clears this handle.
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
