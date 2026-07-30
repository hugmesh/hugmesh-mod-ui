import { Routes } from '@angular/router';
import { MOD_ROUTES } from './mod.routes';

/**
 * Dev-shell routes for standalone development (`ng serve mod`). Mounts the
 * federated {@link MOD_ROUTES} at the root so the moderator remote is fully
 * browsable without the host shell. The host shell ignores this file and loads
 * `./routes` (MOD_ROUTES) directly via the native-federation manifest.
 */
export const routes: Routes = [{ path: '', children: MOD_ROUTES }];
