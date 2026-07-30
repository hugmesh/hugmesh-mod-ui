import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Moderator role-home / landing for the Moderator micro-frontend
 * (`hugmesh-mod-ui`). Visible only to ROLE_MOD or ROLE_ADMIN users
 * (route-guarded by {@link modGuard} at `/mod`).
 *
 * This is intentionally a narrow orientation page — the moderator's full toolkit
 * lives in the {@link ModerationConsoleComponent} at `/mod/console`. The
 * role-home provides a brief description of available actions and links into the
 * console. It is the mod-role analog of admin-ui's landing view.
 *
 * This component has NO logic and NO data fetching — it is a pure template that
 * renders links and descriptive text.
 *
 * @see {@link ModerationConsoleComponent} — the main working surface at `/mod/console`.
 * @see {@link modGuard}                   — route guard that enforces MOD/ADMIN role.
 */
@Component({
  selector: 'hug-mod-home',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './mod-home.component.html',
  styleUrl: './mod-home.component.scss',
})
export class ModHomeComponent {}
