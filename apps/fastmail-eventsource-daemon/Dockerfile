# Fastmail EventSource Daemon
# This daemon connects to Fastmail's EventSource API for real-time email notifications

FROM node:20-alpine

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files and prisma schema
COPY package.json pnpm-lock.yaml* ./
COPY prisma ./prisma/

# Install dependencies (this also runs prisma generate via postinstall)
RUN pnpm install --frozen-lockfile

# Copy source files
COPY . .

# Build TypeScript
RUN pnpm build

# Run the daemon
CMD ["pnpm", "start"]
