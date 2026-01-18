// Object Designer (version 2)
import { EventEmitter } from "events";
import debug from "debug";
import { type LanguageModel } from "ai";
import z from "zod";
import { connect } from "./db";
import { generateRandomId } from "../lib/utils/generate-random-id";
import { generateCode } from "./workflows/generate-code";
import { generateGlbFromCode } from "./workflows/generate-glb-from-code";
import {
  ObjectProps,
  ObjectPropsSchema,
  ProviderOptions,
} from "./workflows/schemas";
import {
  type GlbBinary,
  GlbSnapshotsRenderer,
} from "./workflows/render-glb-snapshots";
import { loadInstructionsTemplateSync } from "./instructions";

export type TaskResult =
  | { code: string; mime_type: string; glb: Uint8Array<ArrayBuffer> }
  | { error: string };

const DEFAULT_MAX_RETRIES = 2;

export const ObjectGenerationOptionsSchema = z.object({
  id: z.string().optional(),
  version: z.string(),
  props: ObjectPropsSchema,
  languageModel: z.custom<LanguageModel>((val) => {
    return typeof val === "object" && val !== null;
  }, "languageModel should be an object"),
  providerOptions: z
    .custom<ProviderOptions>((val) => {
      return typeof val === "object" && val !== null;
    }, "providerOptions should be an object")
    .optional(),
  vmTimeoutMs: z.number().optional(),
  maxRetries: z.number().optional(),
});

export type ObjectGenerationOptions = z.infer<
  typeof ObjectGenerationOptionsSchema
>;

export enum Status {
  QUEUED = "queued",
  PROCESSING = "processing",
  SUCCEEDED = "succeeded",
  FAILED = "failed",
}

export type ObjectGenerationTaskState =
  | {
      version: string;
      status: Status.QUEUED | Status.PROCESSING;
      error: string | null;
      started_at: number;
      ended_at: null;
    }
  | {
      version: string;
      status: Status.SUCCEEDED | Status.FAILED;
      error: string | null;
      started_at: number;
      ended_at: number;
    };

export type ObjectGenerationState = {
  id: string;
  name: string;
  description: string;
  created_at: number;
  modified_at: number;
  is_processing: boolean;
  tasks: ObjectGenerationTaskState[];
};

const log = debug("obj-dsgn");

export class ObjectGenerationTask extends EventEmitter<{
  statusChange: [newStatus: Status, oldStatus: Status];
  completed: [result: TaskResult];
}> {
  private static readonly renderThreeJsGenerationPrompt =
    loadInstructionsTemplateSync<ObjectProps>("threejs-generation");

  constructor({
    id,
    version,
    props,
    languageModel,
    providerOptions,
    vmTimeoutMs,
    maxRetries,
  }: ObjectGenerationOptions) {
    super();

    // metadata
    this.id = id ?? generateRandomId();
    this.version = version;

    // time record
    this.startedAtMs = Date.now();

    // options
    const object_name = props.object_name.trim().replace(/\s+/g, "_");
    this.objectProps = {
      object_name,
      object_description: props.object_description,
    };
    this.languageModel = languageModel;
    this.providerOptions = providerOptions;
    this.vmTimeoutMs = vmTimeoutMs;
    this.maxRetries = maxRetries;

    this.log(`queued for object '${this.objectProps.object_name}'`);
  }

  log(...args: any[]) {
    return log(`task[${this.id}] version[${this.version}]`, ...args);
  }

  // metadata

  readonly id: string;
  readonly version: string;
  private _status: Status = Status.QUEUED;
  private cancelled = false;

  get status() {
    return this._status;
  }

  private set status(status: Status) {
    if (status === this._status) return;
    const oldStatus = this._status;
    this._status = status;
    this.emit("statusChange", status, oldStatus);
    this.log(`status changed from '${oldStatus}' to '${status}'`);
  }

  // time record

  readonly startedAtMs: number;

  // options

  readonly objectProps: ObjectProps;
  readonly languageModel: LanguageModel;
  readonly providerOptions?: ProviderOptions;
  readonly vmTimeoutMs?: number;
  readonly maxRetries?: number;

  // promises

  private taskPromise: Promise<void> | null = null;

  run() {
    if (this.taskPromise) return this.taskPromise;

    this.status = Status.PROCESSING;
    this.taskPromise = new Promise<void>((resolve) => {
      if (this.cancelled) return resolve();

      const instructions = ObjectGenerationTask.renderThreeJsGenerationPrompt(
        this.objectProps,
      );

      let isSucceeded = false;
      let retries = 0;
      const results: TaskResult[] = [];
      const maxRetries = Math.max(0, this.maxRetries ?? DEFAULT_MAX_RETRIES);

      (async () => {
        while (retries <= maxRetries) {
          if (retries != 0) {
            this.log(
              `Retry (${retries}/${maxRetries}), Reason:`,
              results.at(-1),
            );
          }

          try {
            const code = await generateCode({
              prompt: instructions,
              model: this.languageModel,
              providerOptions: this.providerOptions,
            });
            if (this.cancelled) return;

            const glb = await generateGlbFromCode({
              code,
              timeoutMs: this.vmTimeoutMs,
            });
            const result = { code, glb, mime_type: "model/gltf-binary" };

            if (this.cancelled) return;

            isSucceeded = true;
            results.push(result);

            break;
          } catch (err) {
            if (this.cancelled) return;

            results.push({ error: (err as Error)?.message ?? String(err) });
            retries += 1;

            continue;
          }
        }

        const result = results.at(-1) ?? { error: "No results available" };

        try {
          await this.save(result);
        } catch (err) {
          this.log("failed to save result:", err);
        } finally {
          this.status = isSucceeded ? Status.SUCCEEDED : Status.FAILED;
          resolve();
          this.emit("completed", result);
        }
      })();
    });

    return this.taskPromise;
  }

  cancel() {
    if (this.status === Status.SUCCEEDED || this.status === Status.FAILED) {
      return;
    }
    this.cancelled = true;
    this.status = Status.FAILED;

    const result = { error: "Task was cancelled" };
    this.save(result).finally(() => this.emit("completed", result));
  }

  private async save(result: TaskResult) {
    try {
      const { code, error, mime_type, glb } =
        "error" in result
          ? { ...result, code: null, mime_type: null, glb: null }
          : { ...result, error: null };
      const db = await connect();
      await db.queries.add_result({
        task: {
          id: this.id,
          name: this.objectProps.object_name,
          description: this.objectProps.object_description,
        },
        result: {
          version: this.version,
          code,
          error,
          mime_type,
          blob_content: glb,
          started_at: this.startedAtMs,
          ended_at: Date.now(),
        },
      });
    } catch (err) {
      this.log("failed to saved:", err);
    }
  }
}

