FROM oven/bun:1
WORKDIR /app

# Install dependencies (cached layer)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source and entrypoints
COPY src/ ./src/
COPY docker/bridge-entrypoint.sh ./docker/

# Build Tailwind CSS
RUN bunx tailwindcss -i src/web/styles/input.css -o src/web/styles/output.css --minify

# Default: API server
CMD ["bun", "run", "src/service/server.ts"]
