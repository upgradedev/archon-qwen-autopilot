# Locked/reviewed production image: compile with the exact project Node/npm pair,
# then run only emitted JavaScript and production dependencies as uid/gid 1000.
FROM node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY scripts/apply-schema.ts scripts/bootstrap-db.ts ./scripts/
RUN npm run --ignore-scripts build \
    && npm prune --omit=dev --ignore-scripts \
    && npm cache clean --force

FROM cgr.dev/chainguard/wolfi-base@sha256:02dab76bd852a70556b5b2002195c8a5fdab77d323c433bf6642aab080489795 AS runtime-apk-archives

# Request every locked package name through Wolfi's signed index, then reject the
# response unless every returned version, filename and byte digest is exactly the
# independently reviewed lock. apk-tools 2 `fetch` does not accept version constraints.
WORKDIR /tmp/runtime-apk-lock
COPY runtime-packages.lock runtime-apk-archives.sha256 ./
RUN set -eu; \
    grep -Ev '^(#|$)' runtime-packages.lock > packages; \
    test "$(wc -l < packages)" -eq 45; \
    test "$(grep -Ec '^[a-z0-9][a-z0-9+._-]*=[0-9][a-zA-Z0-9+._:-]*-r[0-9]+$' packages)" -eq 45; \
    cut -d= -f1 packages > package-names; \
    test "$(wc -l < package-names)" -eq 45; \
    test "$(LC_ALL=C sort -u package-names | wc -l)" -eq 45; \
    sed 's/=/-/; s/$/.apk/' packages | LC_ALL=C sort > expected-archives; \
    test "$(LC_ALL=C sort -u expected-archives | wc -l)" -eq 45; \
    test "$(wc -l < runtime-apk-archives.sha256)" -eq 45; \
    test "$(grep -Ec '^[0-9a-f]{64}  [a-z0-9][a-z0-9+._-]*-[0-9][a-zA-Z0-9+._:-]*-r[0-9]+\.apk$' runtime-apk-archives.sha256)" -eq 45; \
    awk '{ print $2 }' runtime-apk-archives.sha256 | LC_ALL=C sort > manifest-archives; \
    test "$(LC_ALL=C sort -u manifest-archives | wc -l)" -eq 45; \
    diff -u expected-archives manifest-archives; \
    mkdir -p /tmp/runtime-apks; \
    apk fetch --no-cache --output /tmp/runtime-apks $(cat package-names); \
    test "$(find /tmp/runtime-apks -mindepth 1 -maxdepth 1 | wc -l)" -eq 45; \
    test "$(find /tmp/runtime-apks -mindepth 1 -maxdepth 1 -type f | wc -l)" -eq 45; \
    : > actual-archives.unsorted; \
    for archive in /tmp/runtime-apks/*; do \
      test -f "$archive"; \
      basename "$archive" >> actual-archives.unsorted; \
    done; \
    LC_ALL=C sort actual-archives.unsorted > actual-archives; \
    test "$(wc -l < actual-archives)" -eq 45; \
    test "$(LC_ALL=C sort -u actual-archives | wc -l)" -eq 45; \
    diff -u expected-archives actual-archives; \
    (cd /tmp/runtime-apks && sha256sum -c /tmp/runtime-apk-lock/runtime-apk-archives.sha256)

FROM cgr.dev/chainguard/wolfi-base@sha256:02dab76bd852a70556b5b2002195c8a5fdab77d323c433bf6642aab080489795 AS runtime

ENV NODE_ENV=production
ENV PORT=9000
ENV HOME=/tmp
WORKDIR /app

# The local archives are an exact 45-file set fetched through Wolfi's signed index
# and independently byte-locked. Revalidate the complete set and hashes in the
# network-disabled install step before allowing the intentionally local/untrusted
# APK mode. The final base + added inventory remains exact as well.
COPY runtime-packages.lock runtime-apk-inventory.lock runtime-apk-archives.sha256 /tmp/runtime-apk-lock/
RUN --network=none \
    --mount=type=bind,from=runtime-apk-archives,source=/tmp/runtime-apks,target=/tmp/runtime-apks,ro \
    set -eu; \
    grep -Ev '^(#|$)' /tmp/runtime-apk-lock/runtime-packages.lock > /tmp/runtime-apk-lock/packages; \
    test "$(wc -l < /tmp/runtime-apk-lock/packages)" -eq 45; \
    sed 's/=/-/; s/$/.apk/' /tmp/runtime-apk-lock/packages \
      | LC_ALL=C sort > /tmp/runtime-apk-lock/expected-archives; \
    test "$(LC_ALL=C sort -u /tmp/runtime-apk-lock/expected-archives | wc -l)" -eq 45; \
    test "$(wc -l < /tmp/runtime-apk-lock/runtime-apk-archives.sha256)" -eq 45; \
    test "$(grep -Ec '^[0-9a-f]{64}  [a-z0-9][a-z0-9+._-]*-[0-9][a-zA-Z0-9+._:-]*-r[0-9]+\.apk$' /tmp/runtime-apk-lock/runtime-apk-archives.sha256)" -eq 45; \
    awk '{ print $2 }' /tmp/runtime-apk-lock/runtime-apk-archives.sha256 \
      | LC_ALL=C sort > /tmp/runtime-apk-lock/manifest-archives; \
    test "$(LC_ALL=C sort -u /tmp/runtime-apk-lock/manifest-archives | wc -l)" -eq 45; \
    diff -u /tmp/runtime-apk-lock/expected-archives /tmp/runtime-apk-lock/manifest-archives; \
    test "$(find /tmp/runtime-apks -mindepth 1 -maxdepth 1 | wc -l)" -eq 45; \
    test "$(find /tmp/runtime-apks -mindepth 1 -maxdepth 1 -type f | wc -l)" -eq 45; \
    : > /tmp/runtime-apk-lock/actual-archives.unsorted; \
    for archive in /tmp/runtime-apks/*; do \
      test -f "$archive"; \
      basename "$archive" >> /tmp/runtime-apk-lock/actual-archives.unsorted; \
    done; \
    LC_ALL=C sort /tmp/runtime-apk-lock/actual-archives.unsorted \
      > /tmp/runtime-apk-lock/actual-archives; \
    test "$(wc -l < /tmp/runtime-apk-lock/actual-archives)" -eq 45; \
    test "$(LC_ALL=C sort -u /tmp/runtime-apk-lock/actual-archives | wc -l)" -eq 45; \
    diff -u /tmp/runtime-apk-lock/expected-archives /tmp/runtime-apk-lock/actual-archives; \
    (cd /tmp/runtime-apks && sha256sum -c /tmp/runtime-apk-lock/runtime-apk-archives.sha256); \
    : > /tmp/runtime-apk-lock/empty-repositories; \
    apk --no-cache --no-network --repositories-file /tmp/runtime-apk-lock/empty-repositories \
      add --allow-untrusted /tmp/runtime-apks/*.apk; \
    grep -Ev '^(#|$)' /tmp/runtime-apk-lock/runtime-apk-inventory.lock \
      | sed 's/=/-/' | LC_ALL=C sort > /tmp/runtime-apk-lock/expected-inventory; \
    apk --no-network --repositories-file /tmp/runtime-apk-lock/empty-repositories info -v \
      | LC_ALL=C sort > /tmp/runtime-apk-lock/actual-inventory; \
    diff -u /tmp/runtime-apk-lock/expected-inventory /tmp/runtime-apk-lock/actual-inventory; \
    test "$(node --version)" = "v24.18.0"; \
    command -v pdftoppm >/dev/null; \
    ! command -v npm >/dev/null; \
    rm -rf /tmp/runtime-apk-lock

COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/dist/src ./dist/src
COPY --from=build --chown=1000:1000 /app/dist/scripts/apply-schema.js ./dist/scripts/apply-schema.js
COPY --from=build --chown=1000:1000 /app/dist/scripts/bootstrap-db.js ./dist/scripts/bootstrap-db.js
# Runtime assets deliberately live beside their compiled consumers.
COPY --chown=1000:1000 src/ui.html ./dist/src/ui.html
COPY --chown=1000:1000 src/db/schema.sql ./dist/src/db/schema.sql
COPY --chown=1000:1000 demo/sample-invoice.png ./dist/demo/sample-invoice.png
COPY --chown=1000:1000 package.json ./dist/package.json

EXPOSE 9000
USER 1000:1000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT []
CMD ["node", "dist/src/server.js"]
