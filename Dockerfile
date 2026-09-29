# ---- build stage: full Node toolchain, installs production dependencies only ----
# Pinned by tag AND digest: the tag is for humans, the digest is what is pulled
# (Dependabot's "docker" ecosystem bumps both when a new image is published).
FROM node:26-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no dependency gets to run code on the build machine.
RUN npm ci --omit=dev --ignore-scripts

# ---- runtime stage: distroless = no shell, no package manager, no npm ----
# nodejs24-debian13 is the only supported Node 24 line (distroless marks every
# other tag deprecated). The :nonroot variant already runs as uid 65532.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:bb6b03d81066993293a10feda7250e8e1cc034035fe9b61cfceededa7c8bf04d
LABEL org.opencontainers.image.source="https://github.com/mahdi78ba/greengateway" \
      org.opencontainers.image.description="GreenGateway: a policy-driven LLM gateway in front of OpenRouter" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
# Only what the process needs. Tests, the observability stack, .env and .git
# never enter the image (.dockerignore is an allow-list of the same paths).
# COPY runs as root, so /app and its contents are root-owned and read-only for
# the app user (uid 65532): the process cannot modify its own code.
COPY --from=build /app/node_modules /app/node_modules
COPY package.json /app/
COPY src /app/src
COPY tools /app/tools
# config/tenants.yaml is NOT shipped: tenant keys are per-environment data (a
# baked-in copy would be default credentials). Mount it at run time, as
# docker-compose.yml does; Kubernetes will mount a ConfigMap (a later phase):
#   docker run -v ./config/tenants.yaml:/app/config/tenants.yaml:ro ...
WORKDIR /app
EXPOSE 8080
# No HEALTHCHECK on purpose: distroless has no shell or curl. Compose and
# Kubernetes probe GET /healthz from outside the container instead.
CMD ["src/server.js"]
