import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionService } from './session.service';

/**
 * Route guard that restricts the moderator micro-frontend (`/mod/**`) to callers
 * holding a Casdoor `'mod'`, `'admin'` or `'superadmin'` role (superadmin since
 * operator decision 100, 2026-09-23). Unauthenticated or insufficiently
 * privileged callers are redirected to `/login`.
 *
 * The guard uses {@link SessionService.isMod}, which mirrors the mod-bff-api's
 * server-side `hasAnyRole('MOD','ADMIN','SUPERADMIN')` check on `/bff/mod/**`. This is DEFENCE-IN-DEPTH: the
 * BFF remains the authoritative gate; the guard simply prevents loading the
 * moderation UI bundle for users who cannot use it.
 *
 * @see {@link SessionService.isMod} — the derived role signal this guard consults.
 * @see {@link MOD_ROUTES}           — where this guard is applied.
 */
export const modGuard: CanActivateFn = () => {
  const session = inject(SessionService);
  const router = inject(Router);
  // Allow access when the caller holds the MOD, ADMIN or SUPERADMIN role.
  if (session.isMod()) return true;
  // Redirect to the login page for any other caller (unauthenticated or wrong role).
  return router.parseUrl('/login');
};
