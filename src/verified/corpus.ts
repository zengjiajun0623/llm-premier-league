// Five platform-owned artifact classes. Each is seeded/parametrized so every
// leg gets a fresh instance, and each checker is discriminative: a correct
// reference solution passes smoke + edges; a plausible-but-sloppy variant is
// refutable by at least one in-envelope input.

import { mulberry32 } from "../rng.js";
import type { ArtifactClass, ProblemInstance } from "./types.js";

// ---------------------------------------------------------------------------
// helpers (platform-owned; never shipped into the sandbox)
// ---------------------------------------------------------------------------

function isIntArray(x: unknown, max: number, lo: number, hi: number): x is number[] {
  return (
    Array.isArray(x) &&
    x.length <= max &&
    x.every((v) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi)
  );
}

function jsonBytes(x: unknown): number {
  return Buffer.byteLength(JSON.stringify(x), "utf8");
}

function multisetEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const m = new Map<number, number>();
  for (const v of a) m.set(v, (m.get(v) ?? 0) + 1);
  for (const v of b) {
    const c = m.get(v);
    if (!c) return false;
    if (c === 1) m.delete(v);
    else m.set(v, c - 1);
  }
  return m.size === 0;
}

// ===========================================================================
// A. sortlist — array/integer function with an algebraic property spec.
//    solve(list) -> the same multiset, ordered per instance direction.
// ===========================================================================
const sortlist: ArtifactClass = {
  id: "sortlist",
  description: "Reorder a list of integers into sorted order (a permutation of the input).",
  envelope: { timeoutMs: 8000, maxInputBytes: 8192 },
  inputGrammar:
    "A JSON array of integers, e.g. [3,1,-2,2]. Length 0..200, each value in [-1000000000, 1000000000].",
  generate(seed) {
    const r = mulberry32(seed ^ 0xa11);
    const order: "asc" | "desc" = r() < 0.5 ? "asc" : "desc";
    return {
      classId: "sortlist",
      seed,
      params: { order },
      boundsDescription: "0..200 integers, each in [-1e9, 1e9].",
      statementForProver:
        `Implement \`solve(nums)\` where nums is a list of integers. Return a new list ` +
        `containing exactly the same integers (same multiset, duplicates preserved) ` +
        `sorted in ${order === "asc" ? "NON-DECREASING (ascending)" : "NON-INCREASING (descending)"} order. ` +
        `Bounds: 0..200 elements, each in [-1e9, 1e9].`,
    };
  },
  validateInput(input, inst) {
    return isIntArray(input, 200, -1e9, 1e9) && jsonBytes(input) <= inst.classId.length + this.envelope.maxInputBytes;
  },
  checkOutput(input, output, inst) {
    if (!isIntArray(input, 200, -1e9, 1e9)) return false;
    if (!Array.isArray(output) || !output.every((v) => typeof v === "number" && Number.isInteger(v))) return false;
    const out = output as number[];
    if (!multisetEqual(input as number[], out)) return false;
    const asc = inst.params.order === "asc";
    for (let i = 1; i < out.length; i++) {
      if (asc ? out[i] < out[i - 1] : out[i] > out[i - 1]) return false;
    }
    return true;
  },
  hiddenSmokeInputs() {
    // Duplicate-free so a dedup-buggy solve still passes smoke.
    return [[], [1], [2, 1], [-5, 3, 10], [-1000000000, 1000000000, 0]];
  },
  edgeInputs() {
    return [[2, 2, 1], [1, 1], [0, 0, 0], [5, -5, 5], [3, 1, 2], [7, 7, 7, 1]];
  },
  referenceSolveSrc(inst) {
    const rev = inst.params.order === "desc" ? "True" : "False";
    return `def solve(nums):\n    return sorted(nums, reverse=${rev})\n`;
  },
  buggySolveSrc(inst) {
    // Sorts correctly but drops duplicates -> violates the permutation invariant.
    const rev = inst.params.order === "desc" ? "True" : "False";
    return `def solve(nums):\n    return sorted(set(nums), reverse=${rev})\n`;
  },
  brokenSolveSrc() {
    return `def solve(nums):\n    raise ValueError("nope")\n`;
  },
};

