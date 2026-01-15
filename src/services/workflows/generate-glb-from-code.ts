import path from "path";
import { Worker } from "worker_threads";
import { transpile, ModuleKind, ScriptTarget } from "typescript";
import { CodeExecutionOptions } from "./schemas";
import z from "zod";

const WorkerLogsSchema = z.object({
  lines: z.array(
    z.object({
      level: z.string(),
      message: z.string(),
      ts: z.number(),
    })
  ),
  dropped: z.number(),
});

const GltfWorkerResultSchema = z.union([
  z.object({
    success: z.literal(true),
    object: z.instanceof(ArrayBuffer),
    logs: WorkerLogsSchema,
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
    from: z.string(),
    logs: WorkerLogsSchema,
  }),
]);

export function generateGlbFromCode({
  code,
  timeoutMs = 10_000,
}: CodeExecutionOptions) {
  return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    const workerPath = path.resolve(__dirname, "./workers/threejs.js");

    const js = transpile(code, {
      module: ModuleKind.CommonJS,
      target: ScriptTarget.ES2022,
    });

    const worker = new Worker(workerPath, { workerData: { code: js } });

    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      reject(new Error("Worker timeout"));
    }, timeoutMs);

    const done = (fn: () => void) => {
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn();
    };

    worker.once("message", (msg: unknown) => {
      done(async () => {
        const parsed = GltfWorkerResultSchema.safeParse(msg);
        if (!parsed.success) {
          return reject(new Error("Invalid worker message"));
        }
        const result = parsed.data;
        if (result.success) {
          return resolve(new Uint8Array(result.object));
        } else {
          return reject(new Error(`[${result.from}] ${result.error}`));
        }
      });
    });

    worker.once("error", (err) => done(() => reject(err)));

    worker.once("exit", (code) => {
      if (code !== 0)
        done(() => reject(new Error(`Worker exited with code ${code}`)));
    });
  });
}
