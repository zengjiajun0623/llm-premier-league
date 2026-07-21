import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Tests point RESULTS_DIR at a temp dir so simulated seasons never touch real results.
export function resultsDir(): string {
  return process.env.RESULTS_DIR ?? join(ROOT, "results");
}
