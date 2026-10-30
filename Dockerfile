# Dispatch demo image: the Nebius agent only, running as an unprivileged user.
FROM node:22-slim

# Tools the agent commonly needs inside a project: git, Python for tests and scripts, curl.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY demo ./demo

RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4378 \
    DISPATCH_CLI=0 \
    DISPATCH_DEMO=1 \
    DISPATCH_HOME_DIR=/home/node \
    DISPATCH_DATA_DIR=/data/state \
    DISPATCH_WORKSPACES=/data/workspaces
USER node
VOLUME /data
EXPOSE 4378
CMD ["node", "src/index.ts"]
