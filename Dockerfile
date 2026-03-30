# Multi-stage Dockerfile for aio-abs-providers
FROM node:24-bullseye-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production

FROM node:24-bullseye-slim AS runner
WORKDIR /app
# Create non-root user
RUN groupadd -r app && useradd -r -g app app || true
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN chown -R app:app /app
# Install gosu for proper privilege dropping in the entrypoint (correct signal forwarding).
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*
# The entrypoint runs as root, fixes mounted volume permissions, then drops to the app user.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENV NODE_ENV=production
EXPOSE 4000
ENTRYPOINT ["/entrypoint.sh"]
CMD ["npm", "run", "start:backbone"]
