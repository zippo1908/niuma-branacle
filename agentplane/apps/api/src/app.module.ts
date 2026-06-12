import { Module } from "@nestjs/common";
import { InfraModule } from "./infra/infra.module.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { AuthController } from "./auth/auth.controller.js";
import { ProjectsController } from "./projects/projects.controller.js";
import { DemandsController } from "./demands/demands.controller.js";
import { RunsController } from "./runs/runs.controller.js";
import { ProfilesController } from "./profiles/profiles.controller.js";
import { CicdController } from "./cicd/cicd.controller.js";
import { WebhooksController } from "./cicd/webhooks.controller.js";
import { HealthController } from "./health.controller.js";

@Module({
  imports: [InfraModule],
  controllers: [
    HealthController,
    AuthController,
    ProjectsController,
    DemandsController,
    RunsController,
    ProfilesController,
    CicdController,
    WebhooksController,
  ],
  providers: [AuthGuard],
})
export class AppModule {}