// ===========================================================================
// B. caesar — string transformation checked against a platform reference oracle.
//    solve(s) -> s with each ASCII letter shifted by k (case preserved).
// ===========================================================================
function caesarRef(s: string, k: number): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) out += String.fromCharCode(((c - 65 + k) % 26) + 65);
    else if (c >= 97 && c <= 122) out += String.fromCharCode(((c - 97 + k) % 26) + 97);
    else out += ch;
  }
  return out;
}
const caesar: ArtifactClass = {
  id: "caesar",
  description: "Caesar-shift the ASCII letters of a string by a fixed k, preserving case and non-letters.",
  envelope: { timeoutMs: 8000, maxInputBytes: 8192 },
  inputGrammar: "A JSON string, 0..2000 characters (any Unicode). e.g. \"Hello, World!\"",
  generate(seed) {
    const r = mulberry32(seed ^ 0xcae);
    const k = 1 + Math.floor(r() * 25); // 1..25
    return {
      classId: "caesar",
      seed,
      params: { k },
      boundsDescription: "String of 0..2000 characters.",
      statementForProver:
        `Implement \`solve(s)\` where s is a string. Shift every ASCII letter forward by ${k} ` +
        `positions within its case (wrapping z->a and Z->A). Uppercase stays uppercase, ` +
        `lowercase stays lowercase. Leave every non-letter character (digits, spaces, ` +
        `punctuation, and any non-ASCII character) unchanged. Return the resulting string. ` +
        `Bounds: 0..2000 characters.`,
    };
  },
  validateInput(input, inst) {
    return typeof input === "string" && wellFormed(input) && [...input].length <= 2000 && jsonBytes(input) <= this.envelope.maxInputBytes;
  },
  checkOutput(input, output, inst) {
    if (typeof input !== "string" || typeof output !== "string") return false;
    return output === caesarRef(input, inst.params.k as number);
  },
  hiddenSmokeInputs() {
    // Lowercase / non-letter only, so a "lowercase-only" bug still passes smoke.
    return ["", "abc", "the quick brown fox", "a1 b2 c3", "zzz"];
  },
  edgeInputs() {
    return ["Hello, World!", "ABC", "MixedCase", "Zebra", "café", "Ünïcode", "XYZ"];
  },
  referenceSolveSrc(inst) {
    const k = inst.params.k as number;
    return (
      `def solve(s):\n` +
      `    out = []\n` +
      `    for ch in s:\n` +
      `        o = ord(ch)\n` +
      `        if 65 <= o <= 90:\n` +
      `            out.append(chr((o - 65 + ${k}) % 26 + 65))\n` +
      `        elif 97 <= o <= 122:\n` +
      `            out.append(chr((o - 97 + ${k}) % 26 + 97))\n` +
      `        else:\n` +
      `            out.append(ch)\n` +
      `    return ''.join(out)\n`
    );
  },
  buggySolveSrc(inst) {
    // Shifts lowercase only; leaves uppercase untouched.
    const k = inst.params.k as number;
    return (
      `def solve(s):\n` +
      `    out = []\n` +
      `    for ch in s:\n` +
      `        o = ord(ch)\n` +
      `        if 97 <= o <= 122:\n` +
      `            out.append(chr((o - 97 + ${k}) % 26 + 97))\n` +
      `        else:\n` +
      `            out.append(ch)\n` +
      `    return ''.join(out)\n`
    );
  },
  brokenSolveSrc() {
    return `def solve(s):\n    return 12345\n`; // wrong type -> fails smoke
  },
};

