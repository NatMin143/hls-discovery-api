FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev \
 && npx playwright install --with-deps chromium \
 && apt-get update && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
COPY inspector.js server.js index.html ./
ENV NODE_ENV=production
ENTRYPOINT ["tini", "--"]
CMD ["node", "server.js"]
