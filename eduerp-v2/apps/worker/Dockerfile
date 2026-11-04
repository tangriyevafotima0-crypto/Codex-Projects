# EduERP v2.0 — Center Outbox & Scheduler Worker Dockerfile (Stage 03 Foundation)
# Build context: eduerp-v2/ directory

FROM node:24.18.1-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json .nvmrc ./
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json

RUN npm ci --ignore-scripts --no-audit --no-fund

COPY packages/contracts ./packages/contracts
COPY apps/worker ./apps/worker
COPY docs/architecture/openapi.yaml ./docs/architecture/openapi.yaml
COPY docs/architecture/operation-inventory.csv ./docs/architecture/operation-inventory.csv

RUN npm --workspace=@eduerp/contracts run build && npm --workspace=@eduerp/worker run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.18.1-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S eduerp && adduser -S eduerp -G eduerp

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=builder /app/packages/contracts/dist ./packages/contracts/dist
# Preserve workspace-local dependencies as well as hoisted root modules.
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/docs/architecture/openapi.yaml ./docs/architecture/openapi.yaml
COPY --from=builder /app/docs/architecture/operation-inventory.csv ./docs/architecture/operation-inventory.csv

USER eduerp

CMD ["node", "apps/worker/dist/src/main.js"]
