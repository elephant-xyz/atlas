# syntax=docker/dockerfile:1.7
# The image Transform's command executor runs the Atlas commands in (see command/README.md).
# Built with BuildKit from a clean checkout of main, at the repository root:
#   docker build --platform linux/amd64 -f command/Dockerfile --build-arg ATLAS_SOURCE_SHA="$(git rev-parse HEAD)" .

# Node 22, the version the workflows run, pinned by its multi-platform index digest.
FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS cli

# elephant-cli 2.0.0-alpha.0 for Linux x86-64, the release and archive digest validate.yml pins.
ADD --checksum=sha256:94cff190683dcee4b5307aaeaa0a3392cd83748335e6110cf501838b7a063f1b \
  https://github.com/elephant-xyz/elephant-cli/releases/download/v2.0.0-alpha.0/elephant-cli-x86_64-unknown-linux-gnu.tar.gz /tmp/elephant-cli.tar.gz
RUN mkdir /tmp/elephant-cli && tar -xzf /tmp/elephant-cli.tar.gz -C /tmp/elephant-cli

FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# git for the checkout, the history the scripts read and the pushes; ssh for the deploy key.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/*
COPY --from=cli /tmp/elephant-cli/elephant-cli /usr/local/bin/elephant-cli

WORKDIR /opt/atlas
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# With this Dockerfile, IMAGE_PATHS in command/lib.mjs: a run refuses unless they are main's at
# ATLAS_SOURCE_SHA.
COPY schema/ schema/
COPY scripts/ scripts/
COPY command/*.mjs command/*.json command/known_hosts command/

# The heap the workflows give the scripts: a full-county CAR is indexed in memory.
ENV NODE_OPTIONS=--max-old-space-size=12288
ARG ATLAS_SOURCE_SHA
RUN printf "%s\n" "$ATLAS_SOURCE_SHA" > REVISION
LABEL org.opencontainers.image.source="https://github.com/elephant-xyz/atlas" \
  org.opencontainers.image.revision="${ATLAS_SOURCE_SHA}"
USER node
