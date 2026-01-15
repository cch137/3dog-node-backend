import { EventEmitter } from "events";
import createDebug from "debug";
import { z } from "zod";
import { generateRandomId } from "../../lib/utils/generate-random-id";
import {
  RealtimeClient,
  RealtimeRoom,
  PoseSchema,
  type Pose,
} from "../realtime/connection";

const debug = createDebug("mv-fn");

// -------------------- Schemas --------------------

export const RelativeMoveSchema = z.object({
  relative: z.object({
    deltaPos: z.tuple([z.number(), z.number(), z.number()]),
    deltaRot: z
      .tuple([z.number(), z.number(), z.number(), z.number()])
      .optional(),
  }),
});

export const MoveTargetSchema = z.union([PoseSchema, RelativeMoveSchema]);
export type MoveTarget = z.infer<typeof MoveTargetSchema>;

export const MoveCommandSchema = z.object({
  object_id: z.string().min(1),
  to: MoveTargetSchema,
  durationMs: z.number().int().min(0).max(60_000).optional(),
});
export type MoveCommand = z.infer<typeof MoveCommandSchema>;

// -------------------- Helpers --------------------

/**
 * 從 RealtimeClient 取得所在的 RealtimeRoom。
 * 使用 Symbol 遍歷 + instanceof 檢查，確保型別安全。
 */
function getRoomFromClient(client: RealtimeClient): RealtimeRoom | null {
  const syms = Object.getOwnPropertySymbols(client);
  for (const sym of syms) {
    // 這裡仍需轉型為 any 才能讀取 Symbol 屬性，但後續檢查是嚴格的
    const value = (client as any)[sym];
    if (value instanceof RealtimeRoom) {
      return value;
    }
  }
  return null;
}

