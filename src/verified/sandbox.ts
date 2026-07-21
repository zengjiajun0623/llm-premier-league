// Hermetic execution of model-authored Python.
//
// Protocol: the model authors ONLY a Python function `solve(input)`. The
// platform wraps it: read one JSON value from stdin, call solve, write the JSON
// result to stdout. The wrapped program is the ONLY thing that enters the
// container -- the spec / checker never do, so P cannot read S at runtime.
//
// Each execution runs exactly ONE input in a fresh container and returns the
// captured output; the TypeScript checker evaluates it afterward.
//
// Default backend: podman, --network none, --read-only + tmpfs /tmp, memory /
// cpu / pid caps, non-root, wall-clock timeout, 64KB stdout cap.
//
// SANDBOX=local backend: a plain `python3` subprocess with the same timeout and
// stdout cap. It is NON-HERMETIC (no isolation) and is intended ONLY for tests
// / CI on machines without podman. Never use it for real, untrusted models.

import { spawn } from "node:child_process";
import type { ExecOutcome, ResourceEnvelope } from "./types.js";

const PODMAN = "/opt/podman/bin/podman";
const IMAGE = "python:3.12-alpine";
const STDOUT_CAP = 64 * 1024;

// Platform-owned harness. `__USER__` is replaced by the model's solve body.
function wrap(userSrc: string): string {
  return (
    `import sys, json\n` +
    userSrc +
    `\n` +
    `def __run():\n` +
    `    data = sys.stdin.read()\n` +
    `    inp = json.loads(data) if data.strip() != '' else None\n` +
    `    out = solve(inp)\n` +
    `    sys.stdout.write(json.dumps(out))\n` +
    `__run()\n`
  );
}

export function sandboxMode(): "podman" | "local" {
  return process.env.SANDBOX === "local" ? "local" : "podman";
}

let imageEnsured = false;
async function ensureImage(): Promise<{ ok: true } | { ok: false; detail: string }> {
  if (imageEnsured) return { ok: true };
  const exists = await new Promise<boolean>((resolve) => {
    const p = spawn(PODMAN, ["image", "exists", IMAGE]);
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
  if (exists) {
    imageEnsured = true;
    return { ok: true };
  }
  const pulled = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    const p = spawn(PODMAN, ["pull", IMAGE]);
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", (e) => resolve({ ok: false, detail: `podman pull spawn failed: ${e.message}` }));
    p.on("close", (code) =>
      code === 0 ? resolve({ ok: true, detail: "" }) : resolve({ ok: false, detail: `podman pull exit ${code}: ${err.slice(0, 200)}` }),
    );
  });
  if (pulled.ok) imageEnsured = true;
  return pulled.ok ? { ok: true } : { ok: false, detail: pulled.detail };
}

interface RunRaw {
  spawnError?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

function runProcess(cmd: string, args: string[], stdin: string, timeoutMs: number): Promise<RunRaw> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ spawnError: e.message, exitCode: null, signal: null, stdout, stderr, timedOut, truncated });
    });
    child.stdout.on("data", (d) => {
      if (stdout.length < STDOUT_CAP) {
        stdout += d.toString();
        if (stdout.length >= STDOUT_CAP) {
          stdout = stdout.slice(0, STDOUT_CAP);
          truncated = true;
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 8192) stderr += d.toString();
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, signal, stdout, stderr, timedOut, truncated });
    });

    // Feed the input on stdin.
    child.stdin.on("error", () => {
      /* ignore EPIPE if the child died early */
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

function classifyRaw(raw: RunRaw): ExecOutcome {
  if (raw.spawnError) return { kind: "infra", detail: `spawn: ${raw.spawnError}` };
  if (raw.timedOut) return { kind: "timeout" };
  // podman engine-level failures (image/config/OCI runtime) surface as 125-127
  // BEFORE the user program runs -> harness defect, not a program fault.
  if (sandboxMode() === "podman" && raw.exitCode !== null && raw.exitCode >= 125 && raw.exitCode <= 127) {
    return { kind: "infra", detail: `podman exit ${raw.exitCode}: ${raw.stderr.slice(0, 200)}` };
  }
  if (raw.exitCode !== 0) return { kind: "crash", detail: `exit ${raw.exitCode}: ${raw.stderr.slice(0, 200)}` };
  if (raw.truncated) return { kind: "crash", detail: "stdout exceeded 64KB cap" };
  const text = raw.stdout.trim();
  try {
    return { kind: "ok", output: text === "" ? null : JSON.parse(text) };
  } catch {
    return { kind: "crash", detail: `unparseable stdout: ${text.slice(0, 120)}` };
  }
}

// Execute P on a single input. Returns the classified outcome.
export async function runInSandbox(
  proverSrc: string,
  input: unknown,
  env: ResourceEnvelope,
): Promise<ExecOutcome> {
  const program = wrap(proverSrc);
  const stdin = JSON.stringify(input);

  if (sandboxMode() === "local") {
    // Non-hermetic fallback: bare python3 subprocess. -I = isolated mode.
    const raw = await runProcess("python3", ["-I", "-c", program], stdin, env.timeoutMs);
    return classifyRaw(raw);
  }

  const ensured = await ensureImage();
  if (!ensured.ok) return { kind: "infra", detail: ensured.detail };

  const args = [
    "run",
    "--rm",
    "-i",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:size=16m,mode=1777",
    "--memory",
    "256m",
    "--cpus",
    "1",
    "--pids-limit",
    "64",
    "--user",
    "65534:65534",
    IMAGE,
    "python3",
    "-I",
    "-c",
    program,
  ];
  // Give podman a little headroom over the in-container wall clock for cold start.
  const raw = await runProcess(PODMAN, args, stdin, env.timeoutMs + 4000);
  return classifyRaw(raw);
}
