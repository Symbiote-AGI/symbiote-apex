// Symbiote — in-memory per-session message queue

export interface QueuedMessage {
  id: string;
  sessionId: string;
  content: string;
  sender: string;
  channelId: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export type MessageHandler = (msg: QueuedMessage) => Promise<void>;

interface SessionQueue {
  messages: QueuedMessage[];
  processing: boolean;
  handler?: MessageHandler;
  onQueueNotify?: (depth: number) => void;
  activeMessageIds: Set<string>;
  completedMessageIds: Map<string, number>;
}

const COMPLETED_MESSAGE_ID_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_COMPLETED_MESSAGE_IDS = 10_000;

function createSessionQueue(handler?: MessageHandler): SessionQueue {
  return {
    messages: [],
    processing: false,
    handler,
    activeMessageIds: new Set(),
    completedMessageIds: new Map(),
  };
}

function pruneCompletedIds(queue: SessionQueue, now: number): void {
  const cutoff = now - COMPLETED_MESSAGE_ID_TTL_MS;
  for (const [id, completedAt] of queue.completedMessageIds) {
    if (completedAt < cutoff) queue.completedMessageIds.delete(id);
  }
  while (queue.completedMessageIds.size > MAX_COMPLETED_MESSAGE_IDS) {
    const oldest = queue.completedMessageIds.keys().next().value;
    if (oldest === undefined) break;
    queue.completedMessageIds.delete(oldest);
  }
}

/**
 * Per-session message queue. Guarantees:
 * - Messages without a handler remain queued until one is registered
 * - Processing is sequential per-session (no race conditions)
 * - Sender is optionally notified when queue depth > 0
 *
 * Failed handlers are logged and require the caller to retry. Queued messages
 * do not survive a process restart.
 */
export class MessageQueue {
  private queues = new Map<string, SessionQueue>();
  private defaultHandler?: MessageHandler;
  private onNotify?: (sessionId: string, depth: number) => void;

  constructor(opts?: { defaultHandler?: MessageHandler; onQueueNotify?: (sessionId: string, depth: number) => void }) {
    this.defaultHandler = opts?.defaultHandler;
    this.onNotify = opts?.onQueueNotify;
  }

  /** Register a handler for a specific session */
  registerHandler(sessionId: string, handler: MessageHandler): void {
    const existing = this.queues.get(sessionId);
    if (existing) {
      existing.handler = handler;
      if (existing.messages.length > 0 && !existing.processing) {
        void this.processQueue(sessionId);
      }
    } else {
      this.queues.set(sessionId, createSessionQueue(handler));
    }
  }

  /** Enqueue a message. Returns queue depth after enqueue. */
  enqueue(msg: QueuedMessage): number {
    if (!msg.id.trim() || !msg.sessionId.trim()) {
      throw new Error('Queued messages require non-empty message and session IDs.');
    }
    let queue = this.queues.get(msg.sessionId);
    if (!queue) {
      const handler = this.defaultHandler;
      if (!handler) {
        console.error(`No handler for session ${msg.sessionId} and no default handler. Message queued until a handler is registered.`);
        queue = createSessionQueue();
        this.queues.set(msg.sessionId, queue);
      } else {
        queue = createSessionQueue(handler);
        this.queues.set(msg.sessionId, queue);
      }
    }

    pruneCompletedIds(queue, Date.now());
    if (queue.activeMessageIds.has(msg.id) || queue.completedMessageIds.has(msg.id)) {
      console.warn(`[queue] Ignoring duplicate message ${msg.id} in session ${msg.sessionId}.`);
      return queue.messages.length;
    }
    queue.activeMessageIds.add(msg.id);
    queue.messages.push(msg);
    const depth = queue.messages.length;

    // Notify if queue has waiting messages
    if (depth > 1 || queue.processing) {
      this.onNotify?.(msg.sessionId, depth);
    }

    // Kick off processing if not already running
    if (!queue.processing && queue.handler) {
      void this.processQueue(msg.sessionId);
    }

    return depth;
  }

  /** Get current queue depth for a session */
  depth(sessionId: string): number {
    return this.queues.get(sessionId)?.messages.length ?? 0;
  }

  /** Check if a session is currently processing */
  isBusy(sessionId: string): boolean {
    return this.queues.get(sessionId)?.processing ?? false;
  }

  /** Get stats for all sessions */
  stats(): { sessionId: string; depth: number; processing: boolean }[] {
    return [...this.queues.entries()].map(([id, q]) => ({
      sessionId: id,
      depth: q.messages.length,
      processing: q.processing,
    }));
  }

  private async processQueue(sessionId: string): Promise<void> {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.processing || !queue.handler) return;

    queue.processing = true;
    try {
      while (queue.messages.length > 0) {
        const handler = queue.handler;
        if (!handler) break;
        const msg = queue.messages.shift()!;
        let succeeded = false;
        try {
          await handler(msg);
          succeeded = true;
        } catch (err) {
          console.error(`Error processing message ${msg.id} in session ${sessionId}:`, err);
          // Don't re-queue on error — log and continue to next message
        } finally {
          queue.activeMessageIds.delete(msg.id);
          if (succeeded) {
            queue.completedMessageIds.set(msg.id, Date.now());
            pruneCompletedIds(queue, Date.now());
          }
        }
      }
    } finally {
      queue.processing = false;
    }
  }
}
