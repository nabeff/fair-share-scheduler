# One image for every service. Node 24 runs TypeScript directly, no build step.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
USER node
CMD ["node", "src/api.ts"]
