import type { RealtimeEvent, RealtimeEvents, RealtimeGateway } from './realtime.types';

/** What REALTIME_ENABLED=false resolves to, so callers never branch on a feature flag. */
export class NoopRealtimeGateway implements RealtimeGateway {
  async attach(): Promise<void> {
    // Nothing to attach.
  }

  emitTo<TEvent extends RealtimeEvent>(
    _room: string,
    _event: TEvent,
    _payload: RealtimeEvents[TEvent],
  ): void {
    // Dropped on purpose.
  }

  async close(): Promise<void> {
    // Nothing to close.
  }
}
