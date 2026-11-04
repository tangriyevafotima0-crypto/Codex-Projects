import { Injectable } from '@nestjs/common';

@Injectable()
export class ClockService {
  private overrideMs: number | null = null;

  public now(): Date {
    if (this.overrideMs !== null) {
      return new Date(this.overrideMs);
    }
    return new Date();
  }

  public setTestNow(date: Date | null): void {
    this.overrideMs = date ? date.getTime() : null;
  }

  public advanceMs(deltaMs: number): Date {
    const base = this.overrideMs ?? Date.now();
    this.overrideMs = base + deltaMs;
    return new Date(this.overrideMs);
  }
}
