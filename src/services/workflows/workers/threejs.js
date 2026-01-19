"use strict";

/**
 * SECURITY NOTES
 * - This worker executes untrusted code: Node's vm is NOT a perfect security boundary.
 * - This implementation blocks:
 *   - Node's real require / built-in modules (fs, child_process, node:*, etc.)
 *   - network / timers on the sandbox global (fetch, setTimeout...)
 *   - console output to stdout/stderr (captured and returned instead)
 * - Allowed modules for sandbox code: only "three" and GLTFExporter paths.
 */

const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const { Blob: NodeBlob } = require("node:buffer");
const { stringify: safeStableStringify } = require("safe-stable-stringify");

const THREE = require("three");

function serializeError(e) {
  if (e instanceof Error) return `${e.message}\n${e.stack || ""}`.trim();
  return String(e);
}

function safeToString(v) {
  if (typeof v === "string") return v;
  if (v instanceof Error) return `${v.message}\n${v.stack || ""}`.trim();
  return safeStableStringify(v, {
    maxLength: 1000,
    circularPlaceholder: "[Circular]",
  });
}

function createCapturedConsole() {
  const MAX_LOGS = 2000;
  const logs = [];
  let dropped = 0;

  const push = (level, args) => {
    if (logs.length >= MAX_LOGS) {
      dropped++;
      logs.shift();
    }
    const msg = args.map(safeToString).join(" ");
    logs.push({ level, message: msg, ts: Date.now() });
  };

  const captured = {
    log: (...a) => push("log", a),
    info: (...a) => push("info", a),
    warn: (...a) => push("warn", a),
    error: (...a) => push("error", a),
    debug: (...a) => push("debug", a),
    trace: (...a) => {
      const stack = new Error().stack || "";
      push("trace", [...a, stack]);
    },
  };

  return { console: captured, logs, getDropped: () => dropped };
}

// Minimal FileReader polyfill for GLTFExporter
class MockFileReader {
  constructor() {
    this.result = null;
    this.error = null;
    this.onload = null;
    this.onloadend = null;
    this.onerror = null;
  }
  async readAsArrayBuffer(blob) {
    try {
      this.result = await blob.arrayBuffer();
      if (typeof this.onload === "function") this.onload({ target: this });
      if (typeof this.onloadend === "function")
        this.onloadend({ target: this });
    } catch (e) {
      this.error = e;
      if (typeof this.onerror === "function") this.onerror(e);
      if (typeof this.onloadend === "function")
        this.onloadend({ target: this });
    }
  }
  async readAsDataURL(blob) {
    try {
      const ab = await blob.arrayBuffer();
      const buf = Buffer.from(ab);
      const type = blob.type || "application/octet-stream";
      this.result = `data:${type};base64,${buf.toString("base64")}`;
      if (typeof this.onload === "function") this.onload({ target: this });
      if (typeof this.onloadend === "function")
        this.onloadend({ target: this });
    } catch (e) {
      this.error = e;
      if (typeof this.onerror === "function") this.onerror(e);
      if (typeof this.onloadend === "function")
        this.onloadend({ target: this });
    }
  }
}

