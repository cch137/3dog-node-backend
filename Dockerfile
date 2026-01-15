# syntax=docker/dockerfile:1

# Build stage: install all deps (including devDeps) and compile the app
FROM node:24-alpine AS build
WORKDIR /usr/src/app

# Copy only manifests first to leverage Docker layer caching
COPY package*.json ./
# Use a clean, reproducible install based on the lockfile
RUN npm run deps:dev

# Copy source code and build
COPY . .
# Ensure entrypoint is executable
RUN chmod +x /usr/src/app/bin/docker-entrypoint.sh
# Compile/transpile/bundle into the output folder (e.g., dist/)
RUN npm run build


# Runtime stage: keep the image small (only prod deps + build output)
FROM node:24-alpine AS runtime
WORKDIR /usr/src/app

# Runtime defaults
ENV NODE_ENV=production
ENV PORT=3609

# Install production-only dependencies
COPY package*.json ./
RUN npm run deps:prod

# Copy only what is needed to run
COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/bin ./bin

EXPOSE 3609

# Use an absolute path for reliability
ENTRYPOINT ["/usr/src/app/bin/docker-entrypoint.sh"]
CMD ["npm", "start"]
