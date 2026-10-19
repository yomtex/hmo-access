import path from "node:path";

// Load test environment into this worker before any app module reads it.
process.loadEnvFile(path.resolve(__dirname, "../.env.test"));
(process.env as Record<string, string>).NODE_ENV = "test";
// Tests drive the background worker explicitly (runJobsUntilIdle) so results are deterministic.
(process.env as Record<string, string>).JOBS_RUN_IN_WEB = "false";
