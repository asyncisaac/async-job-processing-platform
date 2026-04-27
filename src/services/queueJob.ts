import type { TraceCarrier } from "../lib/tracePropagation.js";

export type QueueJobData = { jobId: string; requestId?: string; traceCarrier?: TraceCarrier };

