import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { config } from "./config.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  app.setGlobalPrefix("api/v1", { exclude: ["healthz"] });
  app.enableShutdownHooks();
  await app.listen(config.port);
  // eslint-disable-next-line no-console
  console.log(`[api] listening on http://localhost:${config.port} (prefix /api/v1)`);
}

void bootstrap();
