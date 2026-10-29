import { defineConfig } from "vitest/config";

// PERF=1 runs the scale benchmarks (test/*.perf.ts) instead of the tests, showing what they print.
const perf = !!process.env.PERF;
export default defineConfig({ test: { include: [perf ? "test/**/*.perf.ts" : "test/**/*.test.ts"], ...(perf ? { silent: false } : {}) } });
