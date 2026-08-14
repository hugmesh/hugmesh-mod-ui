# hugmesh-mod-ui — builds the Moderator native-federation REMOTE
# (src → dist/mod) and serves it via nginx with CORS so the
# hugmesh.net host can fetch its remoteEntry.json cross-origin.
# Deployed to the hugmesh-frontend namespace, fronted by the fe-gateway at
# /mod. Casdoor MOD/ADMIN-role guarded by the host.
# Angular CLI 22 requires Node >= 24.15.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# --base-href is REQUIRED: this UI is served under /mod/ behind the fe-gateway.
# Without it Angular emits ROOT-relative asset URLs, so loading /mod/ fetches
# /styles-*.css from the gateway root, gets the shell's HTML back, and the
# remote renders BLANK — it only works when opened at the container's own
# address (operator report, 2026-08-14). The generator's .stack-src tree
# carried this as an UNCOMMITTED local edit; committed here so a clean clone
# builds a working image.
RUN npm run build:mod -- --base-href=/mod/

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/mod/browser /usr/share/nginx/html
EXPOSE 80

#### Runtime THEME injection (the fleet-wide login-ui 50-snap-theme.sh
#### mechanism; see hugmesh-host-shell PR #11 for the full rationale). The hook
#### writes $SNAP_THEME_CSS verbatim at container start; nginx serves it via
#### the exact-match /snap-theme.css alias. /tmp, NOT the docroot: on the
#### nginx-unprivileged images uid 101 cannot write the docroot, and on the
#### root images /tmp is equally correct — ONE stanza for the whole fleet.
#### COPY --chmod, NOT COPY + RUN chmod: unprivileged final stages run as
#### uid 101 and a RUN chmod on root-owned COPY output exits 1 (BuildKit is
#### always on for this stack: Makefile DOCKER_BUILDKIT=1).
COPY --chmod=0755 docker-entrypoint.d/50-snap-theme.sh /docker-entrypoint.d/50-snap-theme.sh
ENV SNAP_THEME_OUT=/tmp/snap-theme.css
