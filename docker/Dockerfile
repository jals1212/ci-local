# The base of the Linux runner ci-local runs a project's steps in: the Node
# version of the project's `.nvmrc`, on Debian, with what GitHub's hosted
# `ubuntu-latest` runner has around it that a Node project's workflow uses.
# Built locally by ci-local and never pushed; a project extends it with its own
# Dockerfile (`ARG CI_LOCAL_BASE` / `FROM ${CI_LOCAL_BASE}`) when it needs more.
#
# NODE_VERSION has no default on purpose: `.nvmrc` is the only place it is written.
ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm

# - The Docker client with the compose and buildx plugins, from Docker's apt
#   repository (Debian's client is too old for a current daemon). Steps drive
#   the host's daemon through the socket ci-local mounts.
# - sudo without a password for the `runner` user ci-local creates, as on the
#   hosted runner: `npx playwright install --with-deps` and the like use it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl sudo \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin docker-buildx-plugin \
 && rm -rf /var/lib/apt/lists/* \
 && echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner \
 && chmod 0440 /etc/sudoers.d/runner

# The package manager a project pins in package.json ("packageManager":
# "pnpm@x.y.z", or yarn) runs as pinned, through corepack: it downloads that
# exact version, checks it, and keeps it under ~/.cache, which ci-local keeps
# between runs. npm needs nothing. No prompt before the download: the runner
# is not interactive.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