// ===========================================================================
// C. calc — stateful mini-parser/evaluator, checked vs a platform reference.
//    solve(expr) -> integer value of an arithmetic expression (+ - *, parens).
// ===========================================================================
// Recursive-descent reference with correct precedence. Returns null on a parse
// A lone UTF-16 surrogate cannot be UTF-8 encoded: the reference itself would
// crash, so such strings are outside every string-class envelope.
function wellFormed(s: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

// error (used both to evaluate and, via validateInput, to enforce grammar Q).
function calcEval(expr: string, mod: number): number | null {
  let i = 0;
  const s = expr;
  const applyMod = (v: number): number => {
    if (mod <= 0) return v;
    const m = ((v % mod) + mod) % mod; // python-style non-negative modulo
    return m;
  };
  function skip() {
    while (i < s.length && s[i] === " ") i++;
  }
  function parseExpr(): number | null {
    let v = parseTerm();
    if (v === null) return null;
    for (;;) {
      skip();
      const op = s[i];
      if (op === "+" || op === "-") {
        i++;
        const t = parseTerm();
        if (t === null) return null;
        v = op === "+" ? v + t : v - t;
      } else break;
    }
    return v;
  }
  function parseTerm(): number | null {
    let v = parseFactor();
    if (v === null) return null;
    for (;;) {
      skip();
      if (s[i] === "*") {
        i++;
        const f = parseFactor();
        if (f === null) return null;
        v = v * f;
      } else break;
    }
    return v;
  }
  function parseFactor(): number | null {
    skip();
    if (s[i] === "(") {
      i++;
      const v = parseExpr();
      if (v === null) return null;
      skip();
      if (s[i] !== ")") return null;
      i++;
      return v;
    }
    const start = i;
    while (i < s.length && s[i] >= "0" && s[i] <= "9") i++;
    if (i === start) return null;
    // reject absurdly long literals to stay in a sane integer range
    if (i - start > 15) return null;
    return parseInt(s.slice(start, i), 10);
  }
  const v = parseExpr();
  if (v === null) return null;
  skip();
  if (i !== s.length) return null; // trailing garbage
  return applyMod(v);
}
const calc: ArtifactClass = {
  id: "calc",
  description: "Evaluate an arithmetic expression with +, -, * and parentheses (correct precedence).",
  envelope: { timeoutMs: 8000, maxInputBytes: 4096 },
  inputGrammar:
    "A JSON string holding an arithmetic expression over non-negative integer literals, " +
    "the binary operators + - *, parentheses ( ), and optional spaces. No unary minus, no " +
    "division. e.g. \"2 + 3 * (4 - 1)\". Max 500 characters.",
  generate(seed) {
    const r = mulberry32(seed ^ 0xca1c);
    const mod = r() < 0.5 ? 0 : 1000000007;
    return {
      classId: "calc",
      seed,
      params: { mod },
      boundsDescription: "Expression string up to 500 chars; standard operator precedence.",
      statementForProver:
        `Implement \`solve(expr)\` where expr is a string containing an arithmetic expression over ` +
        `non-negative integer literals, the binary operators + - * , parentheses, and optional spaces. ` +
        `Evaluate it with standard precedence (\`*\` binds tighter than \`+\`/\`-\`; \`+\`/\`-\` are ` +
        `left-associative) and return the integer result` +
        (mod ? ` reduced modulo ${mod} (a non-negative remainder).` : `.`) +
        ` There is no division and no unary minus. Max 500 characters.`,
    };
  },
  validateInput(input, inst) {
    if (typeof input !== "string" || input.length > 500 || jsonBytes(input) > this.envelope.maxInputBytes) return false;
    // Precondition Q: must parse under the grammar.
    return calcEval(input, inst.params.mod as number) !== null;
  },
  checkOutput(input, output, inst) {
    if (typeof input !== "string") return false;
    const expected = calcEval(input, inst.params.mod as number);
    if (expected === null) return false;
    return typeof output === "number" && Number.isInteger(output) && output === expected;
  },
  hiddenSmokeInputs() {
    // No precedence interaction, so a left-to-right (no-precedence) bug still
    // passes smoke.
    return ["0", "7", "1+2", "10-3-2", "(4)", "2+2+2"];
  },
  edgeInputs() {
    return ["2+3*4", "2*3+4", "(1+2)*3", "10-2*3", "1+2*3+4", "100*0+5", "((2+3))*2"];
  },
  referenceSolveSrc(inst) {
    const mod = inst.params.mod as number;
    const tail = mod ? `\n    return _e() % ${mod}\n` : `\n    return _e()\n`;
    return (
      `def solve(expr):\n` +
      `    s = expr; pos = [0]\n` +
      `    def skip():\n` +
      `        while pos[0] < len(s) and s[pos[0]] == ' ': pos[0]+=1\n` +
      `    def _f():\n` +
      `        skip()\n` +
      `        if pos[0] < len(s) and s[pos[0]] == '(': \n` +
      `            pos[0]+=1; v=_e(); skip(); pos[0]+=1; return v\n` +
      `        st=pos[0]\n` +
      `        while pos[0] < len(s) and s[pos[0]].isdigit(): pos[0]+=1\n` +
      `        return int(s[st:pos[0]])\n` +
      `    def _t():\n` +
      `        v=_f()\n` +
      `        while True:\n` +
      `            skip()\n` +
      `            if pos[0] < len(s) and s[pos[0]]=='*': pos[0]+=1; v*=_f()\n` +
      `            else: break\n` +
      `        return v\n` +
      `    def _e():\n` +
      `        v=_t()\n` +
      `        while True:\n` +
      `            skip()\n` +
      `            if pos[0] < len(s) and s[pos[0]]=='+': pos[0]+=1; v+=_t()\n` +
      `            elif pos[0] < len(s) and s[pos[0]]=='-': pos[0]+=1; v-=_t()\n` +
      `            else: break\n` +
      `        return v` +
      tail
    );
  },
  buggySolveSrc(inst) {
    // Naive left-to-right, ignores '*' precedence.
    const mod = inst.params.mod as number;
    const tail = mod ? ` % ${mod}` : ``;
    return (
      `def solve(expr):\n` +
      `    e = expr.replace('(', ' ( ').replace(')', ' ) ')\n` +
      `    import re\n` +
      `    toks = re.findall(r'\\d+|[+*()-]', expr)\n` +
      `    # evaluate flat left-to-right, no precedence, no parens handling\n` +
      `    val = 0; op = '+'\n` +
      `    for t in toks:\n` +
      `        if t in '+-*':\n` +
      `            op = t\n` +
      `        elif t in '()':\n` +
      `            continue\n` +
      `        else:\n` +
      `            n = int(t)\n` +
      `            if op=='+': val += n\n` +
      `            elif op=='-': val -= n\n` +
      `            else: val *= n\n` +
      `    return val${tail}\n`
    );
  },
  brokenSolveSrc() {
    return `def solve(expr):\n    return "not an int"\n`;
  },
};

// ===========================================================================
// D. subsetsum — constraint-satisfaction: P must OUTPUT a solution; the checker
//    verifies it (classic verify-easy NP style). Ground truth by brute force.
//    solve({nums, target}) -> list of DISTINCT indices summing to target, or null.
// ===========================================================================
function subsetExists(nums: number[], target: number): boolean {
  const n = nums.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    let s = 0;
    for (let b = 0; b < n; b++) if (mask & (1 << b)) s += nums[b];
    if (s === target) return true;
  }
  return false;
}
function validSubsetInput(x: unknown): x is { nums: number[]; target: number } {
  if (typeof x !== "object" || x === null) return false;
  const o = x as any;
  return (
    isIntArray(o.nums, 18, -1e6, 1e6) &&
    typeof o.target === "number" &&
    Number.isInteger(o.target) &&
    Math.abs(o.target) <= 1e7
  );
}
const subsetsum: ArtifactClass = {
  id: "subsetsum",
  description: "Output a subset of indices whose values sum to a target, or null if impossible.",
  envelope: { timeoutMs: 8000, maxInputBytes: 4096 },
  inputGrammar:
    'A JSON object {"nums": [int,...], "target": int}. nums has 0..18 integers in [-1e6, 1e6]; ' +
    "target is an integer with |target| <= 1e7.",
  generate(seed) {
    return {
      classId: "subsetsum",
      seed,
      params: {},
      boundsDescription: "nums: 0..18 integers in [-1e6,1e6]; target integer, |target|<=1e7.",
      statementForProver:
        `Implement \`solve(inp)\` where inp is a dict {"nums": list of ints, "target": int}. ` +
        `Return a list of DISTINCT indices into nums whose values sum EXACTLY to target ` +
        `(the empty list is valid when target is 0). If no such subset exists, return null (Python None). ` +
        `Bounds: 0..18 numbers in [-1e6,1e6], |target|<=1e7.`,
    };
  },
  validateInput(input, inst) {
    return validSubsetInput(input) && jsonBytes(input) <= this.envelope.maxInputBytes;
  },
  checkOutput(input, output, inst) {
    if (!validSubsetInput(input)) return false;
    const { nums, target } = input;
    if (output === null) {
      // Claim: no subset sums to target. Verify by brute force.
      return !subsetExists(nums, target);
    }
    if (!Array.isArray(output)) return false;
    const idx = output as unknown[];
    const seen = new Set<number>();
    let sum = 0;
    for (const v of idx) {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v >= nums.length) return false;
      if (seen.has(v)) return false; // indices must be distinct
      seen.add(v);
      sum += nums[v];
    }
    return sum === target;
  },
  hiddenSmokeInputs() {
    // Cases a greedy solver happens to get right (no greedy trap).
    return [
      { nums: [1, 2, 3], target: 5 },
      { nums: [1, 2, 3], target: 6 },
      { nums: [2, 4], target: 5 }, // no solution
      { nums: [], target: 0 }, // empty subset
      { nums: [10], target: 10 },
    ];
  },
  edgeInputs() {
    return [
      { nums: [4, 3, 3], target: 6 }, // greedy grabs 4, then stuck -> wrongly null
      { nums: [5, 4, 3], target: 7 }, // greedy grabs 5, stuck
      { nums: [8, 5, 5, 2], target: 10 },
      { nums: [1, 1, 1], target: 2 },
      { nums: [7, 6, 5], target: 11 },
    ];
  },
  referenceSolveSrc() {
    return (
      `def solve(inp):\n` +
      `    nums = inp["nums"]; target = inp["target"]; n = len(nums)\n` +
      `    for mask in range(1 << n):\n` +
      `        s = 0; idx = []\n` +
      `        for b in range(n):\n` +
      `            if mask & (1 << b):\n` +
      `                s += nums[b]; idx.append(b)\n` +
      `        if s == target:\n` +
      `            return idx\n` +
      `    return None\n`
    );
  },
  buggySolveSrc() {
    // Greedy: sort by value descending, take while it fits. Misses many subsets.
    return (
      `def solve(inp):\n` +
      `    nums = inp["nums"]; target = inp["target"]\n` +
      `    order = sorted(range(len(nums)), key=lambda i: -nums[i])\n` +
      `    s = 0; idx = []\n` +
      `    for i in order:\n` +
      `        if s + nums[i] <= target:\n` +
      `            s += nums[i]; idx.append(i)\n` +
      `    return idx if s == target else None\n`
    );
  },
  brokenSolveSrc() {
    // Returns indices that may not sum correctly AND reuses; fails smoke.
    return `def solve(inp):\n    return [0, 0]\n`;
  },
};

