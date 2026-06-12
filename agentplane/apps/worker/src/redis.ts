import IORedis from "ioredis";
import { config } from "./config.js";

// BullMQ requires maxRetriesPerRequest: null on its connection.
export const bullConnection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
export const publisher = new IORedis(config.redisUrl);
export const subscriber = new IORedis(config.redisUrl);
