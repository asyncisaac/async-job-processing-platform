import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

let started = false;

export function initTracing(serviceName: string) {
  if (started) return;
  started = true;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;

  if (process.env.OTEL_LOG_LEVEL === "debug") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter({
      url: endpoint.endsWith("/") ? `${endpoint}v1/traces` : `${endpoint}/v1/traces`
    }),
    instrumentations: [getNodeAutoInstrumentations()]
  });

  sdk.start();

  process.on("SIGINT", () => sdk.shutdown().finally(() => process.exit(0)));
  process.on("SIGTERM", () => sdk.shutdown().finally(() => process.exit(0)));
}