function defineBlocked(sandbox, name) {
  Object.defineProperty(sandbox, name, {
    value: undefined,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

function postSuccess(object, logs, droppedLogs) {
  parentPort.postMessage({
    success: true,
    object,
    logs: { lines: logs, dropped: droppedLogs },
  });
}

function postFail(from, err, logs, droppedLogs) {
  parentPort.postMessage({
    success: false,
    from,
    error: serializeError(err),
    logs: { lines: logs, dropped: droppedLogs },
  });
}

(async () => {
  // Capture all console output in this worker (including three.js / GLTFExporter warnings)
  const {
    console: capturedConsole,
    logs,
    getDropped,
  } = createCapturedConsole();
  globalThis.console = capturedConsole;

  try {
    // Polyfills required by GLTFExporter in Node
    globalThis.Blob = globalThis.Blob || NodeBlob;
    globalThis.FileReader = globalThis.FileReader || MockFileReader;

    // Load GLTFExporter (support both paths)
    let GLTFExporter;
    try {
      ({ GLTFExporter } =
        await import("three/addons/exporters/GLTFExporter.js"));
    } catch {
      ({ GLTFExporter } =
        await import("three/examples/jsm/exporters/GLTFExporter.js"));
    }

    // fix: inject GLTFExporter into THREE namespace to fix LLM reference errors.
    if (!THREE.GLTFExporter) THREE.GLTFExporter = GLTFExporter;

    // Allowed modules for sandbox code
    const MODULES = Object.freeze({
      three: THREE,
      "three/examples/jsm/exporters/GLTFExporter.js": Object.freeze({
        GLTFExporter,
      }),
      "three/addons/exporters/GLTFExporter.js": Object.freeze({ GLTFExporter }),
    });

    // Sandbox globals (no Node builtins, no real require)
    const sandbox = {
      globalThis: null, // set below
      console: capturedConsole,

      // fix: share intrinsics to avoid cross-realm TypedArray mismatch
      ArrayBuffer,
      DataView,
      Uint8Array,
      Uint8ClampedArray,
      Uint16Array,
      Uint32Array,
      Int8Array,
      Int16Array,
      Int32Array,
      Float32Array,
      Float64Array,

      // minimal APIs needed by typical three.js code/exporter
      THREE,
      GLTFExporter,
      Blob: globalThis.Blob,
      FileReader: globalThis.FileReader,
      TextEncoder: globalThis.TextEncoder,
      TextDecoder: globalThis.TextDecoder,
      URL: globalThis.URL,

      // internal module map for the restricted require
      __MODULES__: MODULES,

      EXPORT_GLB: (obj) => postSuccess(obj, logs, getDropped()),
      EXPORT_ERROR: (err) => postFail("sandbox", err, logs, getDropped()),
    };
    sandbox.globalThis = sandbox;

    // Block common escape/I/O surfaces in sandbox
    // require, module, exports are defined inside the sandbox separately
    defineBlocked(sandbox, "process");
    defineBlocked(sandbox, "Buffer");
    defineBlocked(sandbox, "__dirname");
    defineBlocked(sandbox, "__filename");

    // Block timers & networking (avoid hanging worker / exfiltration)
    defineBlocked(sandbox, "setTimeout");
    defineBlocked(sandbox, "setInterval");
    defineBlocked(sandbox, "setImmediate");
    defineBlocked(sandbox, "clearTimeout");
    defineBlocked(sandbox, "clearInterval");
    defineBlocked(sandbox, "clearImmediate");
    defineBlocked(sandbox, "fetch");

    // Optional: disable eval/Function references (codegen also disabled below)
    defineBlocked(sandbox, "eval");
    defineBlocked(sandbox, "Function");
    defineBlocked(sandbox, "WebAssembly");

    // Create context with code generation blocked (prevents eval/new Function)
    const context = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });

    // Define a require inside the sandbox realm (NOT Node's require)
    const prelude = `
"use strict";
(() => {
  const modules = globalThis.__MODULES__;
  const hasOwn = Object.prototype.hasOwnProperty;

  function sandboxRequire(id) {
    if (typeof id !== "string") throw new Error("require(id) expects a string literal");
    if (!hasOwn.call(modules, id)) throw new Error("Module not allowed: " + id);
    return modules[id];
  }

  const exports = {};
  const module = { exports };

  Object.defineProperty(globalThis, "require", { value: sandboxRequire, writable: false, configurable: false });
  Object.defineProperty(globalThis, "exports", { value: exports, writable: false, configurable: false });
  Object.defineProperty(globalThis, "module", { value: module, writable: false, configurable: false });
})();
`;

    const userCode = String(workerData.code || "");
    const script = new vm.Script(prelude + userCode);

    // timeout only applies to synchronous execution
    script.runInContext(context, { timeout: 5_000 });
  } catch (e) {
    postFail("vm", e, logs, getDropped());
  }
})();