class ObjectDesigner {
  private static readonly renderer = new GlbSnapshotsRenderer();

  static createSnapshotPng(glbBinary: GlbBinary) {
    return this.renderer.renderGlbSnapshotsToGrid(glbBinary, {
      size: 512,
      background: "#000000",
      format: "image/png",
      timeoutMs: 10_000,
    });
  }

  constructor() {}

  protected readonly processing = new Map<string, ObjectGenerationTask>();

  async getObjectState(taskId: string): Promise<ObjectGenerationState | null> {
    const db = await connect();
    const processingTask = this.processing.get(taskId);
    const response = await db.queries.get_task({ task_id: taskId });

    if (!response) return null;

    const tasks: ObjectGenerationTaskState[] = response.results.map((i) => ({
      ...i,
      status: i.success ? Status.SUCCEEDED : Status.FAILED,
    }));

    if (processingTask) {
      tasks.unshift({
        version: processingTask.version,
        status: Status.PROCESSING,
        error: null,
        started_at: processingTask.startedAtMs,
        ended_at: null,
      });
    }

    return {
      id: taskId,
      name: response.name,
      description: response.description,
      created_at: response.created_at,
      modified_at: response.modified_at,
      is_processing: Boolean(processingTask),
      tasks,
    };
  }

  async getObjectCode(taskId: string, version?: string) {
    const db = await connect();
    return await db.queries.get_result_code({ task_id: taskId, version });
  }

  async getObjectContent(taskId: string, version?: string) {
    const db = await connect();
    return await db.queries.get_result_content({ task_id: taskId, version });
  }

  addTask(options: ObjectGenerationOptions) {
    const task = new ObjectGenerationTask(options);

    this.processing.set(task.id, task);

    task.once("completed", () => {
      this.processing.delete(task.id);
    });

    task.run();

    return task;
  }

  cancelTask(id: string) {
    const task = this.processing.get(id);
    if (!task) return false;
    task.cancel();
    return true;
  }

  waitForTaskEnded(taskId: string, ms: number | null = null) {
    const task = this.processing.get(taskId);
    if (!task) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timeout =
        ms === null
          ? null
          : setTimeout(() => {
              task.off("completed", cb);
              resolve(false);
            }, ms);
      const cb = () => {
        if (timeout !== null) clearTimeout(timeout);
        resolve(true);
      };
      task.once("completed", cb);
    });
  }
}

export const designer = new ObjectDesigner();
