FROM oven/bun:1.3.9-slim AS base
WORKDIR /app

FROM base AS install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS runtime
ENV NODE_ENV=production
ENV AGENT_MAILBOX_HTTP_HOST=0.0.0.0
# Align the app's listen port with EXPOSE (config falls back PORT -> 8137).
ENV PORT=8080

COPY --from=install /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src

EXPOSE 8080
# Drop root (oven/bun ships a non-root `bun` user, uid 1000).
USER bun
CMD ["bun", "run", "http"]
