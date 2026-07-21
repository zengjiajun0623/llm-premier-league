// SYNCHRONOUS sandboxed execution for the admission pipeline.
//
// Why a second executor when sandbox.ts already exists?
//   - sandbox.ts is async (spawn) and only knows how to run a single model-authored
//     `solve(input)`. The admission gates and the runtime adapter need to run a
//     *pair* of model-authored Python sources -- a candidate `solve` AND a
//     proposal-supplied `check(input, output)` -- and combine their results.
//   - The runtime adapter must present ArtifactClass.checkOutput as a SYNCHRONOUS
//     boolean (match.ts calls it synchronously). A proposed class's checker is
//     Python, so the only way to honor that signature is a synchronous sandbox
//     call. spawnSync gives us exactly that.
//
// This executor honors the same SANDBOX=local / podman split as sandbox.ts and
// the same stdin-JSON -> solve -> stdout-JSON protocol. It is used ONLY by the
// offline admission machinery (gate checks, sim runs, tests), never on the
// real-money leg hot-path.

import { spawnSync } from "node:child_process";
import type { ExecOutcome, ResourceEnvelope } from "../types.js";

const PODMAN = "/opt/podman/bin/podman";
const IMAGE = "python:3.12-alpine";
const STDOUT_CAP = 64 * 1024;

function sandboxMode(): "podman" | "local" {
  return process.env.SANDBOX === "local" ? "local" : "podman";
}

// Platform-owned harness (identical protocol to sandbox.ts): read one JSON value
// from stdin, hand it to `solve`, serialize the return value to stdout.
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

// A Python source string literal for embedding another program's source safely.
// JSON.stringify output is a valid Python str literal (\n, \", \\, \uXXXX all
// mean the same in Python; JSON never emits \/ or other Python-hostile escapes).
export function pyStr(s: string): string {
  return JSON.stringify(s);
}

function classify(res: ReturnType<typeof spawnSync>): ExecOutcome {
  // spawnSync sets `error` on timeout (code ETIMEDOUT) or spawn failure.
  const err = res.error as (Error & { code?: string }) | undefined;
  if (err) {
    if (err.code === "ETIMEDOUT" || res.signal === "SIGTERM" || res.signal === "SIGKILL") {
      return { kind: "timeout" };
    }
    return { kind: "infra", detail: `spawn: ${err.message}` };
  }
  if (res.signal === "SIGTERM" || res.signal === "SIGKILL") return { kind: "timeout" };
  const stdout = (res.stdout ?? "").toString();
  const stderr = (res.stderr ?? "").toString();
  if (stdout.length > STDOUT_CAP) return { kind: "crash", detail: "stdout exceeded 64KB cap" };
  // podman engine-level failures surface as 125-127 before the user program runs.
  if (sandboxMode() === "podman" && res.status !== null && res.status >= 125 && res.status <= 127) {
    return { kind: "infra", detail: `podman exit ${res.status}: ${stderr.slice(0, 200)}` };
  }
  if (res.status !== 0) return { kind: "crash", detail: `exit ${res.status}: ${stderr.slice(0, 200)}` };
  const text = stdout.trim();
  try {
    return { kind: "ok", output: text === "" ? null : JSON.parse(text) };
  } catch {
    return { kind: "crash", detail: `unparseable stdout: ${text.slice(0, 120)}` };
  }
}

// Run a wrapped `solve` program on one input, synchronously.
export function runSyncSandbox(proverSrc: string, input: unknown, env: ResourceEnvelope): ExecOutcome {
  const program = wrap(proverSrc);
  const stdin = JSON.stringify(input);

  if (sandboxMode() === "local") {
    const res = spawnSync("python3", ["-I", "-c", program], {
      input: stdin,
      timeout: env.timeoutMs,
      maxBuffer: STDOUT_CAP * 4,
      encoding: "utf8",
    });
    return classify(res);
  }

  const args = [
    "run", "--rm", "-i",
    "--network", "none",
    "--read-only",
    "--tmpfs", "/tmp:size=16m,mode=1777",
    "--memory", "256m",
    "--cpus", "1",
    "--pids-limit", "64",
    "--user", "65534:65534",
    IMAGE, "python3", "-I", "-c", program,
  ];
  const res = spawnSync(PODMAN, args, {
    input: stdin,
    timeout: env.timeoutMs + 4000,
    maxBuffer: STDOUT_CAP * 4,
    encoding: "utf8",
  });
  return classify(res);
}

// Result of running a candidate `solve` and grading its output with a proposal's
// Python `check(input, output)`.
export type CheckedRun =
  | { kind: "ok"; pass: boolean; output: unknown }
  | { kind: "bad"; outcome: ExecOutcome }; // solution or checker crashed / timed out / infra

// Run `solution` on `input`, then grade with `checker`, in ONE hermetic process.
// The solution's `solve` and the checker's `check` are exec'd into separate
// namespaces so their top-level names never collide (either may be model-authored).
export function evalSolutionChecked(
  checkerSrc: string,
  solutionSrc: string,
  input: unknown,
  env: ResourceEnvelope,
): CheckedRun {
  const combined =
    `_SOL = ${pyStr(solutionSrc)}\n` +
    `_CHK = ${pyStr(checkerSrc)}\n` +
    `def solve(inp):\n` +
    `    _sol_ns = {}\n` +
    `    exec(_SOL, _sol_ns)\n` +
    `    _chk_ns = {}\n` +
    `    exec(_CHK, _chk_ns)\n` +
    `    out = _sol_ns["solve"](inp)\n` +
    `    ok = _chk_ns["check"](inp, out)\n` +
    `    return {"output": out, "pass": bool(ok)}\n`;
  const outcome = runSyncSandbox(combined, input, env);
  if (outcome.kind !== "ok") return { kind: "bad", outcome };
  const o = outcome.output as { output: unknown; pass: boolean } | null;
  if (!o || typeof o !== "object" || typeof o.pass !== "boolean") {
    return { kind: "bad", outcome: { kind: "crash", detail: "checker returned a non-boolean protocol result" } };
  }
  return { kind: "ok", pass: o.pass, output: o.output };
}

// Grade an already-produced (input, output) pair with the proposal's checker
// only -- the synchronous primitive the runtime adapter's checkOutput needs. A
// crashing / timing-out / non-boolean checker is treated as NOT verified (false).
export function checkOutputSync(
  checkerSrc: string,
  input: unknown,
  output: unknown,
  env: ResourceEnvelope,
): boolean {
  const combined =
    `_CHK = ${pyStr(checkerSrc)}\n` +
    `def solve(inp):\n` +
    `    _chk_ns = {}\n` +
    `    exec(_CHK, _chk_ns)\n` +
    `    return bool(_chk_ns["check"](inp["input"], inp["output"]))\n`;
  const outcome = runSyncSandbox(combined, { input, output }, env);
  return outcome.kind === "ok" && outcome.output === true;
}

// Run a candidate `solve` on an input and return its raw output (for computing
// the difficulty-gate constant baseline). Returns undefined on any non-ok run.
export function runSolutionRaw(solutionSrc: string, input: unknown, env: ResourceEnvelope): { ok: boolean; output?: unknown } {
  const outcome = runSyncSandbox(solutionSrc, input, env);
  return outcome.kind === "ok" ? { ok: true, output: outcome.output } : { ok: false };
}
