import { env } from "./config.js";
import { createApp } from "./app.js";
import { logger } from "./lib/logger.js";
import { initTracing } from "./lib/tracing.js";

initTracing("ajpp-api");

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "api_started");
});

process.on("SIGINT", () => server.close());
process.on("SIGTERM", () => server.close());

