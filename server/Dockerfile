# STRANDED relay server. Build from the REPOSITORY ROOT so the shared protocol + config modules are in the context:
#   docker build -f server/Dockerfile -t stranded-relay .
#   docker run -p 8787:8787 stranded-relay
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
# The server imports ../src/config.js and ../src/net/protocol.js (shared with the browser client).
COPY src/config.js /app/src/config.js
COPY src/net/protocol.js /app/src/net/protocol.js
COPY server/index.js ./index.js
ENV PORT=8787
EXPOSE 8787
USER node
CMD ["node", "index.js"]
