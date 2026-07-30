import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';
import { authInterceptor } from './app/auth.interceptor';

// Bootstrap the standalone dev-shell application. This file is only executed when
// the remote is served standalone (`ng serve mod`); in production the host shell
// bootstraps its own Angular app and federates `./routes` (MOD_ROUTES) directly —
// this bootstrap is not involved. Session state is read from `localStorage` via
// SessionService (no provider needed — it is `providedIn: 'root'`).
bootstrapApplication(AppComponent, {
  providers: [
    provideRouter(routes),
    // The generated ng-openapi-gen clients (src/app/api) talk over HttpClient;
    // the auth interceptor sends the HttpOnly bff_ session cookie (credentials)
    // — the gateway turns it into the upstream Bearer, so the browser holds no
    // admin-capable bearer of its own.
    provideHttpClient(withInterceptors([authInterceptor])),
  ],
}).catch((err) => console.error(err));
