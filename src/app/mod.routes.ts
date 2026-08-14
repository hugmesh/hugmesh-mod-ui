import { Routes } from '@angular/router';
import { ModHomeComponent } from './mod-home.component';
import { ModerationConsoleComponent } from './moderation-console.component';
import { FindingsPanelComponent } from './findings-panel.component';
import { modGuard } from './mod.guard';

/**
 * Routes exposed by the Moderator native-federation remote (`./routes`). The
 * hugmesh.net host mounts these at `/mod`, giving:
 *
 * - `/mod`          → {@link ModHomeComponent}          — moderator role-home / landing.
 * - `/mod/console`  → {@link ModerationConsoleComponent} — moderation console (queue +
 *   refer-to-admin + ban/lift + domain-lock + server-wide block + audit trail).
 * - `/mod/findings` → {@link FindingsPanelComponent}     — automated edge-AI
 *   system-finding queue (list + confirm/dismiss).
 *
 * MOD/ADMIN role is enforced server-side by the mod-bff-api. {@link modGuard} is
 * applied here as `canActivate` for defence-in-depth: it prevents loading the
 * moderation UI bundle for callers who cannot use it, for both the host-mounted
 * and standalone / dev-shell builds. (The e2e guard-outcome coverage in
 * `e2e/features/moderation/findings-panel.feature` asserts unauthenticated /
 * plain-user callers are redirected to `/login` from `/mod/findings` too.)
 */
export const MOD_ROUTES: Routes = [
  { path: '', component: ModHomeComponent, canActivate: [modGuard] },
  { path: 'console', component: ModerationConsoleComponent, canActivate: [modGuard] },
  { path: 'findings', component: FindingsPanelComponent, canActivate: [modGuard] },
];
