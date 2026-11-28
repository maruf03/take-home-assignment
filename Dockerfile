# syntax=docker/dockerfile:1.7
# Multi-stage Node 24 monorepo image for @app/api and @app/worker (spec §10.4).

FROM node:24-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV SCARF_ANALYTICS=false
RUN corepack enable

FROM base AS prune
ARG APP=api
WORKDIR /repo
COPY . .
RUN pnpm dlx turbo@2.11.13 prune "@app/${APP}" --docker

FROM base AS build
ARG APP=api
WORKDIR /repo
COPY --from=prune /repo/out/json/ .
COPY --from=prune /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=prune /repo/out/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=prune /repo/.npmrc ./.npmrc
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm fetch --frozen-lockfile && pnpm install --offline --frozen-lockfile

COPY --from=prune /repo/out/full/ .
COPY --from=prune /repo/packages/config ./packages/config
COPY tsconfig.base.json ./tsconfig.base.json
RUN pnpm exec turbo run build --filter="@app/${APP}..."
RUN npm_config_inject_workspace_packages=true pnpm --filter "@app/${APP}" --prod deploy /out

FROM node:24-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS runtime
ENV NODE_ENV=production
ENV SCARF_ANALYTICS=false
WORKDIR /app
COPY --from=build --chown=node:node /out .
USER node
CMD ["node", "dist/src/main.js"]
