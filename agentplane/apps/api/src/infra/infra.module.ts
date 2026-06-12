import { Global, Module } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { createDb, type Database } from "@agentplane/db";
import { QUEUES } from "@agentplane/shared";
import { config } from "../config.js";

export const DB = Symbol("DB");
export const RUN_QUEUE = Symbol("RUN_QUEUE");
export const CLONE_QUEUE = Symbol("CLONE_QUEUE");
export const GIT_OPS_QUEUE = Symbol("GIT_OPS_QUEUE");
export const DEPLOY_QUEUE = Symbol("DEPLOY_QUEUE");
export const PUBLISHER = Symbol("PUBLISHER");

const connection = { host: hostFrom(config.redisUrl), port: portFrom(config.redisUrl), maxRetriesPerRequest: null };

function hostFrom(url: string) {
  return new URL(url).hostname;
}
function portFrom(url: string) {
  return Number(new URL(url).port || "6379");
}

@Global()
@Module({
  providers: [
    { provide: DB, useFactory: (): Database => createDb(config.databaseUrl).db },
    { provide: RUN_QUEUE, useFactory: () => new Queue(QUEUES.agentRuns, { connection }) },
    { provide: CLONE_QUEUE, useFactory: () => new Queue(QUEUES.projectClone, { connection }) },
    { provide: GIT_OPS_QUEUE, useFactory: () => new Queue(QUEUES.gitOps, { connection }) },
    { provide: DEPLOY_QUEUE, useFactory: () => new Queue(QUEUES.deploy, { connection }) },
    { provide: PUBLISHER, useFactory: () => new IORedis(config.redisUrl) },
  ],
  exports: [DB, RUN_QUEUE, CLONE_QUEUE, GIT_OPS_QUEUE, DEPLOY_QUEUE, PUBLISHER],
})
export class InfraModule {}
