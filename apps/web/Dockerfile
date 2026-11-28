# syntax=docker/dockerfile:1.7
# Multi-stage Vite React SPA build served by unprivileged nginx on :8080 (spec §10.4 & §10.5).

FROM node:24-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS pruner
WORKDIR /repo
COPY . .
RUN pnpm dlx turbo@2.11.13 prune @app/web --docker

FROM base AS builder
WORKDIR /repo
COPY --from=pruner /repo/out/json/ .
COPY --from=pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /repo/out/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=pruner /repo/.npmrc ./.npmrc
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY --from=pruner /repo/out/full/ .
COPY --from=pruner /repo/packages/config ./packages/config
COPY tsconfig.base.json ./tsconfig.base.json
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=$VITE_API_BASE
RUN pnpm exec turbo run build --filter=@app/web...
RUN cp -r apps/web/dist apps/web/dist-public && find apps/web/dist-public -name '*.map' -delete

FROM nginxinc/nginx-unprivileged:1.27-alpine@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0 AS runtime
COPY infra/nginx/nginx.conf /etc/nginx/nginx.conf
COPY --from=builder /repo/apps/web/dist-public /usr/share/nginx/html
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
