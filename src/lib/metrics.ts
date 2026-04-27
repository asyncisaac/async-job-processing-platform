import type { RequestHandler } from "express";
import client from "prom-client";

export const register = new client.Registry();

client.collectDefaultMetrics({ register });

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"] as const,
  registers: [register]
});

export const httpRequestDurationMs = new client.Histogram({
  name: "http_request_duration_ms",
  help: "HTTP request duration in milliseconds",
  labelNames: ["method", "route", "status"] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [register]
});

export const jobsProcessedTotal = new client.Counter({
  name: "jobs_processed_total",
  help: "Total processed jobs",
  labelNames: ["type", "result"] as const,
  registers: [register]
});

export const jobProcessingDurationMs = new client.Histogram({
  name: "job_processing_duration_ms",
  help: "Job processing duration in milliseconds",
  labelNames: ["type", "result"] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [register]
});

export const metricsMiddleware: RequestHandler = (req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const route = (req.route?.path as string | undefined) ?? req.path;
    const status = String(res.statusCode);
    httpRequestsTotal.inc({ method: req.method, route, status });
    httpRequestDurationMs.observe({ method: req.method, route, status }, durationMs);
  });
  next();
};

export const metricsHandler: RequestHandler = async (_req, res) => {
  res.setHeader("content-type", register.contentType);
  res.send(await register.metrics());
};

