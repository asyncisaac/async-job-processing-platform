import { JobStatus, type Job } from "@prisma/client";
import { ServiceError } from "./serviceError.js";

export function assertManualRetryAllowed(job: Pick<Job, "status">) {
  const allowed = job.status === JobStatus.dlq || job.status === JobStatus.enqueue_failed || job.status === JobStatus.failed;
  if (!allowed) throw new ServiceError("invalid_state", 409);
}

export function assertDlqReplayAllowed(job: Pick<Job, "status">) {
  if (job.status !== JobStatus.dlq) throw new ServiceError("not_dlq", 409);
}

