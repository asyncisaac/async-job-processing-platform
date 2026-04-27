import { context, propagation, trace } from "@opentelemetry/api";

export type TraceCarrier = Record<string, string>;

export function injectTraceCarrier(): TraceCarrier | undefined {
  try {
    const span = trace.getSpan(context.active());
    if (!span) return undefined;
    const carrier: TraceCarrier = {};
    propagation.inject(context.active(), carrier);
    return Object.keys(carrier).length > 0 ? carrier : undefined;
  } catch {
    return undefined;
  }
}

export function extractContextFromCarrier(carrier: TraceCarrier | undefined) {
  if (!carrier) return context.active();
  try {
    return propagation.extract(context.active(), carrier);
  } catch {
    return context.active();
  }
}

