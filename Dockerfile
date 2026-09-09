# syntax=docker/dockerfile:1.7
#
# Four stages, three of them only to keep the last one small: the image that ships holds the
# bundle, the production dependencies and nothing else — no sources, no compiler, no pnpm store.
#
#   docker build -t orangcode-api .
#   docker build -t orangcode-migrate --target migrate .

# Debian rather than Alpine: sharp and @node-rs/argon2 ship prebuilt binaries for glibc, and a
# musl image would either rebuild them from source or fail at the first hash.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# Dependencies alone, so the layer is reused for as long as the lockfile is unchanged.
# `--ignore-scripts` blocks arbitrary code from the dependency tree at build time; the one
# script that matters, `prisma generate`, is run explicitly below.
FROM base AS deps
COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY . .
# The Prisma client is generated into src/, so it has to exist before the bundle is built.
RUN pnpm exec prisma generate && pnpm build

# Migrations need the Prisma CLI, which is a development dependency and has no place in the
# image that serves traffic. They run from this one instead, once, before the instances start.
FROM build AS migrate
ENV NODE_ENV=production
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Never root, and never able to rewrite its own code: the whole tree belongs to another user.
USER node
EXPOSE 3000

# Compiled in, so the orchestrator learns about a dead process without an extra binary in the
# image. `/ready` also reports the database and Redis, which is what "can serve" really means.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT??3000)+'/ready').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "dist/server.js"]
