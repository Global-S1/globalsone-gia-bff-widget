# Stage 1: Dependencies & Development
FROM node:20-alpine AS development

WORKDIR /app
ENV NODE_ENV=development
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

COPY package*.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod=false

COPY . .
# Stage para desarrollo con Hot Refresh

# Stage 2: Build for Production
FROM development AS builder
RUN pnpm build

# Stage 3: Production Runtime
FROM node:20-alpine AS production

WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Usuario no-root por seguridad
RUN addgroup -S nodejs && adduser -S nodejs -G nodejs

COPY package*.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/build ./build
COPY --from=builder /app/config ./config

RUN chown -R nodejs:nodejs /app
USER nodejs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/v1/health/live || exit 1

CMD ["node", "build/index.js"]
