import { HttpInterceptorFn } from '@angular/common/http';

/** Sends the HttpOnly {@code bff_} session cookie (credentials) on every outgoing
 *  HttpClient request — the transport the generated ng-openapi-gen clients
 *  (src/app/api) use. The gateway's BffCookieToBearerWebFilter turns that cookie
 *  into the upstream Authorization: Bearer server-side, so the browser holds NO
 *  admin-capable bearer; it only forwards the opaque cookie. Mirrors
 *  hugmesh-user-ui's auth.interceptor.ts.
 *
 *  <p>The generated request-builder issues same-origin {@code /bff/mod/**}
 *  requests; flipping {@code withCredentials} on here makes the browser attach
 *  the cookie on those XHRs. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  return next(req.clone({ withCredentials: true }));
};
