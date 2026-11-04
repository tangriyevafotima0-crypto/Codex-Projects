# EduERP v2.0 — Center Data Plane Multi-Stage Dockerfile (API Minimal Runner + Dedicated Migrator Tooling Target — G03)
# Build context: eduerp-v2/ directory

FROM node:24.18.1-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json .nvmrc ./
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json

RUN npm ci --ignore-scripts --no-audit --no-fund

COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api
COPY docs/architecture/openapi.yaml ./docs/architecture/openapi.yaml
COPY docs/architecture/operation-inventory.csv ./docs/architecture/operation-inventory.csv

RUN npm --workspace=@eduerp/api run prisma:generate && npm --workspace=@eduerp/contracts run build && npm --workspace=@eduerp/api run build

# Dedicated one-shot migrator target (G03): retains Prisma 7 CLI, prisma.config.ts, schema.prisma, and SQL migrations.
FROM node:24.18.1-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS migrator
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S eduerp && adduser -S eduerp -G eduerp

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/apps/api/prisma.config.ts ./apps/api/prisma.config.ts
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma

USER eduerp
CMD ["npm", "--workspace=@eduerp/api", "run", "migrate:deploy"]

# Prune devDependencies and strip Prisma CLI from the production API runner dependencies (G03)
FROM builder AS prod-deps
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund && rm -rf /app/node_modules/prisma /app/node_modules/.bin/prisma /app/apps/api/node_modules/prisma /app/apps/api/node_modules/.bin/prisma

# Minimal production API runner target (G03): contains only runtime dependencies, compiled dist, and contract assets.
FROM node:24.18.1-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S eduerp && adduser -S eduerp -G eduerp

COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=prod-deps /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=prod-deps /app/apps/api/package.json ./apps/api/package.json
COPY --from=prod-deps /app/apps/api/dist ./apps/api/dist
COPY --from=prod-deps /app/docs/architecture/openapi.yaml ./docs/architecture/openapi.yaml
COPY --from=prod-deps /app/docs/architecture/operation-inventory.csv ./docs/architecture/operation-inventory.csv

USER eduerp
EXPOSE 3000

CMD ["node", "apps/api/dist/src/main.js"]
