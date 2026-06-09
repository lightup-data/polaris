FROM oven/bun:1
WORKDIR /app

# Install dependencies (cached layer)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source and entrypoints
COPY src/ ./src/
COPY docker/bridge-entrypoint.sh ./docker/

# Default: API server
CMD ["bun", "run", "src/service/server.ts"]
