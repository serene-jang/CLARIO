import express from 'express';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

export function webHosting(roots: { teacher: string; student: string }) {
  const router = express.Router({ strict: true });
  router.get('/', (_request, response) => response.redirect(302, '/teacher/'));
  for (const role of ['teacher', 'student'] as const) {
    const root = resolve(roots[role]);
    if (!statSync(resolve(root, 'index.html')).isFile())
      throw new Error(`Missing ${role} web build.`);
    router.get(`/${role}`, (_request, response) => response.redirect(302, `/${role}/`));
    router.use(
      `/${role}/`,
      express.static(root, {
        dotfiles: 'ignore',
        fallthrough: true,
        index: 'index.html',
        setHeaders(response) {
          response.setHeader('Cache-Control', 'no-store');
          response.setHeader('X-Content-Type-Options', 'nosniff');
          response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        },
      }),
    );
  }
  return router;
}
