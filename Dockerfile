FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
# server.ts imports the terminal WebSocket code directly from src (Bun runs the TS as-is)
COPY package.json server.ts ./
COPY src/lib/server ./src/lib/server
USER bun
EXPOSE 3000
CMD ["bun", "server.ts"]
