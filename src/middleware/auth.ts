import type { Context, Next } from 'hono';
import type { WorkerEnv } from '../types';

export async function authMiddleware(c: Context<{ Bindings: WorkerEnv }>, next: Next) {
  const token = c.req.query('token');
  const expected = c.env.ACCESS_TOKEN;

  if (!token || token !== expected) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  return next();
}
