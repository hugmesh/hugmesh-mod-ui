// REMOTE bundle config for the Moderator micro-frontend (native-federation remote
// name "mod"). The hugmesh.systems host consumes the single exposed
// `./routes` module via loadRemoteModule({ remoteName: 'mod', exposedModule:
// './routes' }) and mounts MOD_ROUTES at /mod — so the remote name and the
// exposed module key MUST stay unchanged or the host's moderator console breaks.
//
// The shared-deps surface + RxJS skip list live in ./federation-base.js so a
// change to the federation contract lands in one file, consistent with the host
// and every other HugMesh remote (games convention) — this file is the mod
// analog of hugmesh-admin-ui/federation.config.js.
const { hugmeshRemote } = require('./federation-base');

module.exports = hugmeshRemote({
  name: 'mod',
  exposes: {
    './routes': './src/app/mod.routes.ts',
  },
});
