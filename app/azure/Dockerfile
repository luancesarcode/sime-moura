FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY scripts ./scripts
COPY public ./public
USER node
EXPOSE 8080
CMD ["node","scripts/serve.mjs"]