// quaternion multiply: a * b
function quatMultiply(
  a: [number, number, number, number],
  b: [number, number, number, number]
): [number, number, number, number] {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/**
 * 計算目標絕對位置 (處理相對座標)
 */
export function resolveTargetPose(options: {
  current: Pose;
  to: MoveTarget;
}): Pose {
  const { current, to } = options;

  if ("relative" in to) {
    const { deltaPos, deltaRot } = to.relative;
    const [dx, dy, dz] = deltaPos;

    const nextPos: [number, number, number] = [
      current.pos[0] + dx,
      current.pos[1] + dy,
      current.pos[2] + dz,
    ];

    let nextRot = current.rot;
    if (deltaRot) {
      nextRot = quatMultiply(current.rot, deltaRot);
    }

    return { pos: nextPos, rot: nextRot };
  }

  // 這裡 TypeScript 已經知道 to 是 Pose,絕對
  return to;
}

// -------------------- Task / State --------------------

export enum MoveStatus {
  QUEUED = "queued",
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
}

export type MoveTaskState =
  | { status: MoveStatus.QUEUED; finalPose: null; reason: null }
  | { status: MoveStatus.PROCESSING; finalPose: null; reason: null }
  | { status: MoveStatus.COMPLETED; finalPose: Pose; reason: null }
  | { status: MoveStatus.FAILED; finalPose: null; reason: string };

export class MoveObjectTask extends EventEmitter {
  private static readonly record = new Map<string, MoveObjectTask>();

  // ✅ 同一 object FIFO queue
  private static readonly objectQueueTail = new Map<string, Promise<void>>();

  private static enqueueForObject(objectId: string) {
    const prevTail = this.objectQueueTail.get(objectId) ?? Promise.resolve();
    const prevSafe = prevTail.catch(() => {});

    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    const newTail = prevSafe.then(() => current);
    this.objectQueueTail.set(objectId, newTail);

    newTail.finally(() => {
      if (this.objectQueueTail.get(objectId) === newTail) {
        this.objectQueueTail.delete(objectId);
      }
    });

    return { waitTurn: prevSafe, release };
  }

  static create(options: { client: RealtimeClient; command: MoveCommand }) {
    return new MoveObjectTask(options);
  }

  static get(id: string) {
    return this.record.get(id) ?? null;
  }

  static getState(id: string): MoveTaskState | null {
    return this.record.get(id)?.getState() ?? null;
  }

  static cancel(id: string) {
    const task = this.record.get(id);
    if (task) {
      task.cancel();
      return true;
    }
    return false;
  }

  static cleanupInactive(ttlMs: number) {
    const now = Date.now();
    for (const [id, task] of this.record.entries()) {
      if (
        (task.status === MoveStatus.COMPLETED ||
          task.status === MoveStatus.FAILED) &&
        task.endAtMs !== null &&
        now - task.endAtMs >= ttlMs
      ) {
        this.record.delete(id);
      }
    }
  }

  readonly id: string;
  private readonly client: RealtimeClient;
  private readonly command: MoveCommand;

  private cancelled = false;
  private taskPromise: Promise<void> | null = null;

  private _status: MoveStatus = MoveStatus.QUEUED;
  private finalPose: Pose | null = null;
  private reason: string | null = null;

  private endAtMs: number | null = null;
  private releaseQueueSlot: (() => void) | null = null;

  private constructor(options: {
    client: RealtimeClient;
    command: MoveCommand;
  }) {
    super();
    this.client = options.client;
    this.command = MoveCommandSchema.parse(options.command);
    this.id = generateRandomId();
    MoveObjectTask.record.set(this.id, this);
    debug(`task[${this.id}] queued move for '${this.command.object_id}'`);
  }

  get status() {
    return this._status;
  }
  private set status(v: MoveStatus) {
    if (v === this._status) return;
    const oldStatus = this._status;
    this._status = v;
    this.emit("statusChange", v, oldStatus);
  }

  getState(): MoveTaskState {
    if (this.status === MoveStatus.COMPLETED) {
      return {
        status: this.status,
        finalPose: this.finalPose as Pose,
        reason: null,
      };
    }
    if (this.status === MoveStatus.FAILED) {
      return {
        status: this.status,
        finalPose: null,
        reason: this.reason ?? "unknown error",
      };
    }
    return { status: this.status, finalPose: null, reason: null };
  }

  execute() {
    if (this.taskPromise) return this.taskPromise;

    this.taskPromise = new Promise<void>((resolve) => {
      const { waitTurn, release } = MoveObjectTask.enqueueForObject(
        this.command.object_id
      );
      this.releaseQueueSlot = release;

      waitTurn
        .then(async () => {
          if (this.cancelled) return;

          this.status = MoveStatus.PROCESSING;

          const room = getRoomFromClient(this.client);
          if (!room) {
            throw new Error("Client is not in any room.");
          }

          const entity = room.getEntityById(this.command.object_id);
          if (!entity) {
            throw new Error(
              `Entity '${this.command.object_id}' not found in current room.`
            );
          }

          // 計算絕對座標
          const absTarget = resolveTargetPose({
            current: entity.pose,
            to: this.command.to,
          });

          // Claim
          // 假設 RealtimeClient 上有 controller 屬性 (型別來自 connection.ts)
          const controller = (this.client as any).controller;
          const claimed = room.claimEntityById(controller, entity.id);

          if (!claimed) {
            throw new Error(`Failed to claim entity '${entity.id}'.`);
          }

          try {
            // Update
            const ok = room.updateEntityById(controller, entity.id, {
              pose: absTarget,
            });
            if (!ok) {
              throw new Error(`Failed to update pose for '${entity.id}'.`);
            }

            // 重新抓取確認
            const updated = room.getEntityById(entity.id)?.pose ?? absTarget;

            this.finalPose = updated;
            this.reason = null;
            this.status = MoveStatus.COMPLETED;
          } finally {
            // Release
            if (claimed) {
              room.releaseEntityById(controller, entity.id);
            }
          }
        })
        .catch((err) => {
          if (this.cancelled) return;
          this.finalPose = null;
          this.reason = (err as Error)?.message ?? String(err);
          this.status = MoveStatus.FAILED;
        })
        .finally(() => {
          try {
            this.releaseQueueSlot?.();
          } finally {
            this.releaseQueueSlot = null;
          }
          if (this.endAtMs === null) this.endAtMs = Date.now();
          resolve();
        });
    });

    return this.taskPromise;
  }

  cancel() {
    if (
      this.status === MoveStatus.COMPLETED ||
      this.status === MoveStatus.FAILED
    )
      return;

    const wasQueued = this.status === MoveStatus.QUEUED;
    this.cancelled = true;
    this.finalPose = null;
    this.reason = "Task was cancelled";
    this.status = MoveStatus.FAILED;
    this.endAtMs = Date.now();

    if (wasQueued) {
      try {
        this.releaseQueueSlot?.();
      } finally {
        this.releaseQueueSlot = null;
      }
    }
  }
}

// Timer for cleanup
let cleanupTimerStarted = false;
(() => {
  if (cleanupTimerStarted) return;
  cleanupTimerStarted = true;

  const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
  const INACTIVITY_TTL_MS = 5 * 60 * 1000;

  const timer = setInterval(() => {
    MoveObjectTask.cleanupInactive(INACTIVITY_TTL_MS);
  }, CLEANUP_INTERVAL_MS);

  timer.unref?.();
})();

export function moveObject(options: {
  client: RealtimeClient;
  command: MoveCommand;
}) {
  const task = MoveObjectTask.create(options);
  task.execute();
  return task;
}

export default {};
