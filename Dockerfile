# PUMPICS production image
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    DB_PATH=/data/pumpics.db \
    PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY public ./public
COPY data ./data
COPY scripts ./scripts
# Runs as root: Railway (and most hosts) mount volumes owned by root, so a non-root user couldn't write the database.
RUN mkdir -p /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
