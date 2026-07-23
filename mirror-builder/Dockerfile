# main.js is gitignored (a build artifact, not committed) and manifest.json's
# version can be bumped without anyone remembering to rebuild it — this stage
# always builds obsidian-installer-plugin from current source, so the image
# never bundles a stale or missing main.js.
FROM node:22-alpine AS plugin-build
WORKDIR /build
COPY obsidian-installer-plugin/package.json obsidian-installer-plugin/package-lock.json ./
RUN npm ci
COPY obsidian-installer-plugin/ ./
RUN npm run build

FROM nginx:alpine

RUN apk update && \
    apk add --no-cache --upgrade openssl libssl3 libcrypto3

COPY mirror-builder/nginx/default.conf /etc/nginx/conf.d/default.conf

# Base image ships its own /usr/share/nginx/html/index.html ("Welcome to
# nginx!"); COPY only adds/overwrites files, it never removes it, and it
# would otherwise win over index.json at the mirror root.
RUN rm -rf /usr/share/nginx/html/*

COPY mirror-builder/dist/ /usr/share/nginx/html/
COPY docs/ /usr/share/nginx/html/docs/

# The installer plugin's own build, always current — fixed, version-less
# path (no index.json entry, no version history: self-update only ever
# needs "the current build, right now").
COPY --from=plugin-build /build/manifest.json /build/main.js /usr/share/nginx/html/self/

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/health || exit 1