// ===========================================================================
// E. textmetrics — numeric/edge-case-heavy: unicode, empty, multibyte, overflow.
//    solve(s) -> {length: code points, bytes: utf-8 length, checksum: sum(ord) mod 2^31}.
// ===========================================================================
const MOD31 = 2 ** 31;
function textMetricsRef(s: string): { length: number; bytes: number; checksum: number } {
  const cps = [...s];
  let checksum = 0;
  for (const ch of cps) checksum = (checksum + ch.codePointAt(0)!) % MOD31;
  return { length: cps.length, bytes: Buffer.byteLength(s, "utf8"), checksum };
}
const textmetrics: ArtifactClass = {
  id: "textmetrics",
  description: "Report Unicode code-point count, UTF-8 byte length, and a code-point checksum of a string.",
  envelope: { timeoutMs: 8000, maxInputBytes: 12288 },
  inputGrammar: "A JSON string, 0..2000 code points (any Unicode incl. emoji / astral chars).",
  generate(seed) {
    return {
      classId: "textmetrics",
      seed,
      params: {},
      boundsDescription: "String of 0..2000 Unicode code points.",
      statementForProver:
        `Implement \`solve(s)\` where s is a string. Return a dict with three integer fields: ` +
        `"length" = the number of Unicode CODE POINTS in s (not UTF-16 units and not bytes), ` +
        `"bytes" = the number of bytes in the UTF-8 encoding of s, and ` +
        `"checksum" = (sum of the integer code point values of all characters) modulo 2147483648. ` +
        `Handle empty strings, non-ASCII, and astral/emoji characters correctly. Bounds: 0..2000 code points.`,
    };
  },
  validateInput(input, inst) {
    return typeof input === "string" && wellFormed(input) && [...input].length <= 2000 && jsonBytes(input) <= this.envelope.maxInputBytes;
  },
  checkOutput(input, output, inst) {
    if (typeof input !== "string" || typeof output !== "object" || output === null) return false;
    const o = output as any;
    const ref = textMetricsRef(input);
    return o.length === ref.length && o.bytes === ref.bytes && o.checksum === ref.checksum;
  },
  hiddenSmokeInputs() {
    // Pure ASCII, where code-point count == byte count (a bytes-for-length bug passes).
    return ["", "a", "hello", "12345", "The quick brown fox."];
  },
  edgeInputs() {
    return ["é", "café", "😀", "a😀b", "naïve", "Ω≈ç√", "日本語", "\u{1F600}\u{1F601}"];
  },
  referenceSolveSrc() {
    return (
      `def solve(s):\n` +
      `    cps = list(s)\n` +
      `    checksum = 0\n` +
      `    for ch in cps:\n` +
      `        checksum = (checksum + ord(ch)) % ${MOD31}\n` +
      `    return {"length": len(cps), "bytes": len(s.encode('utf-8')), "checksum": checksum}\n`
    );
  },
  buggySolveSrc() {
    // Uses UTF-8 byte length as the "length" -> wrong for any non-ASCII input.
    return (
      `def solve(s):\n` +
      `    b = s.encode('utf-8')\n` +
      `    checksum = 0\n` +
      `    for ch in s:\n` +
      `        checksum = (checksum + ord(ch)) % ${MOD31}\n` +
      `    return {"length": len(b), "bytes": len(b), "checksum": checksum}\n`
    );
  },
  brokenSolveSrc() {
    return `def solve(s):\n    return {"length": -1}\n`; // missing fields -> fails smoke
  },
};

export const CORPUS: ArtifactClass[] = [sortlist, caesar, calc, subsetsum, textmetrics];

export function classById(id: string): ArtifactClass {
  const c = CORPUS.find((k) => k.id === id);
  if (!c) throw new Error(`unknown artifact class: ${id}`);
  return c;
}

export function classForLeg(index: number): ArtifactClass {
  return CORPUS[((index % CORPUS.length) + CORPUS.length) % CORPUS.length];
}
