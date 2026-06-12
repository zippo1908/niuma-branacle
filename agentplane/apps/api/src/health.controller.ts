import { Controller, Get } from "@nestjs/common";

@Controller()
export class HealthController {
  @Get("healthz")
  health() {
    return { ok: true, service: "agentplane-api", ts: new Date().toISOString() };
  }
}
