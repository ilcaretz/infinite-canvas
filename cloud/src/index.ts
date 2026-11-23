import { handle, purgeExpired } from './app';
import type { Env } from './env';

export default {
  fetch: (req: Request, env: Env) => handle(req, env),
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(purgeExpired(env).catch((e) => console.error('[purge]', e)));
  },
} satisfies ExportedHandler<Env>;
