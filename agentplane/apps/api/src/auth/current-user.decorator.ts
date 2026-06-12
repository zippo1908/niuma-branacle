import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { AuthedUser } from "./auth.guard.js";

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthedUser => {
  const req = ctx.switchToHttp().getRequest<{ user: AuthedUser }>();
  return req.user;
});
