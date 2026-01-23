"use strict";

/**
 * SECURITY NOTES
 * - This worker executes untrusted code: Node's vm is NOT a perfect security boundary.
 * - This implementation blocks:
 *   - Node's real require / built-in modules (fs, child_process, node:*, etc.)
 *   - network / timers on the sandbox global (fetch, setTimeout...)
 *   - console output to stdout/stderr (captured and returned instead)
 * - Allowed modules for sandbox code:
 *   - "three"
 *   - "three/addons/*" (with fallback to "three/examples/jsm/*")
 *   - "three/examples/jsm/*" (with fallback to "three/addons/*")
 */

const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const { Blob: NodeBlob } = require("node:buffer");
const { stringify: safeStableStringify } = require("safe-stable-stringify");

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

function isAllowedThreeSpecifier(id) {
  if (id === "three") return true;
  if (typeof id !== "string") return false;
  return id.startsWith("three/addons/") || id.startsWith("three/examples/jsm/");
}

function getThreeFallbackSpecifier(id) {
  if (id.startsWith("three/addons/")) {
    return id.replace("three/addons/", "three/examples/jsm/");
  }
  if (id.startsWith("three/examples/jsm/")) {
    return id.replace("three/examples/jsm/", "three/addons/");
  }
  return null;
}

function collectStaticRequireSpecifiers(code) {
  // Only preload sync `require("...")` dependencies (because require is sync).
  const out = new Set();
  const re = /require\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  for (const m of code.matchAll(re)) out.add(m[2]);
  return out;
}

function toExportNames(ns) {
  return Reflect.ownKeys(ns).filter((k) => typeof k === "string");
}

/**
 * Normalize ESM module namespace for sandbox:
 * - If namespace has `.default` (object/function), treat it as primary "require" value.
 * - Inject named exports onto `.default` (or overlay with Proxy if frozen).
 * - Provide compat `{ BufferGeometryUtils }` + `THREE.BufferGeometryUtils` patterns.
 */
function normalizeThreeModuleForSandbox(specifier, ns, THREE) {
  const hasDefault =
    ns &&
    Object.prototype.hasOwnProperty.call(ns, "default") &&
    ns.default != null;

  let defaultMain = hasDefault ? ns.default : undefined;

  // Prefer .default as require() value when it's object/function.
  if (
    hasDefault &&
    (typeof defaultMain === "object" || typeof defaultMain === "function")
  ) {
    // Try to inject named exports onto default
    try {
      for (const k of Reflect.ownKeys(ns)) {
        if (k === "default" || typeof k !== "string") continue;
        if (defaultMain[k] === undefined) {
          Object.defineProperty(defaultMain, k, {
            value: ns[k],
            writable: false,
            configurable: true,
          });
        }
      }
    } catch {
      // If default is frozen/non-extensible, overlay with Proxy instead of mutating.
      const proxy = new Proxy(defaultMain, {
        get(target, prop, receiver) {
          if (prop === "default") return target;
          if (Reflect.has(target, prop))
            return Reflect.get(target, prop, receiver);
          return ns[prop];
        },
      });
      defaultMain = proxy;
    }
  }

  // vmNamespace is what vm SyntheticModule will export from
  const vmNamespace = { ...(ns || {}) };
  if (hasDefault) vmNamespace.default = defaultMain;

  // Compat: provide { BufferGeometryUtils } and THREE.BufferGeometryUtils
  const m = /\/([^/]+)\.js$/.exec(String(specifier));
  if (m) {
    const base = m[1]; // e.g. BufferGeometryUtils
    if (base.endsWith("Utils")) {
      const utilsObj =
        hasDefault && defaultMain != null ? defaultMain : vmNamespace;

      if (vmNamespace[base] === undefined) vmNamespace[base] = utilsObj;

      if (THREE && THREE[base] === undefined) {
        Object.defineProperty(THREE, base, {
          value: utilsObj,
          writable: false,
          configurable: false,
          enumerable: false,
        });
      }
    }
  }

  const requireValue =
    hasDefault && defaultMain != null ? defaultMain : vmNamespace;

  return { requireValue, vmNamespace };
}

(async () => {
  const {
    console: capturedConsole,
    logs,
    getDropped,
  } = createCapturedConsole();
  globalThis.console = capturedConsole;

  try {
    globalThis.Blob = globalThis.Blob || NodeBlob;
    globalThis.FileReader = globalThis.FileReader || MockFileReader;

    const userCode = String(workerData.code || "");

    // Use ESM import for three to keep addons consistent.
    const threeNS = await import("three");
    const THREE = { ...threeNS }; // mutable wrapper

    const dynamicVmModuleCache = new Map();

    const importThreeModule = async (id) => {
      try {
        return { ns: await import(id), resolved: id };
      } catch (e1) {
        const fb = getThreeFallbackSpecifier(id);
        if (!fb) throw e1;
        return { ns: await import(fb), resolved: fb };
      }
    };

    // Preload GLTFExporter
    const gltf = await importThreeModule(
      "three/addons/exporters/GLTFExporter.js",
    );
    const { GLTFExporter } = gltf.ns;

    if (!Object.prototype.hasOwnProperty.call(THREE, "GLTFExporter")) {
      Object.defineProperty(THREE, "GLTFExporter", {
        value: GLTFExporter,
        writable: false,
        configurable: false,
        enumerable: false,
      });
    }

    // Preload require() deps (sync require needs preloaded objects)
    const MODULES = Object.create(null);

    // "three" itself
    MODULES.three = THREE;

    // GLTFExporter paths (normalized)
    {
      const norm = normalizeThreeModuleForSandbox(
        "three/addons/exporters/GLTFExporter.js",
        gltf.ns,
        THREE,
      );
      MODULES["three/addons/exporters/GLTFExporter.js"] = norm.requireValue;
      MODULES["three/examples/jsm/exporters/GLTFExporter.js"] =
        norm.requireValue;
    }

    // Preload any statically used require("three/addons/...") modules
    const requireSpecifiers = collectStaticRequireSpecifiers(userCode);
    for (const id of requireSpecifiers) {
      if (!isAllowedThreeSpecifier(id)) continue;
      if (id === "three") continue;
      if (MODULES[id]) continue;

      const m = await importThreeModule(id);
      const norm = normalizeThreeModuleForSandbox(id, m.ns, THREE);

      MODULES[id] = norm.requireValue;
      // Also register resolved alias (addons<->examples)
      MODULES[m.resolved] = norm.requireValue;
    }

    const sandbox = {
      globalThis: null,
      console: capturedConsole,

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

      THREE,
      GLTFExporter,
      Blob: globalThis.Blob,
      FileReader: globalThis.FileReader,
      TextEncoder: globalThis.TextEncoder,
      TextDecoder: globalThis.TextDecoder,
      URL: globalThis.URL,

      __MODULES__: Object.freeze(MODULES),

      EXPORT_GLB: (obj) => postSuccess(obj, logs, getDropped()),
      EXPORT_ERROR: (err) => postFail("sandbox", err, logs, getDropped()),
    };
    sandbox.globalThis = sandbox;

    defineBlocked(sandbox, "process");
    defineBlocked(sandbox, "Buffer");
    defineBlocked(sandbox, "__dirname");
    defineBlocked(sandbox, "__filename");

    defineBlocked(sandbox, "setTimeout");
    defineBlocked(sandbox, "setInterval");
    defineBlocked(sandbox, "setImmediate");
    defineBlocked(sandbox, "clearTimeout");
    defineBlocked(sandbox, "clearInterval");
    defineBlocked(sandbox, "clearImmediate");
    defineBlocked(sandbox, "fetch");

    defineBlocked(sandbox, "eval");
    defineBlocked(sandbox, "Function");
    defineBlocked(sandbox, "WebAssembly");

    const context = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });

    const prelude = `
"use strict";
(() => {
  const modules = globalThis.__MODULES__;
  const hasOwn = Object.prototype.hasOwnProperty;

  function sandboxRequire(id) {
    if (typeof id !== "string") throw new Error("require(id) expects a string literal");
    if (!hasOwn.call(modules, id)) throw new Error("Module not allowed (or not preloaded for require): " + id);
    return modules[id];
  }

  const exports = {};
  const module = { exports };

  Object.defineProperty(globalThis, "require", { value: sandboxRequire, writable: false, configurable: false });
  Object.defineProperty(globalThis, "exports", { value: exports, writable: false, configurable: false });
  Object.defineProperty(globalThis, "module", { value: module, writable: false, configurable: false });
})();
`;

    const importModuleDynamically = async (specifier) => {
      if (!isAllowedThreeSpecifier(specifier)) {
        throw new Error("Dynamic import not allowed: " + String(specifier));
      }

      const cached = dynamicVmModuleCache.get(specifier);
      if (cached) return cached;

      let ns;
      if (specifier === "three") {
        // Use the same wrapper object as require("three")
        ns = { ...THREE, default: THREE };
      } else {
        const m = await importThreeModule(specifier);
        ns = m.ns;
      }

      const norm = normalizeThreeModuleForSandbox(specifier, ns, THREE);
      const vmNS = norm.vmNamespace;

      const exportNames = toExportNames(vmNS);
      const mod = new vm.SyntheticModule(
        exportNames,
        function () {
          for (const name of exportNames) this.setExport(name, vmNS[name]);
        },
        { context },
      );

      dynamicVmModuleCache.set(specifier, mod);

      if (mod.status === "unlinked") {
        await mod.link(() => {
          throw new Error(
            "Unexpected dependency in synthetic module: " + specifier,
          );
        });
      }
      await mod.evaluate();

      return mod;
    };

    const script = new vm.Script(prelude + userCode, {
      importModuleDynamically,
    });

    script.runInContext(context, { timeout: 5_000 });
  } catch (e) {
    postFail("vm", e, logs, getDropped());
  }
})();
